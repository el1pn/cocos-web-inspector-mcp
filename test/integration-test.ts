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
      // A fake game API so browser data tools see a JSON response carrying a token.
      if (pathname === '/api/login') {
        response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=server-session-secret; Path=/' });
        response.end(JSON.stringify({ user: 'bob', accessToken: 'response-token-secret', level: 7 }));
        return;
      }
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
    // Release builds minify engine constructor names; component types must still read as Cocos class names.
    assert.deepEqual(components.components.map((component: { type: string }) => component.type), ['UITransform', 'InspectorFixture']);
    const componentUuid = components.components[1]?.uuid as string;
    assert.ok(componentUuid);
    const buttonUuid = (await call(client, 'cocos_find_node', { pageUrl, componentType: 'Button' })).matches[0]?.uuid as string;
    assert.ok(buttonUuid, 'componentType search must match minified engine components');
    const button = (await call(client, 'cocos_get_node_bounds', { pageUrl, uuid: buttonUuid })).viewport;
    assert.equal((await call(client, 'cocos_get_selection', { pageUrl })).selection, null);
    await page.keyboard.down('Alt');
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    await page.keyboard.up('Alt');
    assert.equal((await call(client, 'cocos_get_selection', { pageUrl })).selection.node.uuid, buttonUuid);
    assert.deepEqual((await call(client, 'cocos_show_stats', { pageUrl, visible: true })).after, { visible: true });
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
    // Release builds strip asset names but keep classes and fields; atlas and asset reports must still read them.
    assert.equal((await call(client, 'cocos_dynamic_atlas', { pageUrl })).available, true);
    const releaseAssets = await call(client, 'cocos_asset_report', { pageUrl, limit: 500 });
    assert.ok(releaseAssets.assets.some((asset: { type: string; status: string }) => asset.type === 'SpriteFrame' && asset.status === 'used'), JSON.stringify(releaseAssets.byType));
    assert.equal(releaseAssets.assets.filter((asset: { status: string }) => asset.status === 'unused').length, 0);
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
  const server = createServer(browserConnection, { allowRuntimeMutation: true, allowBrowserData: true, allowMethodCall: true });
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
    // The vendored scene has no EditBox, ScrollView, or Mask; build them at runtime so every fixture version covers them without a rebuild.
    const [editUuid, passwordUuid, scrollUuid] = await page.evaluate(() => {
      const { cc } = globalThis as any;
      const canvas = cc.director.getScene().getChildByName('Canvas');
      const add = (name: string, x: number, y: number, width: number, height: number, attach = true) => {
        const node = new cc.Node(name);
        node.layer = canvas.layer;
        node.addComponent('cc.UITransform').setContentSize(width, height);
        node.setPosition(x, y, 0);
        if (attach) canvas.addChild(node);
        return node;
      };
      // EditBox picks input or textarea when it loads, so set the mode before the node enters the scene.
      const edit = add('TestEditBox', -230, -250, 240, 50, false).addComponent('cc.EditBox');
      edit.inputMode = 6; // InputMode.SINGLE_LINE; the default ANY is a textarea where Enter adds a newline.
      canvas.addChild(edit.node);
      edit.node.on('text-changed', () => { (globalThis as any).__textChanged = ((globalThis as any).__textChanged ?? 0) + 1; });
      edit.node.on('editing-return', () => { (globalThis as any).__submitted = true; });
      const password = add('TestPassword', -230, -190, 240, 50, false).addComponent('cc.EditBox');
      password.inputFlag = 0; // InputFlag.PASSWORD
      password.inputMode = 6;
      canvas.addChild(password.node);
      const view = add('TestScroll', 220, -150, 240, 300);
      view.addComponent('cc.Mask');
      const content = new cc.Node('Content');
      content.layer = canvas.layer;
      content.addComponent('cc.UITransform').setContentSize(240, 1_200);
      content.getComponent('cc.UITransform').setAnchorPoint(0.5, 1);
      content.setPosition(0, 150, 0);
      for (let index = 0; index < 4; index++) {
        const row = new cc.Node(`Row${index}`);
        row.layer = canvas.layer;
        row.addComponent('cc.UITransform').setContentSize(200, 40);
        row.setPosition(0, -40 - index * 60, 0);
        row.addComponent('cc.Label').string = `Row ${index}`;
        content.addChild(row);
      }
      view.addChild(content);
      const scroll = view.addComponent('cc.ScrollView');
      scroll.content = content;
      scroll.horizontal = false;
      scroll.inertia = false;
      scroll.elastic = false;
      return [edit.node.uuid, password.node.uuid, view.uuid];
    });
    await page.waitForFunction(() => (globalThis as any).cc.director.getTotalFrames() > 0);
    const typed = await call(client, 'cocos_type_text', { pageUrl, uuid: editUuid, text: 'hello', submit: true });
    assert.deepEqual(typed.after, { string: 'hello' }, JSON.stringify(typed));
    assert.equal(typed.submitted, true);
    assert.ok(await page.evaluate(() => (globalThis as any).__textChanged > 0), 'typing must fire text-changed');
    assert.equal(await page.evaluate(() => (globalThis as any).__submitted), true, 'submit must fire editing-return');
    assert.deepEqual((await call(client, 'cocos_type_text', { pageUrl, uuid: editUuid, text: 'bye' })).after, { string: 'bye' }, 'typing replaces existing text');
    const secret = await call(client, 'cocos_type_text', { pageUrl, uuid: passwordUuid, text: 'hunter2' });
    assert.deepEqual(secret.after, { redacted: true }, JSON.stringify(secret));
    assert.equal(JSON.stringify(await call(client, 'cocos_get_properties', { pageUrl, uuid: passwordUuid, componentType: 'EditBox', maxDepth: 0 })).includes('hunter2'), false);
    assert.equal((await client.callTool({ name: 'cocos_type_text', arguments: { pageUrl, uuid: panelUuid, text: 'x' } })).isError, true, 'type_text needs an EditBox');
    const scrollY = () => page.evaluate(uuid => {
      const { cc } = globalThis as any;
      let found: any;
      const visit = (node: any) => { if (node.uuid === uuid) found = node; node.children.forEach(visit); };
      visit(cc.director.getScene());
      return found.getComponent('cc.ScrollView').getScrollOffset().y;
    }, scrollUuid);
    const offsetBefore = await scrollY();
    const dragged = await call(client, 'cocos_drag_node', { pageUrl, uuid: scrollUuid, dx: 0, dy: -150 });
    assert.equal(dragged.dragged, true);
    assert.ok(await scrollY() > offsetBefore + 20, `drag must scroll: ${offsetBefore} -> ${await scrollY()}`);

    const batches = await call(client, 'cocos_analyze_batches', { pageUrl });
    assert.ok(batches.batchCount > 1, JSON.stringify(batches));
    assert.equal(batches.batches.length, batches.batchCount);
    assert.ok(batches.reasons.MASK >= 1, `Mask must break a batch: ${JSON.stringify(batches.reasons)}`);
    assert.ok(batches.reasons.TEXTURE >= 1, `Label after Sprite must break on texture: ${JSON.stringify(batches.reasons)}`);
    assert.ok(batches.batches.some((batch: { node: { path: string } }) => batch.node.path.startsWith('/InspectorTest/Canvas/TestScroll')));
    assert.equal(await page.evaluate(() => Object.keys((globalThis as any).cc.director.root.batcher2D).includes('commitComp')), false, 'batch hooks must be removed after the frame');
    assert.equal((await call(client, 'cocos_analyze_batches', { pageUrl, limit: 1 })).batches.length, 1);
    const tinted = await call(client, 'cocos_analyze_batches', { pageUrl, tintMs: 300 });
    assert.ok(tinted.tinted >= tinted.batchCount - 1, JSON.stringify({ tinted: tinted.tinted, batchCount: tinted.batchCount }));
    assert.match(tinted.batches[0].color, /^hsl\(/);
    assert.equal(await page.evaluate(() => {
      const overlay = (globalThis as any).__cocosWebInspectorBatchOverlay as HTMLElement;
      return overlay?.isConnected && getComputedStyle(overlay).pointerEvents === 'none' && overlay.children.length;
    }), tinted.tinted, 'tint overlay must be pointer-transparent and hold one box per tinted node');
    await page.waitForFunction(() => !(globalThis as any).__cocosWebInspectorBatchOverlay, undefined, { timeout: 2_000 });

    const atlas = await call(client, 'cocos_dynamic_atlas', { pageUrl });
    assert.equal(atlas.available, true);
    assert.equal(atlas.config.enabled, true, JSON.stringify(atlas.config));
    assert.ok(atlas.atlasCount >= 1 && atlas.atlases[0].bytes > 0, JSON.stringify(atlas));
    assert.ok(atlas.atlases[0].textures.some((texture: { usedBy?: string }) => texture.usedBy?.startsWith('/InspectorTest/Canvas/Panel/')), 'packed textures name a node that draws them');
    assert.ok(atlas.packedInScene >= 1);
    const assetsBefore = await call(client, 'cocos_asset_report', { pageUrl, limit: 500 });
    assert.equal(assetsBefore.assets.filter((asset: { status: string }) => asset.status === 'unused').length, 0, 'a clean scene has no unused assets');
    const splash = assetsBefore.assets.find((asset: { name: string }) => asset.name === 'default_sprite_splash');
    assert.equal(splash.status, 'used');
    assert.ok(splash.refCount >= 1 && splash.usedBy.length >= 1);
    // A leak: assets loaded and shown, then the node is destroyed without decRef.
    await page.evaluate(() => {
      const { cc } = globalThis as any;
      const image = new cc.ImageAsset(document.createElement('canvas'));
      image._uuid = 'leak-image';
      const texture = new cc.Texture2D();
      texture._uuid = 'leak-texture';
      texture.image = image;
      const frame = new cc.SpriteFrame();
      frame._uuid = 'leak-frame';
      frame.texture = texture;
      for (const asset of [image, texture, frame]) {
        cc.assetManager.assets.add(asset._uuid, asset);
        asset.addRef();
      }
      const node = new cc.Node('LeakHolder');
      node.addComponent('cc.UITransform');
      node.addComponent('cc.Sprite').spriteFrame = frame;
      cc.director.getScene().getChildByName('Canvas').addChild(node);
    });
    assert.equal((await call(client, 'cocos_asset_report', { pageUrl, type: 'SpriteFrame' })).assets.find((asset: { uuid: string }) => asset.uuid === 'leak-frame').status, 'used');
    await page.evaluate(() => (globalThis as any).cc.director.getScene().getChildByName('Canvas').getChildByName('LeakHolder').destroy());
    // destroy() only marks the node; the engine detaches it at the end of a later frame.
    await page.waitForFunction(() => !(globalThis as any).cc.director.getScene().getChildByName('Canvas').getChildByName('LeakHolder'), undefined, { timeout: 5_000 });
    const leaked = await call(client, 'cocos_asset_report', { pageUrl, unusedOnly: true });
    assert.deepEqual(leaked.assets.map((asset: { uuid: string }) => asset.uuid).sort(), ['leak-frame', 'leak-image', 'leak-texture']);
    assert.ok(leaked.assets.find((asset: { uuid: string }) => asset.uuid === 'leak-texture').bytes > 0);
    await page.evaluate(() => { for (const uuid of ['leak-frame', 'leak-texture', 'leak-image']) (globalThis as any).cc.assetManager.releaseAsset((globalThis as any).cc.assetManager.assets.get(uuid)); });
    assert.equal((await call(client, 'cocos_asset_report', { pageUrl, unusedOnly: true })).matched, 0);
    await page.evaluate(uuids => {
      const canvas = (globalThis as any).cc.director.getScene().getChildByName('Canvas');
      for (const child of [...canvas.children]) if (uuids.includes(child.uuid)) child.destroy();
    }, [editUuid, passwordUuid, scrollUuid]);
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

    assert.equal((await call(client, 'cocos_get_selection', { pageUrl })).selection, null);
    const checkmark = await display('/InspectorTest/Canvas/Panel/TestToggle/Checkmark', 'Sprite');
    const mark = (await call(client, 'cocos_get_node_bounds', { pageUrl, uuid: checkmark.uuid })).viewport;
    const isChecked = () => call(client, 'cocos_get_properties', { pageUrl, uuid: toggle.uuid, componentType: 'Toggle', maxDepth: 0 }).then(result => result.properties.isChecked);
    const checkedBefore = await isChecked();
    await page.keyboard.down('Alt');
    await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
    await page.keyboard.up('Alt');
    const picked = (await call(client, 'cocos_get_selection', { pageUrl })).selection;
    // The earlier click unchecked the toggle, which deactivates Checkmark, so the pick skips it and lands on TestToggle.
    assert.equal(picked.node.uuid, toggle.uuid);
    // Panel only lays out children, so it never counts as a pick target.
    assert.deepEqual(picked.stack.map((item: { name: string }) => item.name), ['TestToggle']);
    assert.equal(await isChecked(), checkedBefore, 'Alt+click must not reach the game');
    // Real games keep invisible full-screen blockers on top (opacity 0, or a container with no renderer); picks must look through them.
    await page.evaluate(() => {
      const { cc } = globalThis as any;
      const canvas = cc.director.getScene().getChildByName('Canvas');
      const holder = new cc.Node('Holder');
      holder.layer = canvas.layer;
      holder.addComponent('cc.UITransform').setContentSize(4_000, 4_000);
      const blocker = new cc.Node('Blocker');
      blocker.layer = canvas.layer;
      blocker.addComponent('cc.UITransform').setContentSize(4_000, 4_000);
      blocker.addComponent('cc.Sprite');
      blocker.addComponent('cc.UIOpacity').opacity = 0;
      holder.addChild(blocker);
      canvas.addChild(holder);
    });
    await page.keyboard.down('Alt');
    await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
    await page.keyboard.up('Alt');
    assert.equal((await call(client, 'cocos_get_selection', { pageUrl })).selection.node.uuid, toggle.uuid);
    await page.evaluate(() => (globalThis as any).cc.director.getScene().getChildByName('Canvas').getChildByName('Holder').destroy());
    assert.deepEqual(await call(client, 'cocos_get_selection', { pageUrl, disable: true }), { version, picker: false, selection: null });

    assert.equal((await call(client, 'cocos_show_stats', { pageUrl, visible: false })).after.visible, false);
    assert.deepEqual((await call(client, 'cocos_show_stats', { pageUrl, visible: true })).after, { visible: true });
    assert.equal(await page.evaluate(() => (globalThis as any).cc.profiler.isShowingStats()), true);
    const emulated = await call(client, 'cocos_emulate_device', { pageUrl, preset: 'iphone-14', orientation: 'landscape', cpuSlowdown: 2, network: 'offline' });
    assert.deepEqual(emulated.after.device, { preset: 'iphone-14', width: 844, height: 390, deviceScaleFactor: 3, mobile: true, orientation: 'landscape' });
    assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio, navigator.maxTouchPoints, navigator.onLine, /iPhone/.test(navigator.userAgent)]), [844, 390, 3, 5, false, true]);
    // Chrome never acknowledges Playwright mouse input under touch emulation; click and drag must send touch instead of hanging.
    // cocos_emulate_device waits for the canvas resize, so a click right after it lands on the new layout.
    assert.equal((await call(client, 'cocos_click_node', { pageUrl, uuid: toggle.uuid })).clicked, true);
    assert.equal((await call(client, 'cocos_drag_node', { pageUrl, uuid: panelUuid, dx: 30, dy: 0, steps: 3, durationMs: 0 })).dragged, true);
    assert.deepEqual((await call(client, 'cocos_emulate_device', { pageUrl, reset: true })).after, {});
    // Reset clears every metrics override on the page, including Playwright's own viewport, back to the window size; Chrome applies it asynchronously.
    await page.waitForFunction(() => innerWidth !== 844, undefined, { timeout: 5_000 });
    assert.deepEqual(await page.evaluate(() => [devicePixelRatio, navigator.maxTouchPoints, navigator.onLine, /iPhone/.test(navigator.userAgent)]), [1, 0, true, false]);

    for (const viewport of [{ width: 1280, height: 720 }, { width: 640, height: 360 }]) {
      await page.setViewportSize(viewport);
      const highlighted = await call(client, 'cocos_highlight_node', { pageUrl, uuid: panelUuid, durationMs: 1_000 });
      assert.equal(highlighted.highlighted, true);
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(highlighted.bounds[key]), `${key} must be finite`);
      assert.ok(highlighted.bounds.width > 0 && highlighted.bounds.height > 0);
      assert.equal(await page.locator('body > div').last().evaluate(element => getComputedStyle(element).pointerEvents), 'none');
    }

    // Paths stand in for UUIDs on every node tool, so agents skip a find_node round trip; a path matching several nodes is refused.
    const titlePath = '/InspectorTest/Canvas/Panel/TitleLabel';
    assert.equal((await call(client, 'cocos_get_node', { pageUrl, path: titlePath })).node.name, 'TitleLabel');
    assert.equal((await call(client, 'cocos_get_properties', { pageUrl, path: titlePath, componentType: 'Label', maxDepth: 0 })).properties.string, 'Inspector title');
    assert.equal((await call(client, 'cocos_get_node_bounds', { pageUrl, path: titlePath })).available, true);
    assert.equal((await call(client, 'cocos_wait_for_property', { pageUrl, path: titlePath, key: 'active', equals: true, timeoutMs: 300 })).matched, true);
    assert.equal((await call(client, 'cocos_set_node_active', { pageUrl, path: titlePath, active: false })).after.active, false);
    assert.equal((await call(client, 'cocos_set_node_active', { pageUrl, path: titlePath, active: true })).after.active, true);
    assert.equal((await call(client, 'cocos_click_node', { pageUrl, path: '/InspectorTest/Canvas/Panel/TestToggle' })).clicked, true);
    assert.deepEqual((await client.callTool({ name: 'cocos_get_node', arguments: { pageUrl, path: '/InspectorTest/Canvas/Missing' } })).structuredContent, { code: 'NODE_NOT_FOUND', message: 'Node not found' });
    assert.equal((await client.callTool({ name: 'cocos_get_node', arguments: { pageUrl, uuid: panelUuid, path: titlePath } })).isError, true, 'uuid and path are exclusive');
    assert.equal((await client.callTool({ name: 'cocos_get_node', arguments: { pageUrl } })).isError, true, 'one of uuid or path is required');
    const twins = await page.evaluate(() => {
      const { cc } = globalThis as any;
      const panel = cc.director.getScene().getChildByName('Canvas').getChildByName('Panel');
      return [0, 1].map(() => { const twin = new cc.Node('Twin'); panel.addChild(twin); return twin.uuid; });
    });
    const ambiguousPath = await client.callTool({ name: 'cocos_set_node_active', arguments: { pageUrl, path: '/InspectorTest/Canvas/Panel/Twin', active: false } });
    assert.deepEqual(ambiguousPath.structuredContent, { code: 'AMBIGUOUS_NODE', message: `Path matches 2 nodes; pass one uuid: ${twins.join(', ')}` });
    assert.equal(await page.evaluate(() => (globalThis as any).cc.director.getScene().getChildByName('Canvas').getChildByName('Panel').children.filter((child: any) => child.name === 'Twin').every((child: any) => child.active)), true, 'an ambiguous path mutates nothing');
    await page.evaluate(() => { for (const twin of (globalThis as any).cc.director.getScene().getChildByName('Canvas').getChildByName('Panel').children.filter((child: any) => child.name === 'Twin')) twin.destroy(); });

    // Why a tap does or does not land: replays the engine dispatch order, dispatches nothing.
    const togglePath = '/InspectorTest/Canvas/Panel/TestToggle';
    const toggleState = () => call(client, 'cocos_get_properties', { pageUrl, path: togglePath, componentType: 'Toggle', maxDepth: 0 }).then(result => result.properties.isChecked);
    const checkedBeforeExplain = await toggleState();
    const open = await call(client, 'cocos_explain_click', { pageUrl, path: togglePath });
    assert.equal(open.clickable, true, JSON.stringify(open));
    assert.equal(open.claimedBy.path, '/InspectorTest/Canvas/Panel/TestToggle');
    assert.equal(await toggleState(), checkedBeforeExplain, 'explain_click must not tap');
    await page.evaluate(() => {
      const { cc } = globalThis as any;
      const panel = cc.director.getScene().getChildByName('Canvas').getChildByName('Panel');
      const shield = new cc.Node('Shield');
      shield.layer = panel.layer;
      shield.addComponent('cc.UITransform').setContentSize(2_000, 2_000);
      shield.addComponent('cc.BlockInputEvents');
      panel.addChild(shield);
    });
    const blocked = await call(client, 'cocos_explain_click', { pageUrl, path: togglePath });
    assert.equal(blocked.clickable, false, JSON.stringify(blocked));
    assert.deepEqual(blocked.reasons, ['BLOCKED_BY_BLOCK_INPUT_EVENTS'], JSON.stringify(blocked));
    assert.equal(blocked.claimedBy.path, '/InspectorTest/Canvas/Panel/Shield');
    await page.evaluate(() => (globalThis as any).cc.director.getScene().getChildByName('Canvas').getChildByName('Panel').getChildByName('Shield').destroy());
    const buttonPath = '/InspectorTest/Canvas/Panel/TestButton';
    const buttonComponent = (await call(client, 'cocos_get_components', { pageUrl, path: buttonPath })).components.find((item: { type: string }) => item.type === 'Button').uuid as string;
    await call(client, 'cocos_set_property', { pageUrl, path: buttonPath, componentUuid: buttonComponent, key: 'interactable', value: false }).catch(() => undefined);
    await page.evaluate(() => { (globalThis as any).cc.director.getScene().getChildByName('Canvas').getChildByName('Panel').getChildByName('TestButton').getComponent('cc.Button').interactable = false; });
    assert.ok((await call(client, 'cocos_explain_click', { pageUrl, path: buttonPath })).reasons.includes('BUTTON_NOT_INTERACTABLE'));
    await page.evaluate(() => { (globalThis as any).cc.director.getScene().getChildByName('Canvas').getChildByName('Panel').getChildByName('TestButton').getComponent('cc.Button').interactable = true; });
    const atPoint = await call(client, 'cocos_explain_click', { pageUrl, x: open.point.x, y: open.point.y });
    assert.equal(atPoint.claimedBy.path, open.claimedBy.path, 'a viewport point resolves the same claimer');

    // Callbacks that outlive their popup. The engine purges ones bound to a destroyed Cocos object; an arrow function registered on each
    // open is unowned, never purged, and grows; a component timer scheduled on a detached (pooled) node is reported as detached.
    const listenersBefore = await call(client, 'cocos_listener_report', { pageUrl });
    assert.equal(listenersBefore.destroyedCount, 0, JSON.stringify(listenersBefore.dead));
    const openLeakyPopup = () => page.evaluate(() => {
      const { cc } = globalThis as any;
      const node = new cc.Node('LeakyPopup');
      cc.director.getScene().getChildByName('Canvas').addChild(node);
      // A typical leak: an arrow callback the popup never removes.
      cc.director.on(cc.Director.EVENT_AFTER_DRAW, () => node.name);
      node.destroy();
    });
    await openLeakyPopup();
    const afterOne = await call(client, 'cocos_listener_report', { pageUrl });
    await openLeakyPopup();
    await openLeakyPopup();
    const afterThree = await call(client, 'cocos_listener_report', { pageUrl });
    const drawGroup = (report: Record<string, any>) => (report.unowned as Array<{ kind: string; event?: string; count: number }>).find(group => group.kind === 'director.on' && group.event === 'director_after_draw')?.count ?? 0;
    assert.equal(drawGroup(afterThree) - drawGroup(afterOne), 2, 'each open adds one unowned listener');
    await page.evaluate(() => {
      const { cc } = globalThis as any;
      const pooled = new cc.Node('PooledItem');
      class PoolTimer extends cc.Component { tick() { return 1; } }
      cc._decorator.ccclass('PoolTimer')(PoolTimer);
      const view = pooled.addComponent(PoolTimer);
      cc.director.getScheduler().schedule(view.tick, view, 5, false);
      (globalThis as any).__pooled = view;
    });
    const pooled = await call(client, 'cocos_listener_report', { pageUrl });
    assert.ok(pooled.dead.some((item: { kind: string; state: string; target: { node: string } }) => item.kind === 'schedule' && item.state === 'detached' && item.target.node === 'PooledItem'), JSON.stringify(pooled.dead));
    await page.evaluate(() => {
      const { cc } = globalThis as any;
      cc.director.getScheduler().unscheduleAllForTarget((globalThis as any).__pooled);
      const list = cc.director._callbackTable[cc.Director.EVENT_AFTER_DRAW];
      for (const info of [...list.callbackInfos]) if (info && info.target === undefined && /node\.name/.test(String(info.callback))) cc.director.off(cc.Director.EVENT_AFTER_DRAW, info.callback);
    });
    assert.equal(drawGroup(await call(client, 'cocos_listener_report', { pageUrl })), drawGroup(listenersBefore));

    // Time scale multiplies every frame's dt.
    assert.deepEqual((await call(client, 'cocos_set_time_scale', { pageUrl })).after, { scale: 1 });
    const scaledTicks = async () => page.evaluate(() => new Promise<number>(resolve => {
      const { cc } = globalThis as any;
      let elapsed = 0;
      const tick = (dt: number) => { elapsed += dt; };
      cc.director.getScheduler().schedule(tick, cc.director.getScene(), 0, false);
      setTimeout(() => { cc.director.getScheduler().unschedule(tick, cc.director.getScene()); resolve(elapsed); }, 600);
    }));
    const normal = await scaledTicks();
    assert.deepEqual((await call(client, 'cocos_set_time_scale', { pageUrl, scale: 4 })).after, { scale: 4 });
    const fast = await scaledTicks();
    assert.ok(fast > normal * 2.5, `scale 4 must speed up game time: ${normal} -> ${fast}`);
    assert.deepEqual((await call(client, 'cocos_set_time_scale', { pageUrl, scale: 1 })), { changed: true, target: {}, before: { scale: 4 }, after: { scale: 1 }, runtimeOnly: true });
    assert.equal(await page.evaluate(() => Object.prototype.hasOwnProperty.call((globalThis as any).cc.director, 'tick')), false, 'scale 1 restores the original tick');

    // Method calls: engine methods on real components, game-style methods on a runtime component, and live-object arguments.
    const labelNode = (await call(client, 'cocos_find_node', { pageUrl, path: '/InspectorTest/Canvas/Panel/TitleLabel' })).matches[0].uuid as string;
    const labelComponent = (await call(client, 'cocos_get_components', { pageUrl, uuid: labelNode })).components.find((component: { type: string }) => component.type === 'Label').uuid as string;
    const named = await call(client, 'cocos_call_method', { pageUrl, uuid: labelNode, method: 'getChildByName', args: ['missing'] });
    assert.deepEqual(named.result, { value: null });
    const sibling = await call(client, 'cocos_call_method', { pageUrl, uuid: labelNode, method: 'getSiblingIndex' });
    assert.equal(typeof sibling.result.value, 'number');
    const component = await call(client, 'cocos_call_method', { pageUrl, uuid: labelNode, method: 'getComponent', args: ['cc.Label'] });
    assert.deepEqual(component.result.value, { $type: 'Component', uuid: labelComponent, type: 'Label' });
    await page.evaluate(() => {
      const { cc } = globalThis as any;
      class InspectorProbe extends cc.Component {
        score = 1;
        stats = { token: 'probe-token-secret', level: 2 };
        add(amount: number) { this.score += amount; return { score: this.score, stats: this.stats }; }
        target(node: any) { return node.name; }
        fail() { throw new TypeError('probe failure'); }
        later(value: string) { return new Promise(resolve => setTimeout(() => resolve(`done:${value}`), 50)); }
        never() { return new Promise(() => undefined); }
        _hidden() { return 'hidden'; }
      }
      cc._decorator.ccclass('InspectorProbe')(InspectorProbe);
      cc.director.getScene().getChildByName('Canvas').getChildByName('Panel').addComponent(InspectorProbe);
    });
    const probe = (await call(client, 'cocos_get_components', { pageUrl, uuid: panelUuid })).components.find((item: { type: string }) => item.type === 'InspectorProbe').uuid as string;
    const added = await call(client, 'cocos_call_method', { pageUrl, uuid: panelUuid, componentUuid: probe, method: 'add', args: [4] });
    assert.deepEqual(added.result.value, { score: 5, stats: { level: 2 } }, 'results use the property redaction rules');
    assert.equal(JSON.stringify(added).includes('probe-token-secret'), false);
    assert.ok(added.serialization.redacted >= 1);
    assert.equal((await call(client, 'cocos_call_method', { pageUrl, uuid: panelUuid, componentUuid: probe, method: 'target', args: [{ $node: labelNode }] })).result.value, 'TitleLabel');
    assert.equal((await call(client, 'cocos_call_method', { pageUrl, uuid: panelUuid, componentUuid: probe, method: 'target', args: [{ $path: '/InspectorTest/Canvas/Panel/TitleLabel' }] })).result.value, 'TitleLabel');
    assert.deepEqual((await call(client, 'cocos_call_method', { pageUrl, uuid: panelUuid, componentUuid: probe, method: 'fail' })).threw, { name: 'TypeError', message: 'probe failure' });
    assert.deepEqual((await call(client, 'cocos_call_method', { pageUrl, uuid: panelUuid, componentUuid: probe, method: 'later', args: ['x'], awaitMs: 2_000 })).result, { value: 'done:x' });
    const pending = await call(client, 'cocos_call_method', { pageUrl, uuid: panelUuid, componentUuid: probe, method: 'never', awaitMs: 100 });
    assert.equal(pending.timedOut, true);
    assert.equal((await client.callTool({ name: 'cocos_call_method', arguments: { pageUrl, uuid: panelUuid, componentUuid: probe, method: '_hidden' } })).isError, true, 'the schema rejects private names');
    for (const method of ['destroy', 'constructor', 'notThere']) {
      const refused = await client.callTool({ name: 'cocos_call_method', arguments: { pageUrl, uuid: panelUuid, componentUuid: probe, method } });
      assert.equal((refused.structuredContent as { code: string } | undefined)?.code, 'INVALID_MUTATION', `${method}: ${JSON.stringify(refused)}`);
    }
    assert.equal((await client.callTool({ name: 'cocos_call_method', arguments: { pageUrl, uuid: panelUuid, method: 'toString()' } })).isError, true, 'method names are identifiers');
    await page.evaluate(() => {
      const panel = (globalThis as any).cc.director.getScene().getChildByName('Canvas').getChildByName('Panel');
      panel.getComponent('InspectorProbe').destroy();
    });

    // Browser data: the game logs a secret, calls an API with a token, and stores one; every tool must mask them.
    await page.evaluate(async () => {
      console.log('login ok token=log-token-secret mode=guest');
      console.error('asset failed to load');
      localStorage.setItem('authToken', 'storage-token-secret');
      localStorage.setItem('settings', JSON.stringify({ volume: 3, password: 'storage-password-secret' }));
      await fetch('/api/login?access_token=query-token-secret&mode=guest', {
        method: 'POST',
        headers: { authorization: 'Bearer header-token-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ user: 'bob', password: 'body-password-secret' }),
      });
      await fetch('/missing-asset.png').then(response => response.arrayBuffer()).catch(() => undefined);
    });
    const consoleResult = await call(client, 'cocos_console_messages', { pageUrl, textContains: 'login ok' });
    assert.equal(consoleResult.messages.length, 1);
    assert.equal(consoleResult.messages[0].text, 'login ok token=[redacted] mode=guest');
    assert.equal((await call(client, 'cocos_console_messages', { pageUrl, types: ['error'] })).messages.some((message: { text: string }) => message.text === 'asset failed to load'), true);
    const requests = await call(client, 'cocos_network_requests', { pageUrl, urlContains: '/api/login' });
    assert.equal(requests.requests.length, 1);
    assert.equal(requests.requests[0].status, 200);
    assert.ok(requests.requests[0].url.endsWith('/api/login?access_token=%5Bredacted%5D&mode=guest'), requests.requests[0].url);
    // Playwright attaches the response to its Request slightly after fetch resolves in the page.
    let failed: Array<{ url: string; status: number }> = [];
    for (let attempt = 0; attempt < 20 && !failed.some(request => request.url.endsWith('/missing-asset.png') && request.status === 404); attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 50));
      failed = (await call(client, 'cocos_network_requests', { pageUrl, failedOnly: true })).requests;
    }
    assert.ok(failed.some(request => request.url.endsWith('/missing-asset.png') && request.status === 404), JSON.stringify(failed));
    const detail = await call(client, 'cocos_network_request', { pageUrl, id: requests.requests[0].id, includeBody: true });
    assert.equal(detail.requestHeaders.authorization, '[redacted]');
    assert.equal(detail.responseHeaders['set-cookie'], '[redacted]');
    assert.deepEqual(JSON.parse(detail.requestBody.body), { user: 'bob', password: '[redacted]' });
    assert.deepEqual(JSON.parse(detail.responseBody.body), { user: 'bob', accessToken: '[redacted]', level: 7 });
    const local = await call(client, 'cocos_storage', { pageUrl, area: 'local' });
    assert.deepEqual(local.entries.find((entry: { key: string }) => entry.key === 'authToken').value, '[redacted]');
    assert.deepEqual(JSON.parse(local.entries.find((entry: { key: string }) => entry.key === 'settings').value), { volume: 3, password: '[redacted]' });
    const cookies = await call(client, 'cocos_storage', { pageUrl, area: 'cookies' });
    assert.equal(cookies.entries.find((entry: { name: string }) => entry.name === 'sid').value, '[redacted]');
    const everything = JSON.stringify([consoleResult, requests, detail, local, cookies]);
    for (const secret of ['log-token', 'query-token', 'header-token', 'body-password', 'response-token', 'storage-token', 'storage-password', 'server-session']) assert.equal(everything.includes(secret), false, secret);
    assert.deepEqual((await client.callTool({ name: 'cocos_network_request', arguments: { pageUrl, id: 999_999 } })).structuredContent, { code: 'REQUEST_NOT_FOUND', message: 'Request 999999 not found; list requests again, older entries are dropped' });
    await page.evaluate(() => localStorage.clear());

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
