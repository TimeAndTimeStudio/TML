// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { InstanceError, NotFoundError, ValidationError } from '../core/errors.js';
import { ensureDir, pathExists, readJson, removePath, writeJson } from '../core/filesystem.js';
import { downloadToFile } from '../download/downloader.js';

export const FABRIC_INSTALLER_VERSION = '1.1.2';
export const FABRIC_MAVEN_BASE_URL = 'https://maven.fabricmc.net/';
export const INSTALL_MARKER_FILE = 'server-install.json';
export const SERVER_LAUNCH_JAR = 'fabric-server-launch.jar';
export const SERVER_GAME_JAR = 'server.jar';

const CONSOLE_MAX_LINES = 2000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const START_SETTLE_MS = 1000;
const STOP_GRACE_MS = 15_000;
const STOP_TERM_MS = 5_000;
const SHUTDOWN_GRACE_MS = 3_000;
const DONE_LINE_RE = /Done \(/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceWithTimeout(promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function notRunning(id) {
  return new NotFoundError(`Server is not running: ${id}`, {
    code: 'SERVER_NOT_RUNNING',
    details: { id },
  });
}

// รัน java แล้วคืน exit code — รวม stdout/stderr เป็นบรรทัดเดียวตามลำดับที่มาถึง
function runLines(executable, args, { cwd, onLine, timeoutMs, signal = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const bind = (stream) => {
      let partial = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        partial += chunk;
        const parts = partial.split(/\r?\n/);
        partial = parts.pop() ?? '';
        for (const part of parts) onLine(part);
      });
      stream.on('end', () => {
        if (partial !== '') onLine(partial);
      });
    };
    bind(child.stdout);
    bind(child.stderr);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(
          reject,
          new InstanceError('Timed out waiting for the Fabric server installer', {
            code: 'SERVER_INSTALL_TIMEOUT',
            status: 504,
            details: { timeoutMs },
          })
        );
      }, timeoutMs);
    }
    if (signal) signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => finish(resolve, code ?? -1));
  });
}

export function createGameServerManager(options = {}) {
  const config = options.config ?? null;
  const logger = options.logger ?? null;
  const manager = options.manager ?? null;
  const getJava = typeof options.getJava === 'function' ? options.getJava : null;
  const fetchImpl = options.fetch ?? null;

  if (!manager || typeof manager.get !== 'function' || typeof manager.paths !== 'function') {
    throw new ValidationError('createGameServerManager requires an instance manager', {
      code: 'INVALID_INSTANCE_MANAGER',
    });
  }
  if (!getJava) {
    throw new ValidationError('createGameServerManager requires a getJava() function', {
      code: 'NO_JAVA_RESOLVER',
    });
  }

  const processes = new Map(); // id -> { proc, startedAt, exited }
  const phases = new Map(); // id -> 'installing' | 'starting' | 'running'
  const busy = new Map(); // id -> Promise (install/start กันชนกัน)
  const lastExits = new Map(); // id -> { code, signal, at }
  const consoles = new Map(); // id -> { lines: [{seq, text}], seq }

  function serverPaths(id) {
    const paths = manager.paths(id);
    return Object.freeze({
      ...paths,
      eulaFile: path.join(paths.gameDir, 'eula.txt'),
      propsFile: path.join(paths.gameDir, 'server.properties'),
      launchJar: path.join(paths.gameDir, SERVER_LAUNCH_JAR),
      gameJar: path.join(paths.gameDir, SERVER_GAME_JAR),
      markerFile: path.join(paths.dir, INSTALL_MARKER_FILE),
    });
  }

  function assertServer(meta) {
    if (meta.type !== 'server') {
      throw new ValidationError('This instance is a game client, not a server', {
        code: 'NOT_SERVER_INSTANCE',
        status: 400,
        details: { id: meta.id, type: meta.type },
      });
    }
  }

  function consoleFor(id) {
    let entry = consoles.get(id);
    if (!entry) {
      entry = { lines: [], seq: 0 };
      consoles.set(id, entry);
    }
    return entry;
  }

  function pushLine(id, text) {
    const entry = consoleFor(id);
    entry.seq += 1;
    entry.lines.push({ seq: entry.seq, text: String(text) });
    if (entry.lines.length > CONSOLE_MAX_LINES) entry.lines.splice(0, entry.lines.length - CONSOLE_MAX_LINES);
  }

  function resetConsole(id) {
    consoles.set(id, { lines: [], seq: 0 });
  }

  function setPhase(id, phase) {
    if (phase === null || phase === undefined) phases.delete(id);
    else phases.set(id, phase);
  }

  async function readMarker(id) {
    try {
      return await readJson(serverPaths(id).markerFile);
    } catch {
      return null;
    }
  }

  async function isInstalled(id, meta) {
    const paths = serverPaths(id);
    const marker = await readMarker(id);
    if (!marker || typeof marker !== 'object') return false;
    if (marker.minecraftVersion !== meta.minecraftVersion) return false;
    if (marker.fabricLoaderVersion !== meta.fabricLoaderVersion) return false;
    return (await pathExists(paths.launchJar)) && (await pathExists(paths.gameJar));
  }

  async function ensureInstallerJar() {
    const dir = path.join(config.paths.cacheDir, 'fabric-installer');
    const dest = path.join(dir, `fabric-installer-${FABRIC_INSTALLER_VERSION}.jar`);
    if (await pathExists(dest)) return dest;
    await ensureDir(dir);
    const url = `${FABRIC_MAVEN_BASE_URL}net/fabricmc/fabric-installer/${FABRIC_INSTALLER_VERSION}/fabric-installer-${FABRIC_INSTALLER_VERSION}.jar`;
    let sha1 = null;
    const doFetch = fetchImpl ?? globalThis.fetch;
    try {
      const res = await doFetch(`${url}.sha1`);
      if (res.ok) {
        const digest = String(await res.text()).trim().split(/\s+/)[0] ?? '';
        if (/^[0-9a-f]{40}$/i.test(digest)) sha1 = digest;
      }
    } catch {
      /* sha1 เอาไว้ยืนยันอย่างเดียว — เจอไม่ได้ไม่เป็นไร (https + maven) */
    }
    await downloadToFile({ url, dest, sha1, id: 'fabric-installer', logger });
    return dest;
  }

  async function runInstaller(id, meta, java) {
    const paths = serverPaths(id);
    setPhase(id, 'installing');
    pushLine(id, `[tml] Installing Fabric ${meta.fabricLoaderVersion} server for Minecraft ${meta.minecraftVersion}…`);
    const installerJar = await ensureInstallerJar();
    const args = [
      '-jar',
      installerJar,
      'server',
      '-dir',
      paths.gameDir,
      '-mcversion',
      meta.minecraftVersion,
      '-loader',
      meta.fabricLoaderVersion,
      '-downloadMinecraft',
    ];
    const code = await runLines(java.path, args, {
      cwd: paths.gameDir,
      onLine: (line) => pushLine(id, line),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (code !== 0) {
      throw new InstanceError('Fabric server install failed', {
        code: 'SERVER_INSTALL_FAILED',
        details: { id, exitCode: code },
      });
    }
    if (!(await pathExists(paths.launchJar)) || !(await pathExists(paths.gameJar))) {
      throw new InstanceError('Fabric server install finished but server files are missing', {
        code: 'SERVER_INSTALL_FAILED',
        details: { id },
      });
    }
    await writeJson(paths.markerFile, {
      minecraftVersion: meta.minecraftVersion,
      fabricLoaderVersion: meta.fabricLoaderVersion,
      installedAt: new Date().toISOString(),
    });
    pushLine(id, '[tml] Server files installed');
    logger?.info('game server installed', { id, minecraftVersion: meta.minecraftVersion });
  }

  async function ensureInstalled(id, meta, java) {
    if (await isInstalled(id, meta)) return false;
    await runInstaller(id, meta, java);
    return true;
  }

  // server.properties ยังไม่มีก็สร้าง — MC อ่านค่าพอร์ตจากตรงนี้ตอนบูต
  async function applyPort(gameDir, port) {
    const file = path.join(gameDir, 'server.properties');
    let content = '';
    try {
      content = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const line = `server-port=${port}`;
    if (/^server-port=.*$/m.test(content)) {
      content = content.replace(/^server-port=.*$/m, line);
    } else {
      const base = content === '' ? '' : `${content.replace(/\s+$/, '')}\n`;
      content = `${base}${line}\n`;
    }
    await fsp.writeFile(file, content);
  }

  async function eulaAccepted(id) {
    try {
      const text = await fsp.readFile(serverPaths(id).eulaFile, 'utf8');
      return /(^|\n)\s*eula\s*=\s*true\s*$/im.test(text);
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
  }

  async function setEula(id, accept) {
    const meta = await manager.get(id);
    assertServer(meta);
    const paths = serverPaths(id);
    if (accept === true) {
      await fsp.writeFile(
        paths.eulaFile,
        '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://account.mojang.com/minecraft/eula)\neula=true\n'
      );
    } else {
      await removePath(paths.eulaFile).catch(() => {});
    }
    await manager.update(id, { eulaAccepted: accept === true });
    logger?.info('server eula updated', { id, accepted: accept === true });
    return { id, eulaAccepted: accept === true };
  }

  async function withBusy(id, fn) {
    if (busy.has(id)) {
      throw new InstanceError('The server is busy with another install or start', {
        code: 'SERVER_BUSY',
        status: 409,
        details: { id },
      });
    }
    const job = (async () => fn())();
    busy.set(id, job);
    try {
      return await job;
    } finally {
      busy.delete(id);
    }
  }

  async function install(id, installOptions = {}) {
    return withBusy(id, async () => {
      const meta = await manager.get(id);
      assertServer(meta);
      if (processes.has(id)) {
        throw new InstanceError(`Server is running: ${id}`, {
          code: 'SERVER_ALREADY_RUNNING',
          status: 409,
          details: { id },
        });
      }
      try {
        const java = await getJava();
        if (installOptions.force !== true && (await isInstalled(id, meta))) {
          pushLine(id, '[tml] Server files already installed — nothing to do');
          return { id, installed: true, skipped: true };
        }
        resetConsole(id);
        await runInstaller(id, meta, java);
        return { id, installed: true, skipped: false };
      } finally {
        setPhase(id, null);
      }
    });
  }

  async function start(id) {
    return withBusy(id, async () => {
      const meta = await manager.get(id);
      assertServer(meta);
      const existing = processes.get(id);
      if (existing) {
        throw new InstanceError(`Server is already running: ${id}`, {
          code: 'SERVER_ALREADY_RUNNING',
          status: 409,
          details: { id, pid: existing.proc.pid ?? null },
        });
      }

      resetConsole(id);
      // EULA ต้องมาก่อน — ไม่งั้นคนที่ยังไม่ยอมรับจะโดนโหลด server.jar 60MB แล้วค่อยถูกปฏิเสธ
      if (!(await eulaAccepted(id))) {
        pushLine(id, '[tml] EULA not accepted — press ACCEPT EULA in this tab first');
        throw new InstanceError('Minecraft EULA not accepted for this server', {
          code: 'EULA_NOT_ACCEPTED',
          status: 409,
          details: { id },
        });
      }

      const java = await getJava();
      let installedNow = false;
      try {
        installedNow = await ensureInstalled(id, meta, java);
      } finally {
        setPhase(id, null);
      }

      const paths = serverPaths(id);
      await applyPort(paths.gameDir, meta.port);

      const args = [
        `-Xms${meta.memory.min}`,
        `-Xmx${meta.memory.max}`,
        ...(meta.extraJvmArgs ?? []),
        '-jar',
        SERVER_LAUNCH_JAR,
        'nogui',
      ];
      const proc = spawn(java.path, args, { cwd: paths.gameDir, stdio: ['pipe', 'pipe', 'pipe'] });
      const handle = { proc, startedAt: Date.now(), exited: null };
      handle.exited = new Promise((resolve) => {
        proc.once('exit', (code, signal) => resolve({ code: code ?? null, signal: signal ?? null }));
        proc.once('error', () => resolve({ code: null, signal: null }));
      });
      processes.set(id, handle);
      setPhase(id, 'starting');

      const attach = (stream, name) => {
        let partial = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          partial += chunk;
          const parts = partial.split(/\r?\n/);
          partial = parts.pop() ?? '';
          for (const line of parts) {
            pushLine(id, line);
            if (phases.get(id) === 'starting' && DONE_LINE_RE.test(line)) setPhase(id, 'running');
          }
        });
        stream.on('end', () => {
          if (partial !== '') pushLine(id, partial);
        });
        stream.on('error', () => {
          /* pipe ปิดระหว่างทาง — ข้ามไป */
        });
      };
      attach(proc.stdout, 'stdout');
      attach(proc.stderr, 'stderr');
      proc.stdin?.on('error', () => {});
      pushLine(id, `[tml] Server started (pid ${proc.pid})`);
      logger?.info('game server started', { id, pid: proc.pid, port: meta.port });

      handle.exited.then(
        ({ code, signal }) => {
          if (processes.get(id) === handle) processes.delete(id);
          phases.delete(id);
          lastExits.set(id, { code, signal, at: new Date().toISOString() });
          pushLine(id, `[tml] Server stopped${code === null ? '' : ` (code ${code})`}${signal ? ` (${signal})` : ''}`);
        },
        () => {
          if (processes.get(id) === handle) processes.delete(id);
          phases.delete(id);
        }
      );

      // crash ทันที (พอร์ตชน / java ไม่พอ) → คืน error พร้อมบรรทัดสุดท้ายให้ UI โชว์
      const settled = await raceWithTimeout(handle.exited, START_SETTLE_MS);
      if (settled) {
        const lines = consoleFor(id).lines.slice(-5).map((line) => line.text);
        throw new InstanceError('Server exited right after starting', {
          code: 'SERVER_START_FAILED',
          status: 500,
          details: { id, exitCode: settled.code, lines },
        });
      }

      return { id, pid: proc.pid, installed: installedNow, port: meta.port };
    });
  }

  async function stop(id) {
    const handle = processes.get(id);
    if (!handle) throw notRunning(id);
    try {
      handle.proc.stdin?.write('stop\n');
    } catch {
      /* pipe ปิดแล้ว — ล้มไป kill เอง */
    }
    const graceful = await raceWithTimeout(handle.exited, STOP_GRACE_MS);
    if (!graceful) {
      handle.proc.kill('SIGTERM');
      const term = await raceWithTimeout(handle.exited, STOP_TERM_MS);
      if (!term) {
        handle.proc.kill('SIGKILL');
        await handle.exited;
      }
    }
    const result = lastExits.get(id) ?? { code: null, signal: null };
    logger?.info('game server stopped', { id, code: result.code, signal: result.signal });
    return { id, stopped: true, code: result.code ?? null, signal: result.signal ?? null };
  }

  async function status(id) {
    const meta = await manager.get(id);
    const handle = processes.get(id) ?? null;
    const startedAt = handle?.startedAt ?? null;
    return {
      id,
      type: meta.type,
      running: handle !== null,
      pid: handle?.proc.pid ?? null,
      phase: phases.get(id) ?? (handle !== null ? 'starting' : 'idle'),
      sessionSeconds:
        handle && startedAt !== null ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0,
      installed: await isInstalled(id, meta),
      eulaAccepted: meta.eulaAccepted === true || (await eulaAccepted(id)),
      port: meta.port,
      exit: lastExits.get(id) ?? null,
      busy: busy.has(id),
    };
  }

  function statusSync(id) {
    const handle = processes.get(id) ?? null;
    const startedAt = handle?.startedAt ?? null;
    return {
      id,
      running: handle !== null,
      pid: handle?.proc.pid ?? null,
      phase: phases.get(id) ?? (handle !== null ? 'starting' : 'idle'),
      sessionSeconds:
        handle && startedAt !== null ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0,
      busy: busy.has(id),
    };
  }

  function readConsole(id, since) {
    const entry = consoleFor(id);
    const from = Number.isInteger(since) && since > 0 ? since : 0;
    return {
      id,
      running: processes.has(id),
      phase: phases.get(id) ?? (processes.has(id) ? 'starting' : 'idle'),
      lines: entry.lines.filter((line) => line.seq > from),
      nextSince: entry.seq,
    };
  }

  function isRunning(id) {
    return processes.has(id);
  }

  // launcher กำลังปิด → ดับ server ทุกตัวไม่ให้กลายเป็น orphan process
  async function shutdown() {
    const ids = [...processes.keys()];
    for (const id of ids) {
      const handle = processes.get(id);
      if (!handle) continue;
      try {
        handle.proc.stdin?.write('stop\n');
      } catch {
        /* ignore */
      }
      const done = await raceWithTimeout(handle.exited, SHUTDOWN_GRACE_MS);
      if (!done) {
        handle.proc.kill('SIGTERM');
        const term = await raceWithTimeout(handle.exited, 1000);
        if (!term) handle.proc.kill('SIGKILL');
      }
    }
  }

  return {
    install,
    start,
    stop,
    status,
    statusSync,
    readConsole,
    setEula,
    eulaAccepted,
    isInstalled,
    isRunning,
    shutdown,
    paths: serverPaths,
  };
}
