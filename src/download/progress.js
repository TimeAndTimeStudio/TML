// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { CancelledError } from '../core/errors.js';

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

export function percentOf(loaded, total) {
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  if (typeof loaded !== 'number' || !Number.isFinite(loaded)) return null;
  return clampPercent((loaded / total) * 100);
}

function normalizeTotal(total) {
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null;
  return total;
}

function normalizeLoaded(loaded) {
  if (typeof loaded !== 'number' || !Number.isFinite(loaded) || loaded < 0) return 0;
  return loaded;
}

export function createProgress({ now = () => Date.now() } = {}) {
  const tasks = new Map();
  const listeners = new Set();

  function ensure(id, extra = {}) {
    const key = String(id);
    let task = tasks.get(key);
    if (!task) {
      task = {
        id: key,
        url: null,
        status: 'pending',
        loaded: 0,
        total: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      };
      tasks.set(key, task);
    }
    if (extra.url !== undefined && extra.url !== null) task.url = String(extra.url);
    return task;
  }

  function notify() {
    if (listeners.size === 0) return;
    let snapshot = null;
    for (const listener of [...listeners]) {
      try {
        if (snapshot === null) snapshot = getSnapshot();
        listener(snapshot);
      } catch {
        // A broken listener must never break the download pipeline.
      }
    }
  }

  function getSnapshot() {
    const items = [];
    const counts = { total: tasks.size, pending: 0, active: 0, done: 0, failed: 0, cancelled: 0 };

    for (const task of tasks.values()) {
      counts[task.status] += 1;
      items.push({
        id: task.id,
        url: task.url,
        status: task.status,
        loaded: task.loaded,
        total: task.total,
        percent: task.status === 'done' && task.total === null ? 100 : percentOf(task.loaded, task.total),
        error: task.error,
      });
    }

    let loaded = 0;
    let total = 0;
    for (const task of tasks.values()) {
      loaded += task.loaded;
      if (task.total !== null) total += task.total;
    }

    return {
      tasks: counts,
      bytes: { loaded, total, percent: total > 0 ? clampPercent((loaded / total) * 100) : null },
      items,
    };
  }

  function register(id, { total = null, url = null } = {}) {
    const task = ensure(id, { url });
    task.total = normalizeTotal(total);
    task.startedAt = task.startedAt ?? now();
    notify();
    return getSnapshot();
  }

  function update(id, { loaded, total } = {}) {
    const task = ensure(id);
    if (task.status === 'pending') task.status = 'active';
    if (task.status === 'pending' || task.status === 'active') {
      if (loaded !== undefined) task.loaded = normalizeLoaded(loaded);
      if (total !== undefined) task.total = normalizeTotal(total);
      if (task.startedAt === null) task.startedAt = now();
    }
    notify();
    return getSnapshot();
  }

  function finish(id, { bytes } = {}) {
    const task = ensure(id);
    if (bytes !== undefined) task.loaded = normalizeLoaded(bytes);
    task.status = 'done';
    task.error = null;
    task.finishedAt = now();
    notify();
    return getSnapshot();
  }

  function fail(id, error = null) {
    const task = ensure(id);
    task.status = error instanceof CancelledError ? 'cancelled' : 'failed';
    task.error = error instanceof Error ? error.message : error === null ? null : String(error);
    task.finishedAt = now();
    notify();
    return getSnapshot();
  }

  function remove(id) {
    const deleted = tasks.delete(String(id));
    notify();
    return deleted;
  }

  function clear() {
    tasks.clear();
    notify();
    return getSnapshot();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('progress subscriber must be a function');
    }
    listeners.add(listener);
    try {
      listener(getSnapshot());
    } catch {
      // Ignore listener failures on initial emission.
    }
    return () => listeners.delete(listener);
  }

  return {
    register,
    update,
    finish,
    fail,
    remove,
    clear,
    subscribe,
    snapshot: getSnapshot,
    get size() {
      return tasks.size;
    },
  };
}
