# Compatibility

## Verified fixture

| Cocos Creator | Build target | Status | Coverage |
| --- | --- | --- | --- |
| 3.8.8 | Web Mobile | Verified | Live Chromium/CDP inspection, opt-in mutations, bounds, capture, snapshots, diagnostics |

The fixture contract is [fixture-manifest.json](../test/fixtures/cocos-3.8.8/fixture-manifest.json). Its sibling-project handoff requires a checksum manifest and provenance metadata before vendored generated artifacts are updated.

## Current limits

- Other Cocos Creator versions: unverified.
- Production/minified build behavior: unverified.
- Frame stepping: unsupported; no stable public API has been verified across a compatibility matrix.
- FPS, frame time, draw calls, triangles, generic invalid-component-reference diagnostics: unavailable unless a stable passive public API is verified.

## Supported operations for 3.8.8 fixture

Inspector mode: page discovery, runtime info, scene tree, node search/context/components/properties, bounds, temporary highlight, node capture, snapshots, hierarchy diagnostics.

Runtime debugger mode (`--allow-runtime-mutation`): node activation, selected transforms, bounded public component properties, pause, and resume. Runtime changes are not transactional and disappear after reload.
