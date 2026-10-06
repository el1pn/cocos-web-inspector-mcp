# Cocos fixture project

Cocos Creator 3.8.8 project that produces the vendored web builds in `test/fixtures/` used by the integration tests.

`assets/scenes/InspectorTest.scene` holds the canaries listed in `fixture-manifest.json`: the `InspectorFixture` component (public values, a redacted `details.password`, a throwing `mustNotRun` getter, a `staleNode` reference destroyed in `onLoad`) and one each of Label, Button, Sprite, Toggle, and RichText.

## Regenerate the scene

```sh
python3 tools/gen-scene.py tools/samples.json
```

`tools/samples.json` holds one real serialized object per `cc.*` type, copied from working 3.8.8 projects.

## Build

From the repository root, with every Cocos Creator closed:

```sh
fixture/build.sh            # 3.8.8: rebuilds and vendors test/fixtures/cocos-3.8.8 and -production
fixture/build.sh 3.7.4      # other versions: vendors test/fixtures/cocos-3.7.4 for manual checks (git-ignored)
npm run check
```

The script copies the committed `fixture/` to `~/.cache/cocos-web-inspector-fixture/<version>`, builds headlessly, rejects broken imports (`Missing class`, `"importer": "*"`, or a build without scenes/scripts), and rewrites the vendored files and SHA-256 manifest. Set `COCOS_CREATOR` for a non-default Creator path.

Pitfalls it avoids:

- A project under `/tmp` (a symlink to `/private/tmp` on macOS) makes Creator 3.8.x drop custom scripts.
- Another running Creator, or a CI runner that kills every Creator, corrupts headless imports.
- VS Code terminals export `ELECTRON_RUN_AS_NODE`, which makes Creator reject `--project`.

Commit `fixture/` changes before building; the vendored provenance records that commit.
