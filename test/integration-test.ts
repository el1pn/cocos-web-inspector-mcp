import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { BrowserConnection } from '../src/browser.js';
import { createServer } from '../src/server.js';

// Each version is a vendored Web Mobile debug build of fixture/ (see docs/COMPATIBILITY.md).
const creatorVersions = ['3.7.4', '3.8.3', '3.8.8'];
const productionFixtureRoot = resolve('test/fixtures/cocos-3.8.8-production');
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

function createFixtureServer(root: string): Server {
  return createHttpServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = normalize(join(root, relative));
      if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('Invalid fixture path');
      if (!(await stat(file)).isFile()) throw new Error('Fixture path is not a file');
      response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
}

async function fixtureFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => entry.isDirectory() ? fixtureFiles(root, join(directory, entry.name)) : [relative(root, join(directory, entry.name)).replaceAll('\\', '/')]));
  return nested.flat().sort();
}

async function verifyProductionFixture(): Promise<void> {
  const provenance = JSON.parse(await readFile(join(productionFixtureRoot, 'fixture-production-provenance.json'), 'utf8')) as { artifact: { creatorVersion: string; platform: string; debug: boolean; sourceMaps: boolean; fileCount: number } };
  assert.deepEqual(provenance.artifact, {
    path: 'build/inspector-web-production',
    platform: 'web-mobile',
    creatorVersion: '3.8.8',
    debug: false,
    sourceMaps: false,
    entryScene: 'db://assets/scenes/InspectorTest.scene',
    fileCount: 41,
    checksumFile: 'build-production-checksums.sha256',
    checksumAlgorithm: 'SHA256',
    checksumExclusions: ['**/*.map', 'manual-check.png'],
  });
  const expected = new Map((await readFile(join(productionFixtureRoot, 'build-production-checksums.sha256'), 'utf8')).replace(/^﻿/, '').trim().split(/\r?\n/).map(line => [line.slice(66), line.slice(0, 64)]));
  const files = (await fixtureFiles(productionFixtureRoot)).filter(file => !['README.md', 'COCOS-ENGINE-LICENSE.md', 'build-production.json', 'build-production-checksums.sha256', 'fixture-production-provenance.json'].includes(file));
  assert.deepEqual(files, [...expected.keys()].sort());
  for (const file of files) assert.equal(createHash('sha256').update(await readFile(join(productionFixtureRoot, file))).digest('hex'), expected.get(file), file);
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

test('production fixture checksum and live Cocos canaries pass', { timeout: 90_000 }, async () => {
  await verifyProductionFixture();
  const fixtureServer = createFixtureServer(productionFixtureRoot);
  const fixturePort = await listen(fixtureServer);
  const cdpPort = await reservePort();
  const profileRoot = await mkdtemp(join(tmpdir(), 'cocos-web-inspector-production-'));
  let launched: { browser: Browser; context: BrowserContext } | undefined;
  const browserConnection = new BrowserConnection(`http://127.0.0.1:${cdpPort}`);
  const server = createServer(browserConnection, { allowRuntimeMutation: true });
  const client = new Client({ name: 'production-integration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pageUrl = `http://127.0.0.1:${fixturePort}/`;
  try {
    launched = await launchBrowser(cdpPort, profileRoot);
    const page = launched.context.pages()[0] ?? await launched.context.newPage();
    await page.goto(pageUrl);
    await waitForFixture(page);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tree = await call(client, 'cocos_scene_tree', { pageUrl, maxDepth: 6, maxNodes: 50 });
    assert.equal(tree.scene.name, 'InspectorTest');
    const panel = await call(client, 'cocos_find_node', { pageUrl, path: '/InspectorTest/Canvas/Panel' });
    const panelUuid = panel.matches[0]?.uuid as string;
    assert.ok(panelUuid);
    const components = await call(client, 'cocos_get_components', { pageUrl, uuid: panelUuid });
    const componentUuid = components.components[1]?.uuid as string;
    assert.ok(componentUuid);
    const properties = await call(client, 'cocos_get_properties', { pageUrl, uuid: panelUuid, componentUuid, maxDepth: 3 });
    assert.equal(properties.properties.title, 'Inspector fixture');
    assert.equal(properties.properties.count, 42);
    assert.equal(properties.properties.featureEnabled, true);
    assert.equal(properties.properties.details.category, 'manual-test');
    assert.deepEqual(properties.properties.staleNode, { $type: 'Node', uuid: properties.properties.staleNode?.uuid, destroyed: true });
    assert.equal(JSON.stringify(properties).includes('must-not-be-returned'), false);
    assert.equal(JSON.stringify(properties).includes('Property getter was invoked'), false);
    assert.equal((await call(client, 'cocos_set_node_active', { pageUrl, uuid: panelUuid, active: false })).after.active, false);
    assert.equal((await call(client, 'cocos_set_node_active', { pageUrl, uuid: panelUuid, active: true })).after.active, true);
  } finally {
    await Promise.allSettled([client.close(), server.close(), browserConnection.close(), launched?.context.close() ?? Promise.resolve()]);
    await closeServer(fixtureServer).catch(() => undefined);
    await rm(profileRoot, { recursive: true, force: true });
  }
});

for (const version of creatorVersions) test(`live Chromium exercises Cocos ${version} inspection, selection, highlight, and reconnect`, { timeout: 90_000 }, async () => {
  const fixtureServer = createFixtureServer(resolve(`test/fixtures/cocos-${version}`));
  const fixturePort = await listen(fixtureServer);
  const pageUrl = `http://127.0.0.1:${fixturePort}/`;
  const cdpPort = await reservePort();
  const profileRoot = await mkdtemp(join(tmpdir(), 'cocos-web-inspector-live-'));
  let launched: { browser: Browser; context: BrowserContext } | undefined;
  const browserConnection = new BrowserConnection(`http://127.0.0.1:${cdpPort}`);
  const server = createServer(browserConnection, { allowRuntimeMutation: true });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    launched = await launchBrowser(cdpPort, join(profileRoot, 'first'));
    const page = launched.context.pages()[0] ?? await launched.context.newPage();
    await page.goto(pageUrl);
    await waitForFixture(page);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const pages = await call(client, 'cocos_list_pages', {});
    assert.equal(pages.pages.length, 1);
    assert.deepEqual(pages.pages[0].cocos, { detected: true, version, sceneName: 'InspectorTest' });
    assert.equal(pages.pages[0].url, pageUrl);

    const runtime = await call(client, 'cocos_runtime_info', { pageUrl });
    assert.deepEqual(runtime.scene.name, 'InspectorTest');
    assert.ok(runtime.nodeCount >= 6);
    const diagnostics = await call(client, 'cocos_runtime_diagnostics', { pageUrl });
    assert.ok(diagnostics.nodeCount >= 6);
    assert.ok(diagnostics.componentCount >= 1);
    assert.ok(diagnostics.maxHierarchyDepth >= 1);
    assert.ok(diagnostics.render.drawCalls > 0, JSON.stringify(diagnostics.render));
    assert.ok(diagnostics.render.triangles > 0);
    assert.ok(diagnostics.render.frameTimeMs > 0);
    // Root publishes fps once per elapsed second, so it stays 0 right after the scene loads.
    await page.waitForFunction(() => (globalThis as any).cc.director.root.fps > 0);
    assert.ok((await call(client, 'cocos_runtime_diagnostics', { pageUrl })).render.fps > 0);
    assert.equal(diagnostics.unavailableMetrics.drawCalls, undefined);

    const tree = await call(client, 'cocos_scene_tree', { pageUrl, maxDepth: 6, maxNodes: 50 });
    assert.equal(tree.version, version);
    assert.equal(tree.scene.name, 'InspectorTest');
    assert.ok(tree.nodeCount >= 6);
    assert.deepEqual(tree.scene.children[0].children.map((node: { name: string }) => node.name), ['Panel', 'UICamera']);

    const found = await call(client, 'cocos_find_node', { pageUrl, path: '/InspectorTest/Canvas/Panel' });
    assert.equal(found.matches.length, 1);
    const panelUuid = found.matches[0].uuid as string;
    assert.ok(panelUuid);
    assert.deepEqual(await call(client, 'cocos_set_node_active', { pageUrl, uuid: panelUuid, active: false }), {
      changed: true,
      target: { nodeUuid: panelUuid },
      before: { active: true },
      after: { active: false },
      runtimeOnly: true,
    });
    assert.equal((await call(client, 'cocos_find_node', { pageUrl, uuid: panelUuid })).matches[0].active, false);
    assert.equal((await call(client, 'cocos_wait_for_property', { pageUrl, uuid: panelUuid, key: 'active', equals: false, timeoutMs: 300 })).matched, true);
    const hidden = await call(client, 'cocos_get_node_bounds', { pageUrl, uuid: panelUuid });
    assert.equal(hidden.visible, false);
    assert.equal(hidden.reason, 'INACTIVE');
    assert.equal((await call(client, 'cocos_click_node', { pageUrl, uuid: panelUuid })).clicked, false);
    assert.deepEqual(await call(client, 'cocos_set_node_active', { pageUrl, uuid: panelUuid, active: true }), {
      changed: true,
      target: { nodeUuid: panelUuid },
      before: { active: false },
      after: { active: true },
      runtimeOnly: true,
    });

    const context = await call(client, 'cocos_get_node', { pageUrl, uuid: panelUuid });
    assert.equal(context.node.path, '/InspectorTest/Canvas/Panel');
    const snapshot = await call(client, 'cocos_snapshot_subtree', { pageUrl, uuid: panelUuid, maxDepth: 2, maxNodes: 20 });
    assert.equal(snapshot.rootUuid, panelUuid);
    assert.equal(snapshot.snapshot.uuid, panelUuid);
    const bounds = await call(client, 'cocos_get_node_bounds', { pageUrl, uuid: panelUuid });
    assert.equal(bounds.available, true);
    assert.ok(bounds.visible);
    assert.ok(bounds.viewport.width > 0 && bounds.viewport.height > 0);
    const capture = await call(client, 'cocos_capture_node', { pageUrl, uuid: panelUuid });
    assert.equal(capture.captured, true);
    assert.equal(capture.mimeType, 'image/png');
    assert.ok(capture.data.length > 0);
    const canvasUuid = (await call(client, 'cocos_find_node', { pageUrl, path: '/InspectorTest/Canvas' })).matches[0].uuid as string;
    await page.setViewportSize({ width: 1024, height: 1024 });
    const fullCapture = await call(client, 'cocos_capture_node', { pageUrl, uuid: canvasUuid });
    assert.equal(fullCapture.captured, true, JSON.stringify({ ...fullCapture, data: undefined }));
    const display = async (path: string, componentType: string) => {
      const uuid = (await call(client, 'cocos_find_node', { pageUrl, path })).matches[0].uuid as string;
      return { uuid, properties: (await call(client, 'cocos_get_properties', { pageUrl, uuid, componentType, maxDepth: 0 })).properties };
    };
    assert.equal((await display('/InspectorTest/Canvas/Panel/TitleLabel', 'Label')).properties.string, 'Inspector title');
    assert.equal((await display('/InspectorTest/Canvas/Panel/TestButton', 'Button')).properties.interactable, true);
    assert.equal((await display('/InspectorTest/Canvas/Panel/IconSprite', 'Sprite')).properties.spriteFrame.name, 'default_sprite_splash');
    assert.equal((await display('/InspectorTest/Canvas/Panel/TestRichText', 'RichText')).properties.string, '<b>Rich</b> fixture');
    const toggle = await display('/InspectorTest/Canvas/Panel/TestToggle', 'Toggle');
    assert.equal(toggle.properties.isChecked, true);
    assert.equal((await call(client, 'cocos_click_node', { pageUrl, uuid: toggle.uuid })).clicked, true);
    assert.equal((await call(client, 'cocos_wait_for_property', { pageUrl, uuid: toggle.uuid, componentType: 'Toggle', key: 'isChecked', equals: false, timeoutMs: 2_000 })).matched, true);
    assert.equal(context.parent.name, 'Canvas');
    const filtered = await call(client, 'cocos_find_node', { pageUrl, nameContains: 'Pan', componentType: 'InspectorFixture', active: true, pathPrefix: '/InspectorTest' });
    assert.equal(filtered.matches[0].uuid, panelUuid);
    const components = await call(client, 'cocos_get_components', { pageUrl, uuid: panelUuid });
    assert.deepEqual(components.components.map((component: { type: string }) => component.type), ['UITransform', 'InspectorFixture']);
    const fixtureComponentUuid = components.components.find((component: { type: string }) => component.type === 'InspectorFixture')?.uuid;
    assert.ok(fixtureComponentUuid);
    const transform = await call(client, 'cocos_set_transform', { pageUrl, uuid: panelUuid, position: { x: 10, y: 20, z: 0 } });
    assert.deepEqual(transform.after, { position: { x: 10, y: 20, z: 0 } });
    assert.deepEqual((await call(client, 'cocos_set_property', { pageUrl, uuid: panelUuid, componentUuid: fixtureComponentUuid, key: 'count', value: 7 })).after, { value: 7 });

    const properties = await call(client, 'cocos_get_properties', { pageUrl, uuid: panelUuid, componentUuid: fixtureComponentUuid, maxDepth: 3 });
    assert.equal(properties.properties.title, 'Inspector fixture');
    assert.equal(properties.properties.count, 7);
    assert.equal(properties.properties.featureEnabled, true);
    assert.equal(properties.properties.details.category, 'manual-test');
    assert.deepEqual(properties.properties.staleNode, { $type: 'Node', uuid: properties.properties.staleNode?.uuid, destroyed: true });
    const waited = await call(client, 'cocos_wait_for_property', { pageUrl, uuid: panelUuid, componentUuid: fixtureComponentUuid, key: 'count', equals: 7, timeoutMs: 1_000 });
    assert.deepEqual(waited, { matched: true, key: 'count', value: 7, polls: 1 });
    assert.equal((await call(client, 'cocos_wait_for_property', { pageUrl, uuid: panelUuid, componentUuid: fixtureComponentUuid, key: 'count', equals: 8, timeoutMs: 300 })).matched, false);
    assert.equal((await client.callTool({ name: 'cocos_step_frame', arguments: { pageUrl } })).isError, true);
    // A new scheduler timer spends its first update initializing, so register it while the game still runs.
    await page.evaluate(() => {
      const root = globalThis as any;
      root.cc.director.getScheduler().schedule(() => { root.__ticks = (root.__ticks ?? 0) + 1; }, root.cc.director.getScene(), 0, false);
    });
    await page.waitForFunction(() => (globalThis as any).__ticks > 0);
    assert.equal((await call(client, 'cocos_pause', { pageUrl })).after.paused, true);
    await page.evaluate(() => { (globalThis as any).__ticks = 0; });
    const stepped = await call(client, 'cocos_step_frame', { pageUrl, frames: 3 });
    assert.equal(stepped.after.totalFrames - stepped.before.totalFrames, 3);
    assert.equal(await page.evaluate(() => (globalThis as any).__ticks), 3);
    assert.equal((await call(client, 'cocos_runtime_info', { pageUrl })).director.paused, true);
    assert.equal((await call(client, 'cocos_resume', { pageUrl })).after.paused, false);
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
    const listedPages = await call(client, 'cocos_list_pages', {});
    assert.equal(listedPages.pages.length, 2);
    assert.ok(listedPages.pages.every((item: { url: string }) => !item.url.includes('?')));
    const ambiguous = await client.callTool({ name: 'cocos_scene_tree', arguments: {} });
    assert.equal(ambiguous.isError, true);
    assert.deepEqual(ambiguous.structuredContent, {
      code: 'MULTIPLE_PAGES',
      message: `Multiple localhost pages found; pass pageUrl: ${pageUrl}, ${pageUrl}`,
    });
    const missingNode = await client.callTool({ name: 'cocos_get_node', arguments: { pageUrl, uuid: 'does-not-exist' } });
    assert.deepEqual(missingNode.structuredContent, { code: 'NODE_NOT_FOUND', message: 'Node not found' });
    const missing = await client.callTool({ name: 'cocos_runtime_info', arguments: { pageUrl: `http://127.0.0.1:${fixturePort}/missing` } });
    assert.equal(missing.isError, true);
    assert.deepEqual(missing.structuredContent, { code: 'PAGE_NOT_FOUND', message: `Local page not found: http://127.0.0.1:${fixturePort}/missing` });
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
