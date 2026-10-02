#!/usr/bin/env node
// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import path from 'node:path';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { ensureDir } from './core/filesystem.js';
import { assertLinuxPlatform } from './core/platform.js';
import { createApiRouter } from './server/routes.js';
import { createTmlServer } from './server/server.js';
import { createMinecraftApi } from './minecraft/api.js';
import { createInstaller } from './minecraft/install.js';
import { createLauncher } from './minecraft/launch.js';
import { createInstanceManager } from './instance/manager.js';
import { createInstanceExporter } from './instance/export.js';
import { createInstanceImporter } from './instance/import.js';
import { createModInstaller } from './mods/install.js';
import { createFabricInstaller } from './fabric/installer.js';
import { createFabricApi } from './fabric/api.js';
import { createModrinthApi } from './modrinth/api.js';
import { createJavaRuntimes } from './java/runtimes.js';
import { defaultJavaRoots, findMinecraftJava } from './java/runtime.js';
import { createAuthProvider } from './auth/provider.js';
import { createTokenStore, SESSION_FILE_NAME } from './auth/token-store.js';
import { writeZipFile } from './archive/zip.js';

const SHUTDOWN_TIMEOUT_MS = 5000;
const KNOWN_FLAGS = new Set(['-h', '--help', '-v', '--version']);

async function packageVersion() {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function printHelp() {
  const version = await packageVersion();
  process.stdout.write(
    [
      `tml ${version} — TML, Time Mini Launcher`,
      '',
      'Usage:',
      '  tml                Start the launcher server (open the printed URL in a browser)',
      '  tml --help, -h     Show this help',
      '  tml --version, -v  Print the installed version',
      '',
      'Environment:',
      '  TML_HOST           Bind host (default 127.0.0.1)',
      '  TML_PORT           Bind port (default 8620)',
      '  TML_LOG_LEVEL      debug | info | warn | error | silent (default warn)',
      '  TML_DATA_DIR       Data directory (default <cwd>/tml-data)',
      '  TML_MSA_CLIENT_ID  Microsoft Entra (Azure) application client ID (GUID)',
      '',
      'Requirements: Linux, Node.js >= 18.17',
      '',
    ].join('\n')
  );
}

async function ensureDataDirs(config) {
  const dirs = [
    config.paths.logsDir,
    config.paths.instancesDir,
    config.paths.cacheDir,
    config.paths.exportsDir,
    config.paths.tmpDir,
  ];
  for (const dir of dirs) await ensureDir(dir);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    await printHelp();
    return;
  }
  if (args.includes('-v') || args.includes('--version')) {
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }
  const unknown = args.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length > 0) {
    process.stderr.write(`tml: unknown option \`${unknown[0]}\`\nTry \`tml --help\` for usage.\n`);
    process.exitCode = 1;
    return;
  }

  assertLinuxPlatform();
  const config = loadConfig();
  await ensureDataDirs(config);

  const logger = createLogger({
    level: config.log.level,
    file: config.log.file,
    context: { app: 'tml' },
  });

  logger.info('starting', {
    version: config.version,
    node: process.version,
    dataDir: config.paths.dataDir,
  });

  const minecraft = createMinecraftApi({ config, logger });
  const mcInstaller = createInstaller({ config, minecraft, logger });

  // The Fabric installer needs manager.paths(), and the manager needs the fabric
  // installer for per-instance launches — bind the manager late through closures.
  let managerRef = null;
  const fabric = createFabricInstaller({
    minecraft,
    logger,
    manager: {
      get: (id) => managerRef.get(id),
      paths: (id) => managerRef.paths(id),
    },
  });
  const javaRuntimes = createJavaRuntimes({ config, logger });

  function findMinecraftJavaWithManaged(options = {}) {
    const chosen = javaRuntimes.getChosen();
    const roots = [
      ...(chosen ? [{ path: path.join(config.paths.javaDir, chosen), source: 'tml-chosen' }] : []),
      { path: config.paths.javaDir, source: 'tml-managed' },
      ...defaultJavaRoots({ env: process.env }),
    ];
    return findMinecraftJava({ ...options, roots });
  }

  const launcher = createLauncher({
    config,
    logger,
    installer: mcInstaller,
    javaRuntime: javaRuntimes,
    findMinecraftJava: findMinecraftJavaWithManaged,
  });
  const manager = createInstanceManager({ config, logger, installer: mcInstaller, launcher, fabric });
  managerRef = manager;

  const modrinthInstaller = createModInstaller({ manager, logger });
  const exporter = createInstanceExporter({ manager, writeZip: writeZipFile, exportsDir: config.paths.exportsDir, logger });
  const importer = createInstanceImporter({ manager, tempRoot: config.paths.tmpDir, logger });

  const auth = createAuthProvider({
    clientId: config.auth.clientId,
    source: config.auth.source,
    logger,
  });
  const account = createTokenStore({ file: path.join(config.paths.dataDir, SESSION_FILE_NAME), logger });
  const modrinth = createModrinthApi({ logger });
  const fabricMeta = createFabricApi({ logger });

  const router = createApiRouter({
    config,
    logger,
    minecraft,
    instance: { manager, exporter, importer, installer: modrinthInstaller },
    auth,
    account,
    modrinth,
    fabric: fabricMeta,
    java: javaRuntimes,
  });
  const server = createTmlServer({ config, logger, router });

  let shuttingDown = false;
  const shutdown = async (reason, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });

    const timer = setTimeout(() => {
      logger.warn('shutdown timed out, forcing exit');
      process.exit(exitCode || 1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    server.close(() => {
      logger.info('stopped');
      process.exit(exitCode);
    });
  };

  server.on('error', (err) => {
    logger.error('server error', { err });
    if (err.code === 'EADDRINUSE') {
      logger.error('port already in use', { host: config.server.host, port: config.server.port });
    }
    process.exitCode = 1;
    shutdown('server-error', 1);
  });

  server.listen(config.server.port, config.server.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.server.port;
    const url = `http://${config.server.host}:${port}`;
    logger.info('launcher ready', { url });
    process.stdout.write(`\n  TML — Time Mini Launcher\n  ${url}\n\n`);
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
  });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`TML failed to start: ${message}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
