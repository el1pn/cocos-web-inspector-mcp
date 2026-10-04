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
  const child: any = {
    uuid: 'child-1', name: 'Player', active: true, activeInHierarchy: true, children: [], components: [new UITransform()],
    worldPosition: { x: 50, y: 30 }, scale: { x: 1, y: 1 },
    secretToken: 'secret-token-value', accessTokens: 'access-tokens-value', refreshToken2: 'refresh-token-value', cookies: 'cookies-value', credentials: 'credentials-value',
    apiKey: 'api-key-value', APIKey: 'upper-api-key-value', apiKey2: 'numbered-api-key-value', privateKey: 'private-key-value', jwt: 'jwt-value', JWTToken: 'jwt-token-value',
    authHeader: 'auth-header-value', sessionId: 'session-value', bearerAuth: 'bearer-value', sessionScore: 12, publicValue: 7,
  };
  child.loop = child;
  const scene = { uuid: 'scene-1', name: 'Scene', active: true, activeInHierarchy: true, children: [child], components: [] };
  const previous = (globalThis as any).cc;
  (globalThis as any).cc = { ENGINE_VERSION: '3.8.7', director: { getScene: () => scene } };
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
    reason: 'Response exceeded 200000 bytes',
  });
});

test('bridge rejects non-3.x runtimes', () => {
  (globalThis as any).cc = { ENGINE_VERSION: '2.4.15', director: { getScene: () => ({}) } };
  assert.throws(() => inspectCocos({ action: 'sceneTree' }), /3.x/);
  delete (globalThis as any).cc;
});

test('MCP exposes exactly five strict tools with accurate annotations', async () => {
  const browser = new BrowserConnection('http://127.0.0.1:9222');
  const server = createServer(browser);
  const client = new Client({ name: 'self-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
      'cocos_find_node',
      'cocos_get_components',
      'cocos_get_properties',
      'cocos_highlight_node',
      'cocos_scene_tree',
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
