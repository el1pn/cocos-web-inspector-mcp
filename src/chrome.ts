import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { InspectorError, sanitizeUrl, validateLocalUrl, type BrowserConnection } from './browser.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function chromePath(override?: string): string {
  const candidates = override ? [override] : process.env.CHROME_PATH ? [process.env.CHROME_PATH] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(base => join(base!, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error(`Chrome not found (checked ${candidates.join(', ')}); pass --chrome-path or set CHROME_PATH`);
  return found;
}

export async function probe(endpoint: string): Promise<{ status: 'ok'; browser: string } | { status: 'http'; code: number } | { status: 'down'; message: string }> {
  try {
    const response = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return { status: 'http', code: response.status };
    return { status: 'ok', browser: String(((await response.json()) as { Browser?: unknown }).Browser ?? 'unknown') };
  } catch (error) {
    return { status: 'down', message: error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : 'unknown error' };
  }
}

// Opt-in (--allow-launch) page and browser lifecycle. The agent supplies only a loopback page URL: the Chrome path comes from
// CHROME_PATH or the platform default, the port from the CDP endpoint, and the profile is a fresh temp directory.
// Only pages opened here can be closed here, and the Chrome this process spawned is killed with its last page or on shutdown.
export class ChromeLauncher {
  #child: ChildProcess | undefined;
  #profile: string | undefined;
  #owned = new Set<Page>();
  #lock: Promise<unknown> = Promise.resolve();
  readonly #port: number;
  readonly #origin: string;

  constructor(endpoint: string, private readonly browser: BrowserConnection) {
    const url = validateLocalUrl(endpoint);
    this.#port = Number(url.port || 80);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || this.#port < 1_024) throw new Error('--allow-launch needs a --cdp-endpoint on 127.0.0.1 or localhost with a port from 1024 to 65535');
    this.#origin = `http://127.0.0.1:${this.#port}`;
  }

  open(rawUrl: string): Promise<{ page: Page; launched: boolean }> {
    const run = this.#lock.then(() => this.#open(rawUrl));
    this.#lock = run.catch(() => {});
    return run;
  }

  async closePage(rawUrl: string): Promise<{ closed: true; browserClosed: boolean }> {
    const wanted = validateLocalUrl(rawUrl, true);
    const live = [...this.#owned].filter(page => !page.isClosed());
    let match = live.filter(page => page.url() === wanted.href);
    if (!match.length && !wanted.search && !wanted.hash) match = live.filter(page => { const url = new URL(page.url()); return url.origin + url.pathname === wanted.origin + wanted.pathname; });
    if (match.length !== 1) throw new InspectorError('PAGE_NOT_FOUND', `${match.length ? 'Several' : 'No'} pages opened by this server match ${sanitizeUrl(rawUrl)}; opened by this server: ${live.map(page => sanitizeUrl(page.url())).join(', ') || 'none'}`);
    await match[0]!.close();
    this.#owned.delete(match[0]!);
    const last = this.#child !== undefined && ![...this.#owned].some(page => !page.isClosed());
    if (last) await this.close();
    return { closed: true, browserClosed: last };
  }

  async close(): Promise<void> {
    const child = this.#child;
    const profile = this.#profile;
    this.#child = this.#profile = undefined;
    this.#owned.clear();
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, sleep(5_000)]);
    }
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }

  async #open(rawUrl: string): Promise<{ page: Page; launched: boolean }> {
    const url = validateLocalUrl(rawUrl, true).href;
    const state = await probe(this.#origin);
    if (state.status === 'http') throw new InspectorError('CDP_UNAVAILABLE', `Port ${this.#port} answers HTTP ${state.code} but is not a Chromium remote-debugging endpoint; free the port or use another --cdp-endpoint`);
    let page: Page;
    if (state.status === 'ok') {
      page = await this.browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      } catch (error) {
        await page.close().catch(() => {});
        throw new InspectorError('PAGE_NOT_FOUND', `Could not load ${sanitizeUrl(url)}: ${error instanceof Error ? error.message.split('\n')[0] : 'navigation failed'}`);
      }
    } else {
      try {
        await this.#spawn(url);
        page = await this.#firstPage();
      } catch (error) {
        await this.close();
        throw error;
      }
    }
    this.#owned.add(page);
    return { page, launched: state.status === 'down' };
  }

  async #spawn(url: string): Promise<void> {
    this.#profile = await mkdtemp(join(tmpdir(), 'cocos-web-inspector-'));
    const child = spawn(chromePath(), [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${this.#port}`,
      `--user-data-dir=${this.#profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      url,
    ], { stdio: 'ignore' });
    this.#child = child;
    const failed = new Promise<never>((_, reject) => child.once('error', reject));
    const deadline = Date.now() + 15_000;
    while ((await Promise.race([probe(this.#origin), failed])).status !== 'ok') {
      if (child.exitCode !== null || Date.now() > deadline) throw new InspectorError('CDP_UNAVAILABLE', `Chrome did not open remote debugging on port ${this.#port}`);
      await sleep(200);
    }
  }

  async #firstPage(): Promise<Page> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const page = (await this.browser.pages())[0];
      if (page) return page;
      if (Date.now() > deadline) throw new InspectorError('NO_LOCAL_PAGE', 'Chrome started but the page did not open');
      await sleep(200);
    }
  }
}
