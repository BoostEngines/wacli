#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractReleaseNotes } from "./extract-release-notes.mjs";
import {
  RELEASE_REPOSITORY,
  assertCommit,
  assertExactInventory,
  parseCliArgs,
  releaseAssetNames,
  runCommand,
  sha256File,
  versionFromTag,
} from "./release-common.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);

function assertOutputDirectory(outputDir) {
  if (fs.existsSync(outputDir)) {
    const entries = fs.readdirSync(outputDir);
    if (entries.length > 0) throw new Error(`download directory is not empty: ${outputDir}`);
  } else {
    fs.mkdirSync(outputDir, { recursive: true });
  }
}

export function downloadAsset(asset, outputDir) {
  const destination = path.join(outputDir, asset.name);
  const fd = fs.openSync(destination, "wx", 0o600);
  try {
    const result = spawnSync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "--header",
        "Accept: application/octet-stream",
        `/repos/${RELEASE_REPOSITORY}/releases/assets/${asset.id}`,
      ],
      {
        env: process.env,
        stdio: ["ignore", fd, "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`download ${asset.name} failed: ${String(result.stderr ?? "").trim()}`);
    }
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(destination);
    throw error;
  }
  fs.closeSync(fd);

  const size = fs.statSync(destination).size;
  if (size !== asset.size) {
    throw new Error(`${asset.name} size mismatch after download: expected ${asset.size}, got ${size}`);
  }
  if (asset.digest) {
    const [algorithm, expected] = asset.digest.split(":", 2);
    if (algorithm !== "sha256" || !/^[0-9a-f]{64}$/.test(expected ?? "")) {
      throw new Error(`${asset.name} has malformed GitHub digest ${JSON.stringify(asset.digest)}`);
    }
    const actual = sha256File(destination);
    if (actual !== expected) throw new Error(`${asset.name} GitHub digest mismatch`);
  }
}

function normalizeReleaseBody(body) {
  return `${String(body ?? "").replace(/\r\n/g, "\n").trimEnd()}\n`;
}

function validateReleaseIdentity(metadata, { releaseId, tag, commit, version, expectedBody }, label) {
  if (Number(metadata.id) !== Number(releaseId)) throw new Error(`GitHub returned the wrong ${label} ID`);
  if (metadata.tag_name !== tag) throw new Error(`${label} tag mismatch`);
  if (metadata.target_commitish !== commit) throw new Error(`${label} target commit mismatch`);
  if (metadata.name !== `wacli ${tag}`) throw new Error(`${label} title mismatch`);
  if (normalizeReleaseBody(metadata.body) !== normalizeReleaseBody(expectedBody)) {
    throw new Error(`${label} notes do not match the selected commit changelog`);
  }
  const assets = metadata.assets ?? [];
  assertExactInventory(
    assets.map((asset) => asset.name),
    releaseAssetNames(version),
    `${label} asset`,
  );
  for (const asset of assets) {
    if (!Number.isInteger(asset.id) || asset.id <= 0 || !Number.isInteger(asset.size) || asset.size <= 0) {
      throw new Error(`${label} asset metadata is incomplete for ${asset.name}`);
    }
    if (asset.state !== "uploaded") throw new Error(`${label} asset ${asset.name} is not fully uploaded`);
  }
  return assets;
}

export function validateDraftMetadata(metadata, { releaseId, tag, commit, version, expectedBody }) {
  if (metadata.draft !== true || metadata.prerelease !== false || metadata.published_at !== null) {
    throw new Error("candidate release must still be an unpublished draft");
  }
  return validateReleaseIdentity(
    metadata,
    { releaseId, tag, commit, version, expectedBody },
    "draft release",
  );
}

export function validatePublishedReleaseMetadata(
  metadata,
  { releaseId, tag, commit, version, expectedBody },
) {
  if (
    metadata.draft !== false ||
    metadata.prerelease !== false ||
    typeof metadata.published_at !== "string" ||
    !Number.isFinite(Date.parse(metadata.published_at))
  ) {
    throw new Error("Homebrew handoff requires a published, non-prerelease release");
  }
  return validateReleaseIdentity(
    metadata,
    { releaseId, tag, commit, version, expectedBody },
    "published release",
  );
}

function main() {
  if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required only for the download step");
  const args = parseCliArgs(process.argv.slice(2));
  for (const required of ["release-id", "tag", "commit", "output"]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }

  const releaseId = Number(args["release-id"]);
  if (!Number.isInteger(releaseId) || releaseId <= 0) throw new Error("--release-id must be a positive integer");
  const version = versionFromTag(args.tag);
  assertCommit(args.commit);
  const outputDir = path.resolve(args.output);
  assertOutputDirectory(outputDir);

  const response = runCommand("gh", [
    "api",
    "--method",
    "GET",
    `/repos/${RELEASE_REPOSITORY}/releases/${releaseId}`,
  ]);
  const metadata = JSON.parse(response.stdout);
  const changelog = runCommand("git", ["show", `${args.commit}:CHANGELOG.md`], {
    cwd: repoRoot,
  }).stdout;
  const expectedBody = extractReleaseNotes(changelog, args.tag);
  const assets = validateDraftMetadata(metadata, {
    releaseId,
    tag: args.tag,
    commit: args.commit,
    version,
    expectedBody,
  });

  for (const name of releaseAssetNames(version)) {
    downloadAsset(assets.find((asset) => asset.name === name), outputDir);
  }

  const safeMetadata = {
    release_id: releaseId,
    tag: args.tag,
    commit: args.commit,
    draft: true,
    prerelease: false,
    assets: assets.map(({ id, name, size, digest }) => ({ id, name, size, digest: digest ?? null })),
  };
  fs.writeFileSync(path.join(outputDir, "release.json"), `${JSON.stringify(safeMetadata, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release download failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
