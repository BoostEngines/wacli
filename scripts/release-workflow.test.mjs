import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveNames,
  assertCodeSignatureIdentity,
  assertExactInventory,
  assertGoBuildInfo,
  crossPlatformArchiveNames,
  parseChecksums,
  releaseArchiveTarget,
  releaseAssetNames,
  releaseManifestDigest,
  verifyDarwinSignature,
} from "./release-common.mjs";
import {
  validateCrossPlatformControlPlane,
  validateCrossPlatformProvenance,
} from "./download-cross-platform-assets.mjs";
import { writeCrossPlatformProvenance } from "./collect-cross-platform-assets.mjs";
import { validateDraftMetadata } from "./download-release-candidate.mjs";
import {
  classifyGovulncheckEvents,
  formatGateResult,
  parseJsonStream,
} from "./govulncheck-stdlib.mjs";
import {
  assertSigningInputs,
  createAndPushSignedTag,
  createDraftRelease,
  dispatchHomebrewHandoff,
  findExactDraftRelease,
  prepareDarwinRelease,
  publishDraftRelease,
  validateGitHubSignedTag,
  validateHomebrewFormula,
  validateHomebrewRelease,
  validateHomebrewRun,
  validateVerifierJobs,
  validateVerifierRun,
} from "./release-local.mjs";

const releaseBuilds = fs.readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const releaseVerify = fs.readFileSync(
  new URL("../.github/workflows/release-verify.yml", import.meta.url),
  "utf8",
);
const releaseLocal = fs.readFileSync(new URL("release-local.mjs", import.meta.url), "utf8");
const crossDownload = fs.readFileSync(
  new URL("download-cross-platform-assets.mjs", import.meta.url),
  "utf8",
);
const crossCollector = fs.readFileSync(
  new URL("collect-cross-platform-assets.mjs", import.meta.url),
  "utf8",
);
const releaseCandidateVerifier = fs.readFileSync(
  new URL("verify-release-candidate.mjs", import.meta.url),
  "utf8",
);

const tag = "v0.12.1";
const version = "0.12.1";
const commit = "a".repeat(40);
const verifierHead = "b".repeat(40);
const expectedBody = "## Changelog\n\n### Security\n\n- Harden release.\n";

function validDisplay(overrides = {}) {
  return [
    `Identifier=${overrides.identifier ?? "org.openclaw.wacli"}`,
    `TeamIdentifier=${overrides.team ?? "FWJYW4S8P8"}`,
    `Authority=Developer ID Application: OpenClaw Foundation (${overrides.team ?? "FWJYW4S8P8"})`,
    "Authority=Developer ID Certification Authority",
    "CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=2+7 location=embedded",
    "Timestamp=9 Jul 2026 at 12:00:00",
  ].join("\n");
}

function validRequirement(team = "FWJYW4S8P8") {
  return (
    'designated => identifier "org.openclaw.wacli" and anchor apple generic and ' +
    `certificate leaf[subject.OU] = "${team}"`
  );
}

test("credential-free release builds are manual, protected-ref, and non-publishing", () => {
  assert.match(releaseBuilds, /^name: release-builds$/m);
  assert.match(releaseBuilds, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(releaseBuilds, /^  push:$/m);
  assert.match(releaseBuilds, /github\.ref == format\('refs\/heads\/\{0\}'/);
  assert.match(
    releaseBuilds,
    /github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/release\.yml@refs\/heads\/\{1\}'/,
  );
  assert.match(releaseBuilds, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(releaseBuilds, /git -C trusted rev-parse HEAD.*TRUSTED_WORKFLOW_SHA/);
  assert.match(releaseBuilds, /persist-credentials: false/);
  assert.match(releaseBuilds, /env -i[\s\S]*goreleaser release --clean --skip=publish/);
  assert.match(releaseBuilds, /--workflow-ref "\$GITHUB_WORKFLOW_REF"/);
  assert.match(releaseBuilds, /--workflow-sha "\$GITHUB_SHA"/);
  assert.match(releaseBuilds, /--run-id "\$GITHUB_RUN_ID"/);
  assert.doesNotMatch(releaseBuilds, /contents: write|gh release (?:create|upload)|secrets\./);
});

test("native verifier is protected-main and drops tokens before candidate verification", () => {
  assert.match(releaseVerify, /^name: release-verify$/m);
  assert.match(releaseVerify, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(releaseVerify, /^  push:$/m);
  assert.match(releaseVerify, /github\.ref == format\('refs\/heads\/\{0\}'/);
  assert.match(
    releaseVerify,
    /github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/release-verify\.yml@refs\/heads\/\{1\}'/,
  );
  assert.match(releaseVerify, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(releaseVerify, /git rev-parse HEAD.*TRUSTED_WORKFLOW_SHA/);
  assert.doesNotMatch(releaseVerify, /ref: \$\{\{ inputs\./);
  assert.match(releaseVerify, /native-darwin-verifier:[\s\S]*?permissions:\n\s+contents: write/);
  assert.equal((releaseVerify.match(/GH_TOKEN:/g) ?? []).length, 1);
  assert.match(releaseVerify, /arch: arm64[\s\S]*runner: macos-15/);
  assert.match(releaseVerify, /arch: x86_64[\s\S]*runner: macos-15-intel/);
  assert.match(
    releaseVerify,
    /name: Verify candidate with no token or release credential[\s\S]*VERIFY_ARCH: \$\{\{ matrix\.arch \}\}[\s\S]*--host-arch "\$VERIFY_ARCH"/,
  );
  assert.match(
    releaseVerify,
    /name: Verify candidate with no token or release credential[\s\S]*?env -i[\s\S]*?verify-release-candidate\.mjs/,
  );
  assert.doesNotMatch(releaseVerify, /secrets\.|gh release (?:create|upload)/);
  assert.match(
    releaseCandidateVerifier,
    /const hostArch = combinedOutput[\s\S]*const tempDir = fs\.mkdtempSync[\s\S]*return \{[\s\S]*hostArch,/,
  );
});

test("binary build info is bound to the exact clean candidate commit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wacli-build-info-test-"));
  const binary = path.join(directory, "wacli");
  fs.writeFileSync(binary, `prefix\0wacli-release-linker-version=[${version}]\0suffix`);
  const buildInfo = {
    GoVersion: "go1.25.12",
    Path: "github.com/openclaw/wacli/cmd/wacli",
    Settings: [
      { Key: "-tags", Value: "sqlite_fts5" },
      { Key: "CGO_ENABLED", Value: "1" },
      { Key: "GOARCH", Value: "arm64" },
      { Key: "GOOS", Value: "darwin" },
      { Key: "vcs.revision", Value: commit },
      { Key: "vcs.modified", Value: "false" },
    ],
  };
  const runWithInfo = (info) => (_command, args) => {
    assert.deepEqual(args, ["version", "-m", "-json", binary]);
    return { stdout: JSON.stringify(info), stderr: "" };
  };
  try {
    assert.doesNotThrow(() =>
      assertGoBuildInfo(binary, version, {
        run: runWithInfo(buildInfo),
        commit,
        expectedGoos: "darwin",
        expectedGoarch: "arm64",
      }),
    );
    assert.throws(
      () =>
        assertGoBuildInfo(binary, version, {
          run: runWithInfo(buildInfo),
          commit: "b".repeat(40),
          expectedGoos: "darwin",
          expectedGoarch: "arm64",
        }),
      /was not built from release commit/,
    );
    assert.throws(
      () =>
        assertGoBuildInfo(binary, version, {
          run: runWithInfo(buildInfo),
          commit,
          expectedGoos: "linux",
          expectedGoarch: "arm64",
        }),
      /target mismatch/,
    );
    assert.throws(
      () =>
        assertGoBuildInfo(binary, version, {
          run: runWithInfo({ ...buildInfo, GoVersion: "go1.25.120" }),
          commit,
          expectedGoos: "darwin",
          expectedGoarch: "arm64",
        }),
      /not go1\.25\.12/,
    );
    fs.writeFileSync(binary, "wacli-release-linker-version=[0.12.10]");
    assert.throws(
      () =>
        assertGoBuildInfo(binary, version, {
          run: runWithInfo(buildInfo),
          commit,
          expectedGoos: "darwin",
          expectedGoarch: "arm64",
        }),
      /one exact release linker setting/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("missing notary profile fails before any release command", () => {
  const calls = [];
  assert.throws(
    () =>
      prepareDarwinRelease({
        tag,
        commit,
        crossPlatformDir: "/unused",
        outputDir: "/unused",
        platform: "darwin",
        env: { MAC_RELEASE_CODESIGN_IDENTITY: "identity" },
        run: (...args) => calls.push(args),
      }),
    /NOTARYTOOL_KEYCHAIN_PROFILE/,
  );
  assert.deepEqual(calls, []);
  assert.throws(() => assertSigningInputs({}), /NOTARYTOOL_KEYCHAIN_PROFILE/);
});

test("official preparation rejects release tokens before any command", () => {
  const calls = [];
  assert.throws(
    () =>
      prepareDarwinRelease({
        tag,
        commit,
        crossPlatformDir: "/unused",
        crossPlatformManifest: "a".repeat(64),
        outputDir: "/unused",
        platform: "darwin",
        env: {
          GH_TOKEN: "redacted",
          MAC_RELEASE_CODESIGN_IDENTITY: "identity",
          NOTARYTOOL_KEYCHAIN_PROFILE: "profile",
        },
        run: (...args) => calls.push(args),
      }),
    /credential-bearing environment: GH_TOKEN/,
  );
  assert.deepEqual(calls, []);
});

test("wrong signing identity is rejected", () => {
  assert.throws(
    () => assertCodeSignatureIdentity(validDisplay({ team: "WRONGTEAM1" }), validRequirement("WRONGTEAM1")),
    /wrong signing team/,
  );
});

test("embedded designated requirement must match exactly", () => {
  assert.throws(
    () =>
      assertCodeSignatureIdentity(
        validDisplay(),
        `${validRequirement()} and certificate leaf[subject.CN] = "unexpected"`,
      ),
    /embedded designated requirement mismatch/,
  );
});

test("standalone CLI requires online notarization without raw spctl assessment", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (["spctl", "syspolicy_check", "stapler"].includes(command)) {
      throw new Error(`standalone CLI verifier must not call ${command}`);
    }
    if (command === "codesign" && args.includes("--display") && args.includes("--requirements")) {
      return { stdout: validRequirement(), stderr: "" };
    }
    if (command === "codesign" && args.includes("--display")) {
      return { stdout: "", stderr: validDisplay() };
    }
    return { stdout: "", stderr: "" };
  };
  assert.doesNotThrow(() => verifyDarwinSignature("/tmp/wacli", { run }));
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "codesign" &&
        args.join(" ") === "--verify --strict --check-notarization -R=notarized /tmp/wacli",
    ),
  );
  assert.ok(!calls.some(([command]) => ["spctl", "syspolicy_check", "stapler"].includes(command)));
});

test("failed online notarization constraint is rejected", () => {
  const run = (command, args) => {
    if (command === "codesign" && args.includes("--display") && args.includes("--requirements")) {
      return { stdout: validRequirement(), stderr: "" };
    }
    if (command === "codesign" && args.includes("--display")) {
      return { stdout: "", stderr: validDisplay() };
    }
    if (command === "codesign" && args.includes("-R=notarized")) {
      throw new Error("online notarization constraint failed");
    }
    return { stdout: "", stderr: "" };
  };
  assert.throws(() => verifyDarwinSignature("/tmp/wacli", { run }), /constraint failed/);
});

test("universal signature metadata is inspected independently for both slices", () => {
  const displayArches = [];
  const run = (command, args) => {
    if (command === "codesign" && args.includes("--display") && args.includes("--requirements")) {
      return { stdout: validRequirement(), stderr: "" };
    }
    if (command === "codesign" && args.includes("--display")) {
      displayArches.push(args[args.indexOf("--arch") + 1]);
      return { stdout: "", stderr: validDisplay() };
    }
    return { stdout: "", stderr: "" };
  };
  verifyDarwinSignature("/tmp/wacli-universal", { run, arch: "x86_64" });
  verifyDarwinSignature("/tmp/wacli-universal", { run, arch: "arm64" });
  assert.deepEqual(displayArches.sort(), ["arm64", "x86_64"]);
});

test("malformed release and checksum inventories fail closed", () => {
  assert.throws(
    () => assertExactInventory(["checksums.txt", "extra"], releaseAssetNames(version), "asset"),
    /inventory mismatch/,
  );
  const badChecksums = archiveNames(version)
    .map((name, index) => `${"a".repeat(64)}  ${index === 0 ? "../escape" : name}`)
    .join("\n");
  assert.throws(() => parseChecksums(badChecksums, archiveNames(version)), /malformed checksums/);
});

test("every release archive name has an exact GOOS and GOARCH contract", () => {
  assert.deepEqual(
    archiveNames(version).map((name) => [name, releaseArchiveTarget(name, version)]),
    [
      [`wacli_${version}_darwin_amd64.tar.gz`, { goos: "darwin", goarch: "amd64" }],
      [`wacli_${version}_darwin_arm64.tar.gz`, { goos: "darwin", goarch: "arm64" }],
      [`wacli_${version}_darwin_universal.tar.gz`, { goos: "darwin", goarch: "universal" }],
      [`wacli_${version}_linux_amd64.tar.gz`, { goos: "linux", goarch: "amd64" }],
      [`wacli_${version}_linux_arm64.tar.gz`, { goos: "linux", goarch: "arm64" }],
      [`wacli_${version}_windows_amd64.zip`, { goos: "windows", goarch: "amd64" }],
    ],
  );
  assert.match(releaseCandidateVerifier, /const target = releaseArchiveTarget\(archiveName, version\)/);
  assert.match(crossCollector, /const target = releaseArchiveTarget\(name, version\)/);
});

test("stdlib gate uses reachable findings and keeps third-party findings visible", () => {
  const events = parseJsonStream(
    [
      { osv: { id: "GO-2026-5856", summary: "stdlib advisory without a reachable finding" } },
      { osv: { id: "GO-THIRD-PARTY", summary: "active dependency advisory" } },
      { finding: { osv: "GO-THIRD-PARTY", trace: [{ module: "example.com/dependency" }] } },
    ]
      .map((event) => JSON.stringify(event, null, 2))
      .join("\n"),
  );
  const result = classifyGovulncheckEvents(events);
  assert.deepEqual(result.stdlib, []);
  assert.deepEqual(result.thirdParty.map((finding) => finding.id), ["GO-THIRD-PARTY"]);
  assert.match(formatGateResult(result), /remain reported and unsuppressed: GO-THIRD-PARTY/);
  assert.match(formatGateResult(result), /no reachable standard-library vulnerabilities/);

  const reachableStdlib = classifyGovulncheckEvents([
    { osv: { id: "GO-STDLIB", summary: "reachable stdlib advisory" } },
    {
      finding: {
        osv: "GO-STDLIB",
        trace: [{ module: "stdlib", version: "go1.25.11", package: "crypto/tls", function: "Conn.Handshake" }],
      },
    },
  ]);
  assert.deepEqual(reachableStdlib.stdlib.map((finding) => finding.id), ["GO-STDLIB"]);
});

test("cross-platform artifact control-plane coordinates fail closed", () => {
  const repository = { id: 1, full_name: "openclaw/wacli", default_branch: "main" };
  const protectedBranch = {
    name: "main",
    protected: true,
    commit: { sha: verifierHead },
  };
  const workflow = { id: 12, path: ".github/workflows/release.yml", state: "active" };
  const workflowRun = {
    id: 123,
    workflow_id: 12,
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    display_title: `release-builds commit=${commit} version=${version}`,
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: verifierHead,
    head_repository: { full_name: "openclaw/wacli" },
  };
  const artifact = {
    id: 456,
    name: `wacli-${version}-cross-${commit}`,
    expired: false,
    size_in_bytes: 123,
    digest: `sha256:${"d".repeat(64)}`,
    workflow_run: { id: 123, head_sha: verifierHead },
  };
  const options = {
    repository,
    protectedBranch,
    workflow,
    workflowRun,
    artifact,
    runId: 123,
    artifactId: 456,
    workflowSha: verifierHead,
    commit,
    version,
  };
  assert.doesNotThrow(() => validateCrossPlatformControlPlane(options));
  assert.throws(
    () =>
      validateCrossPlatformControlPlane({
        ...options,
        workflowRun: { ...workflowRun, path: ".github/workflows/untrusted.yml" },
      }),
    /workflow run provenance mismatch/,
  );
  assert.throws(
    () =>
      validateCrossPlatformControlPlane({
        ...options,
        workflowRun: { ...workflowRun, display_title: "release-builds commit=wrong version=9.9.9" },
      }),
    /workflow run provenance mismatch/,
  );
  assert.throws(
    () =>
      validateCrossPlatformControlPlane({
        ...options,
        artifact: { ...artifact, name: "wrong" },
      }),
    /artifact identity mismatch/,
  );
  assert.throws(
    () =>
      validateCrossPlatformControlPlane({
        ...options,
        protectedBranch: { ...protectedBranch, protected: false },
      }),
    /not a protected default branch/,
  );
  assert.throws(
    () =>
      validateCrossPlatformControlPlane({
        ...options,
        artifact: { ...artifact, digest: null },
      }),
    /exact SHA-256 digest/,
  );
});

test("cross-platform provenance binds dispatch inputs and asset digests", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wacli-cross-provenance-test-"));
  try {
    for (const name of crossPlatformArchiveNames(version)) {
      fs.writeFileSync(path.join(directory, name), name);
    }
    const provenance = writeCrossPlatformProvenance({
      outputDir: directory,
      version,
      commit,
      repository: "openclaw/wacli",
      workflowPath: ".github/workflows/release.yml",
      workflowRef: "openclaw/wacli/.github/workflows/release.yml@refs/heads/main",
      workflowSha: verifierHead,
      runId: 123,
      runAttempt: 2,
      event: "workflow_dispatch",
      ref: "refs/heads/main",
    });
    assert.doesNotThrow(() =>
      validateCrossPlatformProvenance(provenance, {
        sourceDir: directory,
        version,
        commit,
        workflowSha: verifierHead,
        runId: 123,
        runAttempt: 2,
        defaultBranch: "main",
      }),
    );
    assert.throws(
      () =>
        validateCrossPlatformProvenance(
          { ...provenance, inputs: { ...provenance.inputs, version: "9.9.9" } },
          {
            sourceDir: directory,
            version,
            commit,
            workflowSha: verifierHead,
            runId: 123,
            runAttempt: 2,
            defaultBranch: "main",
          },
        ),
      /provenance manifest mismatch/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.match(releaseLocal, /cross-platform-manifest-sha256/);
  assert.doesNotMatch(crossDownload, /"--method",\s*"(?:POST|PATCH|DELETE)"/);
});

test("exact draft metadata rejects extra or partially uploaded assets", () => {
  const assets = releaseAssetNames(version).map((name, index) => ({
    id: index + 1,
    name,
    size: 1,
    state: "uploaded",
  }));
  const metadata = {
    id: 42,
    tag_name: tag,
    target_commitish: commit,
    name: `wacli ${tag}`,
    body: expectedBody,
    draft: true,
    prerelease: false,
    published_at: null,
    assets,
  };
  assert.doesNotThrow(() =>
    validateDraftMetadata(metadata, { releaseId: 42, tag, commit, version, expectedBody }),
  );
  assert.throws(
    () =>
      validateDraftMetadata(
        { ...metadata, assets: [...assets, { id: 99, name: "extra", size: 1, state: "uploaded" }] },
        { releaseId: 42, tag, commit, version, expectedBody },
      ),
    /inventory mismatch/,
  );
  assert.throws(
    () =>
      validateDraftMetadata(
        { ...metadata, assets: assets.map((asset, index) => (index ? asset : { ...asset, state: "new" })) },
        { releaseId: 42, tag, commit, version, expectedBody },
      ),
    /not fully uploaded/,
  );
  assert.throws(
    () =>
      validateDraftMetadata(
        { ...metadata, body: "stale notes" },
        { releaseId: 42, tag, commit, version, expectedBody },
      ),
    /release notes do not match/,
  );
});

test("failed local verification cannot create even a draft", () => {
  const calls = [];
  assert.throws(
    () =>
      createDraftRelease({
        tag,
        commit,
        candidateDir: "/unused",
        verify: () => {
          throw new Error("ticket failed");
        },
        run: (...args) => calls.push(args),
      }),
    /ticket failed/,
  );
  assert.deepEqual(calls, []);
});

test("signed tag creation cannot start before local candidate verification", () => {
  const calls = [];
  assert.throws(
    () =>
      createAndPushSignedTag({
        tag,
        commit,
        candidateDir: "/unused",
        confirm: tag,
        verify: () => {
          throw new Error("candidate failed");
        },
        run: (...args) => calls.push(args),
      }),
    /candidate failed/,
  );
  assert.deepEqual(calls, []);
});

test("draft creation requires the exact signed remote tag", () => {
  const calls = [];
  assert.throws(
    () =>
      createDraftRelease({
        tag,
        commit,
        candidateDir: "/unused",
        verify: () => {},
        verifyTag: () => {
          throw new Error("signed tag missing");
        },
        run: (...args) => calls.push(args),
      }),
    /signed tag missing/,
  );
  assert.deepEqual(calls, []);
  assert.match(releaseLocal, /"--draft",\s*"--verify-tag"/);
});

test("failed draft upload rolls back only the exact partial draft", () => {
  const calls = [];
  let releaseEnumerations = 0;
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "git" && args.includes("ls-remote")) return { status: 0, stdout: "", stderr: "" };
    if (command === "git" && args.includes("show")) {
      return {
        status: 0,
        stdout: "# Changelog\n\n## 0.12.1 - 2026-07-09\n\n### Security\n\n- Harden release.\n",
        stderr: "",
      };
    }
    if (command === "gh" && args[0] === "release") throw new Error("upload failed");
    if (
      command === "gh" &&
      args.some((arg) => arg.startsWith("/repos/openclaw/wacli/releases?per_page=100&page="))
    ) {
      releaseEnumerations += 1;
      if (releaseEnumerations === 1) return { status: 0, stdout: "[]", stderr: "" };
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            id: 42,
            draft: true,
            tag_name: tag,
            target_commitish: commit,
          },
        ]),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.throws(
    () =>
      createDraftRelease({
        tag,
        commit,
        candidateDir: "/unused",
        verify: () => {},
        verifyTag: () => {},
        run,
      }),
    /upload failed/,
  );
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "gh" &&
        args.join(" ") === "api --method DELETE /repos/openclaw/wacli/releases/42",
    ),
  );
  assert.ok(!calls.some(([, args]) => args.includes("PATCH")));
});

test("draft enumeration rejects ambiguous authenticated matches", () => {
  const run = () => ({
    status: 0,
    stdout: JSON.stringify([
      { id: 41, tag_name: tag, draft: true },
      { id: 42, tag_name: tag, draft: true },
    ]),
    stderr: "",
  });
  assert.throws(() => findExactDraftRelease(tag, run), /exactly one authenticated draft/);
  assert.doesNotMatch(releaseLocal.slice(0, releaseLocal.indexOf("export function dispatchHomebrewHandoff")),
    /releases\/tags\/\$\{options\.tag\}/,
  );
});

test("publication accepts GitHub's embedded-signature tag message and rejects unsigned tags", () => {
  const tagObjectSha = "d".repeat(40);
  const tagRef = {
    ref: `refs/tags/${tag}`,
    object: { type: "tag", sha: tagObjectSha },
  };
  const signature = "-----BEGIN SSH SIGNATURE-----\nsigned\n-----END SSH SIGNATURE-----";
  const tagObject = {
    sha: tagObjectSha,
    tag,
    message: `wacli ${version}\n${signature}\n`,
    object: { type: "commit", sha: commit },
    verification: { verified: true, reason: "valid", signature },
  };
  assert.doesNotThrow(() =>
    validateGitHubSignedTag({ tag, commit, tagObjectSha, tagRef, tagObject }),
  );
  assert.throws(
    () =>
      validateGitHubSignedTag({
        tag,
        commit,
        tagObjectSha,
        tagRef,
        tagObject: { ...tagObject, message: `wacli ${version}` },
      }),
    /signed annotated release tag/,
  );
  assert.throws(
    () =>
      validateGitHubSignedTag({
        tag,
        commit,
        tagObjectSha,
        tagRef: { ...tagRef, object: { type: "commit", sha: commit } },
        tagObject,
      }),
    /signed annotated release tag/,
  );
  assert.throws(
    () =>
      validateGitHubSignedTag({
        tag,
        commit,
        tagObjectSha,
        tagRef,
        tagObject: { ...tagObject, verification: { verified: false, reason: "unsigned" } },
      }),
    /signed annotated release tag/,
  );
  assert.match(releaseLocal, /\["tag", "--sign", "--annotate", "--message"/);
  const publishSource = releaseLocal.slice(
    releaseLocal.indexOf("export function publishDraftRelease"),
    releaseLocal.indexOf("export function validateHomebrewRelease"),
  );
  assert.ok(
    publishSource.indexOf("verifyGitHubSignedReleaseTag") < publishSource.indexOf('"PATCH"'),
    "signed tag verification must precede publication",
  );
});

test("stale verifier evidence cannot publish a draft", () => {
  const assets = releaseAssetNames(version).map((name, index) => ({
    id: index + 1,
    name,
    size: 1,
    state: "uploaded",
  }));
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "git" && args.includes("show")) {
      return {
        status: 0,
        stdout: "# Changelog\n\n## 0.12.1 - 2026-07-09\n\n### Security\n\n- Harden release.\n",
        stderr: "",
      };
    }
    if (args.includes(`/repos/openclaw/wacli/releases/42`)) {
      return {
        status: 0,
        stdout: JSON.stringify({
          id: 42,
          tag_name: tag,
          target_commitish: commit,
          name: `wacli ${tag}`,
          body: expectedBody,
          draft: true,
          prerelease: false,
          published_at: null,
          assets,
        }),
        stderr: "",
      };
    }
    if (args.includes("/repos/openclaw/wacli")) {
      return {
        status: 0,
        stdout: JSON.stringify({ full_name: "openclaw/wacli", default_branch: "main" }),
        stderr: "",
      };
    }
    if (args.includes("/repos/openclaw/wacli/actions/workflows/release-verify.yml")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          id: 7,
          path: ".github/workflows/release-verify.yml",
          state: "active",
        }),
        stderr: "",
      };
    }
    if (args.includes("/repos/openclaw/wacli/branches/main")) {
      return {
        status: 0,
        stdout: JSON.stringify({ name: "main", protected: true, commit: { sha: verifierHead } }),
        stderr: "",
      };
    }
    if (args.includes("/repos/openclaw/wacli/actions/runs/99")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          id: 99,
          workflow_id: 7,
          path: ".github/workflows/release-verify.yml",
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          head_sha: verifierHead,
          head_repository: { full_name: "openclaw/wacli" },
        }),
        stderr: "",
      };
    }
    if (args.includes("/repos/openclaw/wacli/actions/runs/99/jobs?filter=latest&per_page=100")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          jobs: [
            {
              id: 100,
              name: "native-darwin-arm64",
              status: "completed",
              conclusion: "success",
              labels: ["macos-15"],
            },
            {
              id: 101,
              name: "native-darwin-x86_64",
              status: "completed",
              conclusion: "success",
              labels: ["macos-15-intel"],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (command === "gh" && args[0] === "run" && args.includes("--log")) {
      return { status: 0, stdout: "VERIFIED stale candidate", stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  assert.throws(
    () =>
      publishDraftRelease({
        releaseId: 42,
        tag,
        commit,
        verifierRun: 99,
        verifierHead,
        confirm: tag,
        vmConfirm: tag,
        run,
      }),
    /exact arm64 candidate marker/,
  );
  assert.ok(!calls.some(([, args]) => args.includes("PATCH")));
});

test("local mutation path is draft-first and publication needs explicit confirmation", () => {
  assert.match(releaseLocal, /"release",\s*"create",[\s\S]*?"--draft"/);
  assert.match(releaseLocal, /options\.confirm !== options\.tag/);
  assert.match(releaseLocal, /options\.vmConfirm !== options\.tag/);
  assert.match(releaseLocal, /actions\/workflows\/release-verify\.yml/);
  assert.match(releaseLocal, /workflowRun\.head_sha !== verifierHead/);
  assert.doesNotMatch(releaseLocal, /workflowName|headBranch/);
});

test("publication authenticates verifier workflow path, ID, and exact head SHA", () => {
  const repository = { full_name: "openclaw/wacli", default_branch: "main" };
  const protectedBranch = { name: "main", protected: true, commit: { sha: verifierHead } };
  const workflow = { id: 7, path: ".github/workflows/release-verify.yml", state: "active" };
  const workflowRun = {
    id: 99,
    workflow_id: 7,
    path: ".github/workflows/release-verify.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: verifierHead,
    head_repository: { full_name: "openclaw/wacli" },
  };
  assert.doesNotThrow(() =>
    validateVerifierRun({
      repository,
      protectedBranch,
      workflow,
      workflowRun,
      runId: 99,
      verifierHead,
    }),
  );
  assert.throws(
    () =>
      validateVerifierRun({
        repository,
        protectedBranch,
        workflow,
        workflowRun: { ...workflowRun, workflow_id: 8 },
        runId: 99,
        verifierHead,
      }),
    /exact release-verify workflow/,
  );
  assert.throws(
    () =>
      validateVerifierRun({
        repository,
        protectedBranch,
        workflow,
        workflowRun: { ...workflowRun, path: ".github/workflows/other.yml" },
        runId: 99,
        verifierHead,
      }),
    /exact release-verify workflow/,
  );
  assert.throws(
    () =>
      validateVerifierRun({
        repository,
        protectedBranch,
        workflow,
        workflowRun: { ...workflowRun, head_sha: "c".repeat(40) },
        runId: 99,
        verifierHead,
      }),
    /exact protected-default/,
  );
  assert.throws(
    () =>
      validateVerifierRun({
        repository,
        protectedBranch: {
          ...protectedBranch,
          commit: { sha: "c".repeat(40) },
        },
        workflow,
        workflowRun,
        runId: 99,
        verifierHead,
      }),
    /current protected default-branch/,
  );
});

test("publication authenticates separate native verifier jobs and runner architectures", () => {
  const jobs = [
    {
      id: 100,
      name: "native-darwin-arm64",
      status: "completed",
      conclusion: "success",
      labels: ["macos-15"],
    },
    {
      id: 101,
      name: "native-darwin-x86_64",
      status: "completed",
      conclusion: "success",
      labels: ["macos-15-intel"],
    },
  ];
  assert.deepEqual([...validateVerifierJobs(jobs).keys()], ["arm64", "x86_64"]);
  assert.throws(
    () => validateVerifierJobs(jobs.map((job, index) => (index ? job : { ...job, labels: ["macos-15-intel"] }))),
    /native arm64 verifier job identity/,
  );
  assert.match(releaseLocal, /--job[\s\S]*String\(verifierJobs\.get\(arch\)\.id\)/);
  assert.match(releaseLocal, /native \$\{arch\} verifier job emitted the \$\{otherArch\} marker/);
});

test("publication cannot start before explicit clean-VM Gatekeeper proof", () => {
  const calls = [];
  assert.throws(
    () =>
      publishDraftRelease({
        releaseId: 42,
        tag,
        commit,
        verifierRun: 99,
        confirm: tag,
        run: (...args) => calls.push(args),
      }),
    /naturally quarantined clean-VM no-alert proof/,
  );
  assert.deepEqual(calls, []);
});

test("Homebrew handoff binds the public release ID, manifest, inventory, and prerelease state", () => {
  const assets = releaseAssetNames(version).map((name, index) => ({
    id: index + 1,
    name,
    size: index + 10,
    state: "uploaded",
    digest: `sha256:${String(index + 1).padStart(64, "0")}`,
  }));
  const release = {
    id: 42,
    tag_name: tag,
    target_commitish: commit,
    name: `wacli ${tag}`,
    body: expectedBody,
    draft: false,
    prerelease: false,
    published_at: "2026-07-09T12:00:00Z",
    assets,
  };
  const manifestDigest = releaseManifestDigest({ release_id: 42, tag, commit, assets });
  const options = { releaseId: 42, tag, commit, version, expectedBody, manifestDigest };
  assert.doesNotThrow(() => validateHomebrewRelease(release, options));
  assert.throws(
    () => validateHomebrewRelease({ ...release, prerelease: true }, options),
    /published, non-prerelease/,
  );
  assert.throws(
    () => validateHomebrewRelease(release, { ...options, manifestDigest: "f".repeat(64) }),
    /verified draft manifest/,
  );
  assert.throws(
    () => validateHomebrewRelease({ ...release, id: 43 }, options),
    /wrong published release ID/,
  );
  assert.doesNotMatch(releaseLocal, /releases\/tags\/\$\{options\.tag\}/);
});

test("Homebrew formula verification requires exact target URLs and checksums", () => {
  const checksums = new Map(
    archiveNames(version).map((name, index) => [name, String(index + 1).padStart(64, "0")]),
  );
  const targetLines = ["darwin_arm64", "darwin_amd64", "linux_arm64", "linux_amd64"]
    .map((target) => {
      const name = `wacli_${version}_${target}.tar.gz`;
      return (
        `      url "https://github.com/openclaw/wacli/releases/download/${tag}/${name}"\n` +
        `      sha256 "${checksums.get(name)}"`
      );
    })
    .join("\n");
  const formula = `class Wacli < Formula\n  version "${version}"\n${targetLines}\nend\n`;
  assert.doesNotThrow(() => validateHomebrewFormula(formula, { tag, checksums }));
  assert.throws(
    () =>
      validateHomebrewFormula(formula.replace(checksums.get(`wacli_${version}_darwin_arm64.tar.gz`), "f".repeat(64)), {
        tag,
        checksums,
      }),
    /checksum mismatch/,
  );
  assert.throws(
    () => validateHomebrewFormula(formula.replace(`/download/${tag}/`, "/download/v9.9.9/"), { tag, checksums }),
    /formula URL inventory mismatch/,
  );
});

test("Homebrew run authentication rejects a mutable workflow identity", () => {
  const tapHead = "e".repeat(40);
  const repository = { full_name: "openclaw/homebrew-tap", default_branch: "main" };
  const branch = { name: "main", commit: { sha: tapHead } };
  const workflow = { id: 12, path: ".github/workflows/update-formula.yml", state: "active" };
  const workflowRun = {
    id: 99,
    workflow_id: 12,
    path: ".github/workflows/update-formula.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: tapHead,
    head_repository: { full_name: "openclaw/homebrew-tap" },
  };
  assert.doesNotThrow(() =>
    validateHomebrewRun({ repository, branch, workflow, workflowRun, runId: 99 }),
  );
  assert.throws(
    () =>
      validateHomebrewRun({
        repository,
        branch,
        workflow,
        workflowRun: { ...workflowRun, path: ".github/workflows/other.yml" },
        runId: 99,
      }),
    /exact authenticated handoff workflow/,
  );
});

test("Homebrew mutation cannot start without an explicit clean-host gate", () => {
  const calls = [];
  assert.throws(
    () =>
      dispatchHomebrewHandoff({
        releaseId: 42,
        tag,
        commit,
        manifestDigest: "f".repeat(64),
        run: (...args) => calls.push(args),
      }),
    /confirm-clean-homebrew-host/,
  );
  assert.deepEqual(calls, []);
});
