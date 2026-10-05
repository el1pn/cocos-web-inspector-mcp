# cocos-web-inspector-fixture

Cocos Creator 3.8.8 project that produces the vendored web builds used by `cocos-web-inspector-mcp` integration tests.

`assets/scenes/InspectorTest.scene` holds the canaries listed in `fixture-manifest.json`: the `InspectorFixture` component (public values, a redacted `details.password`, a throwing `mustNotRun` getter) and one each of Label, Button, Sprite, Toggle, and RichText.

## Regenerate the scene

```sh
python3 tools/gen-scene.py tools/samples.json
```

`tools/samples.json` holds one real serialized object per `cc.*` type, copied from working 3.8.8 projects.

## Build

The first import must happen in the GUI Editor. On an empty `library/`, the headless CLI often starts without the `scene`/`typescript` importers, rewrites their `.meta` files to `"importer": "*"`, and emits a build with no scene or scripts.

1. Open the project once in Creator 3.8.8 GUI, wait for import, close it.
2. Build both variants:

```sh
for cfg in build-dev build-production; do
  env -u ELECTRON_RUN_AS_NODE /Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator \
    --project "$PWD" --build "configPath=$PWD/$cfg.json"
done
```

3. Verify each `build/*/src/settings.json` has non-empty `engine.builtinAssets` and `scripting.scriptPackages`, and that no `.meta` reads `"importer": "*"`. Rebuild if not.

Outputs: `build/inspector-web` (debug) and `build/inspector-web-production`.
