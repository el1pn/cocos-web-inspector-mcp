import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { emulateDevice } from '../src/bridge.js';

function fixture() {
  const calls: string[] = [];
  const sessions: { detached: boolean }[] = [];
  let fail: ((method: string) => boolean) | undefined;
  let frames = true;
  let gate: Promise<void> | undefined;
  const page = {
    context: () => ({ newCDPSession: async () => {
      const session = { detached: false };
      sessions.push(session);
      return {
        send: async (method: string) => {
          calls.push(method);
          if (gate) { const pending = gate; gate = undefined; await pending; }
          if (fail?.(method)) throw new Error('CDP failure');
          return { userAgent: 'test' };
        },
        detach: async () => { session.detached = true; },
      };
    } }),
    waitForFunction: async () => {},
    evaluate: async () => frames ? undefined : new Promise(() => {}),
    reload: async () => {},
  } as unknown as Page;
  return { page, calls, sessions, setFailure: (value?: (method: string) => boolean) => { fail = value; },
    setFrames: (value: boolean) => { frames = value; }, setGate: (value: Promise<void>) => { gate = value; } };
}

test('serializes concurrent changes and retains committed state', async () => {
  const f = fixture();
  let release!: () => void;
  f.setGate(new Promise<void>(resolve => { release = resolve; }));
  const first = emulateDevice(f.page, { preset: 'iphone-se' });
  const second = emulateDevice(f.page, { cpuSlowdown: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sessions.length, 1);
  release();
  await first;
  const result = await second as { before: { device: { preset: string } }; after: { cpuSlowdown: number } };
  assert.equal(result.before.device.preset, 'iphone-se');
  assert.equal(result.after.cpuSlowdown, 2);
  assert.equal(f.sessions.length, 1);
});

test('rolls back failed updates and cleans up failed sessions', async () => {
  const f = fixture();
  f.setFailure(() => true);
  await assert.rejects(emulateDevice(f.page, { preset: 'iphone-se' }), /CDP failure/);
  assert.equal(f.sessions[0]?.detached, true);
  f.setFailure();
  await emulateDevice(f.page, { preset: 'iphone-se' });
  let failed = false;
  f.setFailure(method => method === 'Emulation.setCPUThrottlingRate' && !failed && (failed = true));
  await assert.rejects(emulateDevice(f.page, { cpuSlowdown: 2 }), /CDP failure/);
  f.setFailure();
  const result = await emulateDevice(f.page, {}) as { before: { cpuSlowdown?: number; device: { preset: string } } };
  assert.equal(result.before.cpuSlowdown, undefined);
  assert.equal(result.before.device.preset, 'iphone-se');
  assert.equal(f.sessions[1]?.detached, false);
  f.setFailure(() => true);
  await assert.rejects(emulateDevice(f.page, { cpuSlowdown: 3 }), /CDP failure/);
  assert.equal(f.sessions[1]?.detached, true);
  f.setFailure();
  const fresh = await emulateDevice(f.page, {}) as { before: object };
  assert.deepEqual(fresh.before, {});
});

test('reset detaches even when CDP fails', async () => {
  const f = fixture();
  await emulateDevice(f.page, { preset: 'iphone-se' });
  f.setFailure(() => true);
  await assert.rejects(emulateDevice(f.page, { reset: true }), /CDP failure/);
  assert.equal(f.sessions[0]?.detached, true);
  f.setFailure();
  const result = await emulateDevice(f.page, {}) as { before: object };
  assert.deepEqual(result.before, {});
});

test('animation frames cannot block indefinitely', { timeout: 5_000 }, async () => {
  const f = fixture();
  f.setFrames(false);
  await emulateDevice(f.page, {});
});
