import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserConnection, InspectorError, sanitizeUrl, validateLocalUrl } from './browser.js';
import { devicePresetNames, emulateDevice, inspectCocosPage, networkProfileNames, type DevicePreset, type NetworkProfile } from './bridge.js';

const write = (line: string) => process.stdout.write(`${line}\n`);

function flags(args: string[], names: string[], booleans: string[] = []): { values: Record<string, string>; positional: string[] } {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (booleans.includes(arg)) values[arg] = 'true';
    else if (names.includes(arg)) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      values[arg] = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    else positional.push(arg);
  }
  return { values, positional };
}

function chromePath(override?: string): string {
  const candidates = override ? [override] : process.env.CHROME_PATH ? [process.env.CHROME_PATH] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(base => join(base!, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error(`Chrome not found (checked ${candidates.join(', ')}); pass --chrome-path or set CHROME_PATH`);
  return found;
}

async function probe(endpoint: string): Promise<{ status: 'ok'; browser: string } | { status: 'http'; code: number } | { status: 'down'; message: string }> {
  try {
    const response = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return { status: 'http', code: response.status };
    return { status: 'ok', browser: String(((await response.json()) as { Browser?: unknown }).Browser ?? 'unknown') };
  } catch (error) {
    return { status: 'down', message: error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : 'unknown error' };
  }
}

function listener(port: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[1]?.split(/\s+/).slice(0, 2).join(' pid ');
  } catch {
    return undefined;
  }
}

async function launch(args: string[]): Promise<void> {
  const { values, positional } = flags(args, ['--port', '--profile', '--chrome-path', '--device', '--cpu-slowdown', '--network'], ['--landscape']);
  if (positional.length !== 1) throw new Error('Usage: cocos-web-inspector-mcp launch <url> [--port 9222] [--profile <dir>] [--chrome-path <path>] [--device <preset>] [--landscape] [--cpu-slowdown <1-20>] [--network <profile>]');
  const url = validateLocalUrl(positional[0]!, true).href;
  const port = Number(values['--port'] ?? 9222);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) throw new Error('--port must be an integer from 1024 to 65535');
  const device = values['--device'] as DevicePreset | undefined;
  if (device && !devicePresetNames.includes(device)) throw new Error(`--device must be one of: ${devicePresetNames.join(', ')}`);
  const network = values['--network'] as NetworkProfile | undefined;
  if (network && !networkProfileNames.includes(network)) throw new Error(`--network must be one of: ${networkProfileNames.join(', ')}`);
  const cpuSlowdown = values['--cpu-slowdown'] === undefined ? undefined : Number(values['--cpu-slowdown']);
  if (cpuSlowdown !== undefined && !(cpuSlowdown >= 1 && cpuSlowdown <= 20)) throw new Error('--cpu-slowdown must be from 1 to 20');
  if (values['--landscape'] && !device) throw new Error('--landscape needs --device');

  const endpoint = `http://127.0.0.1:${port}`;
  if ((await probe(endpoint)).status !== 'down') throw new Error(`Port ${port} is already in use${listener(String(port)) ? ` by ${listener(String(port))}` : ''}; pass --port or stop that process`);
  const profile = values['--profile'] ?? join(tmpdir(), `cocos-web-inspector-profile-${port}`);
  const chrome = spawn(chromePath(values['--chrome-path']), [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ], { stdio: 'ignore' });
  const exited = new Promise<void>(resolve => chrome.once('exit', () => resolve()));
  const failed = new Promise<never>((_, reject) => chrome.once('error', reject));
  const deadline = Date.now() + 15_000;
  while ((await Promise.race([probe(endpoint), failed])).status !== 'ok') {
    if (chrome.exitCode !== null || Date.now() > deadline) throw new Error(`Chrome did not open remote debugging on port ${port}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  const emulating = device || cpuSlowdown !== undefined || network;
  if (emulating) {
    // Chrome drops emulation when its CDP session closes, so this process keeps the connection open.
    const browser = await chromium.connectOverCDP(endpoint);
    const deadlinePage = Date.now() + 10_000;
    let page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === url);
    while (!page && Date.now() < deadlinePage) {
      await new Promise(resolve => setTimeout(resolve, 200));
      page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === url);
    }
    if (!page) throw new Error(`Page ${sanitizeUrl(url)} did not open`);
    await emulateDevice(page, { preset: device, orientation: values['--landscape'] ? 'landscape' : undefined, cpuSlowdown, network, reload: true });
  }

  write(`Chrome is running with loopback remote debugging at ${endpoint}`);
  write(`Profile: ${profile}`);
  if (emulating) write(`Emulation: ${[device && `${device}${values['--landscape'] ? ' landscape' : ''}`, cpuSlowdown && `CPU ${cpuSlowdown}x slower`, network].filter(Boolean).join(', ')} (ends when this command stops)`);
  write('Add the MCP server to Claude Code with:');
  write(`  claude mcp add cocos-web-inspector -- npx -y cocos-web-inspector-mcp --cdp-endpoint ${endpoint}`);
  write('Press Ctrl+C to close Chrome.');
  const stop = () => chrome.kill();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await exited;
  process.exit(0);
}

async function doctor(args: string[]): Promise<void> {
  const { values, positional } = flags(args, ['--cdp-endpoint']);
  if (positional.length) throw new Error('Usage: cocos-web-inspector-mcp doctor [--cdp-endpoint <url>]');
  const endpoint = values['--cdp-endpoint'] ?? process.env.COCOS_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
  let failed = false;
  const pass = (message: string) => write(`ok    ${message}`);
  const fail = (code: string, message: string, fix: string) => {
    failed = true;
    write(`FAIL  ${code}: ${message}\n      Fix: ${fix}`);
  };

  let url: URL;
  try {
    url = validateLocalUrl(endpoint);
    pass(`CDP endpoint ${url.origin} is loopback`);
  } catch (error) {
    fail('CDP_UNAVAILABLE', `${error instanceof Error ? error.message : 'Invalid endpoint'}: ${sanitizeUrl(endpoint)}`, 'use an http://127.0.0.1:<port> endpoint');
    process.exitCode = 1;
    return;
  }
  const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  const owner = listener(port);
  const httpEndpoint = url.origin.replace(/^ws/, 'http');
  const probed = await probe(httpEndpoint);
  if (probed.status === 'down') fail('CDP_UNAVAILABLE', `nothing answers on port ${port} (${probed.message})`, `run: npx cocos-web-inspector-mcp launch <game-url> --port ${port}`);
  else if (probed.status === 'http') fail('CDP_UNAVAILABLE', `port ${port} answers HTTP ${probed.code}${owner ? ` (${owner})` : ''}`, probed.code === 404 ? 'Chrome built-in remote debugging (chrome://inspect/#remote-debugging) holds this port; turn it off or launch on another --port' : 'stop the process holding this port or use another port');
  else pass(`${probed.browser} answers on port ${port}${owner ? ` (${owner})` : ''}`);

  const connection = new BrowserConnection(endpoint);
  try {
    if (probed.status === 'ok' || probed.status === 'http' && probed.code === 404) {
      const pages = await connection.pages();
      if (!pages.length) fail('NO_LOCAL_PAGE', 'no localhost page is open', 'open the game at http://localhost:<port>/ in that Chrome');
      else pass(`${pages.length} localhost page${pages.length === 1 ? '' : 's'} open`);
      for (const page of pages.slice(0, 10)) {
        const info = await page.evaluate(inspectCocosPage).catch(() => undefined) as { cocos?: { detected: boolean; version?: string; sceneName?: string } } | undefined;
        const name = sanitizeUrl(page.url());
        if (!info?.cocos?.detected) fail('COCOS_NOT_FOUND', `no Cocos Creator 3.x runtime on ${name}`, 'wait for the build to load, or check that it is a Cocos Creator 3.x web build');
        else if (!info.cocos.sceneName) fail('SCENE_NOT_READY', `Cocos ${info.cocos.version} on ${name} has no active scene yet`, 'wait for the first scene to load');
        else pass(`Cocos ${info.cocos.version}, scene "${info.cocos.sceneName}" on ${name}`);
      }
      if (pages.length > 1) write(`note  ${pages.length} pages: MCP tools need pageUrl (see cocos_list_pages)`);
    }
  } catch (error) {
    fail(error instanceof InspectorError ? error.code : 'CDP_UNAVAILABLE', error instanceof Error ? error.message : 'connection failed', 'restart Chrome with --remote-debugging-port, or use the launch command');
  } finally {
    await connection.close().catch(() => {});
  }
  if (failed) process.exitCode = 1;
}

export const commands: Record<string, (args: string[]) => Promise<void>> = { launch, doctor };
