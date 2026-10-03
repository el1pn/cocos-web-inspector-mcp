import { chromium, type Browser, type Page } from 'playwright-core';

const LOOPBACK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const PAGE_PROTOCOLS = new Set(['http:', 'https:']);

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
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

export class BrowserConnection {
  #browser: Browser | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly timeout = 10_000,
  ) {
    validateLocalUrl(endpoint);
  }

  async page(pageUrl?: string): Promise<Page> {
    const browser = await this.#connect();
    const pages = browser.contexts().flatMap(context => context.pages()).filter(candidate => {
      try {
        validateLocalUrl(candidate.url(), true);
        return true;
      } catch {
        return false;
      }
    });

    if (pageUrl) {
      const wanted = validateLocalUrl(pageUrl, true).href;
      const selected = pages.find(candidate => new URL(candidate.url()).href === wanted);
      if (!selected) throw new Error(`Local page not found: ${sanitizeUrl(pageUrl)}`);
      return selected;
    }
    if (pages.length === 0) throw new Error('No localhost page is attached to Chromium');
    if (pages.length > 1) {
      const choices = pages.slice(0, 10).map(candidate => sanitizeUrl(candidate.url())).join(', ');
      throw new Error(`Multiple localhost pages found; pass pageUrl: ${choices}`);
    }
    return pages[0]!;
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    await browser?.close();
  }

  async #connect(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    const browser = await chromium.connectOverCDP(this.endpoint, { timeout: this.timeout });
    this.#browser = browser;
    browser.on('disconnected', () => {
      this.#browser = undefined;
    });
    return browser;
  }
}
