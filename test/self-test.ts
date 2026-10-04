import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sanitizeUrl, validateLocalUrl, BrowserConnection } from '../src/browser.js';
import { inspectCocos, runBridge } from '../src/bridge.js';
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
}));

test('property serializer avoids getters, secrets, and cycles', () => withFakeCocos(() => {
  const node = ((globalThis as any).cc.director.getScene()).children[0];
  Object.defineProperty(node, 'dangerous', { enumerable: true, get: () => { throw new Error('getter ran'); } });
  const accessorReference: any = {};
  Object.defineProperty(accessorReference, 'uuid', { enumerable: true, get: () => { throw new Error('reference getter ran'); } });
  node.accessorReference = accessorReference;
  const prototypeReference = Object.create({ uuid: 'prototype-node', children: [], name: 'Prototype Node' });
  node.prototypeReference = prototypeReference;
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
}));

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
      'cocos_capture_node',
      'cocos_find_node',
      'cocos_get_components',
      'cocos_get_node',
      'cocos_get_node_bounds',
      'cocos_get_properties',
      'cocos_highlight_node',
      'cocos_list_pages',
      'cocos_runtime_diagnostics',
      'cocos_runtime_info',
      'cocos_scene_tree',
      'cocos_snapshot_subtree',
    ]);
    const highlight = tools.tools.find(tool => tool.name === 'cocos_highlight_node');
    assert.deepEqual(highlight?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    assert.ok(tools.tools.filter(tool => tool !== highlight).every(tool => tool.annotations?.readOnlyHint === true));
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
    const invalid = await client.callTool({ name: 'cocos_set_node_active', arguments: { uuid: 'x', active: true, extra: true } });
    assert.equal(invalid.isError, true);
  } finally {
    await Promise.allSettled([client.close(), server.close(), browser.close()]);
  }
});
