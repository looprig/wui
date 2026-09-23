import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Not re-exported from the package barrel: it is `clientlink.ts`'s documented
// internal seam for driving the adapter without a socket, which is exactly what
// reading the connect frame's advertised version needs.
import { createClientLinkWithTransport } from "../../packages/protocol/src/clientlink.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST_NAME,
  buildBundleManifest,
  readBundleInputs,
  writeBundleManifest,
} from "./write-bundle-manifest.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));

const temporaries: string[] = [];

function temporaryDirectory(): string {
  const created = mkdtempSync(join(tmpdir(), "looprig-wui-bundle-manifest-"));
  temporaries.push(created);
  return created;
}

afterEach(() => {
  while (temporaries.length > 0) rmSync(temporaries.pop()!, { recursive: true, force: true });
});

describe("readBundleInputs", () => {
  it("reads the three versions from the three authorities that own them", () => {
    // Absolute literals, deliberately. Deriving the expectation from the same
    // files the function reads would pin nothing at all: the assertion would
    // hold for whatever those files happen to say, including a value drifted
    // out from under the embedded Go marker.
    expect(readBundleInputs(repository)).toEqual({
      coreVersion: "v0.11.0",
      protocolVersion: "0.1.0",
      sessionwireVersion: 1,
    });
  });

  it("takes the sessionwire version from Core's negotiation schema, not from a copy", () => {
    // The comparable quantity Factory checks its own Core support against is
    // the `const` in version_negotiation_response.schema.json, which is
    // vendored verbatim from the pinned Core. Point the reader at a repository
    // whose schema says something else and the answer must move with it.
    const fake = temporaryDirectory();
    stageRepository(fake, { sessionwireVersion: 4 });
    expect(readBundleInputs(fake).sessionwireVersion).toBe(4);
  });

  it("reads the core and protocol versions from their own files, not from a constant", () => {
    // A literal here would be a fourth authority: the manifest would keep
    // claiming v0.7.0 after contract/VERSION moved, and the Go marker would
    // report a Core the vendored schemas no longer came from.
    const fake = temporaryDirectory();
    stageRepository(fake, { coreVersion: "v9.4.1", protocolVersion: "3.2.1" });
    expect(readBundleInputs(fake)).toEqual({
      coreVersion: "v9.4.1",
      protocolVersion: "3.2.1",
      sessionwireVersion: 1,
    });
  });

  it("refuses a negotiation schema that pins no single version", () => {
    const fake = temporaryDirectory();
    stageRepository(fake, { sessionwireVersionLiteral: '{"type": "integer"}' });
    expect(() => readBundleInputs(fake)).toThrow(/sessionwire version/);
  });
});

describe("buildBundleManifest", () => {
  it("emits the release manifest as sorted, machine-readable fields", () => {
    expect(
      buildBundleManifest({
        release: true,
        coreVersion: "v0.7.0",
        protocolVersion: "0.1.0",
        sessionwireVersion: 1,
      }),
    ).toEqual({
      core_version: "v0.7.0",
      protocol_version: "0.1.0",
      release: true,
      sessionwire_version: 1,
    });
  });

  it("declares a non-release bundle non-release rather than omitting the field", () => {
    // An absent field is indistinguishable from an older manifest shape to a
    // consumer that gates on it, so the placeholder states its own status.
    const manifest = buildBundleManifest({
      release: false,
      coreVersion: "v0.7.0",
      protocolVersion: "0.1.0",
      sessionwireVersion: 1,
    });
    expect(manifest.release).toBe(false);
    expect(Object.keys(manifest)).toContain("release");
  });

  it.each([
    ["an empty core version", { coreVersion: "" }],
    ["an empty protocol version", { protocolVersion: "" }],
    ["a zero sessionwire version", { sessionwireVersion: 0 }],
    ["a negative sessionwire version", { sessionwireVersion: -1 }],
    ["a fractional sessionwire version", { sessionwireVersion: 1.5 }],
    ["a non-boolean release flag", { release: "true" }],
  ])("refuses to emit a manifest with %s", (_label, override) => {
    expect(() =>
      buildBundleManifest({
        release: true,
        coreVersion: "v0.7.0",
        protocolVersion: "0.1.0",
        sessionwireVersion: 1,
        ...override,
      } as Parameters<typeof buildBundleManifest>[0]),
    ).toThrow();
  });
});

describe("writeBundleManifest", () => {
  it("writes the manifest into the bundle directory the Go side embeds", () => {
    const out = temporaryDirectory();
    writeBundleManifest(out, { release: true, repository });
    const written = JSON.parse(readFileSync(join(out, BUNDLE_MANIFEST_NAME), "utf8"));
    expect(written).toEqual({
      core_version: "v0.11.0",
      protocol_version: "0.1.0",
      release: true,
      sessionwire_version: 1,
    });
  });

  it("writes a non-release manifest when the release flag is not given", () => {
    const out = temporaryDirectory();
    writeBundleManifest(out, { repository });
    const written = JSON.parse(readFileSync(join(out, BUNDLE_MANIFEST_NAME), "utf8"));
    expect(written.release).toBe(false);
  });

  it("ends the file with a newline so the committed manifest is a normal text file", () => {
    const out = temporaryDirectory();
    writeBundleManifest(out, { repository });
    expect(readFileSync(join(out, BUNDLE_MANIFEST_NAME), "utf8").endsWith("}\n")).toBe(true);
  });
});

describe("the committed manifest", () => {
  it("still names the versions its three authorities hold", () => {
    // Drift, not a pin: the literals live in `readBundleInputs` above and in
    // bundle_test.go. What this adds is that the marker COMMITTED under dist/
    // has not been left behind by a bump — moving contract/VERSION or the
    // protocol package version without rebuilding the bundle is silent
    // otherwise, and Go only cross-checks the Core half.
    //
    // `release` is deliberately not asserted. Both values are legitimate for a
    // committed tree: a development commit carries whatever bundle was last
    // force-added, a release commit one `make release-dist` built and verified.
    // The property that always holds — the no-Node placeholder never claims a
    // release — is enforced in the reader, in bundle.go.
    const committed = JSON.parse(
      readFileSync(join(repository, "dist", BUNDLE_MANIFEST_NAME), "utf8"),
    );
    const { coreVersion, protocolVersion, sessionwireVersion } = readBundleInputs(repository);
    expect(committed.core_version).toBe(coreVersion);
    expect(committed.protocol_version).toBe(protocolVersion);
    expect(committed.sessionwire_version).toBe(sessionwireVersion);
    expect(typeof committed.release).toBe("boolean");
  });

  it("advertises the same protocol version the JavaScript handshake sends", () => {
    // The Centrifuge connect frame carries the client name and version. That
    // string and the marker the Go side reads must be one version, or a
    // Factory that trusts the marker is negotiating against a client it has
    // not actually checked.
    const committed = JSON.parse(
      readFileSync(join(repository, "dist", BUNDLE_MANIFEST_NAME), "utf8"),
    );
    let advertised: { name?: unknown; version?: unknown } | undefined;
    createClientLinkWithTransport({
      transportFactory: (_endpoint, options) => {
        advertised = options;
        return stubTransport();
      },
    });
    expect(advertised?.name).toBe("looprig-protocol");
    expect(advertised?.version).toBe(committed.protocol_version);
  });
});

/** A `ClientLinkTransport` that does nothing: the handshake options are read at construction. */
function stubTransport() {
  const subscription = {
    state: "unsubscribed",
    on() { return subscription; },
    subscribe() {},
    release() {},
  };
  const transport = {
    state: "disconnected",
    on() { return transport; },
    connect() {},
    disconnect() {},
    newSubscription() { return subscription; },
    async rpc() { return {}; },
  };
  return transport as never;
}

/**
 * Stages the three files `readBundleInputs` reads, so a case can move one of
 * them without touching the real repository.
 */
function stageRepository(
  root: string,
  options: {
    coreVersion?: string;
    protocolVersion?: string;
    sessionwireVersion?: number;
    sessionwireVersionLiteral?: string;
  } = {},
): void {
  const schemaDirectory = join(root, "contract", "schema");
  const protocolDirectory = join(root, "packages", "protocol");
  mkdirSync(schemaDirectory, { recursive: true });
  mkdirSync(protocolDirectory, { recursive: true });
  writeFileSync(join(root, "contract", "VERSION"), `${options.coreVersion ?? "v0.7.0"}\n`);
  writeFileSync(
    join(protocolDirectory, "package.json"),
    JSON.stringify({ version: options.protocolVersion ?? "0.1.0" }),
  );
  const version = options.sessionwireVersionLiteral ?? `{"const": ${options.sessionwireVersion ?? 1}}`;
  writeFileSync(
    join(schemaDirectory, "version_negotiation_response.schema.json"),
    `{"properties": {"version": ${version}}}`,
  );
}
