# Changelog

All notable changes are documented here.

## Unreleased

## 0.1.5

### Fixed

- Publish from Node 24 so npm trusted publishing authenticates the release; 0.1.2 through 0.1.4 were tagged but never reached npm.
- Drop `--provenance`: sigstore verification requires a public source repository, and this repo is private.

## 0.1.4

### Fixed

- Preserve production fixture bytes and parse its UTF-8 BOM checksum manifest on Linux CI.

## 0.1.3

### Fixed

- Preserve the production fixture bytes so its SHA-256 handoff verifies after a Linux checkout.

## 0.1.2

### Added

- Bounded Cocos runtime inspection, discovery, diagnostics, visual bounds, and viewport-clipped node capture.
- Opt-in runtime debugger tools for node activation, transforms, public properties, pause, and resume.
- Stateless subtree snapshots for client-side comparison.

### Security

- Loopback-only CDP/page policy, strict tool schemas, bounded output, and startup-only mutation opt-in.

## 0.1.1

- Initial npm package metadata and MCP server version consistency.
