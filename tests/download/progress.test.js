// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgress, percentOf } from '../../src/download/progress.js';
import { CancelledError } from '../../src/core/errors.js';

test('percentOf handles unknown and invalid totals', () => {
  assert.equal(percentOf(50, 100), 50);
  assert.equal(percentOf(0, 100), 0);
  assert.equal(percentOf(200, 100), 100);
  assert.equal(percentOf(10, 0), null);
  assert.equal(percentOf(10, null), null);
  assert.equal(percentOf(null, 100), null);
});

test('progress aggregates bytes and task states', () => {
  const progress = createProgress({ now: () => 1000 });

  progress.register('a', { total: 100, url: 'https://example.com/a' });
  progress.register('b', { total: 300 });

  let snapshot = progress.snapshot();
  assert.equal(snapshot.tasks.total, 2);
  assert.equal(snapshot.tasks.pending, 2);
  assert.equal(snapshot.bytes.loaded, 0);
  assert.equal(snapshot.bytes.total, 400);
  assert.equal(snapshot.bytes.percent, 0);

  progress.update('a', { loaded: 100 });
  progress.finish('a', { bytes: 100 });
  progress.update('b', { loaded: 150 });

  snapshot = progress.snapshot();
  assert.equal(snapshot.tasks.done, 1);
  assert.equal(snapshot.tasks.active, 1);
  assert.equal(snapshot.bytes.loaded, 250);
  assert.equal(snapshot.bytes.total, 400);
  assert.equal(snapshot.bytes.percent, 62.5);

  const itemA = snapshot.items.find((item) => item.id === 'a');
  assert.equal(itemA.status, 'done');
  assert.equal(itemA.percent, 100);
  assert.equal(itemA.url, 'https://example.com/a');
});

test('subscribe receives snapshots and can unsubscribe', () => {
  const progress = createProgress();
  const seen = [];
  const unsubscribe = progress.subscribe((snapshot) => seen.push(snapshot.tasks.total));

  assert.equal(seen[0], 0, 'subscriber is called immediately');
  progress.register('one');
  progress.register('two');
  assert.equal(seen.length, 3);

  unsubscribe();
  progress.register('three');
  assert.equal(seen.length, 3);
  assert.equal(progress.snapshot().tasks.total, 3);
});

test('a failing subscriber does not break the tracker', () => {
  const progress = createProgress();
  progress.subscribe(() => {
    throw new Error('boom');
  });

  assert.doesNotThrow(() => progress.register('a'));
  assert.equal(progress.snapshot().tasks.total, 1);
});

test('failed and cancelled tasks are distinguished', () => {
  const progress = createProgress();

  progress.fail('a', new Error('upstream exploded'));
  progress.fail('b', new CancelledError('stopped by user'));

  const snapshot = progress.snapshot();
  assert.equal(snapshot.tasks.failed, 1);
  assert.equal(snapshot.tasks.cancelled, 1);
  assert.equal(snapshot.items.find((item) => item.id === 'a').error, 'upstream exploded');
});

test('reset and remove clean up task state', () => {
  const progress = createProgress();
  progress.register('a', { total: 10 });
  progress.update('a', { loaded: 5 });

  assert.equal(progress.remove('a'), true);
  assert.equal(progress.remove('a'), false);
  assert.equal(progress.snapshot().tasks.total, 0);

  progress.register('b');
  progress.clear();
  assert.equal(progress.size, 0);
  assert.deepEqual(progress.snapshot().bytes, { loaded: 0, total: 0, percent: null });
});
