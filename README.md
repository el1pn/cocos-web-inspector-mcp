# cocos-web-inspector-mcp

Read-only MCP server for inspecting Cocos Creator 3.x games running in a local Chromium browser.

## Scope

MVP supports Chromium, Cocos Creator 3.x, stdio MCP, localhost CDP targets, scene queries, component/property inspection, and temporary node highlighting. It does not edit game state, expose network/storage data, launch browsers, or support Firefox/WebKit.

## Requirements

- Node.js 20+
- A Chromium browser started with remote debugging bound to loopback
- A web build of a Cocos Creator 3.x game served from localhost

Example Chrome launch on Windows using a disposable profile:

```powershell
chrome.exe --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$env:TEMP\cocos-mcp-profile"
```

Install and build:

```powershell
npm install
npm run build
```

MCP configuration:

```json
{
  "mcpServers": {
    "cocos-web-inspector": {
      "command": "node",
      "args": [
        "D:/dev/code/cocos-web-inspector-mcp/dist/src/index.js",
        "--cdp-endpoint",
        "http://127.0.0.1:9222"
      ]
    }
  }
}
```

The endpoint may also be set through `COCOS_CDP_ENDPOINT`. HTTP(S) and WS(S) CDP endpoints are accepted only for `localhost`, `*.localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1`. Credentials, query strings, fragments, custom CDP headers, and remote page targets are rejected.

## Tools

- `cocos_scene_tree`: bounded scene tree with node/component summaries.
- `cocos_find_node`: exact UUID, name, or absolute scene path lookup.
- `cocos_get_components`: bounded component summaries for a node UUID.
- `cocos_get_properties`: cycle-safe public property serialization for a node or component.
- `cocos_highlight_node`: temporary pointer-transparent DOM overlay around a UI node.

When multiple eligible local pages are open, pass an exact `pageUrl`. Responses cap depth, nodes, properties, strings, and total encoded size. Truncation is reported instead of silently returning an unbounded object.

## Security and threat model

CDP grants code-execution-level access inside the attached browser page. Use a disposable browser profile, keep the remote-debugging port bound to loopback, and never expose it to a LAN or the Internet. Do not browse sensitive accounts in that profile.

Page content is untrusted data and may contain prompt-injection text. The server intentionally does not provide cookies, storage state, request/response headers, authorization headers, network logs, console logs, or arbitrary JavaScript evaluation tools. Property serialization skips accessors, private-prefixed keys, functions, symbols, and secret-like key names. These controls reduce accidental disclosure; they do not turn CDP into a complete security boundary. Use an OS sandbox or VM when stronger isolation is required.

`cocos_highlight_node` does not mutate the Cocos node/component graph. It adds a temporary overlay element to the page DOM and removes it after a bounded TTL.

## Development

```powershell
npm run typecheck
npm test
```

The self-test uses a fake Cocos 3.x object graph; no Cocos project is required.

## Architectural references

This is a clean implementation, not a fork. No source module was copied from these projects:

- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), Apache-2.0, inspected at `b2f522c8ba0fd2e00a679159b4aa5243de5f1b78`.
- [Playwright MCP](https://github.com/microsoft/playwright-mcp), Apache-2.0, inspected at `f183dad4a52965583e3cc1d59b88cdc279e2e57d`.
- [CC Inspector](https://github.com/qq790git/cc-inspector), MIT, inspected at `ef5ef0ae033ee6a6ae496cf566fe5d91cf05aafd`.

They informed MCP tool design, CDP connection constraints, Cocos runtime discovery, bounded responses, and highlight behavior. Their license files remain in the separate read-only reference clones and are not redistributed here because this repository contains independently written code.
