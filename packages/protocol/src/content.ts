/**
 * Framework-neutral content helpers: constructing `CreateRequest.blocks`
 * entries and explicitly loading a retained tool-result object.
 *
 * `readToolCapturePages` is deliberately NOT part of folding. Folding retains
 * only a logical object id, byte counts, encoding, truncation metadata, and the
 * already-shaped inline preview. A caller invokes the read in response to a
 * user action and supplies both a per-request page size and a total ceiling.
 * Metadata is checked before range I/O; the bounded result is assembled and
 * digest-verified before any page is returned to a renderer. The page byte
 * arrays are views over that one verified result buffer, not duplicate copies.
 *
 * The request-block helper below constructs `CreateRequest.blocks` entries
 * (the request body `submit`/`createSession` accept — see transport.ts).
 * `blocks` is loosely typed at the schema level (each item is just
 * `{"type":"object"}` — see create_request.schema.json's own description,
 * "Block semantics are validated by the content block codec, not this
 * schema") because the actual codec lives in harness's `core/content`
 * package (Go), not this SDK.
 *
 * `textBlock` mirrors that codec's EXACT wire shape for a plain-text content
 * block: `{"type":"text","Text":"..."}` — the capitalized `Text` field is not
 * a stylistic guess, it's what `content.TextBlock` (a bare
 * `struct{ Text string }` with no `json` struct tag, see harness's
 * `core/content/block.go`) actually encodes to. Confirmed against harness's
 * own `pkg/serve/handlers_lifecycle_test.go`, whose `validBlocksBody` fixture
 * is literally `{"blocks":[{"type":"text","Text":"hello"}]}`. Sending a
 * lowerCamelCase `text` field instead would silently decode to an EMPTY
 * TextBlock server-side (Go's default JSON unmarshaling is case-insensitive
 * for matching but there is no `text` field to match at all here — the real
 * field is `Text`), not fail loudly, so getting this exact casing right
 * matters.
 */

import type { FactoryReads } from "./factory-rest.js";
import { RequestAbortedError } from "./errors.js";
import type { ObjectMetadata } from "./types.js";
import type { ToolResultCaptureSummary } from "./toolsummary.js";

export interface ReadToolCaptureOptions {
  /** Maximum bytes per Factory range request. */
  pageBytes: number;
  /** UI policy ceiling; captures above it are refused before any object I/O. */
  ceilingBytes: number;
  signal?: AbortSignal;
}

export interface ToolCapturePage {
  start: number;
  end: number;
  bytes: Uint8Array;
}

export interface ToolCaptureContent {
  metadata: ObjectMetadata;
  pages: ToolCapturePage[];
  bytes: Uint8Array;
}

export class ToolCaptureTooLargeError extends Error {
  constructor() {
    super("retained tool result exceeds the requested read ceiling");
    this.name = "ToolCaptureTooLargeError";
  }
}

export class ToolCaptureIntegrityError extends Error {
  constructor(detail = "retained tool result failed integrity verification") {
    super(detail);
    this.name = "ToolCaptureIntegrityError";
  }
}

function throwIfCaptureReadAborted(signal: AbortSignal | undefined, path: string): void {
  if (signal?.aborted) throw new RequestAbortedError(path);
}

/** Explicit object read invoked by a user's expand/page action. */
export async function readToolCapturePages(
  reads: FactoryReads,
  sessionId: string,
  capture: ToolResultCaptureSummary,
  options: ReadToolCaptureOptions,
): Promise<ToolCaptureContent> {
  if (!Number.isSafeInteger(options.pageBytes) || options.pageBytes <= 0) {
    throw new RangeError("tool capture pageBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.ceilingBytes) || options.ceilingBytes < 0) {
    throw new RangeError("tool capture ceilingBytes must be a non-negative safe integer");
  }
  if (capture.capturedBytes > options.ceilingBytes) throw new ToolCaptureTooLargeError();
  if (capture.objectId === undefined) throw new ToolCaptureIntegrityError("tool result has no retained object");
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}/objects/${encodeURIComponent(capture.objectId)}`;
  throwIfCaptureReadAborted(options.signal, path);

  const metadata = await reads.readObjectMetadata(sessionId, capture.objectId, { signal: options.signal });
  throwIfCaptureReadAborted(options.signal, path);
  if (metadata.reference.object_id !== capture.objectId || metadata.size_bytes !== capture.capturedBytes) {
    throw new ToolCaptureIntegrityError();
  }

  const pages: ToolCapturePage[] = [];
  const bytes = new Uint8Array(capture.capturedBytes);
  for (let start = 0; start < capture.capturedBytes; start += options.pageBytes) {
    const end = Math.min(capture.capturedBytes - 1, start + options.pageBytes - 1);
    const page = await reads.readObjectRange(sessionId, capture.objectId, {
      start,
      end,
      signal: options.signal,
    });
    throwIfCaptureReadAborted(options.signal, path);
    const expectedRange = `bytes ${start}-${end}/${capture.capturedBytes}`;
    if (page.contentRange !== expectedRange || page.bytes.length !== end - start + 1) {
      throw new ToolCaptureIntegrityError();
    }
    bytes.set(page.bytes, start);
    pages.push({ start, end, bytes: bytes.subarray(start, end + 1) });
  }

  if (metadata.digest !== undefined) {
    const match = /^sha256:([0-9a-f]{64})$/.exec(metadata.digest);
    if (match === null) throw new ToolCaptureIntegrityError();
    const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    throwIfCaptureReadAborted(options.signal, path);
    const actualHex = Array.from(actual, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actualHex !== match[1]) throw new ToolCaptureIntegrityError();
  }
  return { metadata, pages, bytes };
}

/**
 * The wire shape of a single text content block, as `content.TextBlock` (Go)
 * encodes it. Carries an index signature purely so a `TextContentBlock`
 * value structurally satisfies `CreateRequest["blocks"]`'s item type (schema-
 * derived as an open `{[x: string]: unknown}`, per create_request.schema.json's
 * `{"type":"object"}` with no declared properties) — TypeScript's implicit-
 * index-signature compatibility only applies to a genuinely fresh object
 * literal at the assignment site, not to a value flowing through a named
 * return type like this one.
 */
export interface TextContentBlock {
  type: "text";
  Text: string;
  [key: string]: unknown;
}

/** Builds a `CreateRequest.blocks` entry carrying plain text — the shape a chat composer submits. */
export function textBlock(text: string): TextContentBlock {
  return { type: "text", Text: text };
}
