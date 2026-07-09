# Release

Read when: preparing official artifacts, verifying a draft, publishing a release, or handing the release to the OpenClaw Homebrew tap.

Official release objects are local, draft-first operations. The signed tag is a separate pre-draft gate because GitHub CLI would otherwise create a lightweight tag. GitHub Actions may build credential-free Linux and Windows inputs and may verify an existing draft, but it cannot sign, notarize, upload, or publish release assets. Run each mutation as a separate maintainer gate.

## Security contract

- Release commit: full SHA already reachable from the protected default branch.
- Workflow trust: both manual workflows require the protected default branch in `github.ref` and the exact workflow path in `github.workflow_ref`; protected tooling is checked out at `github.sha` and asserts that exact HEAD before use.
- Toolchain: exact Go 1.25.12; source and every final thin platform binary pass the reachable-standard-library `govulncheck` gate. Binary verification parses the exact Go build-info header, target `GOOS`/`GOARCH`, clean VCS revision, and release linker setting. Any active third-party finding remains visible and unsuppressed.
- macOS identity: exactly one Developer ID Application authority from Foundation Team `FWJYW4S8P8`.
- macOS identifier: `org.openclaw.wacli` on every thin and universal binary.
- macOS signing: trusted timestamp, hardened runtime, and the exact embedded designated requirement `designated => identifier "org.openclaw.wacli" and anchor apple generic and certificate leaf[subject.OU] = "FWJYW4S8P8"` on both final thin binaries, then again on the post-`lipo` universal binary.
- Notarization: `xcrun notarytool` with the runtime `NOTARYTOOL_KEYCHAIN_PROFILE`; the repository stores no notary credentials or profile name. Standalone binaries prove the online ticket with `codesign --verify --strict --check-notarization -R=notarized`.
- Cross-platform provenance: the local downloader authenticates the exact protected workflow path/ID/head SHA, run/attempt/event/ref, candidate commit/version inputs, artifact ID/name/GitHub digest, embedded provenance, and per-asset hashes before the local preparer accepts Linux or Windows bytes.
- Draft verification: separate native arm64 and x86_64 jobs from the current protected-default-branch tooling check the exact release ID, tag, commit, changelog-derived title and notes, per-binary VCS revision and clean-build bit, asset inventory, checksums, archive contents, Go version and linker setting, `GOOS`/`GOARCH`, CLI version, architectures, authority, Team ID, identifier, exact embedded designated requirement, online notarization constraint, and native CLI version output. Universal signature metadata is inspected independently with `codesign --arch` for both slices.
- Gatekeeper: standalone CLI assets do not use `spctl --assess`, `syspolicy_check`, or `stapler` as acceptance gates. On macOS 26.5 these tools reject valid notarized standalone code because it is not an app. Gatekeeper proof is a naturally quarantined download executed on a clean VM with no security alert.
- Token boundary: the native verifier job has the scope needed to read a draft, but exposes `github.token` only as `GH_TOKEN` in the exact asset-download step. Checkout never persists credentials. Verification and candidate execution run under `env -i` with no GitHub, Actions, Homebrew, signing, or notarization credential.
- Tag and publication: a separate local gate creates and pushes an annotated signed tag at the exact verified commit. Publication requires its exact local and remote tag objects and GitHub's valid signature verification before and after changing the draft state. No workflow can publish unsigned Darwin assets.
- Homebrew: the existing OpenClaw tap handoff is bound to the exact public release ID, commit, verified manifest, signed tag, non-prerelease state, inventory, and downloaded checksums. The local closeout authenticates the tap workflow path and ID, verifies the resulting formula, and performs a clean install and formula test.

The normal `pnpm build`, GoReleaser checks, snapshot builds, and Linux/Windows release builds remain credential-free.

## Expected assets

The draft must contain exactly these seven assets:

- `wacli_<version>_darwin_amd64.tar.gz`
- `wacli_<version>_darwin_arm64.tar.gz`
- `wacli_<version>_darwin_universal.tar.gz`
- `wacli_<version>_linux_amd64.tar.gz`
- `wacli_<version>_linux_arm64.tar.gz`
- `wacli_<version>_windows_amd64.zip`
- `checksums.txt`

Every archive contains only `LICENSE`, `README.md`, and `wacli` (`wacli.exe` on Windows). `checksums.txt` names every archive exactly once.

## Serialized release gates

Set the release coordinates once:

```bash
tag=v0.12.1
version=${tag#v}
commit=$(git rev-parse HEAD)
```

Before any official build, date the matching changelog section, commit it, push protected `main`, and confirm `commit` is the full release SHA.

### 1. Credential-free cross-platform build

Dispatch the workflow from protected `main`, never from the candidate ref:

```bash
gh workflow run release.yml \
  --repo openclaw/wacli \
  --ref main \
  -f commit="$commit" \
  -f version="$version"
```

After it succeeds, record the exact workflow run ID, artifact ID, and protected workflow head SHA. Run the authenticated downloader with `GH_TOKEN` injected only for this process:

```bash
node scripts/download-cross-platform-assets.mjs \
  --run-id "$cross_run_id" \
  --artifact-id "$cross_artifact_id" \
  --workflow-sha "$cross_workflow_sha" \
  --commit "$commit" \
  --version "$version" \
  --output /path/to/authenticated-cross-assets
```

The downloader uses only GitHub `GET` requests, validates the exact workflow/run/artifact provenance and digest, and prints `AUTHENTICATED_CROSS_PLATFORM manifest_sha256=<sha256> ...`. Record that digest as `cross_manifest`, then remove `GH_TOKEN` from the environment before any build, verification, or execution. The artifact contains only credential-free Linux and Windows archives plus provenance metadata; it is not a GitHub Release and cannot publish anything.

### 2. Local Darwin build, signing, and notarization

Run the local preparer through the `release-mac-app` skill's `mac-release codesign-run` wrapper so the dedicated Developer ID keychain is bounded and restored. Set `MAC_RELEASE` to that skill's `scripts/mac-release` helper. Supply `MAC_RELEASE_CODESIGN_IDENTITY` and `NOTARYTOOL_KEYCHAIN_PROFILE` only at runtime through approved credential handling.

```bash
"$MAC_RELEASE" codesign-run -- \
  node scripts/release-local.mjs prepare \
    --tag "$tag" \
    --commit "$commit" \
    --cross-platform-dir /path/to/authenticated-cross-assets \
    --cross-platform-manifest-sha256 "$cross_manifest" \
    --output "dist/release/$tag"
```

Preparation is local and fail-closed. It completes source and every thin platform binary vulnerability check, signs both Darwin thin binaries, creates and signs the universal binary, submits one ZIP containing all three final Darwin binaries to `notarytool`, verifies the online notarization constraint, assembles all seven assets, and re-verifies the complete candidate before moving it into the output directory. It performs no GitHub or Homebrew mutation.

### 3. Create and verify the signed release tag

After local preparation has produced the complete verified candidate, create the annotated signed tag at the exact release commit:

```bash
node scripts/release-local.mjs tag \
  --tag "$tag" \
  --commit "$commit" \
  --candidate-dir "dist/release/$tag" \
  --confirm-signed-tag "$tag"
```

The command re-verifies the candidate without release credentials before any tag mutation, refuses an existing local or remote tag, verifies the local signature and annotation, pushes only the exact tag ref, and confirms the remote annotated object and peeled commit. Record the tag object SHA.

### 4. Create the private draft

The draft command re-verifies the local candidate and the exact signed local, remote, and GitHub tag objects before its first release mutation. It uses `gh release create --verify-tag`, so GitHub cannot infer or create a lightweight tag.

```bash
node scripts/release-local.mjs draft \
  --tag "$tag" \
  --commit "$commit" \
  --candidate-dir "dist/release/$tag"
```

Record the exact numeric draft release ID printed by the command.

### 5. Native protected-branch verification

Dispatch the verifier from protected `main`; selected-ref dispatches are rejected.

```bash
gh workflow run release-verify.yml \
  --repo openclaw/wacli \
  --ref main \
  -f release_id="$release_id" \
  -f tag="$tag" \
  -f commit="$commit"
```

Record the successful verifier run ID and its exact protected workflow head SHA as `verifier_head`. Publication authenticates the numeric workflow ID and exact `.github/workflows/release-verify.yml` path in addition to that SHA; display names and branch names alone are insufficient. The workflow must complete separate arm64 and x86_64 native jobs. Its log must contain both exact architecture markers:

```text
VERIFIED_ARCH arch=arm64 release_id=<id> tag=<tag> commit=<full-sha> manifest_sha256=<sha256>
VERIFIED_ARCH arch=x86_64 release_id=<id> tag=<tag> commit=<full-sha> manifest_sha256=<sha256>
```

### 6. Clean-VM Gatekeeper proof

On a clean macOS 26.5 VM, obtain the exact draft archive through a normal download path that naturally applies quarantine. Do not synthesize quarantine with `xattr`. Execute the host-compatible thin binary and the universal binary, confirm `wacli --version` reports the release version, and confirm macOS presents no Gatekeeper security alert. This is an attribution gate: signing `wacli` still says nothing about the random temporary Swift script used by Contacts import.

Do not use standalone-binary `spctl`, `syspolicy_check`, or `stapler` output as proof. Preserve the VM version, natural-download path, archive checksum, tested binary architecture, command output, and no-alert observation in the private release record.

### 7. Publish the verified draft

Set `release_manifest` to the identical manifest SHA-256 printed by both native verifier jobs. Publication requires the exact successful verifier run, the verifier head still being the current protected default-branch SHA, the signed tag, the clean-VM proof, and explicit confirmations equal to the tag:

```bash
node scripts/release-local.mjs publish \
  --release-id "$release_id" \
  --tag "$tag" \
  --commit "$commit" \
  --verifier-run "$verifier_run" \
  --verifier-head "$verifier_head" \
  --confirm-publish "$tag" \
  --confirm-gatekeeper-vm "$tag"
```

The command authenticates the workflow's numeric ID and exact path, requires separate exact arm64 and x86_64 markers, verifies the signed annotated tag through Git and GitHub, publishes the exact release ID, and rechecks the signed tag. If protected `main` advances after native verification, rerun the verifier at the new head rather than accepting historical evidence.

### 8. Verify the public release and hand off Homebrew

Use a clean Homebrew host where `brew list --versions wacli` reports no installation. The command downloads the exact release assets by ID, checks GitHub digests and `checksums.txt`, revalidates the signed tag and manifest, dispatches and authenticates the existing OpenClaw tap workflow, checks the four target-specific formula URLs and SHA-256 values, then taps, installs, and tests the formula:

```bash
node scripts/release-local.mjs homebrew \
  --release-id "$release_id" \
  --tag "$tag" \
  --commit "$commit" \
  --manifest-sha256 "$release_manifest" \
  --confirm-clean-homebrew-host "$tag"
```

The final `HOMEBREW_VERIFIED` marker records the release, manifest, signed tag object, and exact tap run. Then open the changelog's next patch section as `Unreleased` and commit that closeout separately.

## Contacts permission caveat

`contacts import-system` currently writes its embedded Swift source to a random temporary directory and runs that script with `swift`/`xcrun`. Signing `wacli` does not give that temporary helper a stable code identity and must not be described as stabilizing macOS Contacts permission. A clean-machine VM attribution test remains an explicit release gate; packaging a stable helper is a separate design change.
