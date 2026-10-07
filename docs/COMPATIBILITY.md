# Compatibility

## Verified fixtures

CI runs the live Chromium/CDP integration test against each vendored snapshot.

| Cocos Creator | Build target | Snapshot | Coverage |
| --- | --- | --- | --- |
| 3.8.8 | Web Mobile debug | [cocos-3.8.8](../test/fixtures/cocos-3.8.8/) | Live Chromium/CDP inspection, opt-in mutations, bounds, capture, snapshots, diagnostics, node picker, stats overlay, device emulation, and runtime-built EditBox, ScrollView, and Mask for text input, drag, and batch analysis |
| 3.8.8 | Web Mobile production/minified | [cocos-3.8.8-production](../test/fixtures/cocos-3.8.8-production/) | Checksum-validated live Chromium/CDP scene, component type and UUID, `componentType` search, property, redaction, getter-safety, active-state, node picker, and stats overlay canaries |
| 3.8.3 | Web Mobile debug | [cocos-3.8.3](../test/fixtures/cocos-3.8.3/) | Same as 3.8.8 debug |
| 3.7.4 | Web Mobile debug | [cocos-3.7.4](../test/fixtures/cocos-3.7.4/) | Same as 3.8.8 debug |

The debug fixture contract is [fixture-manifest.json](../test/fixtures/cocos-3.8.8/fixture-manifest.json). Production provenance and checksum are vendored at [fixture-production-provenance.json](../test/fixtures/cocos-3.8.8-production/fixture-production-provenance.json) and [build-production-checksums.sha256](../test/fixtures/cocos-3.8.8-production/build-production-checksums.sha256). The fixture project lives in [fixture/](../fixture/); `fixture/build.sh <version>` rebuilds `test/fixtures/cocos-<version>` and its checksum manifest on macOS or Git Bash on Windows. The script avoids building under `/tmp`, a symlink to `/private/tmp` on macOS that makes Creator 3.8.3 drop custom scripts with `Missing class`.

## Real-game checks

Package 2.0.1 was also run against a production Cocos Creator 3.8.8 game, outside CI: the editor browser preview (login scene, 53 nodes) and a minified Web Mobile release build (maintenance scene, 34 nodes). `launch`, `doctor`, the node picker, the stats overlay, device emulation, and `componentType` search behaved as documented. These runs found the invisible-blocker, `navigator.platform`, and minified-component-name bugs fixed in 2.0.1.

The unreleased input and batch tools were run over stdio against a Web Mobile debug build of the same game (login scene, 55 nodes, with its own popups instantiated from `resources`). `cocos_type_text` filled a username and a password EditBox, the password never appeared in tool output, and inactive tab fields reported `INACTIVE`. `cocos_drag_node` scrolled a populated ScrollView by 533 px. `cocos_analyze_batches` reported 22 batches for 23 draw calls on the login scene, every break caused by texture, and on a popup with a masked ScrollView reported the Mask's Graphics as `MASK` and the following labels as `STENCIL`. `cocos_dynamic_atlas` showed the game ships with the dynamic atlas disabled; enabled at runtime for the check, it packed 12 login sprites into one 2048² page (fill 0.19) and excluded the 1920×1080 background as `TOO_LARGE`. `cocos_asset_report` found 37 unused assets on the login scene, 23 of them used by the previous scene and not yet released, and 183 after a popup loaded from `resources` was destroyed without releasing its assets, led by its full-screen textures. With `--allow-browser-data`, startup on the same build produced 24 console messages and 54 requests; the tools surfaced the two 503 responses from the game's staging API with their JSON bodies, masked access and refresh tokens inside a JSON localStorage value and inside a console log line, and returned no cookie values. With `--allow-method-call`, `cocos_call_method` called engine methods on the game's components, toggled its terms checkbox through `Toggle.setIsCheckedWithoutNotify`, refused `destroy` and getter names, and called the login controller's sign-in handler, which the game itself declined while its maintenance popup held the screen, as the console showed. Every single-node tool accepted real scene paths in place of UUIDs. `cocos_explain_click` showed that a tap anywhere on the maintenance scene is claimed by the full-screen popup's `BlockInputEvents` view, and that the guest login button on the login scene is clickable. `cocos_listener_report` found 33 callbacks without a Cocos owner on the login scene, all engine or SDK registrations, and no growth after opening and closing a popup three times. `cocos_set_time_scale` ran 3.01 game seconds per real second at scale 3 and 0.99 after reset, and a click right after `cocos_emulate_device` landed without waiting.

## Current limits

- Supported range is Cocos Creator 3.7.4 through 3.8.8, the versions CI guards. Older 3.x releases are unsupported: 3.6.3 passed the 1.x tools manually in package 1.0.0, but its engine license forbids vendoring a build, so CI cannot guard it and the 2.0 tools never ran on it. Cocos Creator 2.x is rejected.
- Frame stepping: `cc.game.step`, `director.getTotalFrames`, and `director.pause`/`resume` are public and behave identically on 3.7.4, 3.8.3, and 3.8.8 (verified live: N steps run N logic ticks, the game stays paused).
- Render metrics: `root.fps`/`frameTime` and `device.numDrawCalls`/`numTris`/`numInstances` exist with the same backing fields on 3.7.4, 3.8.3, and 3.8.8 and update with the profiler hidden. Generic invalid-component-reference diagnostics remain unavailable.

## Supported operations for 3.8.8 fixture

Inspector mode: page discovery, runtime info, scene tree, node search/context/components/properties, bounds, temporary highlight, node capture, snapshots, hierarchy diagnostics, node picker, dynamic atlas report, and asset report (private `DynamicAtlasManager`, `Atlas`, `Cache`, and `Asset._ref` fields, verified on 3.7.4, 3.8.3, and 3.8.8).

Runtime debugger mode (`--allow-runtime-mutation`): node activation, selected transforms, bounded public component properties, click, drag, EditBox text input, pause, resume, frame stepping, stats overlay, device emulation, and draw-batch analysis (private `Batcher2D` fields, verified on 3.7.4, 3.8.3, and 3.8.8). Runtime changes are not transactional and disappear after reload.

Commands: `launch` and `doctor` run outside the MCP server and need no Cocos-specific API.
