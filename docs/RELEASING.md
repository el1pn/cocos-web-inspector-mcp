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
5. The tag-only GitHub release workflow reruns the full gate on Node.js 24 before `npm publish`. It authenticates through npm trusted publishing (OIDC) in the `npm` GitHub environment.
6. npm may take a few minutes to serve the new version. Verify with `npm view cocos-web-inspector-mcp dist-tags.latest --prefer-online`, then create release notes.

Provenance is off while the repository is private: sigstore verification requires a public source repository. Re-add `--provenance` to the workflow when the repository becomes public.

Do not bypass tests, package review, or GitHub environment approval.
