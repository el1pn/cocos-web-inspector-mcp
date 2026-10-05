import { chromium, type Browser, type Page } from 'playwright-core';

const LOOPBACK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const PAGE_PROTOCOLS = new Set(['http:', 'https:']);

export type InspectorErrorCode =
  | 'CDP_UNAVAILABLE'
  | 'NO_LOCAL_PAGE'
  | 'MULTIPLE_PAGES'
  | 'PAGE_NOT_FOUND'
  | 'COCOS_NOT_FOUND'
  | 'SCENE_NOT_READY'
  | 'NODE_NOT_FOUND'
  | 'COMPONENT_NOT_FOUND'
  | 'AMBIGUOUS_COMPONENT'
  | 'MUTATION_DISABLED'
  | 'INVALID_MUTATION'
  | 'OUTPUT_TRUNCATED';

export class InspectorError extends Error {
  constructor(readonly code: InspectorErrorCode, message: string) {
    super(message);
    this.name = 'InspectorError';
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!match && match.slice(1).every(part => Number(part) <= 255) && match[1] === '127';
}

export function validateLocalUrl(raw: string, page = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  const protocols = page ? PAGE_PROTOCOLS : LOOPBACK_PROTOCOLS;
  if (!protocols.has(url.protocol)) throw new Error(`Unsupported ${page ? 'page' : 'CDP'} URL protocol`);
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  if (!page && (url.search || url.hash)) throw new Error('CDP URL query and fragment are not allowed');
  if (!isLoopbackHostname(url.hostname)) throw new Error('Only localhost targets are allowed');
  return url;
}

export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 2_000);
  } catch {
    return '<invalid-url>';
  }
}

export class BrowserConnection {
  #browser: Browser | undefined;
  #connecting: Promise<Browser> | undefined;
  #closed = false;

  constructor(
    private readonly endpoint: string,
    private readonly timeout = 10_000,
    private readonly connectOverCDP: (endpoint: string, options: { timeout: number }) => Promise<Browser> =
      (target, options) => chromium.connectOverCDP(target, options),
  ) {
    validateLocalUrl(endpoint);
  }

  async pages(): Promise<Page[]> {
    if (this.#closed) throw new Error('Browser connection is closed');
    const browser = await this.#connect();
    if (this.#closed) throw new Error('Browser connection is closed');
    return browser.contexts().flatMap(context => context.pages()).filter(candidate => {
      try {
        validateLocalUrl(candidate.url(), true);
        return true;
      } catch {
        return false;
      }
    });
  }

  async page(pageUrl?: string): Promise<Page> {
    const pages = await this.pages();
    if (pageUrl) {
      const wanted = validateLocalUrl(pageUrl, true).href;
      const selected = pages.filter(candidate => new URL(candidate.url()).href === wanted);
      if (selected.length === 0) throw new InspectorError('PAGE_NOT_FOUND', `Local page not found: ${sanitizeUrl(pageUrl)}`);
      if (selected.length > 1) throw new InspectorError('MULTIPLE_PAGES', `Multiple localhost pages match pageUrl: ${sanitizeUrl(pageUrl)}; close duplicate tabs or use a separate Chromium per project`);
      return selected[0]!;
    }
    if (pages.length === 0) throw new InspectorError('NO_LOCAL_PAGE', 'No localhost page is attached to Chromium');
    if (pages.length > 1) {
      const choices = pages.slice(0, 10).map(candidate => sanitizeUrl(candidate.url())).join(', ');
      throw new InspectorError('MULTIPLE_PAGES', `Multiple localhost pages found; pass pageUrl: ${choices}`);
    }
    return pages[0]!;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const current = this.#browser;
    const connecting = this.#connecting;
    this.#browser = undefined;
    const pending = await connecting?.catch(() => undefined);
    if (this.#browser === pending) this.#browser = undefined;
    await Promise.all([...new Set([current, pending].filter((browser): browser is Browser => !!browser))].map(browser => browser.close()));
  }

  async #connect(): Promise<Browser> {
    if (this.#closed) throw new Error('Browser connection is closed');
    if (this.#browser?.isConnected()) return this.#browser;
    if (this.#connecting) return this.#connecting;

    const options = { timeout: this.timeout };
    const connecting = this.connectOverCDP(this.endpoint, options).catch(error => {
      // A second Chromium on a taken IPv4 port may bind only [::1].
      const url = new URL(this.endpoint);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/\b404\b|ECONNREFUSED/.test(String(error?.message))) throw error;
      url.hostname = '[::1]';
      return this.connectOverCDP(url.toString().replace(/\/$/, ''), options).catch(() => { throw error; });
    }).then(async browser => {
      if (this.#closed) {
        await browser.close();
        throw new Error('Browser connection is closed');
      }
      this.#browser = browser;
      browser.on('disconnected', () => {
        if (this.#browser === browser) this.#browser = undefined;
      });
      return browser;
    }).catch(error => {
      if (error instanceof InspectorError || error instanceof Error && error.message === 'connect failed') throw error;
      const message = error instanceof Error ? error.message : 'unknown error';
      const hint = /\b404\b/.test(message)
        ? '; port is likely held by Chrome built-in remote debugging (chrome://inspect/#remote-debugging), which has no /json/version: turn it off or use another port, check with lsof -nP -iTCP:<port> -sTCP:LISTEN'
        : '';
      throw new InspectorError('CDP_UNAVAILABLE', `Unable to connect to Chromium CDP: ${message}${hint}`);
    });
    this.#connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.#connecting === connecting) this.#connecting = undefined;
    }
  }
}
