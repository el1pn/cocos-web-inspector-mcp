# Compatibility

## Verified fixtures

CI runs the live Chromium/CDP integration test against each vendored snapshot.

| Cocos Creator | Build target | Snapshot | Coverage |
| --- | --- | --- | --- |
| 3.8.8 | Web Mobile debug | [cocos-3.8.8](../test/fixtures/cocos-3.8.8/) | Live Chromium/CDP inspection, opt-in mutations, bounds, capture, snapshots, diagnostics, node picker, stats overlay, device emulation |
| 3.8.8 | Web Mobile production/minified | [cocos-3.8.8-production](../test/fixtures/cocos-3.8.8-production/) | Checksum-validated live Chromium/CDP scene, component type and UUID, `componentType` search, property, redaction, getter-safety, active-state, node picker, and stats overlay canaries |
| 3.8.3 | Web Mobile debug | [cocos-3.8.3](../test/fixtures/cocos-3.8.3/) | Same as 3.8.8 debug |
| 3.7.4 | Web Mobile debug | [cocos-3.7.4](../test/fixtures/cocos-3.7.4/) | Same as 3.8.8 debug |

The debug fixture contract is [fixture-manifest.json](../test/fixtures/cocos-3.8.8/fixture-manifest.json). Production provenance and checksum are vendored at [fixture-production-provenance.json](../test/fixtures/cocos-3.8.8-production/fixture-production-provenance.json) and [build-production-checksums.sha256](../test/fixtures/cocos-3.8.8-production/build-production-checksums.sha256). The fixture project lives in [fixture/](../fixture/); `fixture/build.sh <version>` rebuilds `test/fixtures/cocos-<version>` and its checksum manifest on macOS or Git Bash on Windows. The script avoids building under `/tmp`, a symlink to `/private/tmp` on macOS that makes Creator 3.8.3 drop custom scripts with `Missing class`.

## Manually verified versions

| Cocos Creator | Build target | Verified on | Coverage |
| --- | --- | --- | --- |
| 3.6.3 | Web Mobile debug | 2026-10-06, fixture commit `9ea51ff`, package 1.0.0 | Same as 3.8.8 debug for the 1.x tools. The 2.0 node picker, stats overlay, and device emulation were never run on 3.6.3 |

The 3.6.3 engine ships under a proprietary license (`licenses/ENGINE_license.txt`) that forbids redistribution, so its build is not vendored and CI does not guard it. To recheck, install Creator 3.6.3, run `fixture/build.sh 3.6.3`, add `'3.6.3'` to `creatorVersions` in `test/integration-test.ts`, run `npm run test:integration`, and delete the snapshot afterward. The 2.0 tools rely on `cc.profiler`, `cc.internal.Renderable2D`, `_uiProps._localOpacity`, and `__classname__`. A source read of the 3.6.3 engine found the first three; none was exercised at runtime.

## Real-game checks

Package 2.0.1 was also run against a production Cocos Creator 3.8.8 game, outside CI: the editor browser preview (login scene, 53 nodes) and a minified Web Mobile release build (maintenance scene, 34 nodes). `launch`, `doctor`, the node picker, the stats overlay, device emulation, and `componentType` search behaved as documented. These runs found the invisible-blocker, `navigator.platform`, and minified-component-name bugs fixed in 2.0.1.

## Current limits

- Cocos Creator releases older than 3.6.3: unverified. Cocos Creator 2.x is rejected.
- Frame stepping: `cc.game.step`, `director.getTotalFrames`, and `director.pause`/`resume` are public and behave identically on 3.6.3, 3.7.4, 3.8.3, and 3.8.8 (verified live: N steps run N logic ticks, the game stays paused).
- Render metrics: `root.fps`/`frameTime` and `device.numDrawCalls`/`numTris`/`numInstances` exist with the same backing fields on 3.6.3, 3.7.4, 3.8.3, and 3.8.8 and update with the profiler hidden. Generic invalid-component-reference diagnostics remain unavailable.

## Supported operations for 3.8.8 fixture

Inspector mode: page discovery, runtime info, scene tree, node search/context/components/properties, bounds, temporary highlight, node capture, snapshots, hierarchy diagnostics, node picker.

Runtime debugger mode (`--allow-runtime-mutation`): node activation, selected transforms, bounded public component properties, click, pause, resume, frame stepping, stats overlay, and device emulation. Runtime changes are not transactional and disappear after reload.

Commands: `launch` and `doctor` run outside the MCP server and need no Cocos-specific API.
