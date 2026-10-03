import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sanitizeUrl, validateLocalUrl, BrowserConnection } from '../src/browser.js';
import { inspectCocos } from '../src/bridge.js';
import { createServer } from '../src/server.js';

function withFakeCocos(run: () => void): void {
  class UITransform {
    uuid = 'component-ui';
    enabled = true;
    contentSize = { width: 100, height: 40 };
    anchorPoint = { x: 0.5, y: 0.5 };
  }
  const child: any = {
    uuid: 'child-1', name: 'Player', active: true, activeInHierarchy: true, children: [], components: [new UITransform()],
    worldPosition: { x: 50, y: 30 }, scale: { x: 1, y: 1 }, secretToken: 'must-not-leak', publicValue: 7,
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
  const result = inspectCocos({ action: 'getProperties', uuid: 'child-1', maxDepth: 3 }) as any;
  const json = JSON.stringify(result);
  assert.equal(result.properties.publicValue, 7);
  assert.equal(json.includes('must-not-leak'), false);
  assert.equal(json.includes('getter ran'), false);
  assert.equal(result.properties.loop.$type, 'Node');
}));

test('bridge rejects non-3.x runtimes', () => {
  (globalThis as any).cc = { ENGINE_VERSION: '2.4.15', director: { getScene: () => ({}) } };
  assert.throws(() => inspectCocos({ action: 'sceneTree' }), /3.x/);
  delete (globalThis as any).cc;
});

test('MCP exposes exactly five strict read-only tools', async () => {
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
    assert.ok(tools.tools.every(tool => tool.annotations?.readOnlyHint === true));
    const invalid = await client.callTool({ name: 'cocos_get_components', arguments: { uuid: 'x', extra: true } });
    assert.equal(invalid.isError, true);
  } finally {
    await Promise.allSettled([client.close(), server.close(), browser.close()]);
  }
});
