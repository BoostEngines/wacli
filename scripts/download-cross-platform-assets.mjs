#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RELEASE_REPOSITORY,
  assertCommit,
  assertExactInventory,
  crossPlatformArchiveNames,
  parseArchiveListing,
  parseCliArgs,
  runCommand,
  sha256File,
} from "./release-common.mjs";
import {
  crossPlatformProvenanceName,
  crossPlatformWorkflowPath,
} from "./collect-cross-platform-assets.mjs";

export const authenticatedCrossPlatformName = "authenticated-cross-platform.json";

function sha256FromDigest(digest, label) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(digest ?? ""));
  if (!match) throw new Error(`${label} must be an exact SHA-256 digest`);
  return match[1];
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

export function validateCrossPlatformControlPlane({
  repository,
  protectedBranch,
  workflow,
  workflowRun,
  artifact,
  runId,
  artifactId,
  workflowSha,
  commit,
  version,
}) {
  assertCommit(workflowSha);
  assertCommit(commit);
  const numericRunId = positiveInteger(runId, "run ID");
  const numericArtifactId = positiveInteger(artifactId, "artifact ID");
  if (repository.full_name !== RELEASE_REPOSITORY || !repository.default_branch) {
    throw new Error("cross-platform repository identity mismatch");
  }
  if (
    protectedBranch.name !== repository.default_branch ||
    protectedBranch.protected !== true ||
    !/^[0-9a-f]{40}$/.test(String(protectedBranch.commit?.sha ?? ""))
  ) {
    throw new Error("cross-platform workflow ref is not a protected default branch");
  }
  if (
    !Number.isInteger(workflow.id) ||
    workflow.id <= 0 ||
    workflow.path !== crossPlatformWorkflowPath ||
    workflow.state !== "active"
  ) {
    throw new Error("cross-platform workflow identity mismatch");
  }
  if (
    Number(workflowRun.id) !== numericRunId ||
    Number(workflowRun.workflow_id) !== workflow.id ||
    workflowRun.path !== crossPlatformWorkflowPath ||
    workflowRun.event !== "workflow_dispatch" ||
    workflowRun.display_title !== `release-builds commit=${commit} version=${version}` ||
    workflowRun.status !== "completed" ||
    workflowRun.conclusion !== "success" ||
    workflowRun.head_branch !== repository.default_branch ||
    workflowRun.head_sha !== workflowSha ||
    workflowRun.head_repository?.full_name !== RELEASE_REPOSITORY
  ) {
    throw new Error("cross-platform workflow run provenance mismatch");
  }
  const expectedName = `wacli-${version}-cross-${commit}`;
  if (
    Number(artifact.id) !== numericArtifactId ||
    artifact.name !== expectedName ||
    artifact.expired !== false ||
    !Number.isInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    Number(artifact.workflow_run?.id) !== numericRunId ||
    artifact.workflow_run?.head_sha !== workflowSha
  ) {
    throw new Error("cross-platform artifact identity mismatch");
  }
  sha256FromDigest(artifact.digest, "GitHub artifact digest");
}

export function validateCrossPlatformProvenance(provenance, options) {
  const {
    sourceDir,
    version,
    commit,
    workflowSha,
    runId,
    runAttempt,
    defaultBranch,
  } = options;
  const numericRunId = positiveInteger(runId, "run ID");
  const numericRunAttempt = positiveInteger(runAttempt, "run attempt");
  const expectedRef = `refs/heads/${defaultBranch}`;
  const expectedWorkflowRef = `${RELEASE_REPOSITORY}/${crossPlatformWorkflowPath}@${expectedRef}`;
  if (
    provenance.schema !== 1 ||
    provenance.repository !== RELEASE_REPOSITORY ||
    provenance.workflow_path !== crossPlatformWorkflowPath ||
    provenance.workflow_ref !== expectedWorkflowRef ||
    provenance.workflow_sha !== workflowSha ||
    Number(provenance.run_id) !== numericRunId ||
    Number(provenance.run_attempt) !== numericRunAttempt ||
    provenance.event !== "workflow_dispatch" ||
    provenance.ref !== expectedRef ||
    provenance.inputs?.commit !== commit ||
    provenance.inputs?.version !== version
  ) {
    throw new Error("cross-platform artifact provenance manifest mismatch");
  }

  const expectedNames = crossPlatformArchiveNames(version);
  const assets = provenance.assets ?? [];
  assertExactInventory(
    assets.map((asset) => asset.name),
    expectedNames,
    "cross-platform provenance asset",
  );
  for (const asset of assets) {
    if (!Number.isInteger(asset.size) || asset.size <= 0 || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
      throw new Error(`invalid provenance metadata for ${asset.name}`);
    }
    const file = path.join(sourceDir, asset.name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size !== asset.size || sha256File(file) !== asset.sha256) {
      throw new Error(`cross-platform provenance digest mismatch for ${asset.name}`);
    }
  }
}

function downloadArtifact(artifactId, destination) {
  const fd = fs.openSync(destination, "wx", 0o600);
  let result;
  try {
    result = spawnSync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "--header",
        "Accept: application/vnd.github+json",
        `/repos/${RELEASE_REPOSITORY}/actions/artifacts/${artifactId}/zip`,
      ],
      { env: process.env, stdio: ["ignore", fd, "pipe"], encoding: "utf8" },
    );
  } finally {
    fs.closeSync(fd);
  }
  if (result.error || result.status !== 0) {
    fs.rmSync(destination, { force: true });
    if (result.error) throw result.error;
    throw new Error(`artifact download failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
  }
}

function readJsonApi(endpoint) {
  return JSON.parse(runCommand("gh", ["api", "--method", "GET", endpoint]).stdout);
}

export function validateAuthenticatedCrossPlatformDirectory({
  sourceDir,
  version,
  commit,
  manifestDigest,
}) {
  assertCommit(commit);
  if (!/^[0-9a-f]{64}$/.test(String(manifestDigest ?? ""))) {
    throw new Error("authenticated cross-platform manifest digest must be a SHA-256 value");
  }
  const expectedNames = [
    ...crossPlatformArchiveNames(version),
    crossPlatformProvenanceName,
    authenticatedCrossPlatformName,
  ];
  assertExactInventory(fs.readdirSync(sourceDir), expectedNames, "authenticated cross-platform file");
  const authenticatedFile = path.join(sourceDir, authenticatedCrossPlatformName);
  if (sha256File(authenticatedFile) !== manifestDigest) {
    throw new Error("authenticated cross-platform manifest digest mismatch");
  }
  const authenticated = JSON.parse(fs.readFileSync(authenticatedFile, "utf8"));
  if (
    authenticated.schema !== 1 ||
    authenticated.repository !== RELEASE_REPOSITORY ||
    authenticated.workflow_path !== crossPlatformWorkflowPath ||
    authenticated.protected_ref !== true ||
    !/^[-A-Za-z0-9._/]+$/.test(String(authenticated.default_branch ?? "")) ||
    authenticated.inputs?.commit !== commit ||
    authenticated.inputs?.version !== version ||
    !Number.isInteger(authenticated.workflow_id) ||
    authenticated.workflow_id <= 0 ||
    !Number.isInteger(authenticated.run_id) ||
    authenticated.run_id <= 0 ||
    !Number.isInteger(authenticated.run_attempt) ||
    authenticated.run_attempt <= 0 ||
    !Number.isInteger(authenticated.artifact_id) ||
    authenticated.artifact_id <= 0 ||
    authenticated.artifact_name !== `wacli-${version}-cross-${commit}`
  ) {
    throw new Error("authenticated cross-platform manifest coordinates mismatch");
  }
  assertCommit(authenticated.workflow_sha);
  assertCommit(authenticated.protected_branch_head);
  sha256FromDigest(authenticated.artifact_digest, "authenticated artifact digest");
  if (!/^[0-9a-f]{64}$/.test(authenticated.provenance_sha256)) {
    throw new Error("authenticated provenance digest is invalid");
  }
  const provenanceFile = path.join(sourceDir, crossPlatformProvenanceName);
  if (sha256File(provenanceFile) !== authenticated.provenance_sha256) {
    throw new Error("authenticated provenance digest mismatch");
  }
  const provenance = JSON.parse(fs.readFileSync(provenanceFile, "utf8"));
  validateCrossPlatformProvenance(provenance, {
    sourceDir,
    version,
    commit,
    workflowSha: authenticated.workflow_sha,
    runId: authenticated.run_id,
    runAttempt: authenticated.run_attempt,
    defaultBranch: authenticated.default_branch,
  });
  return authenticated;
}

function main() {
  if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required only for authenticated artifact download");
  const args = parseCliArgs(process.argv.slice(2));
  for (const required of ["run-id", "artifact-id", "workflow-sha", "commit", "version", "output"]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  assertCommit(args["workflow-sha"]);
  assertCommit(args.commit);
  if (!/^\d+\.\d+\.\d+$/.test(args.version)) throw new Error("--version must look like X.Y.Z");
  const runId = positiveInteger(args["run-id"], "run ID");
  const artifactId = positiveInteger(args["artifact-id"], "artifact ID");
  const outputDir = path.resolve(args.output);
  if (fs.existsSync(outputDir)) throw new Error(`refusing to replace output directory ${outputDir}`);
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });

  const repository = readJsonApi(`/repos/${RELEASE_REPOSITORY}`);
  const protectedBranch = readJsonApi(
    `/repos/${RELEASE_REPOSITORY}/branches/${encodeURIComponent(repository.default_branch)}`,
  );
  const workflow = readJsonApi(
    `/repos/${RELEASE_REPOSITORY}/actions/workflows/release.yml`,
  );
  const workflowRun = readJsonApi(`/repos/${RELEASE_REPOSITORY}/actions/runs/${runId}`);
  const artifact = readJsonApi(`/repos/${RELEASE_REPOSITORY}/actions/artifacts/${artifactId}`);
  validateCrossPlatformControlPlane({
    repository,
    protectedBranch,
    workflow,
    workflowRun,
    artifact,
    runId,
    artifactId,
    workflowSha: args["workflow-sha"],
    commit: args.commit,
    version: args.version,
  });

  const tempRoot = fs.mkdtempSync(path.join(path.dirname(outputDir), ".wacli-cross-download-"));
  try {
    const artifactZip = path.join(tempRoot, "artifact.zip");
    downloadArtifact(artifactId, artifactZip);
    if (sha256File(artifactZip) !== sha256FromDigest(artifact.digest, "GitHub artifact digest")) {
      throw new Error("downloaded GitHub artifact digest mismatch");
    }
    const listing = runCommand("unzip", ["-Z1", artifactZip]);
    const names = parseArchiveListing(`${listing.stdout}${listing.stderr}`);
    assertExactInventory(
      names,
      [...crossPlatformArchiveNames(args.version), crossPlatformProvenanceName],
      "GitHub artifact entry",
    );
    const extractedDir = path.join(tempRoot, "extracted");
    fs.mkdirSync(extractedDir);
    runCommand("unzip", ["-q", artifactZip, "-d", extractedDir]);
    for (const name of names) {
      if (!fs.lstatSync(path.join(extractedDir, name)).isFile()) {
        throw new Error(`GitHub artifact entry ${name} is not a regular file`);
      }
    }
    const provenanceFile = path.join(extractedDir, crossPlatformProvenanceName);
    const provenance = JSON.parse(fs.readFileSync(provenanceFile, "utf8"));
    validateCrossPlatformProvenance(provenance, {
      sourceDir: extractedDir,
      version: args.version,
      commit: args.commit,
      workflowSha: args["workflow-sha"],
      runId,
      runAttempt: workflowRun.run_attempt,
      defaultBranch: repository.default_branch,
    });
    const authenticated = {
      schema: 1,
      repository: RELEASE_REPOSITORY,
      default_branch: repository.default_branch,
      protected_ref: true,
      protected_branch_head: protectedBranch.commit.sha,
      workflow_id: workflow.id,
      workflow_path: crossPlatformWorkflowPath,
      workflow_sha: args["workflow-sha"],
      run_id: runId,
      run_attempt: workflowRun.run_attempt,
      artifact_id: artifactId,
      artifact_name: artifact.name,
      artifact_digest: artifact.digest,
      provenance_sha256: sha256File(provenanceFile),
      inputs: { commit: args.commit, version: args.version },
    };
    const authenticatedFile = path.join(extractedDir, authenticatedCrossPlatformName);
    fs.writeFileSync(authenticatedFile, `${JSON.stringify(authenticated, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const manifestDigest = sha256File(authenticatedFile);
    fs.renameSync(extractedDir, outputDir);
    process.stdout.write(
      `AUTHENTICATED_CROSS_PLATFORM manifest_sha256=${manifestDigest} run_id=${runId} ` +
        `artifact_id=${artifactId} workflow_sha=${args["workflow-sha"]}\n`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`cross-platform artifact download failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
