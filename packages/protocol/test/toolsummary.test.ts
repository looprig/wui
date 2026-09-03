/**
 * `toolUseSummary` — the durable, redacted one-line detail a COLD-REPLAYED tool
 * card shows, ported from tui's `internal/presentation/toolsummary.go`.
 *
 * ## Why these expectations are what they are
 *
 * The live card's `summary` is harness's own `ToolCallStarted.Summary`
 * (`pkg/serve/ephemeral.go`'s `toolCallStartedDelta`), which is already
 * redacted. A replayed card has no such field — the ephemeral frame is never
 * persisted — so it has to derive one from the stored `ToolUseBlock.Input`, and
 * the derivation must land in the SAME place: a card that showed a file's whole
 * contents on replay and a path while live would be two different cards for one
 * call. That is why this is a summariser and not a raw-input renderer.
 *
 * ## The Go decoder semantics this replicates, verbatim
 *
 * tui's summariser is `json.Unmarshal` into a small tagged struct per tool, and
 * two of encoding/json's behaviours are load-bearing here rather than
 * incidental:
 *
 *  - **A type mismatch on ANY mapped field fails the whole decode**, and every
 *    summariser returns "" on `err != nil`. So `{"path":"/a","content":7}` is
 *    not "the path with a bad content field", it is no summary at all. Fail
 *    closed: showing less is safe, showing something the input did not say is
 *    not.
 *  - **Field matching is exact-first, then case-insensitive** (encoding/json's
 *    documented fallback), so `{"Command":"ls"}` reaches a `json:"command"`
 *    field. Replicated so a card does not go blank in wui while tui renders it.
 *
 * A non-object input (a string, a number, an array) is an `Unmarshal` error and
 * yields ""; a literal `null` decodes as a no-op into the zero struct, which
 * every summariser then renders as "" as well — the two paths are
 * indistinguishable in the output, which is why one guard covers both.
 *
 * `len()` in `writeSummary` is Go's BYTE length. `"é"` is one UTF-16 code unit
 * and two UTF-8 bytes, so `.length` would disagree with tui on any non-ASCII
 * payload.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FactoryReads } from "../src/factory-rest.js";
import { RequestAbortedError } from "../src/errors.js";
import { readToolCapturePages, ToolCaptureIntegrityError, ToolCaptureTooLargeError } from "../src/content.js";
import { toolResultCaptures, toolUseSummary, type ToolResultCaptureSummary } from "../src/toolsummary.js";
import * as content from "../src/content.js";

describe("retained tool-result content", () => {
  it("exposes an explicit user-initiated pageable Factory read", () => {
    expect(typeof (content as Record<string, unknown>)["readToolCapturePages"]).toBe("function");
  });

  const capture: ToolResultCaptureSummary = {
    toolExecutionId: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
    objectId: "object-1",
    capturedBytes: 10,
    originalBytes: 21,
    originalBytesLowerBound: undefined,
    declaredCeilingBytes: 10,
    truncated: true,
    truncationReason: "capture_ceiling",
    encoding: "utf-8",
  };
  const digest = "sha256:72399361da6a7754fec986dca5b7cbaf1c810a28ded4abaf56b2106d06cb78b0";

  function reads(overrides: Partial<FactoryReads> = {}): FactoryReads {
    return {
      listAgents: vi.fn(),
      listRecentSessions: vi.fn(),
      readStatus: vi.fn(),
      readJournal: vi.fn(),
      listGates: vi.fn(),
      readObjectMetadata: vi.fn(async () => ({
        reference: { object_id: "object-1" },
        size_bytes: 10,
        media_type: "text/plain",
        digest,
      })),
      readObjectRange: vi.fn(async (_sessionId, _objectId, options) => ({
        bytes: new TextEncoder().encode("abcdefghij").slice(options.start, options.end + 1),
        contentRange: `bytes ${options.start}-${options.end}/10`,
        mediaType: "text/plain",
      })),
      ...overrides,
    } as FactoryReads;
  }

  it("continues exact inclusive ranges through the captured byte count after Host/workspace deletion", async () => {
    const factory = reads();
    const loaded = await readToolCapturePages(factory, "session-1", capture, { pageBytes: 4, ceilingBytes: 10 });

    expect(factory.readObjectMetadata).toHaveBeenCalledWith("session-1", "object-1", { signal: undefined });
    expect(vi.mocked(factory.readObjectRange).mock.calls.map(([, , options]) => [options.start, options.end])).toStrictEqual([
      [0, 3], [4, 7], [8, 9],
    ]);
    expect(loaded.pages.map(({ start, end }) => [start, end])).toStrictEqual([[0, 3], [4, 7], [8, 9]]);
    expect(new TextDecoder().decode(loaded.bytes)).toBe("abcdefghij");
    expect(loaded.metadata.digest).toBe(digest);
  });

  it("allows a capture exactly at the caller's declared ceiling", async () => {
    const factory = reads();
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 10, ceilingBytes: 10 })).resolves.toMatchObject({
      pages: [{ start: 0, end: 9 }],
    });
  });

  it("refuses an over-ceiling capture before metadata or object I/O", async () => {
    const factory = reads();
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 4, ceilingBytes: 9 })).rejects.toBeInstanceOf(ToolCaptureTooLargeError);
    expect(factory.readObjectMetadata).not.toHaveBeenCalled();
    expect(factory.readObjectRange).not.toHaveBeenCalled();
  });

  it("cancels before the first object read and forwards mid-read cancellation", async () => {
    const already = new AbortController();
    already.abort();
    const untouched = reads();
    await expect(readToolCapturePages(untouched, "session-1", capture, { pageBytes: 4, ceilingBytes: 10, signal: already.signal })).rejects.toBeInstanceOf(RequestAbortedError);
    expect(untouched.readObjectMetadata).not.toHaveBeenCalled();

    const later = new AbortController();
    const interrupted = new RequestAbortedError("range");
    const factory = reads({ readObjectRange: vi.fn(async (_sid, _oid, options) => {
      expect(options.signal).toBe(later.signal);
      later.abort();
      throw interrupted;
    }) });
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 4, ceilingBytes: 10, signal: later.signal })).rejects.toBe(interrupted);

    const completedPageAbort = new AbortController();
    const ignoringFactory = reads({ readObjectRange: vi.fn(async (_sid, _oid, options) => {
      completedPageAbort.abort();
      return {
        bytes: new TextEncoder().encode("abcdefghij").slice(options.start, options.end + 1),
        contentRange: `bytes ${options.start}-${options.end}/10`,
        mediaType: "text/plain",
      };
    }) });
    await expect(readToolCapturePages(ignoringFactory, "session-1", capture, {
      pageBytes: 4, ceilingBytes: 10, signal: completedPageAbort.signal,
    })).rejects.toBeInstanceOf(RequestAbortedError);
    expect(ignoringFactory.readObjectRange).toHaveBeenCalledTimes(1);
  });

  it("rejects a digest mismatch after bounded reads", async () => {
    const factory = reads({ readObjectMetadata: vi.fn(async () => ({
      reference: { object_id: "object-1" }, size_bytes: 10, digest: `sha256:${"0".repeat(64)}`,
    })) });
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 4, ceilingBytes: 10 })).rejects.toBeInstanceOf(ToolCaptureIntegrityError);
  });

  it("rejects metadata whose immutable size disagrees with the capture before range I/O", async () => {
    const factory = reads({ readObjectMetadata: vi.fn(async () => ({
      reference: { object_id: "object-1" }, size_bytes: 11, digest,
    })) });
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 4, ceilingBytes: 10 })).rejects.toBeInstanceOf(ToolCaptureIntegrityError);
    expect(factory.readObjectRange).not.toHaveBeenCalled();
  });

  it("surfaces a missing retained object and never attempts a range", async () => {
    const missing = new Error("object not found");
    const factory = reads({ readObjectMetadata: vi.fn(async () => { throw missing; }) });
    await expect(readToolCapturePages(factory, "session-1", capture, { pageBytes: 4, ceilingBytes: 10 })).rejects.toBe(missing);
    expect(factory.readObjectRange).not.toHaveBeenCalled();
  });
});

describe("tool-result capture projection against Core fixture authorities", () => {
  it("uses Core's logical reference spelling and never copies private extensions", () => {
    const reference = JSON.parse(readFileSync(new URL("../../../contract/fixtures/object_reference.json", import.meta.url), "utf8"));
    const metadata = JSON.parse(readFileSync(new URL("../../../contract/fixtures/object_metadata.json", import.meta.url), "utf8"));
    const captures = toolResultCaptures([{
      tool_execution_id: "execution-1",
      tool_use_id: "use-1",
      reference: { ...reference, signed_url: "SECRET-url", backend_key: "SECRET-key", credential: "SECRET-credential", raw_bytes: "SECRET-bytes" },
      captured_bytes: metadata.size_bytes,
      original_bytes: null,
      original_bytes_lower_bound: metadata.size_bytes + 1,
      truncated: true,
      truncation_reason: "source_limit",
      encoding: "binary",
    }]);
    expect(captures.get("use-1")).toStrictEqual({
      toolExecutionId: "execution-1",
      objectId: reference.object_id,
      capturedBytes: 42,
      originalBytes: null,
      originalBytesLowerBound: 43,
      declaredCeilingBytes: undefined,
      truncated: true,
      truncationReason: "source_limit",
      encoding: "binary",
    });
    expect(JSON.stringify(captures.get("use-1"))).not.toContain("SECRET");
  });
});

describe("toolUseSummary: the path tools", () => {
  it("summarises Read, ReadFile and EditFile as their trimmed path", () => {
    expect(toolUseSummary("Read", { path: "/etc/hosts" })).toBe("/etc/hosts");
    expect(toolUseSummary("ReadFile", { path: "  /etc/hosts  " })).toBe("/etc/hosts");
    expect(toolUseSummary("EditFile", { path: "/tmp/x.ts" })).toBe("/tmp/x.ts");
  });

  it("renders no path at all rather than an edit's substrings", () => {
    // EditFile's input carries old_string/new_string. Neither is read: the
    // summary is the redacted detail, and a diff fragment is not redacted.
    expect(toolUseSummary("EditFile", { path: "/tmp/x.ts", old_string: "secret", new_string: "s" })).toBe(
      "/tmp/x.ts",
    );
  });

  it("yields no summary when the path key is absent or empty", () => {
    expect(toolUseSummary("Read", {})).toBe("");
    expect(toolUseSummary("Read", { path: "" })).toBe("");
    expect(toolUseSummary("Read", { path: "   " })).toBe("");
  });
});

describe("toolUseSummary: WriteFile counts bytes and never shows them", () => {
  it("renders the path and the content's BYTE length", () => {
    expect(toolUseSummary("WriteFile", { path: "/tmp/out.txt", content: "hello" })).toBe(
      "/tmp/out.txt (5 bytes)",
    );
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // "é" is 1 in JS `.length` and 2 in Go `len()`. "𝄞" is 2 code units and 4
    // bytes. A `.length` implementation returns "(3 bytes)" here.
    expect(toolUseSummary("WriteFile", { path: "/a", content: "é𝄞" })).toBe("/a (6 bytes)");
  });

  it("renders (0 bytes) for an empty write, which is a real operation", () => {
    expect(toolUseSummary("WriteFile", { path: "/a", content: "" })).toBe("/a (0 bytes)");
  });

  it("yields no summary at all when the path is missing — never a bare byte count", () => {
    expect(toolUseSummary("WriteFile", { content: "hello" })).toBe("");
    expect(toolUseSummary("WriteFile", { path: "  ", content: "hello" })).toBe("");
  });

  it("never renders the content itself", () => {
    const summary = toolUseSummary("WriteFile", { path: "/a", content: "SECRET-TOKEN" });
    expect(summary).not.toContain("SECRET");
  });
});

describe("toolUseSummary: Bash", () => {
  it("prefers `command` and falls back to the legacy `cmd`", () => {
    expect(toolUseSummary("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(toolUseSummary("Bash", { cmd: "ls -la" })).toBe("ls -la");
    expect(toolUseSummary("Bash", { command: "new", cmd: "old" })).toBe("new");
  });

  it("does NOT trim the command, matching tui", () => {
    // pathSummary trims and bashSummary does not. A command's leading
    // whitespace is part of what was run, and tui shows it; normalising here
    // would make the two renderers disagree about the same call.
    expect(toolUseSummary("Bash", { command: "  ls  " })).toBe("  ls  ");
  });

  it("yields no summary when neither key is present", () => {
    expect(toolUseSummary("Bash", {})).toBe("");
  });
});

describe("toolUseSummary: Fetch, WebSearch and Skill", () => {
  it("renders Fetch as an upper-cased method and its url", () => {
    expect(toolUseSummary("Fetch", { method: "get", url: "https://x/y" })).toBe("GET https://x/y");
    expect(toolUseSummary("Fetch", { method: "  post  ", url: "  https://x/y  " })).toBe("POST https://x/y");
  });

  it("renders a Fetch with no method as the bare url, and no url as nothing", () => {
    expect(toolUseSummary("Fetch", { url: "https://x/y" })).toBe("https://x/y");
    expect(toolUseSummary("Fetch", { method: "GET" })).toBe("");
    expect(toolUseSummary("Fetch", { method: "GET", url: "   " })).toBe("");
  });

  it("never renders a Fetch's headers or body", () => {
    const summary = toolUseSummary("Fetch", {
      method: "POST",
      url: "https://x/y",
      headers: { Authorization: "Bearer SECRET" },
      body: "SECRET-BODY",
    });
    expect(summary).toBe("POST https://x/y");
  });

  it("renders WebSearch as its trimmed query and Skill as its trimmed name", () => {
    expect(toolUseSummary("WebSearch", { query: "  go generics  " })).toBe("go generics");
    expect(toolUseSummary("WebSearch", {})).toBe("");
    expect(toolUseSummary("Skill", { name: "  brainstorming  " })).toBe("brainstorming");
    expect(toolUseSummary("Skill", {})).toBe("");
  });
});

describe("toolUseSummary: Glob and Grep", () => {
  it("renders a Glob pattern, scoped by its root when there is one", () => {
    expect(toolUseSummary("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolUseSummary("Glob", { pattern: "**/*.ts", root: "src" })).toBe("**/*.ts in src");
    expect(toolUseSummary("Glob", { pattern: "  **/*.ts  ", root: "  src  " })).toBe("**/*.ts in src");
  });

  it("renders a Grep pattern, scoped by its path, with the legacy `q` fallback", () => {
    expect(toolUseSummary("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(toolUseSummary("Grep", { pattern: "TODO", path: "src" })).toBe("TODO in src");
    expect(toolUseSummary("Grep", { q: "TODO", path: "src" })).toBe("TODO in src");
    expect(toolUseSummary("Grep", { pattern: "new", q: "old" })).toBe("new");
  });

  it("yields no summary when the pattern is blank, so `in src` never stands alone", () => {
    expect(toolUseSummary("Glob", { root: "src" })).toBe("");
    expect(toolUseSummary("Glob", { pattern: "   ", root: "src" })).toBe("");
    expect(toolUseSummary("Grep", { path: "src" })).toBe("");
    expect(toolUseSummary("Grep", { pattern: "   ", path: "src" })).toBe("");
  });
});

describe("toolUseSummary: the tools with deliberately no summary", () => {
  it("renders nothing for the task tools, whose arguments are the task text", () => {
    // The input deliberately carries a key every OTHER summariser reads, so
    // wiring a task tool to any of them fails here. Falling through to the
    // `default` arm is NOT caught, and cannot be: the explicit arms and the
    // default both return "", so deleting them is an equivalent mutation. They
    // are written out for the same reason tui writes them out — the silence is
    // a decision about these tools, not an omission.
    const everySummarisersKey = {
      title: "ship it",
      description: "the whole plan",
      path: "/tmp/notes",
      command: "rm -rf /",
      content: "body",
      query: "how",
      pattern: "TODO",
      root: "src",
      name: "brainstorming",
      method: "post",
      url: "https://x/y",
    };
    for (const name of ["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"]) {
      expect(toolUseSummary(name, everySummarisersKey), name).toBe("");
    }
  });

  it("renders nothing for a tool the catalogue does not know", () => {
    expect(toolUseSummary("SomeMcpTool", { path: "/etc/hosts", command: "ls" })).toBe("");
    expect(toolUseSummary("", { path: "/etc/hosts" })).toBe("");
  });

  it("is case-SENSITIVE on the tool name, which is a durable identifier", () => {
    // The name is content.ToolUseBlock.Name, matched against the registry's
    // exact spelling; "read" is a different tool, not a spelling of "Read".
    expect(toolUseSummary("read", { path: "/a" })).toBe("");
    expect(toolUseSummary("BASH", { command: "ls" })).toBe("");
  });
});

describe("toolUseSummary: the decoder's own semantics", () => {
  it("yields no summary for an input that is not a JSON object", () => {
    // Every one of these is an `Unmarshal` error in tui, or (for null) a no-op
    // decode into the zero struct. Both render "".
    expect(toolUseSummary("Read", null)).toBe("");
    expect(toolUseSummary("Read", undefined)).toBe("");
    expect(toolUseSummary("Read", "/etc/hosts")).toBe("");
    expect(toolUseSummary("Read", ["/etc/hosts"])).toBe("");
    expect(toolUseSummary("Read", 7)).toBe("");
    expect(toolUseSummary("Bash", true)).toBe("");
  });

  it("fails the WHOLE decode when any mapped field has the wrong type", () => {
    // encoding/json sets an error and every summariser returns "" on it, so a
    // sibling field's bad type takes the good one down with it.
    expect(toolUseSummary("Read", { path: 7 })).toBe("");
    expect(toolUseSummary("WriteFile", { path: "/a", content: 7 })).toBe("");
    expect(toolUseSummary("Bash", { command: "ls", cmd: 7 })).toBe("");
    expect(toolUseSummary("Grep", { pattern: "TODO", path: null })).toBe("");
    expect(toolUseSummary("Fetch", { method: "GET", url: ["https://x"] })).toBe("");
  });

  it("ignores unmapped keys entirely, whatever their type", () => {
    expect(toolUseSummary("Read", { path: "/a", limit: 20, offset: null, extra: { deep: [] } })).toBe("/a");
  });

  it("matches a field name case-insensitively, exact spelling first", () => {
    // encoding/json's documented fallback. Without it a `{"Command":"ls"}`
    // input renders in tui and goes blank in wui.
    expect(toolUseSummary("Bash", { Command: "ls" })).toBe("ls");
    expect(toolUseSummary("Read", { PATH: "/a" })).toBe("/a");
    expect(toolUseSummary("Read", { Path: "/exact-loses", path: "/exact-wins" })).toBe("/exact-wins");
  });
});
