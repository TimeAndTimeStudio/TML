// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import { ValidationError } from '../core/errors.js';

export const DEPENDENCY_BUCKETS = Object.freeze(['optional', 'incompatible', 'embedded']);

function invalidRoot(value) {
  return new ValidationError('resolveDependencies requires a Modrinth version id or version object', {
    code: 'INVALID_DEPENDENCY_ROOT',
    details: { mod: typeof value === 'string' ? value : typeof value },
  });
}

function invalidEntry(reason, details = {}) {
  return new ValidationError(`Invalid dependency entry: ${reason}`, {
    code: 'INVALID_DEPENDENCY_ENTRY',
    details,
  });
}

export function createDependencyResolver(options = {}) {
  const manager = options.manager ?? null;
  const modrinth = options.modrinth ?? null;
  const installer = options.installer ?? null;
  const logger = options.logger ?? null;

  if (!manager || typeof manager.get !== 'function' || typeof manager.paths !== 'function') {
    throw new ValidationError('createDependencyResolver requires an instance manager', {
      code: 'INVALID_INSTANCE_MANAGER',
    });
  }
  if (!modrinth || typeof modrinth.getVersion !== 'function' || typeof modrinth.listVersions !== 'function') {
    throw new ValidationError('createDependencyResolver requires a Modrinth API with getVersion() and listVersions()', {
      code: 'INVALID_MODRINTH_API',
    });
  }
  if (!installer || typeof installer.status !== 'function' || typeof installer.install !== 'function') {
    throw new ValidationError('createDependencyResolver requires a mod installer with status() and install()', {
      code: 'INVALID_MOD_INSTALLER',
    });
  }

  async function toVersion(mod) {
    if (typeof mod === 'string') {
      return modrinth.getVersion(mod);
    }
    if (
      !mod
      || typeof mod !== 'object'
      || typeof mod.id !== 'string'
      || mod.id === ''
      || typeof mod.projectId !== 'string'
      || mod.projectId === ''
      || !Array.isArray(mod.dependencies)
    ) {
      throw invalidRoot(mod);
    }
    return mod;
  }

  async function resolveVersionFor(dep, meta) {
    if (typeof dep.versionId === 'string' && dep.versionId !== '') {
      return modrinth.getVersion(dep.versionId);
    }

    const candidates = await modrinth.listVersions(dep.projectId, {
      gameVersions: [meta.minecraftVersion],
      loaders: [meta.loader],
    });
    const usable = candidates.filter((version) => Array.isArray(version.files) && version.files.length > 0);
    const picked = usable.find((version) => version.versionType === 'release') ?? usable[0];
    if (!picked) {
      throw new ValidationError(
        `No usable Modrinth version for dependency "${dep.projectId}" on Minecraft ${meta.minecraftVersion} (${meta.loader})`,
        {
          code: 'DEPENDENCY_VERSION_NOT_FOUND',
          details: {
            projectId: dep.projectId,
            minecraftVersion: meta.minecraftVersion,
            loader: meta.loader,
          },
        },
      );
    }
    return picked;
  }

  function normalizeDep(raw, context) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalidEntry('not an object', context);
    }
    if (typeof raw.projectId !== 'string' || raw.projectId === '') {
      throw invalidEntry('missing projectId', context);
    }
    const dependencyType = typeof raw.dependencyType === 'string' ? raw.dependencyType : '';
    if (dependencyType !== 'required' && !DEPENDENCY_BUCKETS.includes(dependencyType)) {
      throw invalidEntry(`unknown dependencyType "${dependencyType}"`, { ...context, dependencyType });
    }
    return {
      projectId: raw.projectId,
      versionId: typeof raw.versionId === 'string' && raw.versionId !== '' ? raw.versionId : null,
      fileName: typeof raw.fileName === 'string' && raw.fileName !== '' ? raw.fileName : null,
      dependencyType,
    };
  }

  async function resolveDependencies(instanceId, mod) {
    const meta = await manager.get(instanceId);
    const root = await toVersion(mod);

    const visited = new Set([root.projectId]);
    const skippedSets = {
      optional: new Set(),
      incompatible: new Set(),
      embedded: new Set(),
    };
    const dependencies = [];
    const queue = [];

    for (const raw of root.dependencies) {
      queue.push({ dep: normalizeDep(raw, { projectId: root.projectId, versionId: root.id }), depth: 1 });
    }

    while (queue.length > 0) {
      const { dep, depth } = queue.shift();

      if (dep.dependencyType !== 'required') {
        skippedSets[dep.dependencyType].add(dep.projectId);
        continue;
      }
      if (visited.has(dep.projectId)) continue;
      visited.add(dep.projectId);

      const version = await resolveVersionFor(dep, meta);
      const state = await installer.status(instanceId, version.id);

      dependencies.push({
        projectId: dep.projectId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        dependencyType: 'required',
        depth,
        fileName: dep.fileName,
        files: Object.freeze([...version.files.map((file) => file.filename)]),
        installed: state.installed === true,
      });

      for (const raw of version.dependencies) {
        queue.push({ dep: normalizeDep(raw, { projectId: version.projectId, versionId: version.id }), depth: depth + 1 });
      }
    }

    const dependenciesFrozen = Object.freeze(dependencies.map((entry) => Object.freeze(entry)));
    const missing = dependenciesFrozen.filter((entry) => !entry.installed);
    const skipped = Object.freeze(
      Object.fromEntries(
        Object.entries(skippedSets).map(([key, set]) => [key, Object.freeze([...set])]),
      ),
    );

    logger?.debug('dependencies resolved', {
      instanceId,
      rootVersionId: root.id,
      total: dependenciesFrozen.length,
      missing: missing.length,
    });

    return Object.freeze({
      instanceId,
      root: Object.freeze({ projectId: root.projectId, versionId: root.id }),
      dependencies: dependenciesFrozen,
      missing: Object.freeze(missing),
      skipped,
    });
  }

  async function installDependencies(instanceId, mod, installOptions = {}) {
    const plan = await resolveDependencies(instanceId, mod);
    const installed = [];

    for (const dep of plan.missing) {
      const result = await installer.install(instanceId, dep.versionId, installOptions);
      installed.push(result);
      logger?.info('dependency installed', {
        instanceId,
        projectId: dep.projectId,
        versionId: dep.versionId,
        files: result.files.map((file) => file.filename),
      });
    }

    return Object.freeze({
      instanceId,
      root: plan.root,
      plan,
      installed: Object.freeze(installed),
    });
  }

  return { resolveDependencies, installDependencies };
}
