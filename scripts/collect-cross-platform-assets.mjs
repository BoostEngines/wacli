#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_REPOSITORY,
  assertArchiveContents,
  assertCommit,
  assertExactInventory,
  assertGoBuildInfo,
  crossPlatformArchiveNames,
  parseCliArgs,
  releaseArchiveTarget,
  runCommand,
  sha256File,
} from "./release-common.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
export const crossPlatformProvenanceName = "cross-platform-provenance.json";
export const crossPlatformWorkflowPath = ".github/workflows/release.yml";

export function collectCrossPlatformAssets({
  sourceDir,
  outputDir,
  version,
  commit,
  run = runCommand,
  env = process.env,
}) {
  assertCommit(commit);
  const expected = crossPlatformArchiveNames(version);
  const releaseLike = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^wacli_.+_(?:linux|windows)_/.test(entry.name))
    .map((entry) => entry.name);
  assertExactInventory(releaseLike, expected, "cross-platform build");

  if (fs.existsSync(outputDir)) {
    if (fs.readdirSync(outputDir).length > 0) throw new Error(`output directory is not empty: ${outputDir}`);
  } else {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wacli-cross-verify-"));
  try {
    for (const name of expected) {
      const archive = path.join(sourceDir, name);
      const binaryName = name.includes("windows") ? "wacli.exe" : "wacli";
      assertArchiveContents(archive, binaryName, { run });
      const extractDir = path.join(tempDir, name.replace(/[^a-zA-Z0-9_.-]/g, "_"));
      fs.mkdirSync(extractDir);
      if (name.endsWith(".zip")) run("unzip", ["-q", archive, "-d", extractDir]);
      else run("tar", ["-xzf", archive, "-C", extractDir]);
      const binary = path.join(extractDir, binaryName);
      const binaryStat = fs.lstatSync(binary);
      if (!binaryStat.isFile()) throw new Error(`${name} binary is not a regular file`);
      if (!name.includes("windows") && (binaryStat.mode & 0o111) === 0) {
        throw new Error(`${name} binary is not executable`);
      }
      const target = releaseArchiveTarget(name, version);
      assertGoBuildInfo(binary, version, {
        run,
        commit,
        expectedGoos: target.goos,
        expectedGoarch: target.goarch,
      });
      run(process.execPath, [path.join(scriptDir, "govulncheck-stdlib.mjs"), "binary", binary], {
        cwd: repoRoot,
        env,
        stdio: "inherit",
      });
      fs.copyFileSync(archive, path.join(outputDir, name), fs.constants.COPYFILE_EXCL);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function writeCrossPlatformProvenance({
  outputDir,
  version,
  commit,
  repository,
  workflowPath,
  workflowRef,
  workflowSha,
  runId,
  runAttempt,
  event,
  ref,
}) {
  assertCommit(commit);
  assertCommit(workflowSha);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("release version must look like X.Y.Z");
  if (repository !== RELEASE_REPOSITORY || workflowPath !== crossPlatformWorkflowPath) {
    throw new Error("cross-platform provenance repository or workflow path mismatch");
  }
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error("cross-platform provenance ref must be a branch ref");
  }
  const expectedWorkflowRef = `${repository}/${workflowPath}@${ref}`;
  if (workflowRef !== expectedWorkflowRef) {
    throw new Error("cross-platform provenance workflow_ref mismatch");
  }
  if (event !== "workflow_dispatch") {
    throw new Error("cross-platform provenance event must be workflow_dispatch");
  }
  const numericRunId = Number(runId);
  const numericRunAttempt = Number(runAttempt);
  if (!Number.isInteger(numericRunId) || numericRunId <= 0) throw new Error("invalid workflow run ID");
  if (!Number.isInteger(numericRunAttempt) || numericRunAttempt <= 0) {
    throw new Error("invalid workflow run attempt");
  }

  const names = crossPlatformArchiveNames(version);
  assertExactInventory(fs.readdirSync(outputDir), names, "cross-platform provenance input");
  const assets = names.map((name) => {
    const file = path.join(outputDir, name);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`invalid cross-platform asset ${name}`);
    return { name, size: stat.size, sha256: sha256File(file) };
  });
  const provenance = {
    schema: 1,
    repository,
    workflow_path: workflowPath,
    workflow_ref: workflowRef,
    workflow_sha: workflowSha,
    run_id: numericRunId,
    run_attempt: numericRunAttempt,
    event,
    ref,
    inputs: { commit, version },
    assets,
  };
  fs.writeFileSync(
    path.join(outputDir, crossPlatformProvenanceName),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { flag: "wx", mode: 0o644 },
  );
  return provenance;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  for (const required of [
    "source",
    "output",
    "version",
    "commit",
    "repository",
    "workflow-path",
    "workflow-ref",
    "workflow-sha",
    "run-id",
    "run-attempt",
    "event",
    "ref",
  ]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(args.version)) throw new Error("--version must look like X.Y.Z");
  collectCrossPlatformAssets({
    sourceDir: path.resolve(args.source),
    outputDir: path.resolve(args.output),
    version: args.version,
    commit: args.commit,
  });
  writeCrossPlatformProvenance({
    outputDir: path.resolve(args.output),
    version: args.version,
    commit: args.commit,
    repository: args.repository,
    workflowPath: args["workflow-path"],
    workflowRef: args["workflow-ref"],
    workflowSha: args["workflow-sha"],
    runId: args["run-id"],
    runAttempt: args["run-attempt"],
    event: args.event,
    ref: args.ref,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`cross-platform asset collection failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
