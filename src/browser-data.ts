import type { Page, Request } from 'playwright-core';
import { InspectorError } from './browser.js';

// Browser data tools (console, network, storage) run only behind --allow-browser-data.
// Redaction is best effort: secret-like keys, auth headers, cookie values, JWTs, and bearer tokens are masked; free text can still leak.
const REDACTED = '[redacted]';
const MAX_TEXT = 2_000;
const MAX_BODY = 20_000;
const sensitiveParts = ['token', 'cookie', 'authorization', 'password', 'passwd', 'secret', 'credential', 'jwt', 'apikey', 'privatekey', 'accesskey', 'signingkey', 'authheader', 'signature', 'otp', 'pin'];
const sensitiveHeaders = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token']);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
  return sensitiveParts.some(part => part === 'pin' || part === 'otp' ? normalized === part : normalized.includes(part))
    || normalized.includes('bearer')
    || normalized.startsWith('session') && ['id', 'key', 'token'].some(part => normalized.includes(part));
}

export function redactText(text: string, limit = MAX_TEXT): string {
  return text
    .replace(/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, '[redacted-jwt]')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/((?:^|[?&;\s"'{,])([\w-]+)["']?\s*[=:]\s*["']?)([^&;\s"',}]+)/g, (match, prefix: string, key: string) => isSensitiveKey(key) ? `${prefix}${REDACTED}` : match)
    .slice(0, limit);
}

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
    return redactText(url.toString());
  } catch {
    return redactText(raw);
  }
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).slice(0, 100).map(([name, value]) => [name, sensitiveHeaders.has(name.toLowerCase()) || isSensitiveKey(name) ? REDACTED : redactText(value, 500)]));
}

function redactJson(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object') return value;
  if (depth > 20) return '[MaxDepth]';
  if (Array.isArray(value)) return value.slice(0, 500).map(item => redactJson(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 500).map(([key, item]) => [key, isSensitiveKey(key) ? REDACTED : redactJson(item, depth + 1)]));
}

/** Redacts a body: JSON by key, form data by field, anything else as text. */
export function redactBody(text: string): { body: string; truncated: boolean } {
  let body: string;
  try {
    body = JSON.stringify(redactJson(JSON.parse(text)));
  } catch {
    body = /^[\w.%+-]+=[^&]*(&[\w.%+-]+=[^&]*)*$/.test(text.trim())
      ? text.split('&').map(pair => { const [key = '', ...rest] = pair.split('='); return isSensitiveKey(decodeURIComponent(key)) ? `${key}=${REDACTED}` : `${key}=${rest.join('=')}`; }).join('&')
      : redactText(text, Number.MAX_SAFE_INTEGER);
  }
  return { body: body.slice(0, MAX_BODY), truncated: body.length > MAX_BODY };
}

export async function consoleMessages(page: Page, options: { types?: string[] | undefined; textContains?: string | undefined; limit?: number | undefined }): Promise<unknown> {
  const limit = options.limit ?? 50;
  const messages = (await page.consoleMessages()).filter(message => !options.types?.length || options.types.includes(message.type()));
  const errors = (await page.pageErrors()).map(error => ({ type: 'pageerror', text: `${error.name}: ${error.message}`, location: (error.stack ?? '').split('\n')[1]?.trim().slice(0, 300) }));
  const items = [
    ...messages.map(message => {
      const location = message.location();
      return { type: message.type(), text: message.text(), location: location.url ? `${redactUrl(location.url)}:${location.lineNumber}:${location.columnNumber}` : undefined };
    }),
    ...(!options.types?.length || options.types.includes('pageerror') ? errors : []),
  ].filter(item => !options.textContains || item.text.includes(options.textContains));
  const selected = items.slice(-limit).map(item => ({ ...item, text: redactText(item.text) }));
  return { messages: selected, matched: items.length, truncated: items.length > limit, note: 'Messages since this server attached to the page (Playwright keeps the last 200); reload the page to capture startup logs.' };
}

// Playwright Request objects carry no stable id; number them per page as they are first listed.
const requestIds = new WeakMap<Request, number>();
let nextRequestId = 1;
const idOf = (request: Request) => {
  let id = requestIds.get(request);
  if (id === undefined) requestIds.set(request, id = nextRequestId++);
  return id;
};

export async function networkRequests(page: Page, options: { urlContains?: string | undefined; resourceType?: string | undefined; failedOnly?: boolean | undefined; limit?: number | undefined }): Promise<unknown> {
  const limit = options.limit ?? 50;
  const rows = await Promise.all((await page.requests()).map(async request => {
    const response = await request.response().catch(() => null);
    const failure = request.failure()?.errorText;
    const timing = request.timing();
    return {
      id: idOf(request),
      method: request.method(),
      url: redactUrl(request.url()),
      resourceType: request.resourceType(),
      status: response?.status() ?? null,
      ...(failure ? { failure: failure.slice(0, 300) } : {}),
      ...(timing.responseEnd > 0 ? { durationMs: Math.round(timing.responseEnd) } : {}),
    };
  }));
  const matched = rows.filter(row => (!options.urlContains || row.url.includes(options.urlContains))
    && (!options.resourceType || row.resourceType === options.resourceType)
    && (!options.failedOnly || row.failure || (row.status ?? 0) >= 400));
  return { requests: matched.slice(-limit), matched: matched.length, truncated: matched.length > limit, note: 'Requests since this server attached; Playwright drops old entries to bound memory.' };
}

export async function networkRequest(page: Page, id: number, includeBody: boolean): Promise<unknown> {
  const request = (await page.requests()).find(candidate => requestIds.get(candidate) === id);
  if (!request) throw new InspectorError('REQUEST_NOT_FOUND', `Request ${id} not found; list requests again, older entries are dropped`);
  const response = await request.response().catch(() => null);
  const post = request.postData();
  let responseBody: { body: string; truncated: boolean } | { unavailable: string } | undefined;
  if (includeBody && response) {
    const type = (await response.headerValue('content-type').catch(() => null)) ?? '';
    responseBody = /json|text|javascript|xml|x-www-form-urlencoded/.test(type)
      ? await response.text().then(redactBody, () => ({ unavailable: 'BODY_EVICTED' }))
      : { unavailable: `BINARY ${type.slice(0, 100)}` };
  }
  return {
    id,
    method: request.method(),
    url: redactUrl(request.url()),
    resourceType: request.resourceType(),
    requestHeaders: redactHeaders(await request.allHeaders().catch(() => request.headers())),
    ...(includeBody && post ? { requestBody: redactBody(post) } : {}),
    ...(response ? { status: response.status(), statusText: response.statusText().slice(0, 200), responseHeaders: redactHeaders(await response.allHeaders().catch(() => response.headers())) } : {}),
    ...(request.failure() ? { failure: request.failure()!.errorText.slice(0, 300) } : {}),
    ...(responseBody ? { responseBody } : {}),
    timing: request.timing(),
  };
}

export async function storage(page: Page, area: 'local' | 'session' | 'cookies', keyContains?: string, limit = 100): Promise<unknown> {
  if (area === 'cookies') {
    // A native (JSB) runtime has no browser context or cookie jar.
    if (typeof page.context !== 'function') return { area, available: false, reason: 'UNSUPPORTED_PUBLIC_API', entries: [], matched: 0, truncated: false };
    // Cookie values are always withheld; names and attributes are enough to debug expiry and scope.
    const cookies = (await page.context().cookies(page.url())).filter(cookie => !keyContains || cookie.name.includes(keyContains));
    return {
      area,
      entries: cookies.slice(0, limit).map(cookie => ({ name: cookie.name, value: REDACTED, domain: cookie.domain, path: cookie.path, expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite })),
      matched: cookies.length,
      truncated: cookies.length > limit,
    };
  }
  // Native (JSB) builds have localStorage only, backed by a SQLite file; there is no sessionStorage or cookie jar.
  const entries = await page.evaluate(store => {
    const target = store === 'local' ? localStorage : (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (!target) return null;
    const out: Array<[string, string]> = [];
    for (let index = 0; index < target.length && index < 5_000; index++) {
      const key = target.key(index);
      if (key !== null) out.push([key, String(target.getItem(key) ?? '').slice(0, 200_000)]);
    }
    return out;
  }, area);
  if (!entries) return { area, available: false, reason: 'UNSUPPORTED_PUBLIC_API', entries: [], matched: 0, truncated: false };
  const matched = entries.filter(([key]) => !keyContains || key.includes(keyContains));
  return {
    area,
    entries: matched.slice(0, limit).map(([key, value]) => {
      if (isSensitiveKey(key)) return { key, value: REDACTED, bytes: value.length };
      const { body, truncated } = redactBody(value);
      return { key, value: body.slice(0, MAX_TEXT), bytes: value.length, ...(truncated || body.length > MAX_TEXT ? { truncated: true } : {}) };
    }),
    matched: matched.length,
    truncated: matched.length > limit,
  };
}
