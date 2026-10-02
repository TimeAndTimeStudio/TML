// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { CancelledError, CorruptDataError, JavaRuntimeError, LaunchError, ValidationError } from '../core/errors.js';
import { assertLinuxPlatform } from '../core/platform.js';
import { ensureDir, pathExists } from '../core/filesystem.js';
import { NATIVES_MANIFEST, evaluateRules } from './install.js';
import { findMinecraftJava } from '../java/runtime.js';

export const CLASSPATH_SEPARATOR = ':';
export const LAUNCHER_NAME = 'TML';
export const MAX_OUTPUT_LINES = 500;
export const MAX_MISSING_DETAILS = 25;

export function offlineUuid(username) {
  const digest = createHash('md5').update(`OfflinePlayer:${String(username)}`, 'utf8').digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createOfflineSession(options = {}) {
  const username = typeof options.username === 'string' && options.username !== '' ? options.username : 'Player';
  const uuid = typeof options.uuid === 'string' && options.uuid !== '' ? options.uuid : offlineUuid(username);
  const accessToken =
    typeof options.accessToken === 'string' && options.accessToken !== '' ? options.accessToken : randomUUID();
  const userType = typeof options.userType === 'string' && options.userType !== '' ? options.userType : 'legacy';

  return Object.freeze({
    username,
    uuid,
    accessToken,
    userType,
    clientId: typeof options.clientId === 'string' ? options.clientId : '',
    xuid: typeof options.xuid === 'string' ? options.xuid : '',
    userProperties: options.userProperties ?? {},
  });
}

export function splitLegacyArguments(input) {
  const out = [];
  if (typeof input !== 'string' || input === '') return out;

  let current = '';
  let started = false;
  let quoted = false;

  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (char === ' ' || char === '\t' || char === '\n')) {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

function substitutePlaceholders(template, values, unresolved) {
  return String(template).replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (Object.hasOwn(values, key)) return String(values[key]);
    unresolved.add(key);
    return '';
  });
}

function resolveArgumentList(entries, ctx) {
  const out = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      out.push(substitutePlaceholders(entry, ctx.values, ctx.unresolved));
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.rules !== undefined && !evaluateRules(entry.rules, ctx.ruleContext)) continue;
    const value = entry.value;
    const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    for (const item of list) out.push(substitutePlaceholders(item, ctx.values, ctx.unresolved));
  }
  return out;
}

function normalizeAuth(auth) {
  if (auth === undefined || auth === null) return createOfflineSession();
  if (typeof auth !== 'object' || Array.isArray(auth)) {
    throw new ValidationError('"auth" must be an object', { code: 'INVALID_AUTH', details: { received: typeof auth } });
  }

  const username = typeof auth.username === 'string' && auth.username !== '' ? auth.username : 'Player';
  const session = { ...createOfflineSession({ username }) };
  for (const key of ['username', 'uuid', 'accessToken', 'userType', 'clientId', 'xuid']) {
    if (auth[key] !== undefined && auth[key] !== null) session[key] = String(auth[key]);
  }
  if (auth.userProperties !== undefined && auth.userProperties !== null) {
    session.userProperties = auth.userProperties;
  }
  return Object.freeze(session);
}

async function missingFiles(launchPlan) {
  const plan = launchPlan.plan;
  const checks = [plan.client.dest, ...plan.libraries.map((library) => library.dest)];
  if (plan.logging) checks.push(plan.logging.dest);
  if (plan.natives.length > 0) checks.push(path.join(launchPlan.nativesDir, NATIVES_MANIFEST));

  const missing = [];
  for (const dest of checks) {
    if (!(await pathExists(dest))) missing.push(dest);
  }
  return missing;
}

function captureOutput(child, output, onOutput) {
  const emit = (stream, line) => {
    output[stream].push(line);
    if (output[stream].length > MAX_OUTPUT_LINES) output[stream].shift();
    if (onOutput) onOutput(line, stream);
  };

  for (const stream of ['stdout', 'stderr']) {
    let carry = '';
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk) => {
      const parts = (carry + chunk).split('\n');
      carry = parts.pop() ?? '';
      for (const raw of parts) emit(stream, raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    });
    child[stream].on('end', () => {
      if (carry !== '') {
        const line = carry;
        carry = '';
        emit(stream, line);
      }
    });
  }
}

// สร้าง env ของกระบวนการเกม: 'x11' บังคับ SDL/GLFW ให้ใช้ XWayland — แล้ว GNOME/mutter จะวาด title bar + ปุ่ม +
// ไอคอนหน้าต่างตามธีมระบบให้เอง (mutter ไม่รองรับ xdg-decoration → ไม่เคยวาด decoration ให้ client Wayland)
// ลบ WAYLAND_DISPLAY อย่างเดียวไม่พอ: libwayland ต่อ default socket "wayland-0" เองเมื่อ env หายไป (พิสูจน์แล้ว:
// เกมยังได้ video driver = wayland) — ต้องบังคับ SDL ไม่ให้ probe wayland ด้วย SDL_VIDEO_DRIVER (ตัว override
// ที่ SDL ระบุใน message ของมันเอง) + ค่า SDL_VIDEODRIVER (ชื่อ legacy) + XDG_SESSION_TYPE ให้ตรงกับความจริง
export function buildProcessEnv(platform, baseEnv = process.env, overrides = {}) {
  const env = { ...baseEnv, ...overrides };
  if (platform === 'x11') {
    delete env.WAYLAND_DISPLAY;
    delete env.WAYLAND_SOCKET;
    env.XDG_SESSION_TYPE = 'x11';
    env.SDL_VIDEO_DRIVER = 'x11';
    env.SDL_VIDEODRIVER = 'x11';
  }
  return env;
}

export function createLauncher(options = {}) {
  assertLinuxPlatform();

  const config = options.config ?? null;
  const logger = options.logger ?? null;
  const installer = options.installer ?? null;
  if (!installer || typeof installer.plan !== 'function' || !installer.layout) {
    throw new ValidationError('createLauncher() requires an installer', { code: 'NO_INSTALLER' });
  }

  const javaFinder = options.findMinecraftJava ?? findMinecraftJava;
  if (typeof javaFinder !== 'function') {
    throw new ValidationError('"findMinecraftJava" must be a function', { code: 'INVALID_JAVA_FINDER' });
  }

  const javaRuntime = options.javaRuntime ?? null;
  if (javaRuntime !== null && typeof javaRuntime.ensure !== 'function') {
    throw new ValidationError('"javaRuntime" must provide an ensure() function', { code: 'INVALID_JAVA_RUNTIME' });
  }

  const layout = installer.layout;
  const launcherVersion = typeof config?.version === 'string' ? config.version : '0.0.0';
  const defaultGameDir = config?.paths?.instancesDir ? path.join(config.paths.instancesDir, 'preview') : null;

  function resolveGameDir(value) {
    if (value === undefined || value === null) {
      if (!defaultGameDir) {
        throw new ValidationError('launch() requires a game directory', { code: 'INVALID_GAME_DIR' });
      }
      return path.resolve(defaultGameDir);
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError('"gameDir" must be a non-empty path', {
        code: 'INVALID_GAME_DIR',
        details: { value: String(value) },
      });
    }
    return path.resolve(value);
  }

  function buildValues({ plan, auth, gameDir, nativesDir, classpath, resolution }) {
    const values = {
      auth_player_name: auth.username,
      auth_uuid: auth.uuid,
      auth_access_token: auth.accessToken,
      auth_session: `${auth.accessToken}:0`,
      auth_xuid: auth.xuid,
      clientid: auth.clientId,
      user_type: auth.userType,
      user_properties:
        typeof auth.userProperties === 'string' ? auth.userProperties : JSON.stringify(auth.userProperties ?? {}),
      version_name: plan.id,
      version_type: plan.type ?? 'release',
      game_directory: gameDir,
      assets_root: layout.assets,
      game_assets: layout.assets,
      assets_index_name: plan.assetIndex?.id ?? plan.assets ?? 'legacy',
      classpath,
      classpath_separator: CLASSPATH_SEPARATOR,
      natives_directory: nativesDir,
      launcher_name: LAUNCHER_NAME,
      launcher_version: launcherVersion,
      library_directory: layout.libraries,
    };
    if (resolution?.width !== undefined && resolution?.width !== null) {
      values.resolution_width = String(resolution.width);
    }
    if (resolution?.height !== undefined && resolution?.height !== null) {
      values.resolution_height = String(resolution.height);
    }
    return values;
  }

  async function buildLaunchPlan(input, opts = {}) {
    const features = opts.features && typeof opts.features === 'object' ? { ...opts.features } : {};
    const plan = await installer.plan(input, { features });

    if (typeof plan.mainClass !== 'string' || plan.mainClass === '') {
      throw new CorruptDataError(`Version "${plan.id}" has no mainClass`, { details: { id: plan.id } });
    }

    const gameDir = resolveGameDir(opts.gameDir);
    const auth = normalizeAuth(opts.auth);

    const finderOptions = {
      logger,
      requiredMajor: plan.javaVersion?.majorVersion ?? null,
      requiredComponent: plan.javaVersion?.component ?? null,
    };

    let java;
    try {
      java = await javaFinder(finderOptions);
    } catch (err) {
      if (!javaRuntime || !(err instanceof JavaRuntimeError)) throw err;
      logger?.info('java runtime missing — downloading Microsoft runtime', {
        requiredMajor: finderOptions.requiredMajor,
        requiredComponent: finderOptions.requiredComponent,
      });
      await javaRuntime.ensure({
        requiredMajor: finderOptions.requiredMajor,
        requiredComponent: finderOptions.requiredComponent,
        onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
      });
      java = await javaFinder(finderOptions);
    }

    if (!java || typeof java.path !== 'string' || java.path === '') {
      throw new LaunchError('Java runtime lookup returned no executable', {
        details: { stage: 'java' },
      });
    }
    if (!path.isAbsolute(java.path)) {
      throw new LaunchError('Java runtime path must be absolute', {
        details: { stage: 'java', java: java.path },
      });
    }

    const classpath = [plan.client.dest, ...plan.libraries.map((library) => library.dest)];
    const classpathString = classpath.join(CLASSPATH_SEPARATOR);
    const nativesDir = layout.nativesDir(plan.id);

    const unresolved = new Set();
    const values = buildValues({ plan, auth, gameDir, nativesDir, classpath: classpathString, resolution: opts.resolution });
    const ctx = { values, unresolved, ruleContext: { os: plan.os, features } };

    const jvmArgs = plan.arguments?.jvm ? resolveArgumentList(plan.arguments.jvm, ctx) : [];
    if (!jvmArgs.some((arg) => arg.startsWith('-Djava.library.path='))) {
      jvmArgs.push(`-Djava.library.path=${nativesDir}`);
    }
    if (!jvmArgs.some((arg) => arg.startsWith('-Dminecraft.launcher.brand='))) {
      jvmArgs.push(`-Dminecraft.launcher.brand=${LAUNCHER_NAME}`);
    }
    if (!jvmArgs.some((arg) => arg.startsWith('-Dminecraft.launcher.version='))) {
      jvmArgs.push(`-Dminecraft.launcher.version=${launcherVersion}`);
    }
    if (!jvmArgs.includes('-cp') && !jvmArgs.includes('-classpath')) {
      jvmArgs.push('-cp', classpathString);
    }
    if (plan.logging && !jvmArgs.some((arg) => arg.startsWith('-Dlog4j.configurationFile='))) {
      jvmArgs.push(`-Dlog4j.configurationFile=${plan.logging.dest}`);
    }
    if (Array.isArray(opts.extraJvmArgs)) {
      jvmArgs.push(...opts.extraJvmArgs);
    }

    let gameArgs;
    if (plan.arguments?.game) {
      gameArgs = resolveArgumentList(plan.arguments.game, ctx);
    } else if (plan.minecraftArguments) {
      gameArgs = splitLegacyArguments(plan.minecraftArguments).map((token) =>
        substitutePlaceholders(token, values, unresolved),
      );
    } else {
      gameArgs = [];
    }
    if (Array.isArray(opts.extraGameArgs)) {
      gameArgs.push(...opts.extraGameArgs);
    }

    return {
      id: plan.id,
      mainClass: plan.mainClass,
      java,
      args: [...jvmArgs, plan.mainClass, ...gameArgs],
      jvmArgs,
      gameArgs,
      classpath,
      classpathString,
      nativesDir,
      assetsRoot: layout.assets,
      libraryDir: layout.libraries,
      gameDir,
      auth,
      cwd: gameDir,
      unresolved: [...unresolved].sort(),
      plan,
    };
  }

  async function launch(input, opts = {}) {
    const signal = opts.signal ?? null;
    if (signal?.aborted) {
      throw new CancelledError('Launch cancelled', { details: { id: String(input) } });
    }

    const launchPlan = await buildLaunchPlan(input, opts);
    if (signal?.aborted) {
      throw new CancelledError('Launch cancelled', { details: { id: launchPlan.id } });
    }

    const missing = await missingFiles(launchPlan);
    if (missing.length > 0) {
      throw new LaunchError(`Minecraft "${launchPlan.id}" is not installed`, {
        code: 'MINECRAFT_NOT_INSTALLED',
        status: 409,
        details: {
          stage: 'preflight',
          count: missing.length,
          missing: missing.slice(0, MAX_MISSING_DETAILS),
        },
      });
    }

    await ensureDir(launchPlan.gameDir);
    await ensureDir(launchPlan.nativesDir);

    const envOverrides = opts.env && typeof opts.env === 'object' ? opts.env : {};
    const child = spawn(launchPlan.java.path, launchPlan.args, {
      cwd: launchPlan.gameDir,
      env: buildProcessEnv(opts.windowPlatform, process.env, envOverrides),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: false,
    });

    const output = { stdout: [], stderr: [] };
    captureOutput(child, output, typeof opts.onOutput === 'function' ? opts.onOutput : null);

    let settleExit;
    const exited = new Promise((resolve) => {
      settleExit = resolve;
    });
    child.once('exit', (code, exitSignal) => settleExit({ code, signal: exitSignal, error: null }));
    child.once('error', (error) => {
      logger?.error('minecraft process error', { error: error.message });
      settleExit({ code: null, signal: null, error });
    });

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error) => {
        child.off('spawn', onSpawn);
        reject(
          new LaunchError(`Failed to start Minecraft: ${error.message}`, {
            cause: error,
            details: { stage: 'spawn', java: launchPlan.java.path, gameDir: launchPlan.gameDir },
          }),
        );
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    logger?.info('minecraft launched', {
      id: launchPlan.id,
      pid: child.pid,
      java: launchPlan.java.path,
      gameDir: launchPlan.gameDir,
      args: launchPlan.args.length,
    });

    return {
      pid: child.pid,
      java: launchPlan.java.path,
      args: launchPlan.args,
      cwd: launchPlan.gameDir,
      child,
      output,
      launchPlan,
      kill: (killSignal = 'SIGTERM') => child.kill(killSignal),
      exited,
    };
  }

  return { launch, buildLaunchPlan };
}
