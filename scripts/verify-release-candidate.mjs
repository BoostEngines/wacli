#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveNames,
  assertArchiveContents,
  assertCommit,
  assertExactInventory,
  assertGoBuildInfo,
  assertNoReleaseCredentials,
  parseCliArgs,
  releaseArchiveTarget,
  releaseManifestDigest,
  releaseAssetNames,
  runCommand,
  sanitizedExecutionEnv,
  verifyChecksums,
  verifyDarwinSignature,
  versionFromTag,
} from "./release-common.mjs";

function combinedOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function extractArchive(archive, destination, run) {
  fs.mkdirSync(destination, { recursive: true });
  if (archive.endsWith(".zip")) run("unzip", ["-q", archive, "-d", destination]);
  else run("tar", ["-xzf", archive, "-C", destination]);
}

function assertArchitectures(binary, expected, run) {
  const result = run("lipo", ["-archs", binary]);
  const actual = combinedOutput(result).trim().split(/\s+/).filter(Boolean);
  assertExactInventory(actual, expected, `${path.basename(binary)} architecture`);
}

function assertReleaseMetadata(metadata, { releaseId, tag, commit, version }) {
  if (Number(metadata.release_id) !== Number(releaseId)) throw new Error("release metadata ID mismatch");
  if (metadata.tag !== tag) throw new Error("release metadata tag mismatch");
  if (metadata.commit !== commit) throw new Error("release metadata commit mismatch");
  if (metadata.draft !== true || metadata.prerelease !== false) {
    throw new Error("release candidate must be an unpublished, non-prerelease draft");
  }
  assertExactInventory(
    (metadata.assets ?? []).map((asset) => asset.name),
    releaseAssetNames(version),
    "release metadata asset",
  );
}

function assertDownloadedAssetMetadata(candidateDir, metadata) {
  for (const asset of metadata.assets) {
    const file = path.join(candidateDir, asset.name);
    const stat = fs.statSync(file);
    if (stat.size !== asset.size) {
      throw new Error(`${asset.name} size mismatch: expected ${asset.size}, got ${stat.size}`);
    }
  }
}

function assertVersionCommand(binary, version, run) {
  const result = run(binary, ["--version"], {
    env: sanitizedExecutionEnv(),
    cwd: path.dirname(binary),
  });
  const output = combinedOutput(result).trim();
  if (output !== `wacli ${version}`) {
    throw new Error(`${path.basename(binary)} --version returned ${JSON.stringify(output)}`);
  }
}

export function verifyCandidateDirectory(options) {
  const run = options.run ?? runCommand;
  const candidateDir = path.resolve(options.candidateDir);
  const tag = options.tag;
  const commit = options.commit;
  const releaseId = options.releaseId;
  const version = versionFromTag(tag);
  assertCommit(commit);

  const entries = fs.readdirSync(candidateDir, { withFileTypes: true });
  const nonFiles = entries.filter((entry) => !entry.isFile());
  if (nonFiles.length > 0) {
    throw new Error(`candidate directory contains non-files: ${nonFiles.map((entry) => entry.name).join(", ")}`);
  }
  const files = entries.map((entry) => entry.name);
  const metadataFile = path.join(candidateDir, "release.json");
  const expectedFiles = releaseId ? [...releaseAssetNames(version), "release.json"] : releaseAssetNames(version);
  assertExactInventory(files, expectedFiles, "candidate file");

  let metadata = null;
  if (releaseId) {
    metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    assertReleaseMetadata(metadata, { releaseId, tag, commit, version });
    assertDownloadedAssetMetadata(candidateDir, metadata);
  }

  verifyChecksums(candidateDir, version);
  const hostArch = combinedOutput(run("uname", ["-m"])).trim();
  if (options.expectedHostArch && hostArch !== options.expectedHostArch) {
    throw new Error(`verifier host mismatch: expected ${options.expectedHostArch}, got ${hostArch}`);
  }
  if (hostArch !== "arm64" && hostArch !== "x86_64") {
    throw new Error(`unsupported macOS verifier architecture ${hostArch}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wacli-release-verify-"));
  const binaries = new Map();
  try {
    for (const archiveName of archiveNames(version)) {
      const archive = path.join(candidateDir, archiveName);
      const expectedBinary = archiveName.includes("windows") ? "wacli.exe" : "wacli";
      assertArchiveContents(archive, expectedBinary, { run });
      const destination = path.join(tempDir, archiveName.replace(/[^a-zA-Z0-9_.-]/g, "_"));
      extractArchive(archive, destination, run);
      const binary = path.join(destination, expectedBinary);
      const binaryStat = fs.lstatSync(binary);
      if (!binaryStat.isFile()) throw new Error(`${archiveName} binary is not a regular file`);
      if (!archiveName.includes("windows") && (binaryStat.mode & 0o111) === 0) {
        throw new Error(`${archiveName} binary is not executable`);
      }
      for (const name of ["LICENSE", "README.md", expectedBinary]) {
        if (!fs.lstatSync(path.join(destination, name)).isFile()) {
          throw new Error(`${archiveName} entry ${name} is not a regular file`);
        }
      }
      const target = releaseArchiveTarget(archiveName, version);
      if (target.goarch !== "universal") {
        assertGoBuildInfo(binary, version, {
          run,
          commit,
          expectedGoos: target.goos,
          expectedGoarch: target.goarch,
        });
      }
      binaries.set(archiveName, binary);
    }

    const darwinAmd64 = binaries.get(`wacli_${version}_darwin_amd64.tar.gz`);
    const darwinArm64 = binaries.get(`wacli_${version}_darwin_arm64.tar.gz`);
    const darwinUniversal = binaries.get(`wacli_${version}_darwin_universal.tar.gz`);

    assertArchitectures(darwinAmd64, ["x86_64"], run);
    assertArchitectures(darwinArm64, ["arm64"], run);
    assertArchitectures(darwinUniversal, ["arm64", "x86_64"], run);

    const universalAmd64 = path.join(tempDir, "wacli-universal-amd64");
    const universalArm64 = path.join(tempDir, "wacli-universal-arm64");
    run("lipo", [darwinUniversal, "-thin", "x86_64", "-output", universalAmd64]);
    run("lipo", [darwinUniversal, "-thin", "arm64", "-output", universalArm64]);
    assertGoBuildInfo(universalAmd64, version, {
      run,
      commit,
      expectedGoos: "darwin",
      expectedGoarch: "amd64",
    });
    assertGoBuildInfo(universalArm64, version, {
      run,
      commit,
      expectedGoos: "darwin",
      expectedGoarch: "arm64",
    });

    verifyDarwinSignature(darwinAmd64, { run });
    verifyDarwinSignature(darwinArm64, { run });
    verifyDarwinSignature(darwinUniversal, { run, arch: "x86_64" });
    verifyDarwinSignature(darwinUniversal, { run, arch: "arm64" });

    if (hostArch === "arm64") assertVersionCommand(darwinArm64, version, run);
    else assertVersionCommand(darwinAmd64, version, run);
    assertVersionCommand(darwinUniversal, version, run);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    releaseId: releaseId ? Number(releaseId) : null,
    tag,
    commit,
    version,
    hostArch,
    manifestDigest: metadata ? releaseManifestDigest(metadata) : null,
  };
}

function main() {
  assertNoReleaseCredentials();
  const args = parseCliArgs(process.argv.slice(2));
  for (const required of ["dir", "tag", "commit"]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  const result = verifyCandidateDirectory({
    candidateDir: args.dir,
    tag: args.tag,
    commit: args.commit,
    releaseId: args["release-id"],
    expectedHostArch: args["host-arch"],
  });
  const manifest = result.manifestDigest ? ` manifest_sha256=${result.manifestDigest}` : "";
  const marker =
    `VERIFIED_ARCH arch=${result.hostArch} release_id=${result.releaseId ?? "local"} ` +
    `tag=${result.tag} commit=${result.commit}` +
    manifest;
  process.stdout.write(`${marker}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
