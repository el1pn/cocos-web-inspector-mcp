import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sanitizeUrl, validateLocalUrl, BrowserConnection } from '../src/browser.js';
import { captureNode, fitsResponse, inspectCocos, runBridge } from '../src/bridge.js';
import { redactBody, redactHeaders, redactText, redactUrl } from '../src/browser-data.js';
import { inspectorPort, NativeConnection, nativeNetworkRequest, nativeNetworkRequests, parseCocosLogcat } from '../src/native.js';
import { createServer } from '../src/server.js';

function fakeBrowser(pageUrl = 'http://localhost:3000') {
  let connected = true;
  let onDisconnected: (() => void) | undefined;
  const page = { url: () => pageUrl };
  const browser: any = {
    isConnected: () => connected,
    contexts: () => [{ pages: () => [page] }],
    on: (event: string, listener: () => void) => {
      if (event === 'disconnected') onDisconnected = listener;
    },
    close: async () => {
      connected = false;
      onDisconnected?.();
    },
  };
  return {
    browser,
    page,
    disconnect: () => {
      connected = false;
      onDisconnected?.();
    },
  };
}

function withFakeCocos(run: () => void): void {
  class UITransform {
    uuid = 'component-ui';
    enabled = true;
    contentSize = { width: 100, height: 40 };
    anchorPoint = { x: 0.5, y: 0.5 };
  }
  class StatsComponent {
    uuid = 'component-stats';
    enabled = true;
    count = 42;
    title = 'Player';
    tint = { r: 1, g: 2, b: 3, a: 4 };
  }
  const child: any = {
    uuid: 'child-1', name: 'Player', active: true, activeInHierarchy: true, children: [], components: [new UITransform(), new StatsComponent()],
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 },
    setPosition(x: number, y: number, z: number) { this.position = { x, y, z }; },
    setRotation(x: number, y: number, z: number, w: number) { this.rotation = { x, y, z, w }; },
    setScale(x: number, y: number, z: number) { this.scale = { x, y, z }; },
    worldPosition: { x: 50, y: 30 },
    secretToken: 'secret-token-value', accessTokens: 'access-tokens-value', refreshToken2: 'refresh-token-value', cookies: 'cookies-value', credentials: 'credentials-value',
    apiKey: 'api-key-value', APIKey: 'upper-api-key-value', apiKey2: 'numbered-api-key-value', privateKey: 'private-key-value', jwt: 'jwt-value', JWTToken: 'jwt-token-value',
    authHeader: 'auth-header-value', sessionId: 'session-value', bearerAuth: 'bearer-value', sessionScore: 12, publicValue: 7,
  };
  child.loop = child;
  const scene = { uuid: 'scene-1', name: 'Scene', active: true, activeInHierarchy: true, children: [child], components: [] };
  const previous = (globalThis as any).cc;
  let paused = false;
  (globalThis as any).cc = {
    ENGINE_VERSION: '3.8.7',
    director: { getScene: () => scene, isPaused: () => paused, pause: () => { paused = true; }, resume: () => { paused = false; } },
    view: { getVisibleSize: () => ({ width: 1280, height: 720 }), getVisibleOrigin: () => ({ x: 0, y: 0 }) },
  };
  try { run(); } finally { (globalThis as any).cc = previous; }
}

test('URL policy accepts loopback and rejects unsafe targets', () => {
  assert.equal(validateLocalUrl('http://127.0.0.1:9222').hostname, '127.0.0.1');
  assert.equal(validateLocalUrl('ws://[::1]:9222/devtools/browser/id').hostname, '[::1]');
  assert.throws(() => validateLocalUrl('https://example.com:9222'), /localhost/);
  assert.throws(() => validateLocalUrl('http://user:pass@localhost:9222'), /credentials/);
  assert.throws(() => validateLocalUrl('http://localhost:9222?token=x'), /query/);
  assert.throws(() => validateLocalUrl('file:///tmp/page', true), /protocol/);
  assert.equal(sanitizeUrl('http://user:pass@localhost:9222/path?token=x#hash'), 'http://localhost:9222/path');
});

test('browser connection shares one pending connect and reconnects after disconnect', async () => {
  const first = fakeBrowser();
  const second = fakeBrowser();
  let resolveConnect: ((browser: any) => void) | undefined;
  let calls = 0;
  const connector = () => {
    calls++;
    if (calls === 1) return new Promise<any>(resolve => { resolveConnect = resolve; });
    return Promise.resolve(second.browser);
  };
  const connection = new BrowserConnection('http://127.0.0.1:9222', 10_000, connector);
  const pending = [connection.page(), connection.page()];
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveConnect!(first.browser);
  assert.deepEqual(await Promise.all(pending), [first.page, first.page]);
  assert.equal(await connection.page(), first.page);
  assert.equal(calls, 1);

  first.disconnect();
  assert.equal(await connection.page(), second.page);
  assert.equal(calls, 2);
  await connection.close();
});

test('browser connection closes a browser resolved during shutdown', async () => {
  const connected = fakeBrowser();
  let resolveConnect: ((browser: any) => void) | undefined;
  const connection = new BrowserConnection(
    'http://127.0.0.1:9222',
    10_000,
    () => new Promise<any>(resolve => { resolveConnect = resolve; }),
  );
  const page = connection.page();
  await Promise.resolve();
  const closing = connection.close();
  resolveConnect!(connected.browser);
  await closing;
  await assert.rejects(page, /closed/);
  assert.equal(connected.browser.isConnected(), false);
  await assert.rejects(() => connection.page(), /closed/);
});

test('browser connection clears a failed pending connect for retry', async () => {
  const recovered = fakeBrowser();
  let rejectConnect: ((error: Error) => void) | undefined;
  let calls = 0;
  const connector = () => {
    calls++;
    if (calls === 1) return new Promise<any>((_resolve, reject) => { rejectConnect = reject; });
    return Promise.resolve(recovered.browser);
  };
  const connection = new BrowserConnection('http://127.0.0.1:9222', 10_000, connector);
  const pending = [connection.page(), connection.page()];
  await Promise.resolve();
  assert.equal(calls, 1);
  rejectConnect!(new Error('connect failed'));
  const failures = await Promise.allSettled(pending);
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.message === 'connect failed'));

  assert.equal(await connection.page(), recovered.page);
  assert.equal(calls, 2);
  await connection.close();
});

test('bridge traverses, finds, and lists fake Cocos data', () => withFakeCocos(() => {
  const tree = inspectCocos({ action: 'sceneTree', maxDepth: 5, maxNodes: 10 }) as any;
  assert.equal(tree.version, '3.8.7');
  assert.equal(tree.scene.children[0].uuid, 'child-1');
  const found = inspectCocos({ action: 'findNode', name: 'Player' }) as any;
  assert.equal(found.matches[0].path, '/Scene/Player');
  const listed = inspectCocos({ action: 'getComponents', uuid: 'child-1' }) as any;
  assert.equal(listed.components[0].type, 'UITransform');
  const context = inspectCocos({ action: 'getNode', uuid: 'child-1' }) as any;
  assert.equal(context.node.path, '/Scene/Player');
  const snapshot = inspectCocos({ action: 'snapshotSubtree', uuid: 'scene-1', maxDepth: 1, maxNodes: 10 }) as any;
  assert.equal(snapshot.snapshot.children[0].uuid, 'child-1');
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(inspectCocos({ action: 'getNodeBounds', uuid: 'child-1' }), { available: false, reason: 'NO_CANVAS', version: '3.8.7', uuid: 'child-1' });
  assert.equal(context.parent.uuid, 'scene-1');
  assert.equal(context.components[1].uuid, 'component-stats');
  const filtered = inspectCocos({ action: 'findNode', nameContains: 'lay', componentType: 'StatsComponent', active: true, pathPrefix: '/Scene' }) as any;
  assert.equal(filtered.matches[0].uuid, 'child-1');
  const byComponent = inspectCocos({ action: 'getProperties', uuid: 'child-1', componentUuid: 'component-stats', maxDepth: 3 }) as any;
  assert.equal(byComponent.componentType, 'StatsComponent');
  assert.equal(byComponent.properties.count, 42);
  const runtime = inspectCocos({ action: 'runtimeInfo' }) as any;
  assert.deepEqual(runtime.scene, { name: 'Scene', uuid: 'scene-1' });
  const diagnostics = inspectCocos({ action: 'runtimeDiagnostics' }) as any;
  assert.equal(diagnostics.nodeCount, 2);
  assert.equal(diagnostics.componentCount, 2);
  assert.equal(diagnostics.maxHierarchyDepth, 1);
  assert.equal(diagnostics.unavailableMetrics.fps, 'UNSUPPORTED_PUBLIC_API');
  assert.deepEqual(diagnostics.render, {});

  // Render metrics come from Root/device backing fields; their public getters must not run.
  class Device { _numDrawCalls = 12; _numTris = 340; _numInstances = 0; }
  class Root { _fps = 59; _frameTime = 0.016; _device = new Device(); }
  for (const proto of [Device.prototype, Root.prototype]) {
    for (const key of ['fps', 'frameTime', 'numDrawCalls', 'numTris', 'device']) Object.defineProperty(proto, key, { get: () => { throw new Error('metric getter ran'); } });
  }
  const director = (globalThis as any).cc.director;
  director._root = new Root();
  const rendered = inspectCocos({ action: 'runtimeDiagnostics' }) as any;
  delete director._root;
  assert.deepEqual(rendered.render, { fps: 59, frameTimeMs: 16, drawCalls: 12, triangles: 340, instances: 0 });
  assert.deepEqual(rendered.unavailableMetrics, { invalidComponentReferences: 'UNSUPPORTED_PUBLIC_API' });
  assert.deepEqual(runtime.visibleSize, { width: 1280, height: 720 });
  assert.deepEqual(runtime.director, { paused: false, running: true });
  assert.equal(runtime.nodeCount, 2);
  assert.deepEqual(inspectCocos({ action: 'setNodeActive', uuid: 'child-1', active: false }), {
    changed: true,
    target: { nodeUuid: 'child-1' },
    before: { active: true },
    after: { active: false },
    runtimeOnly: true,
  });
  assert.deepEqual(inspectCocos({ action: 'setNodeActive', uuid: 'child-1', active: false }), {
    changed: false,
    target: { nodeUuid: 'child-1' },
    before: { active: false },
    after: { active: false },
    runtimeOnly: true,
  });
  assert.deepEqual(inspectCocos({ action: 'setTransform', uuid: 'child-1', position: { x: 1, y: 2, z: 3 }, scale: { x: 2, y: 2, z: 2 } }), {
    changed: true,
    target: { nodeUuid: 'child-1' },
    before: { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    after: { position: { x: 1, y: 2, z: 3 }, scale: { x: 2, y: 2, z: 2 } },
    runtimeOnly: true,
  });
  assert.deepEqual(inspectCocos({ action: 'setProperty', uuid: 'child-1', componentUuid: 'component-stats', key: 'count', value: 7 }), {
    changed: true,
    target: { nodeUuid: 'child-1', componentUuid: 'component-stats' },
    before: { value: 42 },
    after: { value: 7 },
    runtimeOnly: true,
  });
  assert.deepEqual(inspectCocos({ action: 'setProperty', uuid: 'child-1', componentUuid: 'component-stats', key: 'tint', value: { r: 4, g: 3, b: 2, a: 1 } }), {
    changed: true,
    target: { nodeUuid: 'child-1', componentUuid: 'component-stats' },
    before: { value: { r: 1, g: 2, b: 3, a: 4 } },
    after: { value: { r: 4, g: 3, b: 2, a: 1 } },
    runtimeOnly: true,
  });
  assert.deepEqual(inspectCocos({ action: 'pause' }), { changed: true, target: {}, before: { paused: false, running: true }, after: { paused: true, running: false }, runtimeOnly: true });
  assert.deepEqual(inspectCocos({ action: 'resume' }), { changed: true, target: {}, before: { paused: true, running: false }, after: { paused: false, running: true }, runtimeOnly: true });

  // Real director.tick skips logic while director-paused, so the step must run unpaused and re-pause.
  const cc = (globalThis as any).cc;
  let frames = 0;
  const pausedDuringStep: boolean[] = [];
  cc.director.getTotalFrames = () => frames;
  cc.game = { isPaused: () => false, step: () => { pausedDuringStep.push(cc.director.isPaused()); frames++; } };
  assert.throws(() => inspectCocos({ action: 'stepFrame' }), /pause the game before stepping/);
  inspectCocos({ action: 'pause' });
  assert.deepEqual(inspectCocos({ action: 'stepFrame', frames: 3 }), { changed: true, target: {}, before: { totalFrames: 0 }, after: { totalFrames: 3 }, runtimeOnly: true });
  assert.deepEqual(pausedDuringStep, [false, false, false]);
  assert.equal(cc.director.isPaused(), true);
}));

test('property serializer avoids getters, secrets, and cycles', () => withFakeCocos(() => {
  const node = ((globalThis as any).cc.director.getScene()).children[0];
  Object.defineProperty(node, 'dangerous', { enumerable: true, get: () => { throw new Error('getter ran'); } });
  const accessorReference: any = {};
  Object.defineProperty(accessorReference, 'uuid', { enumerable: true, get: () => { throw new Error('reference getter ran'); } });
  node.accessorReference = accessorReference;
  const prototypeReference = Object.create({ uuid: 'prototype-node', children: [], name: 'Prototype Node' });
  node.prototypeReference = prototypeReference;
  // Real Cocos 3.x: uuid/children/name are prototype accessors over _id/_children/_name.
  class EngineNode { _id = 'engine-node'; _name = 'Engine Node'; _children = []; }
  class EngineComponent { _id = 'engine-comp'; node = new EngineNode(); }
  for (const proto of [EngineNode.prototype, EngineComponent.prototype]) {
    for (const key of ['uuid', 'children', 'name']) Object.defineProperty(proto, key, { get: () => { throw new Error('engine getter ran'); } });
  }
  node.engineNode = new EngineNode();
  node.engineComponent = new EngineComponent();
  const result = inspectCocos({ action: 'getProperties', uuid: 'child-1', maxDepth: 3 }) as any;
  const json = JSON.stringify(result);
  assert.equal(result.properties.publicValue, 7);
  for (const secret of ['secret-token-value', 'access-tokens-value', 'refresh-token-value', 'cookies-value', 'credentials-value', 'api-key-value', 'upper-api-key-value', 'numbered-api-key-value', 'private-key-value', 'jwt-value', 'jwt-token-value', 'auth-header-value', 'session-value', 'bearer-value']) {
    assert.equal(json.includes(secret), false);
  }
  assert.equal(result.properties.sessionScore, 12);
  assert.equal(json.includes('getter ran'), false);
  assert.deepEqual(result.properties.accessorReference, {});
  assert.deepEqual(result.properties.prototypeReference, { $type: 'Node', uuid: 'prototype-node', name: 'Prototype Node' });
  assert.equal(result.properties.loop.$type, 'Node');
  assert.deepEqual(result.properties.engineNode, { $type: 'Node', uuid: 'engine-node', name: 'Engine Node' });
  assert.deepEqual(result.properties.engineComponent, { $type: 'Component', uuid: 'engine-comp', type: 'EngineComponent' });
}));

test('property serializer flags destroyed references without isValid', () => withFakeCocos(() => {
  const node = ((globalThis as any).cc.director.getScene()).children[0];
  // Shape after CCObject._destroyImmediate: Destroyed flag set, _children/node nulled, _id kept.
  class Node { _objFlags = 1; _id = 'dead-node'; _name = ''; _children = null; }
  class Button { _objFlags = 1; _id = 'dead-button'; node = null; }
  class Label { _objFlags = 4; _id = 'pending-label'; node = new Node(); }
  for (const proto of [Node.prototype, Button.prototype, Label.prototype]) Object.defineProperty(proto, 'isValid', { get: () => { throw new Error('isValid ran'); } });
  node.staleNode = new Node();
  node.staleButton = new Button();
  node.pendingLabel = new Label();
  node.pendingLabel.node._objFlags = 0;
  const result = inspectCocos({ action: 'getProperties', uuid: 'child-1', maxDepth: 3 }) as any;
  assert.deepEqual(result.properties.staleNode, { $type: 'Node', uuid: 'dead-node', destroyed: true });
  assert.deepEqual(result.properties.staleButton, { $type: 'Button', uuid: 'dead-button', destroyed: true });
  // ToDestroy (1 << 2) is still valid until the end of the frame, matching isValid.
  assert.equal(result.properties.pendingLabel.destroyed, undefined);
}));

test('snapshot stops at the byte budget and asset references collapse', () => withFakeCocos(() => {
  const cc = (globalThis as any).cc;
  const scene = cc.director.getScene();
  scene.children = Array.from({ length: 2_000 }, (_value, index) => ({ uuid: `n-${index}`, name: 'x'.repeat(100), children: [], components: [] }));
  const snapshot = inspectCocos({ action: 'snapshotSubtree', uuid: 'scene-1', maxDepth: 2, maxNodes: 5_000 }) as any;
  assert.ok(snapshot.snapshot.children.length > 100 && snapshot.snapshot.children.length < 2_000);
  assert.deepEqual(snapshot.truncationReasons, ['RESPONSE_LIMIT']);

  class Asset {}
  class SpriteFrame extends Asset { _name = 'coin'; _uuid = 'frame-1'; vertices = { uv: [0, 1] }; }
  cc.Asset = Asset;
  const holder = { uuid: 'holder', name: 'Holder', children: [], components: [], frame: new SpriteFrame() };
  scene.children = [holder];
  const props = (inspectCocos({ action: 'getProperties', uuid: 'holder', maxDepth: 3 }) as any).properties;
  assert.deepEqual(props.frame, { $type: 'SpriteFrame', name: 'coin', uuid: 'frame-1' });
}));

test('capture downscales through CDP when quality steps still exceed the limit', async () => {
  const scales: number[] = [];
  const page: any = {
    evaluate: async (_fn: unknown, request?: unknown) => request
      ? { available: true, visible: true, clippedViewport: { x: 10, y: 20, width: 2_000, height: 1_000 } }
      : [0, 5],
    screenshot: async () => Buffer.alloc(300_000),
    context: () => ({
      newCDPSession: async () => ({
        send: async (_method: string, params: any) => {
          scales.push(params.clip.scale);
          assert.equal(params.clip.y, 25);
          return { data: 'x'.repeat(params.clip.scale > 0.5 ? 300_000 : 1_000) };
        },
        detach: async () => {},
      }),
    }),
  };
  const result = await captureNode(page, 'node') as any;
  assert.deepEqual(scales, [0.75, 0.5]);
  assert.deepEqual({ ...result, data: undefined }, { captured: true, mimeType: 'image/jpeg', data: undefined, width: 2_000, height: 1_000, scale: 0.5 });
});

test('scene tree stops traversing once maxNodes is reached', () => withFakeCocos(() => {
  const scene = (globalThis as any).cc.director.getScene();
  let reads = 0;
  scene.children = Array.from({ length: 100 }, (_value, index) => {
    const child = { uuid: `child-${index}`, name: `Child ${index}`, active: true, activeInHierarchy: true, components: [] };
    Object.defineProperty(child, 'children', { enumerable: true, get: () => { reads++; return []; } });
    return child;
  });
  const result = inspectCocos({ action: 'sceneTree', maxDepth: 5, maxNodes: 2 }) as any;
  assert.equal(result.nodeCount, 2);
  assert.equal(result.truncated, true);
  assert.equal(reads, 1);
}));

test('property serializer bounds inspected keys including skipped values', () => withFakeCocos(() => {
  const node = ((globalThis as any).cc.director.getScene()).children[0];
  for (let index = 0; index < 1_100; index++) node[`_${index}`] = index;
  const result = inspectCocos({ action: 'getProperties', uuid: 'child-1', maxDepth: 3 }) as any;
  assert.equal(result.propertyCount, 1_000);
  assert.equal(result.truncated, true);
}));

test('property serializer reports string and depth truncation', () => withFakeCocos(() => {
  const node = ((globalThis as any).cc.director.getScene()).children[0];
  node.longText = 'x'.repeat(2_001);
  node.nested = { child: { value: 1 } };
  const result = inspectCocos({ action: 'getProperties', uuid: 'child-1', maxDepth: 1 }) as any;
  assert.equal(result.properties.longText.length, 2_000);
  assert.equal(result.properties.nested, '[MaxDepth]');
  assert.equal(result.truncated, true);
}));

test('property serializer returns top-level primitives at maxDepth 0', () => withFakeCocos(() => {
  const node = ((globalThis as any).cc.director.getScene()).children[0];
  node.nested = { value: 1 };
  const result = inspectCocos({ action: 'getProperties', uuid: 'child-1', maxDepth: 0 }) as any;
  assert.equal(result.properties.publicValue, 7);
  assert.equal(result.properties.nested, '[MaxDepth]');
}));

test('property serializer exposes allowlisted display fields without getters', () => withFakeCocos(() => {
  const cc = (globalThis as any).cc;
  class Label { uuid = 'component-label'; node = {}; _string = 'Balance: 100'; _secretToken = 'hidden'; }
  Object.defineProperty(Label.prototype, 'string', { get: () => { throw new Error('getter ran'); } });
  class Button { uuid = 'component-button'; node = {}; _interactable = false; }
  class Sprite { uuid = 'component-sprite'; node = {}; _spriteFrame = { _name: 'coin', _uuid: 'frame-1', _texture: {} }; }
  Object.assign(cc, { Label, Button, Sprite });
  const node = cc.director.getScene().children[0];
  node.components.push(new Label(), new Button(), new Sprite());
  const read = (componentUuid: string) => (inspectCocos({ action: 'getProperties', uuid: 'child-1', componentUuid, maxDepth: 1 }) as any).properties;
  assert.equal(read('component-label').string, 'Balance: 100');
  assert.equal(JSON.stringify(read('component-label')).includes('hidden'), false);
  assert.equal(read('component-button').interactable, false);
  assert.deepEqual(read('component-sprite').spriteFrame, { $type: 'SpriteFrame', name: 'coin', uuid: 'frame-1' });
  assert.equal(read('component-stats').string, undefined);
}));

test('browser connection retries IPv6 loopback and hints at port collisions', async () => {
  const ipv6 = fakeBrowser();
  const tried: string[] = [];
  const connection = new BrowserConnection('http://127.0.0.1:9222', 10_000, async endpoint => {
    tried.push(endpoint);
    if (endpoint.includes('[::1]')) return ipv6.browser;
    throw new Error('Unexpected status 404');
  });
  assert.equal(await connection.page(), ipv6.page);
  assert.deepEqual(tried, ['http://127.0.0.1:9222', 'http://[::1]:9222']);
  await connection.close();
  const failing = new BrowserConnection('http://127.0.0.1:9222', 10_000, async () => { throw new Error('Unexpected status 404'); });
  await assert.rejects(() => failing.page(), /chrome:\/\/inspect/);
  await failing.close();
});

test('runBridge bounds oversized encoded responses', async () => {
  const page = { evaluate: async () => ({ payload: '\\'.repeat(100_000) }) } as any;
  assert.deepEqual(await runBridge(page, { action: 'sceneTree' }), {
    truncated: true,
    truncationReasons: ['RESPONSE_LIMIT'],
  });
});

test('bridge rejects non-3.x runtimes', () => {
  (globalThis as any).cc = { ENGINE_VERSION: '2.4.15', director: { getScene: () => ({}) } };
  assert.throws(() => inspectCocos({ action: 'sceneTree' }), /3.x/);
  delete (globalThis as any).cc;
});

test('MCP omits runtime mutation tools by default', async () => {
  const browser = new BrowserConnection('http://127.0.0.1:9222');
  const server = createServer(browser);
  const client = new Client({ name: 'self-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
      'cocos_asset_report',
      'cocos_capture_node',
      'cocos_dynamic_atlas',
      'cocos_explain_click',
      'cocos_find_node',
      'cocos_get_components',
      'cocos_get_node',
      'cocos_get_node_bounds',
      'cocos_get_properties',
      'cocos_get_selection',
      'cocos_highlight_node',
      'cocos_list_pages',
      'cocos_listener_report',
      'cocos_runtime_diagnostics',
      'cocos_runtime_info',
      'cocos_scene_tree',
      'cocos_snapshot_subtree',
      'cocos_wait_for_property',
    ]);
    const highlight = tools.tools.find(tool => tool.name === 'cocos_highlight_node');
    assert.deepEqual(highlight?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    assert.deepEqual(tools.tools.find(tool => tool.name === 'cocos_get_selection')?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.ok(tools.tools.filter(tool => !['cocos_highlight_node', 'cocos_get_selection'].includes(tool.name)).every(tool => tool.annotations?.readOnlyHint === true));
    const invalid = await client.callTool({ name: 'cocos_get_components', arguments: { uuid: 'x', extra: true } });
    assert.equal(invalid.isError, true);
  } finally {
    await Promise.allSettled([client.close(), server.close(), browser.close()]);
  }
});

test('MCP exposes opted-in node active mutation with strict input', async () => {
  const browser = new BrowserConnection('http://127.0.0.1:9222');
  const server = createServer(browser, { allowRuntimeMutation: true });
  const client = new Client({ name: 'self-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    for (const name of ['cocos_set_node_active', 'cocos_set_transform', 'cocos_set_property', 'cocos_pause', 'cocos_resume']) {
      assert.deepEqual(tools.tools.find(tool => tool.name === name)?.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const name of ['cocos_click_node', 'cocos_drag_node', 'cocos_type_text']) {
      assert.deepEqual(tools.tools.find(tool => tool.name === name)?.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, name);
    }
    assert.equal(tools.tools.find(tool => tool.name === 'cocos_analyze_batches')?.annotations?.idempotentHint, false);
    assert.equal((await client.callTool({ name: 'cocos_drag_node', arguments: { uuid: 'x', dx: 0, dy: 0 } })).isError, true);
    assert.equal((await client.callTool({ name: 'cocos_type_text', arguments: { uuid: 'x', text: 'x'.repeat(2_001) } })).isError, true);
    assert.equal(tools.tools.find(tool => tool.name === 'cocos_step_frame')?.annotations?.idempotentHint, false);
    assert.equal(tools.tools.find(tool => tool.name === 'cocos_show_stats')?.annotations?.idempotentHint, true);
    assert.equal(tools.tools.find(tool => tool.name === 'cocos_set_time_scale')?.annotations?.idempotentHint, true);
    assert.equal((await client.callTool({ name: 'cocos_set_time_scale', arguments: { scale: 0 } })).isError, true);
    assert.equal(tools.tools.find(tool => tool.name === 'cocos_emulate_device')?.annotations?.idempotentHint, false);
    const invalid = await client.callTool({ name: 'cocos_set_node_active', arguments: { uuid: 'x', active: true, extra: true } });
    assert.equal(invalid.isError, true);
    for (const args of [{ width: 400 }, { preset: 'iphone-14', width: 400, height: 800 }, { reset: true, preset: 'iphone-14' }, { mobile: true }, { cpuSlowdown: 50 }, { network: '2g' }]) {
      assert.equal((await client.callTool({ name: 'cocos_emulate_device', arguments: args })).isError, true, JSON.stringify(args));
    }
  } finally {
    await Promise.allSettled([client.close(), server.close(), browser.close()]);
  }
});

test('browser data redaction masks secrets in text, URLs, headers, and bodies', () => {
  // Fake token, assembled at runtime so secret scanners do not flag the fixture.
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'fake-signature-for-tests'].join('.');
  assert.equal(redactText(`login ok ${jwt}`).includes(jwt), false);
  assert.equal(redactText('Authorization: Bearer abcdef1234567890').includes('abcdef1234567890'), false);
  assert.equal(redactText('sent Bearer abcdef1234567890 upstream'), 'sent Bearer [redacted] upstream');
  assert.equal(redactText('token=abc123&mode=guest'), 'token=[redacted]&mode=guest');
  assert.equal(redactText('{"password": "hunter2", "user": "bob"}'), '{"password": "[redacted]", "user": "bob"}');
  assert.equal(redactUrl('http://u:p@127.0.0.1/api?access_token=xyz&page=2'), 'http://127.0.0.1/api?access_token=%5Bredacted%5D&page=2');
  assert.deepEqual(redactHeaders({ Authorization: 'Bearer x', Cookie: 'sid=1', 'X-Api-Key': 'k', 'Content-Type': 'application/json' }), { Authorization: '[redacted]', Cookie: '[redacted]', 'X-Api-Key': '[redacted]', 'Content-Type': 'application/json' });
  assert.equal(redactBody(JSON.stringify({ user: 'bob', password: 'hunter2', profile: { sessionToken: 't', level: 3 } })).body, JSON.stringify({ user: 'bob', password: '[redacted]', profile: { sessionToken: '[redacted]', level: 3 } }));
  assert.equal(redactBody('username=bob&password=hunter2&otp=123456').body, 'username=bob&password=[redacted]&otp=[redacted]');
  assert.equal(redactBody('x'.repeat(30_000)).truncated, true);
  // Words that merely contain "pin" or "otp" are not secrets.
  assert.equal(redactText('shipping=fast&footprint=2'), 'shipping=fast&footprint=2');
});

test('MCP registers browser data tools only with their own flag', async () => {
  for (const [options, expected] of [[{ allowRuntimeMutation: true }, false], [{ allowBrowserData: true }, true]] as const) {
    const browser = new BrowserConnection('http://127.0.0.1:9222');
    const server = createServer(browser, options);
    const client = new Client({ name: 'self-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      for (const name of ['cocos_console_messages', 'cocos_network_requests', 'cocos_network_request', 'cocos_storage']) assert.equal(names.includes(name), expected, name);
      assert.equal(names.includes('cocos_call_method'), false, 'method calls need their own flag');
    } finally {
      await Promise.allSettled([client.close(), server.close(), browser.close()]);
    }
  }
});

test('MCP registers cocos_call_method only with --allow-method-call', async () => {
  const browser = new BrowserConnection('http://127.0.0.1:9222');
  const server = createServer(browser, { allowMethodCall: true });
  const client = new Client({ name: 'self-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tool = (await client.listTools()).tools.find(candidate => candidate.name === 'cocos_call_method');
    assert.deepEqual(tool?.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    for (const args of [{ uuid: 'x', method: 'a.b' }, { uuid: 'x', method: 'f', args: Array(21).fill(0) }, { uuid: 'x', method: 'f', extra: 1 }]) {
      assert.equal((await client.callTool({ name: 'cocos_call_method', arguments: args })).isError, true, JSON.stringify(args).slice(0, 80));
    }
  } finally {
    await Promise.allSettled([client.close(), server.close(), browser.close()]);
  }
});

test('native connection evaluates self-contained bridge source on the loopback inspector only', async () => {
  const realFetch = globalThis.fetch;
  const evaluated: Array<{ url: string; expression: string }> = [];
  globalThis.fetch = (async (input: string | URL) => {
    assert.equal(String(input), 'http://127.0.0.1:43086/json/list');
    // A target list naming another host must not redirect the socket off loopback.
    return new Response(JSON.stringify([{ webSocketDebuggerUrl: 'ws://10.0.0.5:43086/abc' }]));
  }) as typeof fetch;
  try {
    assert.throws(() => new NativeConnection('http://10.0.0.5:43086'), /localhost/);
    const native = new NativeConnection('ws://127.0.0.1:43086/', 1_000, async (url, expression) => {
      evaluated.push({ url, expression });
      return { version: '3.8.8' };
    });
    const page = await native.page();
    assert.deepEqual(await runBridge(page, { action: 'runtimeInfo' }), { version: '3.8.8' });
    assert.equal(evaluated[0]!.url, 'ws://127.0.0.1:43086/abc');
    assert.ok(evaluated[0]!.expression.startsWith('(function inspectCocos(') && evaluated[0]!.expression.endsWith('({"action":"runtimeInfo"})'));

    globalThis.fetch = (async () => new Response(JSON.stringify([{ id: 'busy' }]))) as unknown as typeof fetch;
    await assert.rejects(() => runBridge(page, { action: 'runtimeInfo' }), /already has a session/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('bridge accepts the Cocos native location shim but still rejects remote pages', () => withFakeCocos(() => {
  (globalThis as any).location = { href: 'game.js', protocol: '' };
  try {
    assert.equal((inspectCocos({ action: 'runtimeInfo' }) as any).version, '3.8.7');
    (globalThis as any).location = { href: 'https://example.com/', protocol: 'https:' };
    assert.throws(() => inspectCocos({ action: 'runtimeInfo' }), /localhost/);
  } finally {
    delete (globalThis as any).location;
  }
}));

test('MCP in native mode omits tools that need a browser page', async () => {
  const native = new NativeConnection('http://127.0.0.1:43086');
  const server = createServer(native, { allowRuntimeMutation: true, allowBrowserData: true, native: true });
  const client = new Client({ name: 'self-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['cocos_capture_node', 'cocos_emulate_device', 'cocos_analyze_batches', 'cocos_highlight_node', 'cocos_get_selection', 'cocos_step_frame']) assert.equal(names.includes(name), false, name);
    for (const name of ['cocos_scene_tree', 'cocos_set_node_active', 'cocos_explain_click', 'cocos_pause', 'cocos_click_node', 'cocos_drag_node', 'cocos_type_text', 'cocos_console_messages', 'cocos_network_requests', 'cocos_network_request', 'cocos_storage']) assert.ok(names.includes(name), name);
  } finally {
    await Promise.allSettled([client.close(), server.close(), native.close()]);
  }
});

test('native console parses Cocos logcat lines by level', () => {
  const output = [
    '--------- beginning of main',
    '  1791369278.871  2386  2426 D Cocos   : 13:54:38 [DEBUG]: JS: hello',
    '  1791369278.872  2386  2426 E Cocos   : 13:54:38 [ERROR]: JS: boom',
    '  1791369278.873  2386  2426 W Cocos   : 13:54:38 [WARN]: JS: careful\r',
    '  1791369278.874  2386  2426 I OtherTag: ignored',
  ].join('\n');
  assert.deepEqual(parseCocosLogcat(output).map(({ type, text }) => [type, text]), [['log', 'JS: hello'], ['error', 'JS: boom'], ['warning', 'JS: careful']]);
});

test('asset report matches native assets whose uuid sits behind an accessor', () => {
  // On native (JSB) builds Asset._uuid is a C++ accessor, so only the cache key names the asset.
  class Texture2D { get _uuid() { return 'tex-1'; } }
  class SpriteFrame { _texture = new Texture2D(); get _uuid() { return 'frame-1'; } }
  const frame = new SpriteFrame();
  const unusedTexture = new Texture2D();
  class Sprite { _spriteFrame = frame; }
  const scene = { name: 'Scene', children: [{ name: 'Logo', children: [], components: [new Sprite()] }], components: [] };
  const previous = (globalThis as any).cc;
  (globalThis as any).cc = {
    ENGINE_VERSION: '3.8.8',
    director: { getScene: () => scene },
    assetManager: { assets: { _map: { 'frame-1': frame, 'tex-1': frame._texture, 'tex-2': unusedTexture } } },
  };
  try {
    const report = inspectCocos({ action: 'assetReport' }) as { assets: Array<{ uuid: string; status: string }>; textureBytes: unknown; unavailableMetrics?: unknown };
    assert.deepEqual(Object.fromEntries(report.assets.map(asset => [asset.uuid, asset.status])), { 'frame-1': 'used', 'tex-1': 'used', 'tex-2': 'unused' });
    assert.equal(report.textureBytes, null, 'native textures expose no byte size');
    assert.deepEqual(report.unavailableMetrics, { textureBytes: 'UNSUPPORTED_PUBLIC_API' });
  } finally {
    (globalThis as any).cc = previous;
  }
});

test('native inspector port comes from the latest valid logcat line, or only the expected one on reconnect', () => {
  const line = (port: number) => `D/Cocos: Debugger listening..., visit [ devtools://devtools/bundled/js_app.html?v8only=true&ws=127.0.0.1:${port}/00010002-0003-4004-8005-000600070008 ] in chrome browser to debug!`;
  const logcat = [line(6086), line(43086), line(99999), line(80)].join('\n');
  assert.equal(inspectorPort(logcat), 43086, 'out-of-range ports are ignored');
  assert.equal(inspectorPort(logcat, 6086), 6086);
  assert.equal(inspectorPort(logcat, 40000), undefined, 'a reconnect never switches to a port no line names');
  assert.equal(inspectorPort(''), undefined);
});

test('native network capture records XHR and WebSocket traffic and keeps the game handlers working', async () => {
  // Like the Cocos native binding: addEventListener assigns on*, and the engine calls only the on* property.
  class FakeXhr {
    [key: string]: any;
    status = 0;
    responseType = '';
    responseText = '';
    open() {}
    setRequestHeader() {}
    addEventListener(type: string, listener: () => void) { this[`on${type}`] = listener; }
    getAllResponseHeaders() { return 'Date: Thu, 08 Oct 2026 09:16:11 GMT\r\nSet-Cookie: sid=secret'; }
    send() { this.status = 200; this.responseText = '{"accessToken":"abc","ok":true}'; this.onload?.(); }
  }
  const sent: unknown[] = [];
  const socketArgs: unknown[][] = [];
  class FakeSocket { onmessage: unknown = null; constructor(...args: unknown[]) { socketArgs.push(args); } send(data: unknown) { sent.push(data); } }
  const previous = { XMLHttpRequest: (globalThis as any).XMLHttpRequest, WebSocket: (globalThis as any).WebSocket };
  Object.assign(globalThis, { XMLHttpRequest: FakeXhr, WebSocket: FakeSocket });
  delete (globalThis as any).__cocosWebInspectorNetwork;
  try {
    const page = await new NativeConnection('http://127.0.0.1:43086', 1_000, async (_url, expression) => (0, eval)(expression)).page();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([{ webSocketDebuggerUrl: 'ws://127.0.0.1:43086/abc' }]))) as unknown as typeof fetch;
    try {
      assert.match((await nativeNetworkRequests(page, {}) as { note: string }).note, /Capture started/);
      const xhr = new (globalThis as any).XMLHttpRequest();
      xhr.open('POST', 'https://api.example.test/login?token=t1');
      xhr.setRequestHeader('Authorization', 'Bearer abcdefghijkl');
      let loaded = 0;
      xhr.onload = () => { loaded++; };
      xhr.send('{"password":"p"}');
      assert.equal(loaded, 1, 'the game onload set before send still runs');
      let received: unknown;
      const socket = new (globalThis as any).WebSocket('wss://api.example.test/ws', [], 'cacert.pem');
      assert.deepEqual(socketArgs, [['wss://api.example.test/ws', [], 'cacert.pem']], 'the CA file reaches the native socket');
      socket.onmessage = (event: { data: unknown }) => { received = event.data; };
      (socket.onmessage as (event: unknown) => void)({ data: 'hello' });
      socket.send('ping');
      assert.equal(received, 'hello', 'the game handler still runs');
      assert.deepEqual(sent, ['ping'], 'the native send still runs');
      const list = await nativeNetworkRequests(page, {}) as { requests: Array<{ id: number; url: string; resourceType: string }> };
      assert.deepEqual(list.requests.map(request => [request.resourceType, request.url]), [['xhr', 'https://api.example.test/login?token=%5Bredacted%5D'], ['websocket', 'wss://api.example.test/ws']]);
      const detail = await nativeNetworkRequest(page, list.requests[0]!.id, true) as any;
      assert.equal(detail.requestHeaders.Authorization, '[redacted]');
      assert.equal(detail.responseHeaders.date, 'Thu, 08 Oct 2026 09:16:11 GMT');
      assert.equal(detail.responseHeaders['set-cookie'], '[redacted]');
      assert.match(detail.responseBody.body, /"accessToken":"\[redacted\]"/);
      assert.equal((globalThis as any).__cocosWebInspectorNetwork.entries[0].requestHeaders.Authorization, '[redacted]', 'game memory never holds the raw credential header');
      const socketDetail = await nativeNetworkRequest(page, list.requests[1]!.id, true) as any;
      assert.deepEqual(socketDetail.frames.map((frame: { direction: string; data: string }) => [frame.direction, frame.data]), [['received', 'hello'], ['sent', 'ping']]);
      // 50 frames of 2,000 three-byte characters plus large bodies exceed the 200 KB ceiling; the oldest frames go first.
      for (let index = 0; index < 60; index++) socket.send('ễ'.repeat(2_000));
      const bounded = await nativeNetworkRequest(page, list.requests[1]!.id, true) as any;
      assert.ok(fitsResponse(bounded));
      assert.equal(bounded.framesDropped, true);
      assert.ok(bounded.frames.length > 0 && bounded.frames.length < 50);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    Object.assign(globalThis, previous);
    delete (globalThis as any).__cocosWebInspectorNetwork;
  }
});
