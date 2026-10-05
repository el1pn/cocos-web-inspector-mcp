# Compatibility

## Verified fixture

| Cocos Creator | Build target | Status | Coverage |
| --- | --- | --- | --- |
| 3.8.8 | Web Mobile debug | Verified | Live Chromium/CDP inspection, opt-in mutations, bounds, capture, snapshots, diagnostics |
| 3.8.8 | Web Mobile production/minified | Verified | Checksum-validated live Chromium/CDP scene, component UUID, property, redaction, getter-safety, and active-state canaries |

The debug fixture contract is [fixture-manifest.json](../test/fixtures/cocos-3.8.8/fixture-manifest.json). Production provenance and checksum are vendored at [fixture-production-provenance.json](../test/fixtures/cocos-3.8.8-production/fixture-production-provenance.json) and [build-production-checksums.sha256](../test/fixtures/cocos-3.8.8-production/build-production-checksums.sha256). The fixture project lives in [fixture/](../fixture/); `fixture/build.sh` rebuilds a snapshot and its checksum manifest.

## Manually verified versions

These were verified live but are not vendored, so CI does not guard them. Each build came from the fixture project (source commit `58fec3ca0daaafa35f2470fb4785319ee0535cbc`, now `fixture/`) with only `package.json` `creator.version` changed, built headlessly as Web Mobile debug with `build-dev.json`.

| Cocos Creator | Build target | Verified on | Coverage |
| --- | --- | --- | --- |
| 3.8.3 | Web Mobile debug | 2026-10-05, MCP 0.1.7 | Every inspector and runtime debugger tool, including display fields, click, wait, inactive bounds, redaction, and getter safety |
| 3.7.4 | Web Mobile debug | 2026-10-05, MCP 0.1.7 | Same as 3.8.3 |
| 3.6.3 | Web Mobile debug | 2026-10-05, MCP 0.1.7 | Same as 3.8.3 |

To reproduce, run `fixture/build.sh <version>`; it vendors `test/fixtures/cocos-<version>` for a manual check (git-ignored). The script avoids building under `/tmp`, a symlink to `/private/tmp` on macOS that makes Creator 3.8.3 drop custom scripts with `Missing class`.

## Current limits

- Cocos Creator releases older than 3.6.3: unverified. Cocos Creator 2.x is rejected.
- Frame stepping: `cc.game.step`, `director.getTotalFrames`, and `director.pause`/`resume` are public and behave identically on 3.6.3, 3.7.4, 3.8.3, and 3.8.8 (verified live: N steps run N logic ticks, the game stays paused).
- Render metrics: `root.fps`/`frameTime` and `device.numDrawCalls`/`numTris`/`numInstances` exist with the same backing fields on 3.6.3, 3.7.4, 3.8.3, and 3.8.8 and update with the profiler hidden. Generic invalid-component-reference diagnostics remain unavailable.

## Supported operations for 3.8.8 fixture

Inspector mode: page discovery, runtime info, scene tree, node search/context/components/properties, bounds, temporary highlight, node capture, snapshots, hierarchy diagnostics.

Runtime debugger mode (`--allow-runtime-mutation`): node activation, selected transforms, bounded public component properties, pause, resume, and frame stepping. Runtime changes are not transactional and disappear after reload.
