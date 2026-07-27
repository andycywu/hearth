# Releasing

This project uses tag-driven releases. Pushing a `v*` tag runs
`.github/workflows/release.yml`, which builds, verifies, packages the web
runtime bundles, and creates a GitHub Release.

## Cut a release

1. Update `CHANGELOG.md`: move items from **Unreleased** into a new
   `## [x.y.z] - YYYY-MM-DD` section.
2. Bump versions (root and packages) if needed.
3. Verify locally:
   ```bash
   pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test
   pnpm bundle:all && pnpm check:size
   ```
4. Tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
5. CI creates the release with `tizen-runtime.js`, `aosp-runtime.js` and
   `SHA256SUMS` attached, plus auto-generated notes.

## Signed device packages (.wgt / .apk)

These require the platform SDKs and signing material and are **not** produced in
generic CI:

- **Tizen `.wgt`:** on tooling with Tizen Studio + a signing profile —
  `pnpm bundle:tizen`, then `tizen build-web` / `tizen package -t wgt -s <profile>`
  (see `apps/tizen-app/README.md`). Attach the signed `.wgt` to the release.
- **Android `.apk`:** on tooling with the Android SDK —
  `pnpm bundle:aosp`, then `./gradlew :app:assembleRelease` with your keystore
  (see `apps/aosp-app/README.md`). For first-party TitanOS devices, sign with the
  platform key to unlock privileged controls.

## Versioning
Semantic Versioning. Breaking HAL/tool changes → major; new capabilities →
minor; fixes → patch.
