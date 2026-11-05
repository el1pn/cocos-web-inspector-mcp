import { appendFileSync } from 'node:fs';
import { isSensitiveKey, redactText } from './browser-data.js';

// Opt-in JSONL audit of tool calls (--log-file). Arguments are masked like browser data; results are never logged, only their size and error code.
const MAX_STRING = 200;

function mask(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value, MAX_STRING);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => mask(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, isSensitiveKey(key) || key === 'text' ? '[redacted]' : mask(item, depth + 1)]));
}

/** Wraps `registerTool` so every handler appends one JSON line: time, tool, masked args, duration, ok, error code, result bytes. */
export function logToolCalls(server: { registerTool: (...args: any[]) => unknown }, file: string): void {
  const register = server.registerTool.bind(server);
  server.registerTool = (name: string, config: unknown, handler: (...args: any[]) => Promise<any>) => register(name, config, async (...args: any[]) => {
    const started = Date.now();
    const entry: Record<string, unknown> = { time: new Date(started).toISOString(), tool: name, args: mask(typeof args[0] === 'object' ? args[0] : {}) };
    try {
      const result = await handler(...args);
      entry.ok = !result?.isError;
      if (result?.isError) entry.error = result.structuredContent?.code ?? result.content?.[0]?.text?.slice(0, 200);
      entry.bytes = JSON.stringify(result?.content ?? '').length;
      return result;
    } catch (error) {
      entry.ok = false;
      entry.error = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      throw error;
    } finally {
      entry.ms = Date.now() - started;
      try { appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); } catch { /* logging must never break a call */ }
    }
  });
}
