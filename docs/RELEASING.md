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
5. The tag-only GitHub release workflow reruns the full gate on Node.js 24 before `npm publish --provenance`. It authenticates through npm trusted publishing (OIDC) in the `npm` GitHub environment, which accepts only `v*` tags and waits for a required reviewer to approve the deployment in the Actions run.
6. npm may take a few minutes to serve the new version. Verify with `npm view cocos-web-inspector-mcp dist-tags.latest --prefer-online`, then create release notes.

`main` is protected by a ruleset: no deletion, no force push, and every CI check must pass. Repository admins can bypass it; do so only deliberately.

Do not bypass tests, package review, GitHub environment approval, or npm provenance.
