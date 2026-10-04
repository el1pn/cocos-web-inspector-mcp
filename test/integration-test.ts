import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { BrowserConnection } from '../src/browser.js';
import { createServer } from '../src/server.js';

const fixtureRoot = resolve('test/fixtures/cocos-3.8.8');
const contentTypes: Record<string, string> = {
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mem': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}

function createFixtureServer(): Server {
  return createHttpServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = normalize(join(fixtureRoot, relative));
      if (file !== fixtureRoot && !file.startsWith(`${fixtureRoot}${sep}`)) throw new Error('Invalid fixture path');
      if (!(await stat(file)).isFile()) throw new Error('Fixture path is not a file');
      response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
}

async function reservePort(): Promise<number> {
  const server = createHttpServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function waitForCdp(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chromium may not have opened the debugging socket yet.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Chromium CDP endpoint did not become ready on port ${port}`);
}

async function launchBrowser(cdpPort: number, userDataDir: string): Promise<{ browser: Browser; context: BrowserContext }> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${cdpPort}`],
  });
  await waitForCdp(cdpPort);
  return { browser: context.browser()!, context };
}

async function waitForFixture(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.waitForFunction(() => {
    const root = globalThis as typeof globalThis & { cc?: { director?: { getScene?: () => { name?: string } } } };
    return root.cc?.director?.getScene?.()?.name === 'InspectorTest';
  }, undefined, { timeout: 20_000 }).catch(error => {
    throw new Error(`Cocos fixture did not become ready: ${error instanceof Error ? error.message : String(error)}${errors.length ? `; page errors: ${errors.join(' | ')}` : ''}`);
  });
}

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, any> {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return structured(await client.callTool({ name, arguments: args }));
}

test('live Chromium exercises Cocos inspection, selection, highlight, and reconnect', { timeout: 90_000 }, async () => {
  const fixtureServer = createFixtureServer();
  const fixturePort = await listen(fixtureServer);
  const pageUrl = `http://127.0.0.1:${fixturePort}/`;
  const cdpPort = await reservePort();
  const profileRoot = await mkdtemp(join(tmpdir(), 'cocos-web-inspector-live-'));
  let launched: { browser: Browser; context: BrowserContext } | undefined;
  const browserConnection = new BrowserConnection(`http://127.0.0.1:${cdpPort}`);
  const server = createServer(browserConnection);
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    launched = await launchBrowser(cdpPort, join(profileRoot, 'first'));
    const page = launched.context.pages()[0] ?? await launched.context.newPage();
    await page.goto(pageUrl);
    await waitForFixture(page);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tree = await call(client, 'cocos_scene_tree', { pageUrl, maxDepth: 6, maxNodes: 50 });
    assert.equal(tree.version, '3.8.8');
    assert.equal(tree.scene.name, 'InspectorTest');
    assert.ok(tree.nodeCount >= 6);
    assert.deepEqual(tree.scene.children[0].children.map((node: { name: string }) => node.name), ['Panel', 'UICamera']);

    const found = await call(client, 'cocos_find_node', { pageUrl, path: '/InspectorTest/Canvas/Panel' });
    assert.equal(found.matches.length, 1);
    const panelUuid = found.matches[0].uuid as string;
    assert.ok(panelUuid);

    const components = await call(client, 'cocos_get_components', { pageUrl, uuid: panelUuid });
    assert.deepEqual(components.components.map((component: { type: string }) => component.type), ['UITransform', 'InspectorFixture']);

    const properties = await call(client, 'cocos_get_properties', { pageUrl, uuid: panelUuid, componentType: 'InspectorFixture', maxDepth: 3 });
    assert.equal(properties.properties.title, 'Inspector fixture');
    assert.equal(properties.properties.count, 42);
    assert.equal(properties.properties.featureEnabled, true);
    assert.equal(properties.properties.details.category, 'manual-test');
    assert.equal(JSON.stringify(properties).includes('must-not-be-returned'), false);
    assert.equal(JSON.stringify(properties).includes('Property getter was invoked'), false);

    for (const viewport of [{ width: 1280, height: 720 }, { width: 640, height: 360 }]) {
      await page.setViewportSize(viewport);
      const highlighted = await call(client, 'cocos_highlight_node', { pageUrl, uuid: panelUuid, durationMs: 1_000 });
      assert.equal(highlighted.highlighted, true);
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(highlighted.bounds[key]), `${key} must be finite`);
      assert.ok(highlighted.bounds.width > 0 && highlighted.bounds.height > 0);
      assert.equal(await page.locator('body > div').last().evaluate(element => getComputedStyle(element).pointerEvents), 'none');
    }

    const secondPage = await launched.context.newPage();
    await secondPage.goto(`${pageUrl}?second=1`);
    await waitForFixture(secondPage);
    const ambiguous = await client.callTool({ name: 'cocos_scene_tree', arguments: {} });
    assert.equal(ambiguous.isError, true);
    assert.match(JSON.stringify(ambiguous.content), /Multiple localhost pages found/);
    assert.equal((await call(client, 'cocos_scene_tree', { pageUrl })).scene.name, 'InspectorTest');

    await launched.context.close();
    launched = await launchBrowser(cdpPort, join(profileRoot, 'second'));
    const reconnectedPage = launched.context.pages()[0] ?? await launched.context.newPage();
    await reconnectedPage.goto(pageUrl);
    await waitForFixture(reconnectedPage);
    assert.equal((await call(client, 'cocos_scene_tree', { pageUrl })).scene.name, 'InspectorTest');
  } finally {
    await Promise.allSettled([client.close(), server.close(), browserConnection.close(), launched?.context.close() ?? Promise.resolve()]);
    await closeServer(fixtureServer).catch(() => undefined);
    await rm(profileRoot, { recursive: true, force: true });
  }
});
