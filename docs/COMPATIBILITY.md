# Compatibility

## Verified fixtures

CI runs the live Chromium/CDP integration test against each vendored snapshot.

| Cocos Creator | Build target | Snapshot | Coverage |
| --- | --- | --- | --- |
| 3.8.8 | Web Mobile debug | [cocos-3.8.8](../test/fixtures/cocos-3.8.8/) | Live Chromium/CDP inspection, opt-in mutations, bounds, capture, snapshots, diagnostics |
| 3.8.8 | Web Mobile production/minified | [cocos-3.8.8-production](../test/fixtures/cocos-3.8.8-production/) | Checksum-validated live Chromium/CDP scene, component UUID, property, redaction, getter-safety, and active-state canaries |
| 3.8.3 | Web Mobile debug | [cocos-3.8.3](../test/fixtures/cocos-3.8.3/) | Same as 3.8.8 debug |
| 3.7.4 | Web Mobile debug | [cocos-3.7.4](../test/fixtures/cocos-3.7.4/) | Same as 3.8.8 debug |

The debug fixture contract is [fixture-manifest.json](../test/fixtures/cocos-3.8.8/fixture-manifest.json). Production provenance and checksum are vendored at [fixture-production-provenance.json](../test/fixtures/cocos-3.8.8-production/fixture-production-provenance.json) and [build-production-checksums.sha256](../test/fixtures/cocos-3.8.8-production/build-production-checksums.sha256). The fixture project lives in [fixture/](../fixture/); `fixture/build.sh <version>` rebuilds `test/fixtures/cocos-<version>` and its checksum manifest on macOS or Git Bash on Windows. The script avoids building under `/tmp`, a symlink to `/private/tmp` on macOS that makes Creator 3.8.3 drop custom scripts with `Missing class`.

## Manually verified versions

| Cocos Creator | Build target | Verified on | Coverage |
| --- | --- | --- | --- |
| 3.6.3 | Web Mobile debug | 2026-10-06, fixture commit `9ea51ff` | Same as 3.8.8 debug |

The 3.6.3 engine ships under a proprietary license (`licenses/ENGINE_license.txt`) that forbids redistribution, so its build is not vendored and CI does not guard it. To recheck, run `fixture/build.sh 3.6.3`, add `'3.6.3'` to `creatorVersions` in `test/integration-test.ts`, run `npm run test:integration`, and delete the snapshot afterward.

## Current limits

- Cocos Creator releases older than 3.6.3: unverified. Cocos Creator 2.x is rejected.
- Frame stepping: `cc.game.step`, `director.getTotalFrames`, and `director.pause`/`resume` are public and behave identically on 3.6.3, 3.7.4, 3.8.3, and 3.8.8 (verified live: N steps run N logic ticks, the game stays paused).
- Render metrics: `root.fps`/`frameTime` and `device.numDrawCalls`/`numTris`/`numInstances` exist with the same backing fields on 3.6.3, 3.7.4, 3.8.3, and 3.8.8 and update with the profiler hidden. Generic invalid-component-reference diagnostics remain unavailable.

## Supported operations for 3.8.8 fixture

Inspector mode: page discovery, runtime info, scene tree, node search/context/components/properties, bounds, temporary highlight, node capture, snapshots, hierarchy diagnostics.

Runtime debugger mode (`--allow-runtime-mutation`): node activation, selected transforms, bounded public component properties, pause, resume, and frame stepping. Runtime changes are not transactional and disappear after reload.
