// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../../src/download/queue.js';
import { CancelledError, ValidationError } from '../../src/core/errors.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('queue validates its configuration and tasks', () => {
  assert.throws(() => createQueue({ concurrency: 0 }), (err) => err instanceof ValidationError && err.code === 'INVALID_CONCURRENCY');
  assert.throws(() => createQueue({ concurrency: 1.5 }), (err) => err.code === 'INVALID_CONCURRENCY');

  const queue = createQueue();
  assert.throws(() => queue.add(null), (err) => err.code === 'INVALID_TASK');
  assert.throws(() => queue.add({ id: 'a' }), (err) => err.code === 'INVALID_TASK');
});

test('queue never exceeds its concurrency limit', async () => {
  const queue = createQueue({ concurrency: 2 });
  let inFlight = 0;
  let maxInFlight = 0;

  const handles = Array.from({ length: 6 }, (_, index) =>
    queue.add({
      id: `task-${index}`,
      async run() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick(20);
        inFlight -= 1;
        return index;
      },
    })
  );

  const results = await Promise.all(handles.map((handle) => handle.promise));
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.equal(maxInFlight, 2);
  assert.equal(queue.stats().running, 0);
  assert.equal(queue.stats().pending, 0);
  assert.equal(queue.stats().completed, 6);
});

test('queue keeps running other tasks when one fails', async () => {
  const queue = createQueue({ concurrency: 3 });
  const errors = [];

  queue.on('task:error', ({ id }) => errors.push(id));

  const good = queue.add({ id: 'good', run: async () => 'fine' });
  const bad = queue.add({ id: 'bad', run: async () => { throw new Error('nope'); } });
  const alsoGood = queue.add({ id: 'also-good', run: async () => 'fine too' });

  await assert.rejects(() => bad.promise, /nope/);
  assert.equal(await good.promise, 'fine');
  assert.equal(await alsoGood.promise, 'fine too');
  await queue.onIdle();

  assert.deepEqual(errors, ['bad']);
  assert.equal(queue.stats().failed, 1);
  assert.equal(queue.stats().completed, 2);
});

test('pending tasks can be cancelled before they start', async () => {
  const queue = createQueue({ concurrency: 1 });
  const ran = [];

  const blocker = queue.add({
    id: 'blocker',
    async run({ signal }) {
      ran.push('blocker');
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
        setTimeout(resolve, 500);
      });
      return 'blocker';
    },
  });

  const victim = queue.add({
    id: 'victim',
    run: async () => {
      ran.push('victim');
      return 'victim';
    },
  });

  await tick(5);
  assert.equal(queue.cancel('victim'), true);
  await assert.rejects(() => victim.promise, (err) => err instanceof CancelledError && err.code === 'CANCELLED');

  assert.equal(queue.cancel('does-not-exist'), false);
  queue.cancel('blocker');
  await assert.rejects(() => blocker.promise, CancelledError);

  await queue.onIdle();
  assert.deepEqual(ran, ['blocker']);
  assert.equal(queue.stats().cancelled, 2);
});

test('cancelling a running task aborts its signal', async () => {
  const queue = createQueue({ concurrency: 1 });
  let sawAbort = false;

  const handle = queue.add({
    id: 'slow',
    async run({ signal }) {
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      });
      throw new CancelledError('aborted inside task');
    },
  });

  await tick(5);
  assert.equal(handle.cancel(), true);
  await assert.rejects(() => handle.promise, CancelledError);
  assert.equal(sawAbort, true);

  await queue.onIdle();
  assert.equal(queue.stats().cancelled, 1);
});

test('duplicate task ids are rejected while a task is active', async () => {
  const queue = createQueue({ concurrency: 1 });
  const first = queue.add({ id: 'dup', run: () => tick(20).then(() => 'first') });

  assert.throws(() => queue.add({ id: 'dup', run: async () => 'second' }), (err) => err.code === 'DUPLICATE_TASK_ID');

  await first.promise;
  const second = queue.add({ id: 'dup', run: async () => 'second' });
  assert.equal(await second.promise, 'second');
});

test('onIdle resolves once every task has settled', async () => {
  const queue = createQueue({ concurrency: 2 });
  let idleEvents = 0;
  queue.on('idle', () => {
    idleEvents += 1;
  });

  queue.add({ id: 'a', run: () => tick(10).then(() => 'a') });
  queue.add({ id: 'b', run: () => tick(30).then(() => 'b') });

  const stats = await queue.onIdle();
  assert.equal(stats.completed, 2);
  assert.equal(idleEvents, 1);
  assert.deepEqual(await queue.onIdle(), stats, 'onIdle resolves immediately when already idle');
});

test('an external signal cancels queued and running tasks', async () => {
  const controller = new AbortController();
  const queue = createQueue({ concurrency: 1, signal: controller.signal });

  const running = queue.add({
    id: 'running',
    async run({ signal }) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new CancelledError('aborted');
    },
  });
  const queued = queue.add({ id: 'queued', run: async () => 'never' });

  await tick(5);
  controller.abort();
  await assert.rejects(() => running.promise, CancelledError);
  await assert.rejects(() => queued.promise, CancelledError);
  await queue.onIdle();

  const alreadyAborted = createQueue({ concurrency: 1, signal: AbortSignal.abort() });
  await assert.rejects(
    () => alreadyAborted.add({ id: 'late', run: async () => 'never' }).promise,
    CancelledError
  );
});
