import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Emits `dist/looprig-bundle.json`, the machine-readable marker the Go side
 * exposes as `wui.BundleProtocolVersion()`.
 *
 * `vite.config.ts`'s `bundleManifestPlugin` calls `writeBundleManifest` on every
 * build, into that build's own output directory. The CLI at the bottom is the
 * same writer by hand, for regenerating the committed marker without a build.
 *
 * ## Why a file and not a Go constant
 *
 * The module zip is source-only, so whatever is COMMITTED under `dist/` is what
 * every consumer's `//go:embed all:dist` serves. The JavaScript in that tree
 * carries a `sessionwire/v1` client whose negotiated version and whose
 * `@looprig/protocol` build are properties of THAT BUILD, not of the Go source
 * that happens to sit beside it. A Go constant would keep saying the right
 * thing while the bundle beneath it went stale — which is exactly the failure
 * `wui v0.1.0` shipped (a placeholder tree behind a working handler). Writing
 * the marker into the bundle directory ties the claim to the artefact.
 *
 * ## The three values, and the three authorities that own them
 *
 * None of them is a constant in this file, because a constant here would be a
 * fourth authority that can drift from the other three:
 *
 *  - `sessionwire_version` — the `const` in Core's vendored
 *    `version_negotiation_response.schema.json`. This is the quantity Factory
 *    compares against ITS Core support (runbook 05, task A9.2), so it must come
 *    from the same schema document both sides read, not from a hand-copied `1`.
 *  - `core_version` — `contract/VERSION`, the pinned Core module the vendored
 *    schemas were sourced from. `contract/contract_test.go` already holds that
 *    file, `go.mod`'s require and the Makefile's `CORE_VERSION` together.
 *  - `protocol_version` — `packages/protocol/package.json`'s version, which is
 *    also the string `clientlink.ts` puts in the Centrifuge connect frame.
 *    `write-bundle-manifest.test.ts` drives the real handshake and asserts the
 *    two agree, so the marker cannot advertise a version the client does not.
 *
 * ## `release`
 *
 * States whether the tree was produced by the release process rather than left
 * behind by a developer build or committed for `//go:embed`'s benefit. Its one
 * source is `WUI_BUNDLE_RELEASE=1`, set by `make release-dist` and by nothing
 * else; that target reads the claim back out of the installed tree before the
 * release commit is allowed to exist. It is a
 * present `false`, never an omission: a consumer that gates on it must be able
 * to tell "this bundle says it is not a release" from "this bundle predates the
 * marker", and only `wui.BundleProtocolVersion` returning an error says the
 * latter.
 */

/** The manifest's filename inside the bundle directory. Also `bundleManifestPath` in `bundle.go`. */
export const BUNDLE_MANIFEST_NAME = "looprig-bundle.json";

/** This repository's root, so the CLI needs no argument in the ordinary case. */
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The bundle directory `vite.config.ts`'s `build.outDir` writes and `assets.go` embeds. */
export const DIST_DIR = join(REPOSITORY_ROOT, "dist");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Reads the three versions from the files that own them.
 *
 * @param {string} repository Repository root to read from.
 * @returns {{ coreVersion: string, protocolVersion: string, sessionwireVersion: number }}
 */
export function readBundleInputs(repository = REPOSITORY_ROOT) {
  const coreVersion = readFileSync(join(repository, "contract", "VERSION"), "utf8").trim();
  const protocolVersion = readJson(join(repository, "packages", "protocol", "package.json")).version;
  const schema = readJson(
    join(repository, "contract", "schema", "version_negotiation_response.schema.json"),
  );
  const sessionwireVersion = schema?.properties?.version?.const;
  if (typeof sessionwireVersion !== "number") {
    // A schema that constrains the field without pinning it (a `type`, an
    // `enum`, a `$ref`) leaves no single supported sessionwire version to
    // advertise. Emitting `undefined`, or falling back to a literal 1, would
    // publish a claim nothing checked.
    throw new Error(
      "sessionwire version is not pinned by contract/schema/version_negotiation_response.schema.json",
    );
  }
  return { coreVersion, protocolVersion, sessionwireVersion };
}

/**
 * Validates the inputs and shapes them into the manifest object.
 *
 * @param {{ release: boolean, coreVersion: string, protocolVersion: string, sessionwireVersion: number }} inputs
 * @returns {{ core_version: string, protocol_version: string, release: boolean, sessionwire_version: number }}
 */
export function buildBundleManifest(inputs) {
  const { release, coreVersion, protocolVersion, sessionwireVersion } = inputs;
  if (typeof release !== "boolean") {
    throw new TypeError(`bundle manifest release flag must be a boolean, got ${typeof release}`);
  }
  if (typeof coreVersion !== "string" || coreVersion === "") {
    throw new TypeError("bundle manifest core version must be a non-empty string");
  }
  if (typeof protocolVersion !== "string" || protocolVersion === "") {
    throw new TypeError("bundle manifest protocol version must be a non-empty string");
  }
  if (!Number.isInteger(sessionwireVersion) || sessionwireVersion < 1) {
    // Zero is the value a Go `int` field takes when a key is absent, so it is
    // the shape an empty marker arrives in. Refusing to WRITE it keeps the
    // reader's rejection of it unambiguous.
    throw new TypeError(
      `bundle manifest sessionwire version must be a positive integer, got ${sessionwireVersion}`,
    );
  }
  // Key order is alphabetical and fixed so a re-emitted manifest is byte-stable
  // and a release diff shows a version change rather than a reordering.
  return {
    core_version: coreVersion,
    protocol_version: protocolVersion,
    release,
    sessionwire_version: sessionwireVersion,
  };
}

/**
 * Writes the manifest into a bundle directory.
 *
 * @param {string} directory Bundle directory to write into (defaults to `dist/`).
 * @param {{ release?: boolean, repository?: string }} options
 * @returns {{ core_version: string, protocol_version: string, release: boolean, sessionwire_version: number }}
 */
export function writeBundleManifest(directory = DIST_DIR, options = {}) {
  const { release = false, repository = REPOSITORY_ROOT } = options;
  const manifest = buildBundleManifest({ release, ...readBundleInputs(repository) });
  writeFileSync(join(directory, BUNDLE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const args = process.argv.slice(2);
  const release = args.includes("--release");
  const directory = args.find((argument) => !argument.startsWith("--")) ?? DIST_DIR;
  const manifest = writeBundleManifest(directory, { release });
  console.log(`${join(directory, BUNDLE_MANIFEST_NAME)}: ${JSON.stringify(manifest)}`);
}
