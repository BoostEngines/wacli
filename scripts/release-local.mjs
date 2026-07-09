#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectCrossPlatformAssets } from "./collect-cross-platform-assets.mjs";
import {
  downloadAsset as downloadReleaseAsset,
  validateDraftMetadata,
  validatePublishedReleaseMetadata,
} from "./download-release-candidate.mjs";
import { validateAuthenticatedCrossPlatformDirectory } from "./download-cross-platform-assets.mjs";
import { extractReleaseNotes } from "./extract-release-notes.mjs";
import {
  RELEASE_DESIGNATED_REQUIREMENT,
  RELEASE_GO_TOOLCHAIN,
  RELEASE_GO_VERSION,
  RELEASE_IDENTIFIER,
  RELEASE_REPOSITORY,
  archiveNames,
  assertCommit,
  assertExactInventory,
  assertNoReleaseCredentials,
  parseChecksums,
  parseCliArgs,
  releaseAssetNames,
  releaseManifestDigest,
  runCommand,
  sanitizedExecutionEnv,
  sha256File,
  verifyChecksums,
  verifyDarwinSignature,
  versionFromTag,
} from "./release-common.mjs";
import { verifyCandidateDirectory } from "./verify-release-candidate.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const homebrewRepository = "openclaw/homebrew-tap";
const homebrewWorkflowPath = ".github/workflows/update-formula.yml";
const homebrewFormulaPath = "Formula/wacli.rb";

export function assertSigningInputs(env = process.env) {
  if (!env.NOTARYTOOL_KEYCHAIN_PROFILE) {
    throw new Error("NOTARYTOOL_KEYCHAIN_PROFILE must name the runtime notarytool profile");
  }
  if (!env.MAC_RELEASE_CODESIGN_IDENTITY) {
    throw new Error("MAC_RELEASE_CODESIGN_IDENTITY must select the Foundation Developer ID identity");
  }
}

function assertReleaseSource(version, commit, run) {
  const status = run("git", ["status", "--porcelain=v1"], { cwd: repoRoot }).stdout.trim();
  if (status) throw new Error("official release preparation requires a clean checkout");
  const head = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim();
  if (head !== commit) throw new Error(`release commit ${commit} is not checked out (HEAD is ${head})`);
  run("git", ["merge-base", "--is-ancestor", commit, "origin/main"], { cwd: repoRoot });

  const goMod = fs.readFileSync(path.join(repoRoot, "go.mod"), "utf8");
  if (!/^go 1\.25\.12$/m.test(goMod)) throw new Error("go.mod must require exact Go 1.25.12");
  const rootSource = fs.readFileSync(path.join(repoRoot, "cmd/wacli/root.go"), "utf8");
  if (!rootSource.includes(`var version = \"${version}\"`)) {
    throw new Error(`cmd/wacli/root.go does not default to ${version}`);
  }
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  if (!new RegExp(`^## ${version} - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md section ${version} must be dated before official preparation`);
  }
}

function buildDarwinBinary({ arch, version, output, run, buildEnv }) {
  const clangArch = arch === "amd64" ? "x86_64" : "arm64";
  const env = {
    ...buildEnv,
    CGO_CFLAGS: `${buildEnv.CGO_CFLAGS ?? ""} -arch ${clangArch} -Wno-error=missing-braces`.trim(),
    CGO_ENABLED: "1",
    CGO_LDFLAGS: `${buildEnv.CGO_LDFLAGS ?? ""} -arch ${clangArch}`.trim(),
    GOARCH: arch,
    GOOS: "darwin",
  };
  run(
    "go",
    [
      "build",
      "-trimpath",
      "-tags",
      "sqlite_fts5",
      "-ldflags",
      `-s -w -X main.version=${version} ` +
        `-X main.releaseLinkerSetting=wacli-release-linker-version=[${version}]`,
      "-o",
      output,
      "./cmd/wacli",
    ],
    { cwd: repoRoot, env },
  );
}

function signBinary(binary, identity, run, arches = []) {
  run("codesign", [
    "--force",
    "--sign",
    identity,
    "--identifier",
    RELEASE_IDENTIFIER,
    "--requirements",
    `=${RELEASE_DESIGNATED_REQUIREMENT}`,
    "--options",
    "runtime",
    "--timestamp",
    binary,
  ]);
  if (arches.length === 0) {
    verifyDarwinSignature(binary, { run, requireNotarization: false });
  } else {
    for (const arch of arches) {
      verifyDarwinSignature(binary, { run, arch, requireNotarization: false });
    }
  }
}

function notarizeBinaries(binaries, profile, tempRoot, run) {
  const payloadDir = path.join(tempRoot, "notary-payload");
  fs.mkdirSync(payloadDir);
  for (const [name, binary] of Object.entries(binaries)) {
    fs.copyFileSync(binary, path.join(payloadDir, name), fs.constants.COPYFILE_EXCL);
  }
  const submission = path.join(tempRoot, "wacli-notarization.zip");
  run("ditto", ["-c", "-k", "--sequesterRsrc", payloadDir, submission]);
  const result = run("xcrun", [
    "notarytool",
    "submit",
    submission,
    "--keychain-profile",
    profile,
    "--wait",
    "--output-format",
    "json",
  ]);
  const response = JSON.parse(result.stdout);
  if (response.status !== "Accepted") {
    throw new Error(`notarytool did not accept the submission (status ${response.status ?? "missing"})`);
  }
  for (const [name, binary] of Object.entries(binaries)) {
    if (name === "universal") {
      verifyDarwinSignature(binary, { run, arch: "x86_64" });
      verifyDarwinSignature(binary, { run, arch: "arm64" });
    } else {
      verifyDarwinSignature(binary, { run });
    }
  }
}

function createDarwinArchive(candidateDir, version, target, binary, run) {
  const name = `wacli_${version}_darwin_${target}.tar.gz`;
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(candidateDir), `${target}-archive-`));
  try {
    fs.copyFileSync(binary, path.join(stagingDir, "wacli"), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(path.join(repoRoot, "LICENSE"), path.join(stagingDir, "LICENSE"));
    fs.copyFileSync(path.join(repoRoot, "README.md"), path.join(stagingDir, "README.md"));
    run("tar", [
      "-czf",
      path.join(candidateDir, name),
      "-C",
      stagingDir,
      "LICENSE",
      "README.md",
      "wacli",
    ]);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function writeChecksums(candidateDir, version) {
  const lines = archiveNames(version).map((name) => `${sha256File(path.join(candidateDir, name))}  ${name}`);
  fs.writeFileSync(path.join(candidateDir, "checksums.txt"), `${lines.join("\n")}\n`, {
    flag: "wx",
    mode: 0o644,
  });
}

export function prepareDarwinRelease(options) {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  assertSigningInputs(env);
  assertNoReleaseCredentials(env);
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("official Darwin preparation must run on macOS");
  }

  const version = versionFromTag(options.tag);
  assertCommit(options.commit);
  assertReleaseSource(version, options.commit, run);

  const outputDir = path.resolve(options.outputDir);
  if (fs.existsSync(outputDir)) throw new Error(`refusing to replace existing output directory ${outputDir}`);
  const outputParent = path.dirname(outputDir);
  fs.mkdirSync(outputParent, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(outputParent, ".wacli-release-"));
  const candidateDir = path.join(tempRoot, "candidate");
  fs.mkdirSync(candidateDir);

  const buildEnv = sanitizedExecutionEnv({ GOTOOLCHAIN: RELEASE_GO_TOOLCHAIN }, env);

  try {
    const goVersion = run("go", ["env", "GOVERSION"], { cwd: repoRoot, env: buildEnv }).stdout.trim();
    if (goVersion !== RELEASE_GO_VERSION) {
      throw new Error(`official build requires ${RELEASE_GO_VERSION}, got ${goVersion}`);
    }
    run(process.execPath, [path.join(scriptDir, "govulncheck-stdlib.mjs"), "source"], {
      cwd: repoRoot,
      env: buildEnv,
      stdio: "inherit",
    });

    const crossPlatformDir = path.resolve(options.crossPlatformDir);
    validateAuthenticatedCrossPlatformDirectory({
      sourceDir: crossPlatformDir,
      version,
      commit: options.commit,
      manifestDigest: options.crossPlatformManifest,
    });
    collectCrossPlatformAssets({
      sourceDir: crossPlatformDir,
      outputDir: candidateDir,
      version,
      commit: options.commit,
      run,
      env: buildEnv,
    });

    const binariesDir = path.join(tempRoot, "darwin-binaries");
    fs.mkdirSync(binariesDir);
    const binaries = {
      amd64: path.join(binariesDir, "wacli-amd64"),
      arm64: path.join(binariesDir, "wacli-arm64"),
      universal: path.join(binariesDir, "wacli-universal"),
    };
    buildDarwinBinary({ arch: "amd64", version, output: binaries.amd64, run, buildEnv });
    buildDarwinBinary({ arch: "arm64", version, output: binaries.arm64, run, buildEnv });

    for (const binary of [binaries.amd64, binaries.arm64]) {
      run(process.execPath, [path.join(scriptDir, "govulncheck-stdlib.mjs"), "binary", binary], {
        cwd: repoRoot,
        env: buildEnv,
        stdio: "inherit",
      });
      signBinary(binary, env.MAC_RELEASE_CODESIGN_IDENTITY, run);
    }

    run("lipo", ["-create", binaries.amd64, binaries.arm64, "-output", binaries.universal]);
    signBinary(binaries.universal, env.MAC_RELEASE_CODESIGN_IDENTITY, run, ["x86_64", "arm64"]);
    notarizeBinaries(binaries, env.NOTARYTOOL_KEYCHAIN_PROFILE, tempRoot, run);

    createDarwinArchive(candidateDir, version, "amd64", binaries.amd64, run);
    createDarwinArchive(candidateDir, version, "arm64", binaries.arm64, run);
    createDarwinArchive(candidateDir, version, "universal", binaries.universal, run);
    writeChecksums(candidateDir, version);

    verifyCandidateDirectory({
      candidateDir,
      tag: options.tag,
      commit: options.commit,
      run,
    });
    fs.renameSync(candidateDir, outputDir);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  return outputDir;
}

function runLocalVerifier({ candidateDir, tag, commit }, run) {
  run(
    process.execPath,
    [
      path.join(scriptDir, "verify-release-candidate.mjs"),
      "--dir",
      path.resolve(candidateDir),
      "--tag",
      tag,
      "--commit",
      commit,
    ],
    { cwd: repoRoot, env: sanitizedExecutionEnv() },
  );
}

function releaseNotesForCommit(tag, commit, run) {
  const changelog = run("git", ["show", `${commit}:CHANGELOG.md`], { cwd: repoRoot }).stdout;
  return extractReleaseNotes(changelog, tag);
}

function releaseNotesFile(tag, commit, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wacli-release-notes-"));
  const file = path.join(tempDir, "notes.md");
  const body = releaseNotesForCommit(tag, commit, run);
  fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 });
  return { file, tempDir, body };
}

export function listAuthenticatedReleasesForTag(tag, run) {
  const matches = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`,
    ]);
    const releases = JSON.parse(response.stdout);
    if (!Array.isArray(releases)) throw new Error("GitHub release enumeration returned malformed data");
    matches.push(...releases.filter((release) => release.tag_name === tag));
    if (releases.length < 100) return matches;
  }
  throw new Error("GitHub release enumeration exceeded 100 pages");
}

export function findExactDraftRelease(tag, run, { allowAbsent = false } = {}) {
  const matches = listAuthenticatedReleasesForTag(tag, run);
  if (matches.length === 0 && allowAbsent) return null;
  if (matches.length !== 1 || matches[0].draft !== true) {
    throw new Error(`expected exactly one authenticated draft release for ${tag}`);
  }
  return matches[0];
}

export function createDraftRelease(options) {
  const run = options.run ?? runCommand;
  const verify = options.verify ?? (() => runLocalVerifier(options, run));
  const verifyTag =
    options.verifyTag ??
    (() => verifyGitHubSignedReleaseTag({ tag: options.tag, commit: options.commit, run }));
  const version = versionFromTag(options.tag);
  assertCommit(options.commit);
  verify();
  verifyTag();

  run("git", ["merge-base", "--is-ancestor", options.commit, "origin/main"], { cwd: repoRoot });
  if (listAuthenticatedReleasesForTag(options.tag, run).length > 0) {
    throw new Error(`release ${options.tag} already exists`);
  }

  const { file: notesFile, tempDir, body: expectedBody } = releaseNotesFile(
    options.tag,
    options.commit,
    run,
  );
  let createAttempted = false;
  try {
    const assets = releaseAssetNames(version).map((name) => path.join(path.resolve(options.candidateDir), name));
    createAttempted = true;
    run("gh", [
      "release",
      "create",
      options.tag,
      "--repo",
      RELEASE_REPOSITORY,
      "--draft",
      "--verify-tag",
      "--target",
      options.commit,
      "--title",
      `wacli ${options.tag}`,
      "--notes-file",
      notesFile,
      ...assets,
    ]);
  } catch (error) {
    if (createAttempted) rollbackPartialDraft(options, run);
    throw error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  try {
    const draft = findExactDraftRelease(options.tag, run);
    const response = run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${RELEASE_REPOSITORY}/releases/${draft.id}`,
    ]);
    const metadata = JSON.parse(response.stdout);
    validateDraftMetadata(metadata, {
      releaseId: draft.id,
      tag: options.tag,
      commit: options.commit,
      version,
      expectedBody,
    });
    return Number(draft.id);
  } catch (error) {
    rollbackPartialDraft(options, run);
    throw error;
  }
}

function rollbackPartialDraft(options, run) {
  const release = findExactDraftRelease(options.tag, run, { allowAbsent: true });
  if (!release) return;
  if (release.draft !== true || release.tag_name !== options.tag || release.target_commitish !== options.commit) {
    throw new Error("refusing to remove unexpected release after failed draft creation");
  }
  run("gh", ["api", "--method", "DELETE", `/repos/${RELEASE_REPOSITORY}/releases/${release.id}`]);
}

function remoteTagObjects(tag, run) {
  const response = run("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const refs = new Map();
  for (const line of response.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match || refs.has(match[2])) throw new Error(`malformed remote tag data for ${tag}`);
    refs.set(match[2], match[1]);
  }
  return refs;
}

export function verifySignedReleaseTag({ tag, commit, run = runCommand, requireRemote = true }) {
  const version = versionFromTag(tag);
  assertCommit(commit);
  const type = run("git", ["cat-file", "-t", `refs/tags/${tag}`], { cwd: repoRoot }).stdout.trim();
  if (type !== "tag") throw new Error(`${tag} is not an annotated tag object`);
  const tagObjectSha = run("git", ["rev-parse", `refs/tags/${tag}`], { cwd: repoRoot }).stdout.trim();
  const target = run("git", ["rev-parse", `${tag}^{commit}`], { cwd: repoRoot }).stdout.trim();
  if (target !== commit) throw new Error(`${tag} does not point to release commit ${commit}`);
  const subject = run(
    "git",
    ["for-each-ref", "--format=%(contents:subject)", `refs/tags/${tag}`],
    { cwd: repoRoot },
  ).stdout.trim();
  if (subject !== `wacli ${version}`) throw new Error(`${tag} has the wrong annotated tag message`);
  run("git", ["tag", "--verify", tag], { cwd: repoRoot });

  const remote = remoteTagObjects(tag, run);
  if (remote.size === 0 && !requireRemote) return tagObjectSha;
  if (
    remote.size !== 2 ||
    remote.get(`refs/tags/${tag}`) !== tagObjectSha ||
    remote.get(`refs/tags/${tag}^{}`) !== commit
  ) {
    throw new Error(`${tag} remote annotated tag object or peeled commit mismatch`);
  }
  return tagObjectSha;
}

export function createAndPushSignedTag(options) {
  const run = options.run ?? runCommand;
  const verify = options.verify ?? (() => runLocalVerifier(options, run));
  const version = versionFromTag(options.tag);
  assertCommit(options.commit);
  if (options.confirm !== options.tag) throw new Error("--confirm-signed-tag must exactly match --tag");
  verify();
  if (remoteTagObjects(options.tag, run).size !== 0) throw new Error(`remote tag ${options.tag} already exists`);
  const local = run("git", ["show-ref", "--verify", `refs/tags/${options.tag}`], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (local.status === 0) throw new Error(`local tag ${options.tag} already exists`);
  run("git", ["merge-base", "--is-ancestor", options.commit, "origin/main"], { cwd: repoRoot });
  run(
    "git",
    ["tag", "--sign", "--annotate", "--message", `wacli ${version}`, options.tag, options.commit],
    { cwd: repoRoot },
  );
  verifySignedReleaseTag({
    tag: options.tag,
    commit: options.commit,
    run,
    requireRemote: false,
  });
  run("git", ["push", "origin", `refs/tags/${options.tag}:refs/tags/${options.tag}`], {
    cwd: repoRoot,
  });
  return verifySignedReleaseTag({ tag: options.tag, commit: options.commit, run });
}

export function validateGitHubSignedTag({ tag, commit, tagObjectSha, tagRef, tagObject }) {
  const version = versionFromTag(tag);
  assertCommit(commit);
  assertCommit(tagObjectSha);
  // GitHub's Git-tag endpoint includes the embedded signature in both message and verification.signature.
  const signature = String(tagObject.verification?.signature ?? "").trimEnd();
  const expectedMessage = `wacli ${version}\n${signature}`.trimEnd();
  if (
    tagRef.ref !== `refs/tags/${tag}` ||
    tagRef.object?.type !== "tag" ||
    tagRef.object?.sha !== tagObjectSha ||
    tagObject.sha !== tagObjectSha ||
    tagObject.tag !== tag ||
    tagObject.object?.type !== "commit" ||
    tagObject.object?.sha !== commit ||
    !signature ||
    String(tagObject.message ?? "").trimEnd() !== expectedMessage ||
    tagObject.verification?.verified !== true ||
    tagObject.verification?.reason !== "valid"
  ) {
    throw new Error("GitHub signed annotated release tag verification failed");
  }
}

export function verifyGitHubSignedReleaseTag({ tag, commit, run = runCommand }) {
  const tagObjectSha = verifySignedReleaseTag({ tag, commit, run });
  const tagRef = JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${RELEASE_REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
    ]).stdout,
  );
  const tagObject = JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${RELEASE_REPOSITORY}/git/tags/${tagObjectSha}`,
    ]).stdout,
  );
  validateGitHubSignedTag({ tag, commit, tagObjectSha, tagRef, tagObject });
  return tagObjectSha;
}

const releaseVerifyWorkflowPath = ".github/workflows/release-verify.yml";

export function validateVerifierRun({
  repository,
  protectedBranch,
  workflow,
  workflowRun,
  runId,
  verifierHead,
}) {
  assertCommit(verifierHead);
  const defaultBranch = repository.default_branch;
  if (repository.full_name !== RELEASE_REPOSITORY || !defaultBranch) {
    throw new Error("could not authenticate the release repository default branch");
  }
  if (
    protectedBranch.name !== defaultBranch ||
    protectedBranch.protected !== true ||
    protectedBranch.commit?.sha !== verifierHead
  ) {
    throw new Error("verifier head is not the current protected default-branch commit");
  }
  if (
    !Number.isInteger(workflow.id) ||
    workflow.id <= 0 ||
    workflow.path !== releaseVerifyWorkflowPath ||
    workflow.state !== "active"
  ) {
    throw new Error("release verifier workflow identity mismatch");
  }
  if (
    Number(workflowRun.id) !== Number(runId) ||
    Number(workflowRun.workflow_id) !== workflow.id ||
    workflowRun.path !== releaseVerifyWorkflowPath
  ) {
    throw new Error("verifier run does not belong to the exact release-verify workflow");
  }
  if (
    workflowRun.event !== "workflow_dispatch" ||
    workflowRun.status !== "completed" ||
    workflowRun.conclusion !== "success" ||
    workflowRun.head_branch !== defaultBranch ||
    workflowRun.head_sha !== verifierHead ||
    workflowRun.head_repository?.full_name !== RELEASE_REPOSITORY
  ) {
    throw new Error("verifier run is not a successful exact protected-default workflow dispatch");
  }
}

export function validateVerifierJobs(jobs) {
  const expected = new Map([
    ["arm64", "macos-15"],
    ["x86_64", "macos-15-intel"],
  ]);
  assertExactInventory(
    jobs.map((job) => job.name),
    [...expected.keys()].map((arch) => `native-darwin-${arch}`),
    "native verifier job",
  );
  const result = new Map();
  for (const [arch, runnerLabel] of expected) {
    const job = jobs.find((candidate) => candidate.name === `native-darwin-${arch}`);
    if (
      !Number.isInteger(job.id) ||
      job.id <= 0 ||
      job.status !== "completed" ||
      job.conclusion !== "success" ||
      !Array.isArray(job.labels) ||
      !job.labels.includes(runnerLabel)
    ) {
      throw new Error(`native ${arch} verifier job identity or result mismatch`);
    }
    result.set(arch, job);
  }
  return result;
}

export function publishDraftRelease(options) {
  const run = options.run ?? runCommand;
  const version = versionFromTag(options.tag);
  assertCommit(options.commit);
  if (options.confirm !== options.tag) throw new Error("--confirm-publish must exactly match --tag");
  if (options.vmConfirm !== options.tag) {
    throw new Error(
      "--confirm-gatekeeper-vm must exactly match --tag after naturally quarantined clean-VM no-alert proof",
    );
  }
  assertCommit(options.verifierHead);
  const releaseId = Number(options.releaseId);
  const verifierRun = Number(options.verifierRun);
  if (!Number.isInteger(releaseId) || releaseId <= 0) throw new Error("invalid release ID");
  if (!Number.isInteger(verifierRun) || verifierRun <= 0) throw new Error("invalid verifier run ID");

  const release = JSON.parse(
    run("gh", ["api", "--method", "GET", `/repos/${RELEASE_REPOSITORY}/releases/${releaseId}`]).stdout,
  );
  const expectedBody = releaseNotesForCommit(options.tag, options.commit, run);
  validateDraftMetadata(release, {
    releaseId,
    tag: options.tag,
    commit: options.commit,
    version,
    expectedBody,
  });

  const repository = JSON.parse(
    run("gh", ["api", "--method", "GET", `/repos/${RELEASE_REPOSITORY}`]).stdout,
  );
  const workflow = JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${RELEASE_REPOSITORY}/actions/workflows/release-verify.yml`,
    ]).stdout,
  );
  const protectedBranch = JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${RELEASE_REPOSITORY}/branches/${encodeURIComponent(repository.default_branch)}`,
    ]).stdout,
  );
  const workflowRun = JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${RELEASE_REPOSITORY}/actions/runs/${verifierRun}`,
    ]).stdout,
  );
  validateVerifierRun({
    repository,
    protectedBranch,
    workflow,
    workflowRun,
    runId: verifierRun,
    verifierHead: options.verifierHead,
  });
  const jobsResponse = JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${RELEASE_REPOSITORY}/actions/runs/${verifierRun}/jobs?filter=latest&per_page=100`,
    ]).stdout,
  );
  const verifierJobs = validateVerifierJobs(jobsResponse.jobs ?? []);
  const manifestDigest = releaseManifestDigest({
    release_id: releaseId,
    tag: options.tag,
    commit: options.commit,
    assets: release.assets,
  });
  for (const arch of ["arm64", "x86_64"]) {
    const logs = run("gh", [
      "run",
      "view",
      String(verifierRun),
      "--repo",
      RELEASE_REPOSITORY,
      "--job",
      String(verifierJobs.get(arch).id),
      "--log",
    ]).stdout;
    const marker =
      `VERIFIED_ARCH arch=${arch} release_id=${releaseId} tag=${options.tag} ` +
      `commit=${options.commit} manifest_sha256=${manifestDigest}`;
    if (!logs.includes(marker)) {
      throw new Error(`verifier run does not contain the exact ${arch} candidate marker`);
    }
    const otherArch = arch === "arm64" ? "x86_64" : "arm64";
    if (logs.includes(`VERIFIED_ARCH arch=${otherArch} `)) {
      throw new Error(`native ${arch} verifier job emitted the ${otherArch} marker`);
    }
  }

  const tagObjectSha = verifyGitHubSignedReleaseTag({
    tag: options.tag,
    commit: options.commit,
    run,
  });

  const published = JSON.parse(
    run("gh", [
      "api",
      "--method",
      "PATCH",
      `/repos/${RELEASE_REPOSITORY}/releases/${releaseId}`,
      "-F",
      "draft=false",
    ]).stdout,
  );
  if (
    published.draft !== false ||
    published.tag_name !== options.tag ||
    published.target_commitish !== options.commit
  ) {
    throw new Error("GitHub did not publish the exact verified release");
  }
  verifyGitHubSignedReleaseTag({ tag: options.tag, commit: options.commit, run });
  process.stdout.write(`Published ${options.tag} with signed tag object ${tagObjectSha}\n`);
}

export function validateHomebrewRelease(
  release,
  { releaseId, tag, commit, version, expectedBody, manifestDigest },
) {
  if (!/^[0-9a-f]{64}$/.test(String(manifestDigest ?? ""))) {
    throw new Error("Homebrew handoff requires the exact verifier manifest SHA-256");
  }
  const assets = validatePublishedReleaseMetadata(release, {
    releaseId,
    tag,
    commit,
    version,
    expectedBody,
  });
  const actualManifest = releaseManifestDigest({
    release_id: Number(releaseId),
    tag,
    commit,
    assets,
  });
  if (actualManifest !== manifestDigest) {
    throw new Error("published release manifest does not match the verified draft manifest");
  }
  return { assets, manifestDigest: actualManifest };
}

function downloadAndVerifyHomebrewAssets({ assets, version, downloadAsset = downloadReleaseAsset }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wacli-homebrew-release-"));
  try {
    for (const name of releaseAssetNames(version)) {
      downloadAsset(assets.find((asset) => asset.name === name), directory);
    }
    verifyChecksums(directory, version);
    return parseChecksums(
      fs.readFileSync(path.join(directory, "checksums.txt"), "utf8"),
      archiveNames(version),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function validateHomebrewFormula(formula, { tag, checksums }) {
  const version = versionFromTag(tag);
  if (!/^class Wacli < Formula$/m.test(formula)) throw new Error("Homebrew formula class mismatch");
  const versions = [...String(formula).matchAll(/^\s*version "([^"]+)"\s*$/gm)].map(
    (match) => match[1],
  );
  if (versions.length !== 1 || versions[0] !== version) {
    throw new Error("Homebrew formula version mismatch");
  }
  const targets = ["darwin_arm64", "darwin_amd64", "linux_arm64", "linux_amd64"];
  const expectedUrls = targets.map(
    (target) =>
      `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/` +
      `wacli_${version}_${target}.tar.gz`,
  );
  const urlChecksums = new Map();
  for (const match of String(formula).matchAll(/^\s*url "([^"]+)"\r?\n\s*sha256 "([0-9a-f]{64})"\s*$/gm)) {
    if (urlChecksums.has(match[1])) throw new Error(`duplicate Homebrew formula URL ${match[1]}`);
    urlChecksums.set(match[1], match[2]);
  }
  assertExactInventory(urlChecksums.keys(), expectedUrls, "Homebrew formula URL");
  for (const target of targets) {
    const name = `wacli_${version}_${target}.tar.gz`;
    const url = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${name}`;
    if (urlChecksums.get(url) !== checksums.get(name)) {
      throw new Error(`Homebrew formula checksum mismatch for ${name}`);
    }
  }
}

export function validateHomebrewRun({ repository, branch, workflow, workflowRun, runId }) {
  const defaultBranch = repository.default_branch;
  if (repository.full_name !== homebrewRepository || !defaultBranch) {
    throw new Error("Homebrew repository identity mismatch");
  }
  if (branch.name !== defaultBranch || !/^[0-9a-f]{40}$/.test(String(branch.commit?.sha ?? ""))) {
    throw new Error("Homebrew default-branch head mismatch");
  }
  if (
    !Number.isInteger(workflow.id) ||
    workflow.id <= 0 ||
    workflow.path !== homebrewWorkflowPath ||
    workflow.state !== "active"
  ) {
    throw new Error("Homebrew workflow identity mismatch");
  }
  if (
    Number(workflowRun.id) !== Number(runId) ||
    Number(workflowRun.workflow_id) !== workflow.id ||
    workflowRun.path !== homebrewWorkflowPath ||
    workflowRun.event !== "workflow_dispatch" ||
    workflowRun.status !== "completed" ||
    workflowRun.conclusion !== "success" ||
    workflowRun.head_branch !== defaultBranch ||
    workflowRun.head_sha !== branch.commit.sha ||
    workflowRun.head_repository?.full_name !== homebrewRepository
  ) {
    throw new Error("Homebrew run is not the exact authenticated handoff workflow dispatch");
  }
}

function readReleaseById(releaseId, run) {
  return JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${RELEASE_REPOSITORY}/releases/${releaseId}`,
    ]).stdout,
  );
}

function readHomebrewBranch(defaultBranch, run) {
  return JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${homebrewRepository}/branches/${encodeURIComponent(defaultBranch)}`,
    ]).stdout,
  );
}

export function dispatchHomebrewHandoff(options) {
  const run = options.run ?? runCommand;
  const version = versionFromTag(options.tag);
  assertCommit(options.commit);
  const releaseId = Number(options.releaseId);
  if (!Number.isInteger(releaseId) || releaseId <= 0) throw new Error("invalid release ID");
  if (options.cleanConfirm !== options.tag) {
    throw new Error("--confirm-clean-homebrew-host must exactly match --tag on a host without wacli installed");
  }
  const installed = run("brew", ["list", "--versions", "wacli"], { allowFailure: true });
  if (installed.status === 0 || installed.stdout.trim()) {
    throw new Error("Homebrew clean-install gate requires wacli to be absent");
  }

  const expectedBody = releaseNotesForCommit(options.tag, options.commit, run);
  const release = readReleaseById(releaseId, run);
  const validated = validateHomebrewRelease(release, {
    releaseId,
    tag: options.tag,
    commit: options.commit,
    version,
    expectedBody,
    manifestDigest: options.manifestDigest,
  });
  const tagObjectSha = verifyGitHubSignedReleaseTag({
    tag: options.tag,
    commit: options.commit,
    run,
  });
  const checksums = downloadAndVerifyHomebrewAssets({
    assets: validated.assets,
    version,
    downloadAsset: options.downloadAsset,
  });

  const repository = JSON.parse(
    run("gh", ["api", "--method", "GET", `/repos/${homebrewRepository}`]).stdout,
  );
  const workflow = JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${homebrewRepository}/actions/workflows/update-formula.yml`,
    ]).stdout,
  );
  const branch = readHomebrewBranch(repository.default_branch, run);
  if (
    repository.full_name !== homebrewRepository ||
    branch.name !== repository.default_branch ||
    !/^[0-9a-f]{40}$/.test(String(branch.commit?.sha ?? "")) ||
    !Number.isInteger(workflow.id) ||
    workflow.path !== homebrewWorkflowPath ||
    workflow.state !== "active"
  ) {
    throw new Error("Homebrew handoff control plane mismatch");
  }

  const requestId =
    `wacli-${options.tag}-r${releaseId}-${options.commit}-` +
    `${options.manifestDigest}-${options.requestNonce ?? Date.now()}`;
  const expectedTitle = `Update wacli for ${options.tag} (${requestId})`;
  run("gh", [
    "workflow",
    "run",
    String(workflow.id),
    "--repo",
    homebrewRepository,
    "--ref",
    repository.default_branch,
    "-f",
    "formula=wacli",
    "-f",
    `tag=${options.tag}`,
    "-f",
    `repository=${RELEASE_REPOSITORY}`,
    "-f",
    "description=WhatsApp CLI built on whatsmeow",
    "-f",
    "artifact_template={formula}_{version}_{target}.tar.gz",
    "-f",
    `request_id=${requestId}`,
  ]);

  let runId = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = JSON.parse(
      run("gh", [
        "api",
        "--method",
        "GET",
        `/repos/${homebrewRepository}/actions/workflows/${workflow.id}/runs?` +
          `branch=${encodeURIComponent(repository.default_branch)}&event=workflow_dispatch&per_page=30`,
      ]).stdout,
    );
    const matches = (response.workflow_runs ?? []).filter(
      (candidate) =>
        candidate.display_title === expectedTitle &&
        Number(candidate.workflow_id) === workflow.id &&
        candidate.path === homebrewWorkflowPath &&
        candidate.head_sha === branch.commit.sha,
    );
    if (matches.length > 1) throw new Error(`ambiguous Homebrew handoff run ${expectedTitle}`);
    runId = matches[0]?.id ?? null;
    if (runId) break;
    run("sleep", ["2"]);
  }
  if (!runId) throw new Error(`could not find Homebrew handoff run ${expectedTitle}`);
  run("gh", [
    "run",
    "watch",
    String(runId),
    "--repo",
    homebrewRepository,
    "--exit-status",
    "--interval",
    "10",
  ]);
  const workflowRun = JSON.parse(
    run("gh", [
      "api",
      "--method",
      "GET",
      `/repos/${homebrewRepository}/actions/runs/${runId}`,
    ]).stdout,
  );
  validateHomebrewRun({ repository, branch, workflow, workflowRun, runId });

  const updatedBranch = readHomebrewBranch(repository.default_branch, run);
  if (updatedBranch.commit?.sha !== branch.commit.sha) {
    const comparison = JSON.parse(
      run("gh", [
        "api",
        "--method",
        "GET",
        `/repos/${homebrewRepository}/compare/${branch.commit.sha}...${updatedBranch.commit?.sha}`,
      ]).stdout,
    );
    if (comparison.status !== "ahead" || comparison.merge_base_commit?.sha !== branch.commit.sha) {
      throw new Error("Homebrew default branch did not advance from the authenticated workflow head");
    }
  }
  const formula = run("gh", [
    "api",
    "--method",
    "GET",
    "--header",
    "Accept: application/vnd.github.raw+json",
    `/repos/${homebrewRepository}/contents/${homebrewFormulaPath}?ref=${updatedBranch.commit?.sha}`,
  ]).stdout;
  validateHomebrewFormula(formula, { tag: options.tag, checksums });

  const finalRelease = readReleaseById(releaseId, run);
  validateHomebrewRelease(finalRelease, {
    releaseId,
    tag: options.tag,
    commit: options.commit,
    version,
    expectedBody,
    manifestDigest: options.manifestDigest,
  });
  verifyGitHubSignedReleaseTag({ tag: options.tag, commit: options.commit, run });

  run("brew", ["tap", "openclaw/tap"]);
  run("brew", ["update"]);
  const localFormula = run("brew", ["cat", "openclaw/tap/wacli"]).stdout;
  validateHomebrewFormula(localFormula, { tag: options.tag, checksums });
  run("brew", ["install", "--formula", "openclaw/tap/wacli"]);
  run("brew", ["test", "openclaw/tap/wacli"], { env: sanitizedExecutionEnv() });
  const prefix = run("brew", ["--prefix", "wacli"]).stdout.trim();
  const versionOutput = run(path.join(prefix, "bin", "wacli"), ["--version"], {
    env: sanitizedExecutionEnv(),
  }).stdout.trim();
  if (versionOutput !== `wacli ${version}`) throw new Error("clean Homebrew install version mismatch");
  process.stdout.write(
    `HOMEBREW_VERIFIED release_id=${releaseId} tag=${options.tag} commit=${options.commit} ` +
      `manifest_sha256=${options.manifestDigest} tag_object=${tagObjectSha} run_id=${runId}\n`,
  );
}

function required(args, names) {
  for (const name of names) if (!args[name]) throw new Error(`missing --${name}`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseCliArgs(rest);
  if (command === "prepare") {
    required(args, [
      "tag",
      "commit",
      "cross-platform-dir",
      "cross-platform-manifest-sha256",
      "output",
    ]);
    const output = prepareDarwinRelease({
      tag: args.tag,
      commit: args.commit,
      crossPlatformDir: args["cross-platform-dir"],
      crossPlatformManifest: args["cross-platform-manifest-sha256"],
      outputDir: args.output,
    });
    process.stdout.write(`Prepared ${output}\n`);
  } else if (command === "draft") {
    required(args, ["tag", "commit", "candidate-dir"]);
    const releaseId = createDraftRelease({
      tag: args.tag,
      commit: args.commit,
      candidateDir: args["candidate-dir"],
    });
    process.stdout.write(`Created draft release ${releaseId}\n`);
  } else if (command === "tag") {
    required(args, ["tag", "commit", "candidate-dir", "confirm-signed-tag"]);
    const tagObjectSha = createAndPushSignedTag({
      tag: args.tag,
      commit: args.commit,
      candidateDir: args["candidate-dir"],
      confirm: args["confirm-signed-tag"],
    });
    process.stdout.write(`Pushed signed annotated ${args.tag} object ${tagObjectSha}\n`);
  } else if (command === "publish") {
    required(args, [
      "release-id",
      "tag",
      "commit",
      "verifier-run",
      "verifier-head",
      "confirm-publish",
      "confirm-gatekeeper-vm",
    ]);
    publishDraftRelease({
      releaseId: args["release-id"],
      tag: args.tag,
      commit: args.commit,
      verifierRun: args["verifier-run"],
      verifierHead: args["verifier-head"],
      confirm: args["confirm-publish"],
      vmConfirm: args["confirm-gatekeeper-vm"],
    });
  } else if (command === "homebrew") {
    required(args, [
      "release-id",
      "tag",
      "commit",
      "manifest-sha256",
      "confirm-clean-homebrew-host",
    ]);
    dispatchHomebrewHandoff({
      releaseId: args["release-id"],
      tag: args.tag,
      commit: args.commit,
      manifestDigest: args["manifest-sha256"],
      cleanConfirm: args["confirm-clean-homebrew-host"],
    });
  } else {
    throw new Error("usage: release-local.mjs prepare|draft|tag|publish|homebrew [options]");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`local release failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
