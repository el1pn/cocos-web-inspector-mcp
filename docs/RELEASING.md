# Releasing

Publishing is a reviewed manual action. Do not publish from an uncommitted working tree.

1. Update the package version and [CHANGELOG.md](../CHANGELOG.md).
2. Run:

   ```powershell
   npm ci
   npm run check
   npm pack --dry-run
   ```

3. Inspect the package contents and confirm the installed-package smoke test passed.
4. Commit the reviewed version/changelog changes, create a reviewed `v<version>` tag, and push it.
5. The tag-only GitHub release workflow reruns the full gate before `npm publish --provenance`. It requires configured npm trusted publishing and approval for the `npm` GitHub environment.
6. Verify the published package and create release notes after the workflow succeeds.

Do not bypass tests, package review, GitHub environment approval, or npm provenance.
