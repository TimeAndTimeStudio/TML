// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { EventEmitter } from 'node:events';
import { CancelledError, ValidationError } from '../core/errors.js';

const DEFAULT_CONCURRENCY = 4;

export function createQueue(options = {}) {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const externalSignal = options.signal ?? null;
  const idPrefix = options.idPrefix ?? 'task';

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ValidationError('concurrency must be a positive integer', {
      code: 'INVALID_CONCURRENCY',
      details: { concurrency: String(options.concurrency ?? DEFAULT_CONCURRENCY) },
    });
  }

  const events = new EventEmitter();
  events.setMaxListeners(0);

  const pending = [];
  const running = new Map();
  const active = new Map();
  const counts = { added: 0, completed: 0, failed: 0, cancelled: 0 };
  const idleWaiters = [];
  let sequence = 0;
  let busy = false;

  function on(event, listener) {
    events.on(event, listener);
    return () => events.off(event, listener);
  }

  function emit(event, payload) {
    events.emit(event, payload);
  }

  function getStats() {
    return {
      concurrency,
      pending: pending.length,
      running: running.size,
      active: active.size,
      added: counts.added,
      completed: counts.completed,
      failed: counts.failed,
      cancelled: counts.cancelled,
    };
  }

  function pump() {
    while (running.size < concurrency && pending.length > 0) {
      const item = pending.shift();
      if (item.settled) continue;
      if (externalSignal?.aborted) {
        cancelItem(item, 'Queue signal aborted');
        if (active.get(item.id) === item) active.delete(item.id);
        continue;
      }
      start(item);
    }

    if (running.size === 0 && pending.length === 0 && busy) {
      busy = false;
      const stats = getStats();
      const waiters = idleWaiters.splice(0, idleWaiters.length);
      for (const waiter of waiters) waiter(stats);
      emit('idle', stats);
    }
  }

  function schedulePump() {
    queueMicrotask(pump);
  }

  function cancelItem(item, reason) {
    if (item.settled) return false;
    item.settled = true;
    counts.cancelled += 1;
    item.controller.abort(new CancelledError(reason, { details: { id: item.id } }));
    item.settle.reject(new CancelledError(reason, { details: { id: item.id } }));
    emit('task:cancel', { id: item.id });
    return true;
  }

  function start(item) {
    running.set(item.id, item);
    item.startedAt = Date.now();
    emit('task:start', { id: item.id, task: item.task });

    Promise.resolve()
      .then(() => item.task.run({ id: item.id, signal: item.controller.signal, task: item.task }))
      .then(
        (value) => settle(item, null, value),
        (err) => settle(item, err, null)
      );
  }

  function settle(item, err, value) {
    running.delete(item.id);

    if (item.settled) {
      if (active.get(item.id) === item) active.delete(item.id);
      schedulePump();
      return;
    }

    item.settled = true;
    if (active.get(item.id) === item) active.delete(item.id);

    const durationMs = item.startedAt === null ? 0 : Date.now() - item.startedAt;

    if (err) {
      counts.failed += 1;
      item.settle.reject(err);
      emit('task:error', { id: item.id, error: err, durationMs });
    } else {
      counts.completed += 1;
      item.settle.resolve(value);
      emit('task:end', { id: item.id, value, durationMs });
    }

    schedulePump();
  }

  function cancel(id) {
    const key = String(id);
    const item = active.get(key);
    if (!item) return false;

    cancelItem(item, `Task cancelled: ${key}`);

    const index = pending.indexOf(item);
    if (index >= 0) pending.splice(index, 1);
    if (!running.has(key)) active.delete(key);

    schedulePump();
    return true;
  }

  function cancelAll(reason = 'All tasks cancelled') {
    const items = [...active.values()];
    for (const item of items) cancel(item.id);
    if (items.length === 0) schedulePump();
    return items.length;
  }

  function add(task, { id } = {}) {
    if (!task || typeof task !== 'object') {
      throw new ValidationError('Queue task must be an object', { code: 'INVALID_TASK' });
    }
    if (typeof task.run !== 'function') {
      throw new ValidationError('Queue task must define a run() function', { code: 'INVALID_TASK' });
    }

    const taskId = String(id ?? task.id ?? `${idPrefix}-${++sequence}`);
    if (active.has(taskId)) {
      throw new ValidationError(`Duplicate queue task id: ${taskId}`, {
        code: 'DUPLICATE_TASK_ID',
        details: { id: taskId },
      });
    }

    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    promise.catch(() => {});

    const item = {
      id: taskId,
      task,
      controller: new AbortController(),
      settled: false,
      settle,
      promise,
      startedAt: null,
    };

    active.set(taskId, item);
    pending.push(item);
    counts.added += 1;
    busy = true;

    if (externalSignal?.aborted) {
      cancelItem(item, 'Queue signal aborted');
      pending.splice(pending.indexOf(item), 1);
      active.delete(taskId);
      schedulePump();
    } else {
      schedulePump();
    }

    return {
      id: taskId,
      promise,
      cancel: () => cancel(taskId),
      get signal() {
        return item.controller.signal;
      },
    };
  }

  function onIdle() {
    if (running.size === 0 && pending.length === 0) return Promise.resolve(getStats());
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  if (externalSignal) {
    const onAbort = () => cancelAll('Queue signal aborted');
    if (externalSignal.aborted) queueMicrotask(onAbort);
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    add,
    cancel,
    cancelAll,
    onIdle,
    stats: getStats,
    on,
    get concurrency() {
      return concurrency;
    },
  };
}
