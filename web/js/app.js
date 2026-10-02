// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

const REFRESH_MS = 15000;
const VALID_VIEWS = new Set(['instances', 'instance', 'versions', 'settings']);

const VERSION_TYPE_LABELS = {
  release: 'Release',
  snapshot: 'Snapshot',
  old_beta: 'Old Beta',
  old_alpha: 'Old Alpha',
};

const versionsState = { type: 'all', loaded: false, loading: false, selected: null };

const state = {
  health: null,
  config: null,
};

const instancesState = { list: [], loaded: false, detail: null, tab: 'overview', mods: [], packs: { resourcepacks: [], shaderpacks: [] } };
const importState = { token: null, manifest: null };

const el = {};

function cacheElements() {
  const ids = [
    'statusPill',
    'statusText',
    'versionPill',
    'factEndpoint',
    'factUptime',
    'factNode',
    'factPlatform',
    'toastHost',
    'authBtn',
    'accountPill',
    'skinOpenBtn',
  ];
  for (const id of ids) el[id] = document.getElementById(id);
}

async function fetchJson(path) {
  const response = await fetch(path, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error?.message || `${path} responded ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function toast(message, { error = false } = {}) {
  const node = document.createElement('div');
  node.className = error ? 'toast is-error' : 'toast';
  node.textContent = message;
  el.toastHost.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function formatUptime(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  return `${rest}s`;
}

function formatPlaySeconds(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  if (seconds <= 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

function formatLastPlayed(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function setServerStatus(mode) {
  const pill = el.statusPill;
  pill.dataset.state = mode;
  el.statusText.textContent =
    mode === 'online' ? 'Launcher online' : mode === 'offline' ? 'Disconnected' : 'Connecting…';
}

function renderHealth() {
  const health = state.health;
  if (!health) return;

  el.factUptime.textContent = formatUptime(health.uptimeSeconds);
  el.factNode.textContent = health.node ?? '—';
  el.factPlatform.textContent = health.platform ?? '—';
}

function fillIfIdle(input, value) {
  if (!input || input.dataset.dirty === '1') return false;
  if (document.activeElement === input) return false;
  const next = String(value);
  if (input.value === next) return false;
  input.value = next;
  return true;
}

function parseArgString(text) {
  const source = String(text ?? '');
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(source);
  while (match !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
    match = pattern.exec(source);
  }
  return args;
}

function formatArgString(args) {
  if (!Array.isArray(args) || args.length === 0) return '';
  return args.map((arg) => (/[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

function renderConfig() {
  const config = state.config;
  if (!config) return;

  el.versionPill.textContent = `v${config.version}`;
  el.factEndpoint.textContent = `http://${config.server.host}:${config.server.port}`;

  const values = {
    version: config.version,
    dataDir: config.paths.dataDir,
    instancesDir: config.paths.instancesDir,
    cacheDir: config.paths.cacheDir,
    javaRuntime: selectedJavaLabel() ?? 'Not selected — pick one in Java Runtime (PLAY needs it)',
  };

  for (const [key, value] of Object.entries(values)) {
    const cell = document.querySelector(`[data-config="${key}"]`);
    if (cell) cell.textContent = String(value);
  }

  fillIfIdle(document.getElementById('cfgHost'), config.server.host);
  fillIfIdle(document.getElementById('cfgPort'), config.server.port);
  fillIfIdle(document.getElementById('cfgOfflineName'), config.auth?.offlineName ?? '');
  renderAuthFlowPicker(); // LIVE FLOW — ลบพร้อม src/auth/live.js
  if (fillIfIdle(document.getElementById('cfgLogLevel'), config.log.level)) {
    settingsDropdowns.logLevel?.reset();
  }
  if (fillIfIdle(document.getElementById('cfgWindow'), config.window?.platform ?? 'auto')) {
    settingsDropdowns.windowPlatform?.reset();
  }
}

function makeText(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
}

function formatBytes(value) {
  if (typeof value !== 'number' || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function versionTypeLabel(type) {
  return VERSION_TYPE_LABELS[type] ?? type;
}

async function loadVersions({ refresh = false } = {}) {
  const list = document.getElementById('versionsList');
  const counter = document.getElementById('versionCount');
  if (!list || versionsState.loading) return;

  versionsState.loading = true;
  list.replaceChildren(makeText('p', 'muted', 'Loading versions…'));

  try {
    const params = new URLSearchParams();
    if (versionsState.type !== 'all') params.set('type', versionsState.type);
    if (refresh) params.set('refresh', '1');

    const data = await fetchJson(`/api/minecraft/versions?${params.toString()}`);
    versionsState.loading = false;
    versionsState.loaded = true;
    counter.textContent = `${data.count} versions`;
    renderVersionList(data);
  } catch (err) {
    versionsState.loading = false;
    list.replaceChildren(makeText('p', 'muted', `Failed to load: ${err.message}`));
    toast(err.message, { error: true });
  }
}

function renderVersionList(data) {
  const list = document.getElementById('versionsList');
  list.replaceChildren();

  if (data.versions.length === 0) {
    list.appendChild(makeText('p', 'muted', 'No versions in this category'));
    return;
  }

  for (const entry of data.versions) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = versionsState.selected === entry.id ? 'version-row is-active' : 'version-row';
    row.dataset.id = entry.id;
    row.append(
      makeText('span', 'version-id', entry.id),
      makeText('span', `version-type t-${entry.type}`, versionTypeLabel(entry.type)),
      makeText('span', 'version-date', formatDate(entry.releaseTime))
    );
    row.addEventListener('click', () => selectVersion(entry.id));
    list.appendChild(row);
  }
}

async function selectVersion(id) {
  const detail = document.getElementById('versionDetail');
  if (!detail) return;

  versionsState.selected = id;
  for (const row of document.querySelectorAll('.version-row')) {
    row.classList.toggle('is-active', row.dataset.id === id);
  }

  detail.replaceChildren(makeText('p', 'muted', `Loading ${id}…`));

  try {
    const data = await fetchJson(`/api/minecraft/versions/${encodeURIComponent(id)}`);
    renderVersionDetail(data);
  } catch (err) {
    detail.replaceChildren(makeText('p', 'muted', err.message));
  }
}

function renderVersionDetail({ version, source }) {
  const detail = document.getElementById('versionDetail');
  if (!detail) return;

  detail.replaceChildren();

  const head = document.createElement('div');
  head.className = 'version-detail-head';
  head.append(
    makeText('h3', '', version.id),
    makeText('span', `version-type t-${version.type}`, versionTypeLabel(version.type))
  );

  const facts = document.createElement('dl');
  facts.className = 'facts';

  const rows = [
    ['Type', version.type],
    ['Release time', formatDate(version.releaseTime)],
    ['Main class', version.mainClass],
    ['Java', version.javaVersion ? `${version.javaVersion.majorVersion} (${version.javaVersion.component ?? '—'})` : '—'],
    ['Assets index', `${version.assetIndex.id} · ${formatBytes(version.assetIndex.size)}`],
    ['Client jar', formatBytes(version.downloads.client.size)],
    ['Client sha1', version.downloads.client.sha1],
    ['Libraries', String(version.libraries.length)],
    ['Metadata', source],
  ];

  for (const [label, value] of rows) {
    const item = document.createElement('div');
    item.append(makeText('dt', '', label), makeText('dd', '', value));
    facts.appendChild(item);
  }

  detail.append(head, facts);
}

function setupVersionControls() {
  const filters = document.getElementById('versionFilters');
  const refreshButton = document.getElementById('versionRefresh');
  if (!filters) return;

  filters.addEventListener('click', (event) => {
    const button = event.target.closest('.seg');
    if (!button) return;

    versionsState.type = button.dataset.type;
    for (const segment of filters.querySelectorAll('.seg')) {
      segment.classList.toggle('is-active', segment === button);
    }
    loadVersions();
  });

  refreshButton?.addEventListener('click', () => loadVersions({ refresh: true }));
}

async function refresh() {
  // sync session ก่อนเสมอ — ห้ามผูกกับ request อื่น ไม่งั้นชื่อมุมบนจะไม่อัปเดตถ้า fetch ตัวอื่นล้มเหลว
  await loadSession({ silent: true });
  try {
    const [health, config] = await Promise.all([
      fetchJson('/api/health'),
      fetchJson('/api/config'),
    ]);
    state.health = health;
    state.config = config;

    setServerStatus('online');
    renderHealth();
    renderConfig();
    await loadInstances({ silent: true });
    // โหลดรายการ java runtime ตั้งแต่เปิดแอป จะได้แสดง label "Java 25 (java-runtime-…)" ได้ทันที
    // (loadJavaRuntimes มี loaded flag → refresh รอบถัดไปจะไม่ยิงซ้ำ)
    await loadJavaRuntimes();
  } catch (err) {
    setServerStatus('offline');
    if (err.status !== 404) toast(err.message, { error: true });
  }
}

function activateView(name) {
  const view = VALID_VIEWS.has(name) ? name : 'instances';

  for (const button of document.querySelectorAll('[data-view]')) {
    button.classList.toggle('is-active', button.dataset.view === view);
  }
  for (const panel of document.querySelectorAll('[data-view-panel]')) {
    const active = panel.dataset.viewPanel === view;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  }

  if (view === 'versions' && !versionsState.loaded && !versionsState.loading) {
    loadVersions();
  }
  if (view === 'instances' && instancesState.loaded) {
    loadInstances({ silent: true });
  }
  if (view === 'settings') {
    loadJavaRuntimes();
  }
}

function showView(name, { updateHash = true } = {}) {
  const view = VALID_VIEWS.has(name) ? name : 'instances';
  if (updateHash && location.hash !== `#${view}`) {
    history.replaceState(null, '', `#${view}`);
  }
  activateView(view);
}

function handleHash() {
  const raw = location.hash.slice(1);
  if (raw.startsWith('instance/')) {
    const id = decodeURIComponent(raw.slice('instance/'.length));
    activateView('instance');
    loadInstanceDetail(id);
    return;
  }
  activateView(VALID_VIEWS.has(raw) ? raw : 'instances');
}

function setupNavigation() {
  document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.view));
  });

  window.addEventListener('hashchange', handleHash);
  handleHash();
}

// ---------- Instance management ----------

async function postJson(pathname, body, { signal } = {}) {
  const response = await fetch(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `${pathname} responded ${response.status}`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

async function patchJson(pathname, body, { signal } = {}) {
  const response = await fetch(pathname, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `${pathname} responded ${response.status}`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

async function deleteJson(pathname) {
  const response = await fetch(pathname, { method: 'DELETE', headers: { accept: 'application/json' } });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `${pathname} responded ${response.status}`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

// ---------- Launch overlay ----------

const LAUNCH_STAGE_LABELS = {
  idle: 'Preparing…',
  resolve: 'Resolving version…',
  metadata: 'Checking game files…',
  client: 'Downloading client…',
  libraries: 'Downloading libraries…',
  logging: 'Setting up logging…',
  assets: 'Downloading assets…',
  java: 'Downloading Java runtime…',
  spawn: 'Starting game…',
};

function paintLaunchOverlay(data) {
  const stage = document.getElementById('launchStage');
  const fill = document.getElementById('launchProgressFill');
  const percentLabel = document.getElementById('launchPercent');
  if (!stage || !fill || !percentLabel) return;
  const label = LAUNCH_STAGE_LABELS[data.stage] ?? LAUNCH_STAGE_LABELS.idle;
  stage.textContent = label;
  const percent = Math.max(0, Math.min(100, Math.round(Number(data.percent) || 0)));
  fill.style.width = `${data.launching === false ? 0 : percent}%`;
  percentLabel.textContent = data.launching === false ? '—' : `${percent}%`;
}

async function launchWithProgress(id, name) {
  const overlay = document.getElementById('launchOverlay');
  const title = document.getElementById('launchTitle');
  let stopped = false;
  let timer = null;

  const poll = async () => {
    if (stopped) return;
    try {
      const data = await fetchJson(`/api/instances/${encodeURIComponent(id)}/launch-progress`);
      if (!stopped) paintLaunchOverlay(data);
    } catch {
      /* keep the last known state */
    }
    if (!stopped) timer = setTimeout(poll, 400);
  };

  const showTimer = setTimeout(() => {
    if (stopped) return;
    if (title) title.textContent = `Launching ${name}…`;
    if (overlay) overlay.hidden = false;
    paintLaunchOverlay({ launching: true, stage: 'resolve', percent: 0 });
    poll();
  }, 250);

  try {
    return await postJson(`/api/instances/${encodeURIComponent(id)}/launch`);
  } finally {
    stopped = true;
    clearTimeout(showTimer);
    clearTimeout(timer);
    if (overlay) overlay.hidden = true;
  }
}

async function loadInstances({ silent = false } = {}) {
  try {
    const data = await fetchJson('/api/instances');
    instancesState.list = data.instances ?? [];
    instancesState.loaded = true;
    renderInstances();
  } catch (err) {
    if (!silent) toast(err.message, { error: true });
  }
}

const STATUS_POLL_MS = 3000;

async function pollInstanceStatus() {
  try {
    await loadInstances({ silent: true });
    const detail = instancesState.detail;
    if (!detail || location.hash !== `#instance/${encodeURIComponent(detail.id)}`) return;
    const data = await fetchJson(`/api/instances/${encodeURIComponent(detail.id)}`);
    const wasRunning = detail.running === true;
    instancesState.detail = data.instance;
    renderInstanceDetail();
    if (wasRunning && data.instance.running !== true) {
      toast(`${data.instance.name} closed`);
    }
  } catch {
    /* silent — status converges on the next tick */
  }
}

function renderInstances() {
  const grid = document.getElementById('instancesGrid');
  const empty = document.getElementById('instancesEmpty');
  if (!grid || !empty) return;

  grid.replaceChildren();
  const instances = instancesState.list;
  grid.hidden = instances.length === 0;
  empty.hidden = instances.length > 0;

  for (const instance of instances) {
    grid.appendChild(instanceCard(instance));
  }
}

function instanceCard(instance) {
  const card = document.createElement('article');
  card.className = 'instance-card card';
  card.dataset.id = instance.id;

  const head = document.createElement('div');
  head.className = 'instance-card-head';

  const nameBtn = makeText('button', 'instance-name', instance.name);
  nameBtn.type = 'button';
  nameBtn.addEventListener('click', () => {
    location.hash = `#instance/${encodeURIComponent(instance.id)}`;
  });
  head.appendChild(nameBtn);
  if (instance.running) head.appendChild(makeText('span', 'pill pill-running', 'RUNNING'));
  card.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'instance-meta';
  const played = (instance.playSeconds ?? 0) + (instance.sessionSeconds ?? 0);
  meta.append(
    makeText('span', '', `Minecraft ${instance.minecraftVersion}`),
    makeText('span', '', `Fabric ${instance.fabricLoaderVersion}`),
    makeText('span', '', `${instance.mods ?? 0} Mods`),
    makeText('span', '', played > 0 ? `${formatPlaySeconds(played)} played` : 'Not played yet')
  );
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'instance-actions';

  const play = makeText('button', instance.running ? 'btn' : 'btn btn-primary', instance.running ? 'STOP' : 'PLAY');
  play.type = 'button';
  play.addEventListener('click', async () => {
    play.disabled = true;
    try {
      if (instance.running) {
        await postJson(`/api/instances/${instance.id}/stop`);
        toast(`${instance.name} stopped`);
      } else {
        await launchWithProgress(instance.id, instance.name);
        toast(`${instance.name} is launching`);
      }
      await loadInstances({ silent: true });
    } catch (err) {
      toast(err.message, { error: true });
      play.disabled = false;
    }
  });

  const exp = makeText('button', 'btn', 'EXPORT');
  exp.type = 'button';
  exp.addEventListener('click', () => exportInstance(instance));

  const del = makeText('button', 'btn btn-danger', 'DELETE');
  del.type = 'button';
  del.addEventListener('click', () => deleteInstance(instance));

  actions.append(play, exp, del);
  card.appendChild(actions);
  return card;
}

const exportModalState = { instance: null, force: false };

function updateExportPreview() {
  const name = (document.getElementById('exportName')?.value ?? '').trim().replace(/\.zip$/i, '');
  const folder = (document.getElementById('exportPath')?.value ?? '').trim().replace(/\/+$/, '');
  const preview = document.getElementById('exportPreview');
  if (preview) preview.textContent = `${folder ? `${folder}/` : ''}${name || 'instance'}.zip`;
}

function openExportModal(instance) {
  if (!instance) return;
  exportModalState.instance = instance;
  exportModalState.force = false;
  const errorBox = document.getElementById('exportError');
  if (errorBox) errorBox.hidden = true;
  const subtitle = document.getElementById('exportSubtitle');
  if (subtitle) {
    subtitle.textContent = `${instance.name} · Minecraft ${instance.minecraftVersion} · Fabric ${instance.fabricLoaderVersion ?? '—'}`;
  }
  const pathInput = document.getElementById('exportPath');
  if (pathInput) pathInput.value = state.config?.paths?.exportsDir ?? '';
  const nameInput = document.getElementById('exportName');
  if (nameInput) nameInput.value = `${instance.name}-${instance.minecraftVersion}`;
  updateExportPreview();
  const modal = document.getElementById('exportModal');
  if (modal) modal.hidden = false;
  nameInput?.focus();
  nameInput?.select();
}

function closeExportModal() {
  const modal = document.getElementById('exportModal');
  if (modal) modal.hidden = true;
  exportModalState.instance = null;
  exportModalState.force = false;
}

async function submitExport() {
  const instance = exportModalState.instance;
  if (!instance) return;
  const errorBox = document.getElementById('exportError');
  if (errorBox) errorBox.hidden = true;
  const folder = (document.getElementById('exportPath')?.value ?? '').trim();
  let name = (document.getElementById('exportName')?.value ?? '').trim();
  if (name.toLowerCase().endsWith('.zip')) name = name.slice(0, -4);
  if (name.trim() === '' || folder === '') {
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = 'Folder path and file name are required.';
    }
    return;
  }
  try {
    const result = await postJson(`/api/instances/${encodeURIComponent(instance.id)}/export`, {
      name,
      path: folder,
      force: exportModalState.force,
    });
    closeExportModal();
    toast(`Exported ${result.path} (${formatBytes(result.bytes)})`);
    await loadInstances({ silent: true });
  } catch (err) {
    if (err.code === 'EXPORT_EXISTS') {
      exportModalState.force = true;
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = 'File already exists — press EXPORT again to overwrite it.';
      }
      return;
    }
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = err.message;
    }
  }
}

function setupExportModal() {
  document.getElementById('exportCancelBtn')?.addEventListener('click', closeExportModal);
  document.getElementById('exportModal')?.addEventListener('click', (event) => {
    if (event.target.id === 'exportModal') closeExportModal();
  });
  document.getElementById('exportForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitExport();
  });
  for (const id of ['exportPath', 'exportName']) {
    document.getElementById(id)?.addEventListener('input', updateExportPreview);
  }
}

async function exportInstance(instance) {
  openExportModal(instance);
}

async function deleteInstance(instance) {
  const confirmed = window.confirm(`Delete "${instance.name}"?\n\nThis removes its instance.json, minecraft/ directory, mods, config and saves permanently.`);
  if (!confirmed) return;
  try {
    await deleteJson(`/api/instances/${instance.id}`);
    toast(`${instance.name} deleted`);
    if (location.hash.startsWith('#instance/')) {
      location.hash = '#instances';
    }
    await loadInstances({ silent: true });
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------- Instance detail ----------

async function loadInstanceDetail(id) {
  const previousId = instancesState.detail?.id;
  instancesState.detail = null;
  instancesState.mods = [];
  if (previousId !== id) {
    clearModSearchResults();
    setInstanceTab('overview');
  }
  document.getElementById('instanceTitle').textContent = id;
  document.getElementById('instanceSubtitle').textContent = 'Loading…';
  const settingsError = document.getElementById('instanceSettingsError');
  if (settingsError) settingsError.hidden = true;

  try {
    const data = await fetchJson(`/api/instances/${encodeURIComponent(id)}`);
    instancesState.detail = data.instance;
    renderInstanceDetail();
  } catch (err) {
    toast(err.message, { error: true });
    location.hash = '#instances';
  }
}

// แสดง java ที่เลือกไว้ใน Settings (instance.java เป็น 'minecraft-bundled' ตลอด → ไม่บอกอะไร)
// คืน null เมื่อยังไม่ได้เลือก
function selectedJavaLabel() {
  const chosen = state.config?.java?.runtime ?? null;
  if (!chosen) return null;
  const runtime = javaRuntimeState.list.find((entry) => entry.name === chosen) ?? null;
  if (runtime) return `Java ${runtime.major ?? runtime.javaVersion} (${chosen})`;
  // list ยังไม่โหลด → อย่าโชว์ชื่อดิบ "java-runtime-epsilon"; โหลดไม่สำเร็จ/ไม่เจอใน list → โชว์ชื่อไปก่อน
  if (!javaRuntimeState.loaded && !javaRuntimeState.failed) return 'Loading…';
  return chosen;
}

function renderInstanceDetail() {
  const instance = instancesState.detail;
  if (!instance) return;

  document.getElementById('instanceTitle').textContent = instance.name;
  document.getElementById('instanceSubtitle').textContent =
    `Minecraft ${instance.minecraftVersion} · Fabric ${instance.fabricLoaderVersion} · ${instance.mods ?? 0} Mods`;

  const facts = document.getElementById('instanceFacts');
  facts.replaceChildren();
  const rows = [
    ['Instance id', instance.id],
    ['Minecraft', instance.minecraftVersion],
    ['Loader', `${instance.loader} ${instance.fabricLoaderVersion}`],
    ['Mods', String(instance.mods ?? 0)],
    ['Java', selectedJavaLabel() ?? 'Not selected'],
    ['Play time', formatPlaySeconds((instance.playSeconds ?? 0) + (instance.sessionSeconds ?? 0))],
    ['Last played', formatLastPlayed(instance.lastPlayedAt)],
    ['Memory', instance.memory ? `${instance.memory.min} – ${instance.memory.max}` : '—'],
    ['Extra JVM args', instance.extraJvmArgs?.length ? instance.extraJvmArgs.join(' ') : '—'],
    ['Status', instance.running ? `running (pid ${instance.pid})` : 'stopped'],
  ];
  for (const [label, value] of rows) {
    const item = document.createElement('div');
    item.append(makeText('dt', '', label), makeText('dd', '', value));
    facts.appendChild(item);
  }

  const play = document.getElementById('iPlayBtn');
  play.textContent = instance.running ? 'STOP' : 'PLAY';

  fillIfIdle(document.getElementById('isName'), instance.name);
  fillIfIdle(document.getElementById('isMemMin'), instance.memory?.min ?? '');
  fillIfIdle(document.getElementById('isMemMax'), instance.memory?.max ?? '');
  fillIfIdle(document.getElementById('isJvmArgs'), formatArgString(instance.extraJvmArgs));
  const readOnly = {
    isId: instance.id,
    isMc: instance.minecraftVersion,
    isLoader: `${instance.loader} ${instance.fabricLoaderVersion}`,
    isJava: selectedJavaLabel() ?? 'Not selected',
  };
  for (const [id, value] of Object.entries(readOnly)) {
    const cell = document.getElementById(id);
    if (cell) cell.textContent = String(value);
  }
}

function setInstanceTab(tab) {
  instancesState.tab = tab;
  const show = (panelId, active) => {
    const panel = document.getElementById(panelId);
    if (panel) panel.hidden = !active;
  };
  show('instancePanelOverview', tab === 'overview');
  show('instancePanelMods', tab === 'mods');
  show('instancePanelPacks', tab === 'packs');
  show('instancePanelSettings', tab === 'settings');
  document.getElementById('iModsBtn')?.classList.toggle('is-active', tab === 'mods');
  document.getElementById('iPacksBtn')?.classList.toggle('is-active', tab === 'packs');
  document.getElementById('iSettingsBtn')?.classList.toggle('is-active', tab === 'settings');
}

async function loadMods() {
  const instance = instancesState.detail;
  if (!instance) return;
  const list = document.getElementById('modList');
  const pill = document.getElementById('modCountPill');
  list.replaceChildren(makeText('p', 'muted', 'Loading mods…'));

  try {
    const data = await fetchJson(`/api/instances/${encodeURIComponent(instance.id)}/mods`);
    instancesState.mods = data.mods ?? [];
    pill.textContent = `${data.count} mods`;
    renderMods();
  } catch (err) {
    list.replaceChildren(makeText('p', 'muted', err.message));
    toast(err.message, { error: true });
  }
}

function renderMods() {
  const list = document.getElementById('modList');
  list.replaceChildren();

  if (instancesState.mods.length === 0) {
    list.appendChild(makeText('p', 'muted', 'No mods installed in this instance.'));
    return;
  }

  for (const mod of instancesState.mods) {
    const row = document.createElement('div');
    row.className = 'mod-row';
    row.append(
      makeText('span', 'mod-name', mod.filename),
      makeText('span', 'mod-size', formatBytes(mod.size))
    );
    const remove = makeText('button', 'btn btn-danger btn-small', 'REMOVE');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      try {
        await deleteJson(`/api/instances/${instancesState.detail.id}/mods/${encodeURIComponent(mod.filename)}`);
        toast(`${mod.filename} removed`);
        await loadMods();
        await loadInstances({ silent: true });
        renderInstanceDetail();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
    row.appendChild(remove);
    list.appendChild(row);
  }
}

async function loadPacks() {
  const instance = instancesState.detail;
  if (!instance) return;

  for (const kind of ['resourcepacks', 'shaderpacks']) {
    const list = document.getElementById(kind === 'resourcepacks' ? 'rpList' : 'spList');
    if (list) list.replaceChildren(makeText('p', 'muted', 'Loading…'));
    try {
      const data = await fetchJson(
        `/api/instances/${encodeURIComponent(instance.id)}/packs?kind=${kind}`
      );
      instancesState.packs[kind] = data.packs ?? [];
    } catch (err) {
      instancesState.packs[kind] = [];
      if (list) list.replaceChildren(makeText('p', 'muted', err.message));
    }
  }
  renderPacks();
}

function renderPacks() {
  const total =
    instancesState.packs.resourcepacks.length + instancesState.packs.shaderpacks.length;
  const pill = document.getElementById('packCountPill');
  if (pill) pill.textContent = `${total} files`;

  for (const kind of ['resourcepacks', 'shaderpacks']) {
    const list = document.getElementById(kind === 'resourcepacks' ? 'rpList' : 'spList');
    const count = document.getElementById(kind === 'resourcepacks' ? 'rpCountPill' : 'spCountPill');
    const files = instancesState.packs[kind];
    if (count) count.textContent = String(files.length);
    if (!list) continue;
    list.replaceChildren();

    if (files.length === 0) {
      list.appendChild(
        makeText(
          'p',
          'muted',
          kind === 'resourcepacks'
            ? 'No resource packs installed in this instance.'
            : 'No shaders installed in this instance.'
        )
      );
      continue;
    }

    for (const file of files) {
      const row = document.createElement('div');
      row.className = 'mod-row';
      row.append(
        makeText('span', 'mod-name', file.filename),
        makeText('span', 'mod-size', formatBytes(file.size))
      );
      const remove = makeText('button', 'btn btn-danger btn-small', 'REMOVE');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        try {
          await deleteJson(
            `/api/instances/${encodeURIComponent(instancesState.detail.id)}/packs/${encodeURIComponent(file.filename)}?kind=${kind}`
          );
          toast(`${file.filename} removed`);
          await loadPacks();
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
      row.appendChild(remove);
      list.appendChild(row);
    }
  }
}

function setupInstanceDetail() {
  document.getElementById('instanceBackBtn')?.addEventListener('click', () => {
    location.hash = '#instances';
  });

  document.getElementById('iPlayBtn')?.addEventListener('click', async (event) => {
    const instance = instancesState.detail;
    if (!instance) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      if (instance.running) {
        await postJson(`/api/instances/${instance.id}/stop`);
        toast(`${instance.name} stopped`);
      } else {
        await launchWithProgress(instance.id, instance.name);
        toast(`${instance.name} is launching`);
      }
      await loadInstanceDetail(instance.id);
      await loadInstances({ silent: true });
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('iModsBtn')?.addEventListener('click', () => {
    const next = instancesState.tab === 'mods' ? 'overview' : 'mods';
    setInstanceTab(next);
    if (next === 'mods') {
      loadMods();
      ensureDefaultModSearch();
    }
  });

  document.getElementById('iPacksBtn')?.addEventListener('click', () => {
    const next = instancesState.tab === 'packs' ? 'overview' : 'packs';
    setInstanceTab(next);
    if (next === 'packs') {
      loadPacks();
      ensureDefaultPackSearch();
    }
  });

  document.getElementById('iSettingsBtn')?.addEventListener('click', () => {
    setInstanceTab(instancesState.tab === 'settings' ? 'overview' : 'settings');
  });

  const settingsForm = document.getElementById('instanceSettingsForm');
  const settingsError = document.getElementById('instanceSettingsError');
  if (settingsForm && settingsError) {
    for (const id of ['isName', 'isMemMin', 'isMemMax', 'isJvmArgs']) {
      document.getElementById(id)?.addEventListener('input', (event) => {
        event.currentTarget.dataset.dirty = '1';
      });
    }
    settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const instance = instancesState.detail;
      if (!instance) return;
      settingsError.hidden = true;
      const fieldIds = ['isName', 'isMemMin', 'isMemMax', 'isJvmArgs'];
      try {
        const result = await patchJson(`/api/instances/${encodeURIComponent(instance.id)}`, {
          name: document.getElementById('isName').value.trim(),
          memory: {
            min: document.getElementById('isMemMin').value.trim(),
            max: document.getElementById('isMemMax').value.trim(),
          },
          extraJvmArgs: parseArgString(document.getElementById('isJvmArgs').value),
        });
        for (const id of fieldIds) {
          const input = document.getElementById(id);
          if (input) delete input.dataset.dirty;
        }
        instancesState.detail = result.instance;
        renderInstanceDetail();
        toast('Instance settings saved');
        await loadInstances({ silent: true });
      } catch (err) {
        settingsError.hidden = false;
        settingsError.textContent = err.message;
      }
    });
  }

  document.getElementById('iExportBtn')?.addEventListener('click', () => {
    if (instancesState.detail) exportInstance(instancesState.detail);
  });

  document.getElementById('iDeleteBtn')?.addEventListener('click', () => {
    if (instancesState.detail) deleteInstance(instancesState.detail);
  });
}

// ---------- Import / Create wizards ----------

function setImportStep(step) {
  const modal = document.getElementById('importModal');
  document.getElementById('importStep1').hidden = step !== 1;
  document.getElementById('importStep2').hidden = step !== 2;
  document.getElementById('importStep3').hidden = step !== 3;
  document.getElementById('importConfirmBtn').hidden = step !== 2;
  document.getElementById('importDoneBtn').hidden = step !== 3;
  document.getElementById('importCancelBtn').hidden = step === 3;
  modal.dataset.step = String(step);
}

function openImportModal() {
  importState.token = null;
  importState.manifest = null;
  const error = document.getElementById('importError');
  error.hidden = true;
  error.textContent = '';
  document.getElementById('importFile').value = '';
  document.getElementById('importName').value = '';
  setImportStep(1);
  document.getElementById('importModal').hidden = false;
}

function closeImportModal() {
  document.getElementById('importModal').hidden = true;
}

function showImportError(message) {
  const error = document.getElementById('importError');
  error.hidden = false;
  error.textContent = message;
}

async function handleImportFile(file) {
  if (!file) return;
  const error = document.getElementById('importError');
  error.hidden = true;

  try {
    const response = await fetch('/api/instances/import?preview=1', {
      method: 'POST',
      headers: { 'content-type': 'application/zip', accept: 'application/json' },
      body: file,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error?.message || `Upload failed (${response.status})`);
    }

    importState.token = payload.token;
    importState.manifest = payload.manifest;

    const summary = document.getElementById('importSummary');
    summary.replaceChildren();
    const facts = document.createElement('dl');
    facts.className = 'facts';
    for (const [label, value] of [
      ['Archive name', payload.manifest.name],
      ['Minecraft', payload.manifest.minecraftVersion],
      ['Loader', `${payload.manifest.loader} ${payload.manifest.fabricLoaderVersion}`],
      ['Format', `v${payload.manifest.format}`],
    ]) {
      const item = document.createElement('div');
      item.append(makeText('dt', '', label), makeText('dd', '', value));
      facts.appendChild(item);
    }
    summary.appendChild(facts);

    document.getElementById('importName').value = payload.manifest.name;
    setImportStep(2);
  } catch (err) {
    showImportError(err.message);
  }
}

async function confirmImport() {
  const name = document.getElementById('importName').value.trim();
  const confirmBtn = document.getElementById('importConfirmBtn');
  confirmBtn.disabled = true;
  try {
    const result = await postJson('/api/instances/import', { token: importState.token, name });
    document.getElementById('importDoneName').textContent = result.name;
    document.getElementById('importDoneMeta').textContent =
      `Minecraft ${result.manifest.minecraftVersion} · Fabric ${result.manifest.fabricLoaderVersion} · ${result.files} files`;
    setImportStep(3);
    await loadInstances({ silent: true });
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    confirmBtn.disabled = false;
  }
}

function setupImportModal() {
  document.getElementById('importInstanceBtn')?.addEventListener('click', openImportModal);
  document.querySelectorAll('[data-open-import]').forEach((button) => {
    button.addEventListener('click', openImportModal);
  });
  document.getElementById('importFile')?.addEventListener('change', (event) => {
    handleImportFile(event.target.files?.[0] ?? null);
  });
  document.getElementById('importCancelBtn')?.addEventListener('click', closeImportModal);
  document.getElementById('importConfirmBtn')?.addEventListener('click', confirmImport);
  document.getElementById('importDoneBtn')?.addEventListener('click', () => {
    closeImportModal();
    showView('instances');
  });
  document.getElementById('importModal')?.addEventListener('click', (event) => {
    if (event.target.id === 'importModal' && event.target.dataset.step === '1') closeImportModal();
  });
}

function openCreateModal() {
  document.getElementById('createError').hidden = true;
  document.getElementById('createForm').reset();
  createDropdowns.mc?.reset();
  createDropdowns.fabric?.reset();
  createDropdowns.mc?.setDefaultFromOptions();
  createDropdowns.fabric?.setDefaultFromOptions();
  document.getElementById('createModal').hidden = false;
  loadCatalogOptions();
}

function closeCreateModal() {
  document.getElementById('createModal').hidden = true;
}

function setupCreateModal() {
  createDropdowns.mc = createDropdown({ containerId: 'createMcDropdown', valueId: 'createMc' });
  createDropdowns.fabric = createDropdown({ containerId: 'createFabricDropdown', valueId: 'createFabric' });

  document.getElementById('createInstanceBtn')?.addEventListener('click', openCreateModal);
  document.querySelectorAll('[data-open-create]').forEach((button) => {
    button.addEventListener('click', openCreateModal);
  });
  document.getElementById('createCancelBtn')?.addEventListener('click', closeCreateModal);

  document.getElementById('createForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = document.getElementById('createError');
    errorBox.hidden = true;
    const minecraftVersion = document.getElementById('createMc').value.trim();
    const fabricLoaderVersion = document.getElementById('createFabric').value.trim();
    if (minecraftVersion === '' || fabricLoaderVersion === '') {
      errorBox.hidden = false;
      errorBox.textContent = 'Pick a Minecraft version and a Fabric loader version first';
      return;
    }
    try {
      const result = await postJson('/api/instances', {
        name: document.getElementById('createName').value.trim(),
        minecraftVersion,
        fabricLoaderVersion,
      });
      closeCreateModal();
      toast(`${result.instance.name} created`);
      await loadInstances({ silent: true });
      location.hash = `#instance/${encodeURIComponent(result.instance.id)}`;
    } catch (err) {
      errorBox.hidden = false;
      errorBox.textContent = err.message;
    }
  });
}

// ---------- Microsoft account + Modrinth search ----------

const authState = { device: null, controller: null };
const catalogState = { minecraft: false, fabric: false };
const createDropdowns = { mc: null, fabric: null };
const settingsDropdowns = { logLevel: null, windowPlatform: null };
const packSearchDropdowns = { type: null };
const javaRuntimeState = { loaded: false, failed: false, list: [], chosen: null };
let javaRtDropdown = null;

async function loadSession({ silent = false } = {}) {
  try {
    const session = await fetchJson('/api/auth/session');
    renderSession(session);
    return session;
  } catch (err) {
    if (!silent) toast(err.message, { error: true });
    return null;
  }
}

function renderSession(session) {
  const signedIn = session?.signedIn === true;
  el.accountPill.hidden = !signedIn;
  el.skinOpenBtn.hidden = !signedIn; // ปุ่มสกินข้างชื่อผู้เล่น — มีเฉพาะตอน sign in
  el.authBtn.textContent = signedIn ? 'ACCOUNT' : 'SIGN IN';
  // เขียนชื่อทุกครั้ง (ไม่ใช่แค่ตอน sign in) จะได้ไม่ค้างชื่อเก่าหลัง sign out
  el.accountPill.textContent = signedIn ? (session.username ?? '—') : '—';
  const offlineForm = document.getElementById('offlineNameForm');
  if (offlineForm) offlineForm.hidden = signedIn;
}

function authModal() {
  return document.getElementById('authModal');
}

function showAuthError(message, targetId = 'authError') {
  const box = document.getElementById(targetId);
  box.hidden = false;
  box.textContent = message;
}

function renderAuthModal(session) {
  renderAuthFlowPicker(); // LIVE FLOW — ลบพร้อม src/auth/live.js
  const signedIn = session?.signedIn === true;
  document.getElementById('authSignedIn').hidden = !signedIn;
  document.getElementById('authSignedOut').hidden = signedIn;
  document.getElementById('authStartBtn').disabled = session?.clientConfigured === false;

  if (signedIn) {
    // ลบ error ค้างจากการ refresh ที่ล้มเหลวก่อนหน้า ออกเมื่อ sign in ใหม่สำเร็จ
    document.getElementById('authSessionError').hidden = true;
    document.getElementById('authError').hidden = true;
    document.getElementById('skinError').hidden = true;
    const facts = document.getElementById('authFacts');
    facts.replaceChildren();
    const expires = session.expiresAt ? new Date(session.expiresAt).toLocaleString() : '—';
    for (const [label, value] of [
      ['Username', session.username],
      ['UUID', session.uuid],
      ['Xbox XUID', session.xuid ?? '—'],
      ['Expires', session.expired ? `${expires} (expired)` : expires],
    ]) {
      const item = document.createElement('div');
      item.append(makeText('dt', '', label), makeText('dd', '', String(value)));
      facts.appendChild(item);
    }
  }
}

function resetAuthStartUi() {
  authState.device = null;
  document.getElementById('authCodeStep').hidden = true;
  document.getElementById('authWaiting').hidden = true;
  document.getElementById('authError').hidden = true;
  document.getElementById('authStartBtn').hidden = false;
  document.getElementById('authCancelBtn').textContent = 'CANCEL';
}

async function openAuthModal() {
  resetAuthStartUi();
  authModal().hidden = false;
  const session = await loadSession({ silent: true });
  renderAuthModal(session ?? { signedIn: false });
}

function closeAuthModal() {
  authState.device = null;
  authState.controller?.abort();
  authState.controller = null;
  authModal().hidden = true;
}

async function startAuth() {
  const startBtn = document.getElementById('authStartBtn');
  document.getElementById('authError').hidden = true;
  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';

  try {
    const device = await postJson('/api/auth/device', {});
    authState.device = device;
    document.getElementById('authUserCode').textContent = device.userCode;
    const link = document.getElementById('authLink');
    link.href = device.verificationUri ?? 'https://microsoft.com/link';
    link.textContent = (device.verificationUri ?? 'https://microsoft.com/link').replace(/^https?:\/\//, '');
    document.getElementById('authMessage').textContent = device.message ?? '';
    document.getElementById('authCodeStep').hidden = false;
    document.getElementById('authWaiting').hidden = false;
    startBtn.hidden = true;
    document.getElementById('authCancelBtn').textContent = 'STOP';

    await pollAuth(device);
  } catch (err) {
    showAuthError(err.message);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = 'START SIGN IN';
  }
}

async function pollAuth(device) {
  authState.controller = new AbortController();
  while (authState.device === device) {
    if (device.expiresAt && Date.now() >= device.expiresAt) {
      showAuthError('The code has expired — start again');
      authState.device = null;
      break;
    }
    try {
      const result = await postJson('/api/auth/login', { deviceCode: device.deviceCode }, {
        signal: authState.controller.signal,
      });
      authState.device = null;
      authState.controller = null;
      renderSession(result.session);
      renderAuthModal(result.session);
      toast(`Signed in as ${result.session.username}`);
      break;
    } catch (err) {
      if (err.name === 'AbortError') {
        authState.controller = null;
        break;
      }
      if (err.code === 'AUTH_WAIT_TIMEOUT') continue;
      showAuthError(err.message);
      authState.device = null;
      resetWaitingUi();
      break;
    }
  }
}

function resetWaitingUi() {
  document.getElementById('authWaiting').hidden = true;
  document.getElementById('authStartBtn').hidden = false;
  document.getElementById('authCancelBtn').textContent = 'CANCEL';
}

async function signOut() {
  try {
    await deleteJson('/api/auth/session');
    renderSession({ signedIn: false });
    renderAuthModal({ signedIn: false });
    resetAuthStartUi();
    toast('Signed out');
  } catch (err) {
    showAuthError(err.message, 'authSessionError');
  }
}

// กันกด REFRESH ถี่เกินไป (upstream เคยตอบ 429) — มีทั้ง busy lock และ cooldown
const REFRESH_COOLDOWN_MS = 15_000;
let refreshBusy = false;
let refreshCooldownUntil = 0;

async function refreshAuthSession() {
  if (refreshBusy) return;
  if (Date.now() < refreshCooldownUntil) {
    const waitSec = Math.ceil((refreshCooldownUntil - Date.now()) / 1000);
    showAuthError(`Please wait ${waitSec}s before refreshing again`, 'authSessionError');
    return;
  }
  refreshBusy = true;
  const button = document.getElementById('authRefreshBtn');
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'REFRESHING…';
  }
  try {
    const result = await postJson('/api/auth/refresh', {});
    renderSession(result.session);
    renderAuthModal(result.session);
    document.getElementById('authSessionError').hidden = true;
    toast('Session refreshed');
  } catch (err) {
    showAuthError(err.message, 'authSessionError');
    if (err.status === 401) {
      renderSession({ signedIn: false });
      renderAuthModal({ signedIn: false });
      resetAuthStartUi();
    }
  } finally {
    refreshBusy = false;
    refreshCooldownUntil = Date.now() + REFRESH_COOLDOWN_MS;
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

// ---------- Skin change ----------

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000; // ตัดเป็นท่อนละ 32KB กัน stack overflow ของ apply
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function skinFile() {
  return document.getElementById('skinOverlayFile');
}

function selectedSkinFile() {
  const input = skinFile();
  const file = input?.files?.[0] ?? null;
  if (!file) {
    showAuthError('Choose a PNG skin file first', 'skinError');
    return null;
  }
  return file;
}

function previewSkinFile(file) {
  // preview แสดงเฉพาะ "สกินที่ใช้อยู่ตอนนี้" เสมอ — การเลือกไฟล์แค่เตรียมไว้อัปโหลด (ชื่อไฟล์โชว์ข้างปุ่ม)
  skinOverlayState.source = 'file';
  skinOverlayState.name = file.name;
  setSkinFileName(file.name);
  renderSkinOverlayMeta(
    `${file.name} chosen — preview always shows the skin in use · press UPLOAD SKIN to apply it`,
  );
}

// ---------- Skin overlay (หน้าต่างสกิน: แสดง skin ที่ใช้อยู่ + เปลี่ยนได้) ----------

const skinOverlayState = { source: 'active', url: null, name: '', image: null, placeholder: 'No skin preview' };

// hash ใน texture url (https://textures.minecraft.net/texture/<hash>) ใช้ชี้หาไฟล์ใน cache บนเครื่อง
function skinTextureHash(url) {
  const match = /\/texture\/([a-f0-9]{40,64})$/.exec(String(url ?? ''));
  return match ? match[1] : null;
}

// เดา slim/classic จากพิกเซล: แขนขวาของ slim จบแค่ x=53 (classic ถึง x=55)
// → คอลัมน์ 54–55 แถว 20–31 ถ้าโปร่งใสทั้งหมด = slim (ไม่งั้นแขนโดนตัดเวลาวาดแบบ 4px)
function detectSlimModel(image) {
  try {
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (w !== 64 || (h !== 64 && h !== 32)) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0);
    const strip = ctx.getImageData(54, 20, 2, 12).data; // 2 คอลัมน์ × 12 แถว
    for (let i = 3; i < strip.length; i += 4) {
      if (strip[i] > 0) return 'classic'; // มีพิกเซลทึบ → classic
    }
    return 'slim';
  } catch {
    return null; // อ่านพิกเซลไม่ได้ → ไม่เดา ใช้ค่าใน dropdown เดิม
  }
}
let skinVariantDropdown = null;

function skinOverlayEl() {
  return document.getElementById('skinOverlay');
}

function setSkinFileName(text) {
  const node = document.getElementById('skinFileName');
  if (node) node.textContent = text;
}

function renderSkinOverlayMeta(text) {
  const meta = document.getElementById('skinOverlayMeta');
  if (meta && text !== undefined) meta.textContent = text;
  return meta;
}

function chosenSkinVariant() {
  return document.getElementById('skinVariantValue')?.value === 'slim' ? 'slim' : 'classic';
}

// วาดตัวละครจาก texture layout ของ Minecraft (64x64 หรือ 64x32 แบบ mirror)
function drawSkinFigure(ctx, tex, { x, y, scale, armW, legacy, back }) {
  const s = scale;
  const depth = 4;
  const copy = (sx, sy, sw, sh, dx, dy) =>
    ctx.drawImage(tex, sx, sy, sw, sh, x + dx * s, y + dy * s, sw * s, sh * s);

  const headX = back ? 24 : 8;
  const bodyX = back ? 32 : 20;
  const rightArmX = back ? 44 + armW + depth : 44;
  const leftArmX = back ? 36 + armW + depth : 36;
  const rightLegX = back ? 12 : 4;
  const leftLegX = back ? 28 : 20;
  const limbY = 20;
  const leftLimbY = legacy ? 20 : 52;
  const contentW = armW * 2 + 8;

  copy(headX, 8, 8, 8, Math.floor((contentW - 8) / 2), 0);
  copy(rightArmX, limbY, armW, 12, 0, 8);
  copy(bodyX, limbY, 8, 12, armW, 8);
  copy(legacy ? rightArmX : leftArmX, legacy ? limbY : leftLimbY, armW, 12, armW + 8, 8);
  copy(rightLegX, limbY, 4, 12, armW, 20);
  copy(legacy ? rightLegX : leftLegX, legacy ? limbY : leftLimbY, 4, 12, armW + 4, 20);
}

function drawSkinOverlay() {
  const canvas = document.getElementById('skinOverlayCanvas');
  const image = skinOverlayState.image;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!image) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.font = '13px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(skinOverlayState.placeholder ?? 'No skin preview', canvas.width / 2, canvas.height / 2);
    return;
  }

  const armW = chosenSkinVariant() === 'slim' ? 3 : 4;
  const legacy = image.naturalHeight === 32;
  const scale = 10;
  const figureW = (armW * 2 + 8) * scale;
  const figureH = 32 * scale;
  const gap = 48;
  const offsetX = Math.round((canvas.width - (figureW * 2 + gap)) / 2);
  const offsetY = 16;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
  ctx.textAlign = 'center';

  for (let i = 0; i < 2; i += 1) {
    const x = offsetX + i * (figureW + gap);
    drawSkinFigure(ctx, image, { x, y: offsetY, scale, armW, legacy, back: i === 1 });
    ctx.fillText(i === 1 ? 'BACK' : 'FRONT', x + figureW / 2, offsetY + figureH + 18);
  }
}

function loadSkinImage(url) {
  const image = new Image();
  image.addEventListener('load', () => {
    skinOverlayState.image = image;
    // ปรับ model อัตโนมัติจากพิกเซลจริง (skin slim วาดเป็น 4px = แขนโดนตัด)
    const detected = detectSlimModel(image);
    const input = document.getElementById('skinVariantValue');
    if (detected && input && input.value !== detected) {
      skinVariantDropdown?.setValue(detected, { silent: true });
    }
    drawSkinOverlay();
  });
  image.addEventListener('error', () => {
    // รูปจาก data URL โหลดไม่ขึ้น → บอกสาเหตุตรง ๆ แทนที่จะค้างว่าง
    skinOverlayState.image = null;
    renderSkinOverlayMeta('Could not load the skin image');
    drawSkinOverlay();
  });
  image.src = url;
}

// skin ที่ใช้อยู่ตอนนี้: ข้อมูลบัญชีจาก server แล้วดึงรูปจาก cache บนเครื่องเท่านั้น (ไม่ยิงออกไปโหลดจากเน็ต)
// freshDataUrl = รูปที่เพิ่งอัปโหลดสำเร็จ (bytes อยู่ฝั่ง client แล้ว) — server เก็บลง cache แล้วเหมือนกัน แต่ใช้รูปนี้ตรง ๆ เร็วสุด
async function loadActiveSkin({ freshDataUrl = null } = {}) {
  renderSkinOverlayMeta('Loading the skin in use…');
  skinOverlayState.placeholder = 'No skin preview';

  let profile;
  try {
    profile = await fetchJson('/api/minecraft/skin');
  } catch (err) {
    showAuthError(err.message, 'skinError');
    renderSkinOverlayMeta('Could not read your Minecraft profile');
    drawSkinOverlay();
    return;
  }

  const skins = Array.isArray(profile.skins) ? profile.skins : [];
  const active = skins.find((entry) => entry.state === 'ACTIVE') ?? skins[0] ?? null;
  skinOverlayState.source = 'active';
  skinOverlayState.image = null;
  skinOverlayState.url = null;
  skinOverlayState.name = '';

  if (!active) {
    skinOverlayState.placeholder = 'Default skin';
    renderSkinOverlayMeta('Default skin — nothing custom set on this account');
    drawSkinOverlay();
    return;
  }

  if (freshDataUrl) {
    // เพิ่งอัปโหลดสำเร็จ → แสดงรูปที่เพิ่งส่งไปเลย (มันคือสกินที่ใช้อยู่ตอนนี้)
    // server เก็บลง cache แล้ว — ปิดเปิดแอปใหม่ก็ยังเห็นรูปนี้ผ่าน /api/minecraft/skin/image
    skinOverlayState.url = freshDataUrl;
    renderSkinOverlayMeta(
      `Skin in use${profile.username ? ` — ${profile.username}` : ''} · just uploaded`,
    );
    loadSkinImage(freshDataUrl);
    return;
  }

  try {
    const hash = skinTextureHash(active.url);
    const local = await fetchJson(`/api/minecraft/skin/image${hash ? `?hash=${hash}` : ''}`);
    skinOverlayState.url = local.dataUrl;
    renderSkinOverlayMeta(
      `Skin in use${profile.username ? ` — ${profile.username}` : ''} · from this machine's skin cache · preview always shows the skin in use`,
    );
    loadSkinImage(local.dataUrl);
  } catch (err) {
    if (err.status === 404) {
      skinOverlayState.placeholder = 'Skin not on this machine yet';
      renderSkinOverlayMeta('Not cached on this machine yet — upload it here or launch the game once');
      drawSkinOverlay();
      return;
    }
    showAuthError(err.message, 'skinError');
    renderSkinOverlayMeta('Could not load the skin image');
    drawSkinOverlay();
  }
}

async function openSkinOverlay() {
  const modal = skinOverlayEl();
  if (!modal) return;
  document.getElementById('skinError').hidden = true;
  // เปิดทุกครั้ง = แสดง skin ที่ใช้อยู่ตอนนั้น (ล้างไฟล์ที่เลือกค้างไว้)
  skinOverlayState.source = 'active';
  skinOverlayState.url = null;
  skinOverlayState.name = '';
  skinOverlayState.image = null;
  skinOverlayState.placeholder = 'No skin preview';
  setSkinFileName('No file chosen');
  modal.hidden = false;
  await loadActiveSkin();
}

function closeSkinOverlay() {
  const modal = skinOverlayEl();
  if (modal) modal.hidden = true;
}

async function uploadSkin() {
  const file = selectedSkinFile();
  if (!file) return;
  const button = document.getElementById('skinUploadBtn');
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'UPLOADING…';
  }
  document.getElementById('skinError').hidden = true;
  try {
    const data = bufferToBase64(await file.arrayBuffer());
    await postJson('/api/minecraft/skin', {
      data,
      variant: chosenSkinVariant(),
      filename: file.name,
    });
    toast('Skin updated');
    // แสดง skin ที่ใช้อยู่ตัวใหม่ทันที — ใช้รูปที่เพิ่งอัปโหลด (cache ยังไม่มีสกินใหม่จนกว่าเกมจะโหลด)
    await loadActiveSkin({ freshDataUrl: `data:image/png;base64,${data}` });
  } catch (err) {
    showAuthError(err.message, 'skinError');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

async function resetSkin() {
  const button = document.getElementById('skinResetBtn');
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'RESETTING…';
  }
  document.getElementById('skinError').hidden = true;
  try {
    await deleteJson('/api/minecraft/skin');
    toast('Skin reset to default');
    setSkinFileName('No file chosen');
    await loadActiveSkin();
  } catch (err) {
    showAuthError(err.message, 'skinError');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

function setupSkinControls() {
  skinVariantDropdown = createDropdown({ containerId: 'skinVariantDropdown', valueId: 'skinVariantValue' });
  skinVariantDropdown?.setOptions([
    { value: 'classic', label: 'Classic (wide arms)' },
    { value: 'slim', label: 'Slim (narrow arms)' },
  ]);
  skinVariantDropdown?.setValue('classic', { silent: true });

  // ปุ่ม SKIN ข้างชื่อผู้เล่น (topbar) → เปิดหน้าต่างสกิน
  document.getElementById('skinOpenBtn')?.addEventListener('click', openSkinOverlay);

  // CHOOSE FILE แบบ custom (ซ่อน input ไฟล์ของระบบไว้ข้างใน)
  document.getElementById('skinChooseBtn')?.addEventListener('click', () => skinFile()?.click());
  skinFile()?.addEventListener('change', () => {
    document.getElementById('skinError').hidden = true;
    const file = skinFile()?.files?.[0];
    if (file) previewSkinFile(file);
  });

  document.getElementById('skinUploadBtn')?.addEventListener('click', uploadSkin);
  document.getElementById('skinResetBtn')?.addEventListener('click', resetSkin);
  document.getElementById('skinOverlayClose')?.addEventListener('click', closeSkinOverlay);
  document.getElementById('skinOverlay')?.addEventListener('click', (event) => {
    if (event.target?.id === 'skinOverlay') closeSkinOverlay();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const modal = skinOverlayEl();
    if (modal && !modal.hidden) closeSkinOverlay();
  });
  // เปลี่ยน model แล้ววาดตัวอย่างใหม่ทันทีถ้าหน้าต่างสกินเปิดอยู่
  document.getElementById('skinVariantValue')?.addEventListener('input', () => {
    if (skinOverlayEl() && !skinOverlayEl().hidden) drawSkinOverlay();
  });
}

// ---------- LIVE FLOW: ตัวเลือกวิธี sign in (ลบบล็อกนี้พร้อม src/auth/live.js) ----------

function currentAuthFlow() {
  return state.config?.auth?.flow === 'live' ? 'live' : 'aad';
}

function renderAuthFlowPicker() {
  const picker = document.getElementById('authFlowPicker');
  if (!picker) return;
  const flow = currentAuthFlow();
  for (const option of picker.querySelectorAll('[data-flow]')) {
    const active = option.dataset.flow === flow;
    option.classList.toggle('active', active);
    option.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  const hint = document.getElementById('authFlowHint');
  if (hint) {
    hint.textContent = flow === 'live'
      ? 'Instant — signs you in through Minecraft’s Microsoft sign-in. Recommended for most players.'
      : 'Standard — signs you in with this launcher’s own Microsoft app.';
  }
}

function setupAuthFlowPicker() {
  document.getElementById('authFlowPicker')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-flow]');
    if (!option) return;
    const flow = option.dataset.flow;
    if (flow !== 'aad' && flow !== 'live') return;
    try {
      await patchJson('/api/config', { auth: { flow } });
      await refresh();
      renderAuthFlowPicker();
      toast(flow === 'live' ? 'Sign-in method set to Instant' : 'Sign-in method set to Standard');
    } catch (err) {
      showAuthError(err.message);
    }
  });
}

// ---------- /LIVE FLOW ----------

function setupAuth() {
  setupSkinControls();
  el.authBtn?.addEventListener('click', openAuthModal);
  document.getElementById('accountsNavBtn')?.addEventListener('click', openAuthModal);
  document.getElementById('authStartBtn')?.addEventListener('click', startAuth);
  document.getElementById('authCancelBtn')?.addEventListener('click', () => {
    if (authState.device) {
      authState.device = null;
      authState.controller?.abort();
      resetWaitingUi();
    } else {
      closeAuthModal();
    }
  });
  document.getElementById('authCloseBtn')?.addEventListener('click', closeAuthModal);
  document.getElementById('authSignOutBtn')?.addEventListener('click', signOut);
  document.getElementById('authRefreshBtn')?.addEventListener('click', refreshAuthSession);
  authModal()?.addEventListener('click', (event) => {
    if (event.target.id === 'authModal') closeAuthModal();
  });
}

function setupOfflineNameForm() {
  const form = document.getElementById('offlineNameForm');
  const input = document.getElementById('cfgOfflineName');
  const errorBox = document.getElementById('offlineNameError');
  if (!form || !input || !errorBox) return;

  input.addEventListener('input', () => {
    input.dataset.dirty = '1';
    errorBox.hidden = true;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const value = input.value.trim();
    try {
      const result = await patchJson('/api/config', { auth: { offlineName: value === '' ? null : value } });
      delete input.dataset.dirty;
      if (result.saved) {
        toast(value ? `Offline name set to ${value}` : 'Offline name reset to Player');
      } else {
        toast('No changes');
      }
      await refresh();
    } catch (err) {
      errorBox.hidden = false;
      errorBox.textContent = err.message;
    }
  });
}

function setupServerConfigForm() {
  const form = document.getElementById('serverConfigForm');
  const errorBox = document.getElementById('serverConfigError');
  if (!form || !errorBox) return;

  settingsDropdowns.logLevel = createDropdown({ containerId: 'cfgLogLevelDropdown', valueId: 'cfgLogLevel' });
  settingsDropdowns.logLevel?.setOptions(['debug', 'info', 'warn', 'error', 'silent']);
  settingsDropdowns.windowPlatform = createDropdown({ containerId: 'cfgWindowDropdown', valueId: 'cfgWindow' });
  settingsDropdowns.windowPlatform?.setOptions([
    { value: 'auto', label: 'System (auto)' },
    { value: 'x11', label: 'X11 / XWayland' },
  ]);

  for (const id of ['cfgHost', 'cfgPort', 'cfgLogLevel', 'cfgWindow']) {
    document.getElementById(id)?.addEventListener('input', (event) => {
      event.currentTarget.dataset.dirty = '1';
    });
  }

  const clearDirty = () => {
    for (const id of ['cfgHost', 'cfgPort', 'cfgLogLevel', 'cfgWindow']) {
      const input = document.getElementById(id);
      if (input) delete input.dataset.dirty;
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    try {
      const result = await patchJson('/api/config', {
        server: {
          host: document.getElementById('cfgHost').value.trim(),
          port: document.getElementById('cfgPort').value.trim(),
        },
        log: { level: document.getElementById('cfgLogLevel').value },
        window: { platform: document.getElementById('cfgWindow').value },
      });
      if (result.saved) {
        clearDirty();
        toast(
          Array.isArray(result.restartRequired) && result.restartRequired.includes('server')
            ? 'Settings saved — restart the server for the new host/port to apply'
            : 'Settings saved',
        );
      } else {
        toast('No changes');
      }
      await refresh();
    } catch (err) {
      errorBox.hidden = false;
      errorBox.textContent = err.message;
    }
  });
}

// ---------- Java runtime picker ----------

// Overlay แยกของหน้า Java Runtime — แสดงระหว่าง download แล้ว poll progress ของ runtime นั้น
async function downloadJavaRuntimeWithProgress(name) {
  const overlay = document.getElementById('javaOverlay');
  const title = document.getElementById('javaOverlayTitle');
  const stage = document.getElementById('javaOverlayStage');
  const fill = document.getElementById('javaOverlayFill');
  const percentLabel = document.getElementById('javaOverlayPercent');
  let stopped = false;
  let timer = null;

  const paint = (data) => {
    const percent = Math.max(0, Math.min(100, Math.round(Number(data.percent) || 0)));
    if (fill) fill.style.width = `${percent}%`;
    if (percentLabel) percentLabel.textContent = `${percent}%`;
    const files = data.files ?? null;
    if (stage) stage.textContent = files && files.count > 0 ? `Files ${files.done} / ${files.count}` : 'Preparing…';
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const data = await fetchJson(`/api/java/runtimes/${encodeURIComponent(name)}/progress`);
      if (!stopped && data) paint(data);
    } catch {
      /* keep the last known state */
    }
    if (!stopped) timer = setTimeout(poll, 400);
  };

  const showTimer = setTimeout(() => {
    if (stopped) return;
    if (title) title.textContent = `Downloading ${name}…`;
    if (overlay) overlay.hidden = false;
    paint({ percent: 0, files: { done: 0, count: 0 } });
    poll();
  }, 250);

  try {
    return await postJson(`/api/java/runtimes/${encodeURIComponent(name)}/download`, {});
  } finally {
    stopped = true;
    clearTimeout(showTimer);
    clearTimeout(timer);
    if (overlay) overlay.hidden = true;
  }
}

function renderJavaRuntimeCard() {
  const versionCell = document.getElementById('javaRtVersion');
  const releasedCell = document.getElementById('javaRtReleased');
  const stateCell = document.getElementById('javaRtState');
  const pill = document.getElementById('javaRtPill');
  const actionBtn = document.getElementById('javaRtActionBtn');
  const deleteBtn = document.getElementById('javaRtDeleteBtn');
  const valueInput = document.getElementById('javaRtValue');
  if (!versionCell || !releasedCell || !stateCell || !pill || !actionBtn || !valueInput) return;

  const name = valueInput.value;
  const runtime = javaRuntimeState.list.find((entry) => entry.name === name) ?? null;
  versionCell.textContent = runtime ? `Java ${runtime.javaVersion}` : '—';
  releasedCell.textContent = runtime?.released ?? '—';
  stateCell.textContent = runtime
    ? runtime.downloaded
      ? 'Downloaded'
      : 'Not downloaded'
    : '—';

  // ปุ่ม DELETE เห็นเฉพาะ runtime ที่โหลดมาแล้ว (โหลดค้างอยู่/ยังไม่โหลด → ซ่อน)
  if (deleteBtn) deleteBtn.hidden = !(runtime && runtime.downloaded);

  // pill + ปุ่มบอกสถานะเลือก/ยังไม่เลือก (โหลดแล้วเท่านั้นถึงเลือกได้)
  const selected = Boolean(runtime) && runtime.name === javaRuntimeState.chosen;
  pill.textContent = runtime ? (selected ? 'SELECTED' : 'NOT SELECTED') : '—';
  if (!runtime) {
    actionBtn.textContent = 'NOT SELECTED';
    actionBtn.disabled = true;
    actionBtn.dataset.mode = 'none';
  } else if (!runtime.downloaded) {
    actionBtn.textContent = 'DOWNLOAD';
    actionBtn.disabled = javaRuntimeState.list.length === 0;
    actionBtn.dataset.mode = 'download';
  } else if (selected) {
    actionBtn.textContent = 'SELECTED';
    actionBtn.disabled = true;
    actionBtn.dataset.mode = 'none';
  } else {
    actionBtn.textContent = 'NOT SELECTED';
    actionBtn.disabled = false;
    actionBtn.dataset.mode = 'select';
  }
}

// label สำหรับ dropdown = แสดงเป็น Version (Java 21 / Java 17) — ถ้า major ซ้ำกันค่อยเติมชื่อ runtime
function javaRuntimeLabels(list) {
  const labels = new Map();
  const counts = new Map();
  for (const runtime of list) {
    const base = `Java ${runtime.major ?? runtime.javaVersion}`;
    labels.set(runtime.name, base);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  for (const runtime of list) {
    const base = labels.get(runtime.name);
    if (counts.get(base) > 1) labels.set(runtime.name, `${base} — ${runtime.name}`);
  }
  return labels;
}

async function loadJavaRuntimes({ force = false } = {}) {
  const errorBox = document.getElementById('javaRtError');
  if (errorBox) errorBox.hidden = true;
  if (javaRuntimeState.loaded && !force) {
    renderJavaRuntimeCard();
    return;
  }

  try {
    const data = await fetchJson('/api/java/runtimes');
    javaRuntimeState.loaded = true;
    javaRuntimeState.failed = false;
    javaRuntimeState.list = data.runtimes ?? [];
    javaRuntimeState.chosen = data.chosen ?? null;

    // แยกกลุ่ม "Downloaded" กับ "Not downloaded" — เลือกใช้ได้เฉพาะที่โหลดมาแล้วเท่านั้น
    const list = javaRuntimeState.list;
    const labels = javaRuntimeLabels(list);
    const ordered = [...list.filter((entry) => entry.downloaded), ...list.filter((entry) => !entry.downloaded)];
    javaRtDropdown?.setOptions(
      ordered.map((runtime) => ({
        value: runtime.name,
        label: labels.get(runtime.name),
        group: runtime.downloaded ? 'Downloaded' : 'Not downloaded',
      })),
    );
    const valueInput = document.getElementById('javaRtValue');
    if (valueInput) {
      valueInput.value = javaRuntimeState.chosen ?? '';
    }
    javaRtDropdown?.reset();
    renderJavaRuntimeCard();
    // render ซ้ำทันทีที่ list พร้อม — cell "Java runtime" ใน Settings และ facts ของ instance
    // จะเปลี่ยนเป็น "Java 25 (java-runtime-…)" เลย ไม่ต้องรอ refresh รอบถัดไป (15 วิ)
    renderConfig();
    renderInstanceDetail();
  } catch (err) {
    javaRuntimeState.failed = true;
    javaRtDropdown?.markFailed();
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = err.message;
    }
  }
}

function setupJavaRuntimeCard() {
  javaRtDropdown = createDropdown({ containerId: 'javaRtDropdown', valueId: 'javaRtValue' });
  javaRtDropdown?.setOptions([]);
  javaRtDropdown?.setPlaceholder('NOT SELECTED');

  const errorBox = document.getElementById('javaRtError');
  const valueInput = document.getElementById('javaRtValue');
  const actionBtn = document.getElementById('javaRtActionBtn');
  const deleteBtn = document.getElementById('javaRtDeleteBtn');

  // dropdown ใช้ดูรายละเอียดอย่างเดียว — การเลือกใช้จริงทำผ่านปุ่ม NOT SELECTED → SELECTED
  valueInput?.addEventListener('input', () => {
    renderJavaRuntimeCard();
    if (errorBox) errorBox.hidden = true;
  });

  // ปุ่มเดียว 3 สถานะ: DOWNLOAD (ยังไม่โหลด) / NOT SELECTED (โหลดแล้วยังไม่เลือก) / SELECTED (เลือกแล้ว)
  actionBtn?.addEventListener('click', async () => {
    const name = valueInput?.value.trim();
    const mode = actionBtn.dataset.mode;
    if (!name || mode === 'none') return;

    actionBtn.disabled = true;
    actionBtn.textContent = mode === 'select' ? 'SELECTING…' : 'DOWNLOADING…';
    if (deleteBtn) deleteBtn.disabled = true;
    if (errorBox) errorBox.hidden = true;

    if (mode === 'select') {
      try {
        await patchJson('/api/config', { java: { runtime: name } });
        javaRuntimeState.chosen = name;
        await refresh();
        toast(`Java runtime set to ${name}`);
      } catch (err) {
        if (errorBox) {
          errorBox.hidden = false;
          errorBox.textContent = err.message;
        }
      } finally {
        if (deleteBtn) deleteBtn.disabled = false;
        renderJavaRuntimeCard();
      }
      return;
    }

    try {
      const result = await downloadJavaRuntimeWithProgress(name);
      toast(result.cached ? `${name} is already installed` : `Downloaded Java runtime ${name}`);
      await loadJavaRuntimes({ force: true });
      await refresh();
    } catch (err) {
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = err.message;
      }
    } finally {
      if (deleteBtn) deleteBtn.disabled = false;
      renderJavaRuntimeCard();
    }
  });

  // ลบ runtime ที่โหลดแล้ว — ถ้าเป็นตัวที่เลือกอยู่ ระบบจะคืน selection เป็น null ด้วย
  deleteBtn?.addEventListener('click', async () => {
    const name = valueInput?.value.trim();
    const runtime = javaRuntimeState.list.find((entry) => entry.name === name) ?? null;
    if (!name || !runtime?.downloaded) return;
    const wasChosen = javaRuntimeState.chosen === name;
    const confirmed = window.confirm(
      `Delete downloaded Java runtime "${name}"?\n\nThis removes its files from disk permanently.` +
        (wasChosen ? '\n\nIt is the selected runtime — PLAY will need a downloaded runtime to be selected again.' : ''),
    );
    if (!confirmed) return;

    if (errorBox) errorBox.hidden = true;
    actionBtn.disabled = true;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'DELETING…';
    try {
      const result = await deleteJson(`/api/java/runtimes/${encodeURIComponent(name)}`);
      toast(result.clearedChosen ? `Deleted Java runtime ${name} — selection cleared` : `Deleted Java runtime ${name}`);
      javaRuntimeState.chosen = result.chosen ?? null;
      await loadJavaRuntimes({ force: true });
      await refresh();
    } catch (err) {
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = err.message;
      }
    } finally {
      deleteBtn.textContent = 'DELETE';
      deleteBtn.disabled = false;
      actionBtn.disabled = false;
      renderJavaRuntimeCard();
    }
  });
}

function normalizeDropdownOption(option) {
  if (typeof option === 'string') {
    return { value: option, label: option, group: null, disabled: false };
  }
  return {
    value: String(option?.value ?? ''),
    label: String(option?.label ?? option?.value ?? ''),
    group: typeof option?.group === 'string' && option.group !== '' ? option.group : null,
    disabled: option?.disabled === true,
  };
}

function createDropdown({ containerId, valueId }) {
  const container = document.getElementById(containerId);
  const valueInput = document.getElementById(valueId);
  if (!container || !valueInput) return null;

  const toggle = container.querySelector('.dropdown-toggle');
  const menu = container.querySelector('.dropdown-menu');
  const filter = container.querySelector('.dropdown-filter');
  const list = container.querySelector('.dropdown-list');
  const empty = container.querySelector('.dropdown-empty');
  let options = [];
  let loaded = false;
  let touched = false;
  let placeholder = '—';

  function syncLabel() {
    const match = options.find((option) => option.value === valueInput.value);
    const fallback = valueInput.value === '' ? placeholder : valueInput.value;
    toggle.querySelector('.dropdown-value').textContent = match?.label || fallback || '—';
  }

  function close() {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function setValue(value, { silent = false } = {}) {
    touched = true;
    valueInput.value = value;
    if (!silent) valueInput.dispatchEvent(new Event('input', { bubbles: true }));
    syncLabel();
    close();
  }

  function setDefaultFromOptions() {
    if (touched || options.length === 0) return;
    setValue(options[0].value, { silent: true });
  }

  function renderList() {
    const raw = filter ? filter.value.trim() : '';
    const query = raw.toLowerCase();
    const matches = options.filter(
      (option) => option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query)
    );
    list.replaceChildren();
    empty.hidden = matches.length > 0;
    let lastGroup = null;
    for (const option of matches) {
      if (option.group && option.group !== lastGroup) {
        list.appendChild(makeText('li', 'dropdown-group', option.group));
        lastGroup = option.group;
      }
      const item = makeText('li', `dropdown-item${option.disabled ? ' is-disabled' : ''}`, option.label);
      item.setAttribute('role', 'option');
      if (option.disabled) item.setAttribute('aria-disabled', 'true');
      item.addEventListener('click', () => {
        if (!option.disabled) setValue(option.value);
      });
      list.appendChild(item);
    }
    if (matches.length > 0) return;
    if (!loaded) return;
    if (options.length === 0) {
      empty.textContent =
        query === ''
          ? filter
            ? 'Failed to load the list — type a value and press Enter'
            : 'Failed to load the list'
          : `Using “${raw}” (typed) — press Enter`;
    } else if (query === '') {
      empty.textContent = 'No entries';
    } else {
      empty.textContent = `No match for “${raw}” — press Enter to use the typed value`;
    }
  }

  function open() {
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    if (filter) filter.value = '';
    renderList();
    if (filter) filter.focus();
  }

  toggle.addEventListener('click', () => (menu.hidden ? open() : close()));
  filter?.addEventListener('input', renderList);
  filter?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      toggle.focus();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const typed = filter.value.trim();
    if (typed === '') return;
    const exact =
      options.find((option) => option.label.toLowerCase() === typed.toLowerCase()) ??
      options.find((option) => option.value.toLowerCase() === typed.toLowerCase());
    const partial =
      options.find((option) => option.label.toLowerCase().includes(typed.toLowerCase())) ??
      options.find((option) => option.value.toLowerCase().includes(typed.toLowerCase()));
    setValue((exact ?? partial)?.value ?? typed);
  });
  document.addEventListener('click', (event) => {
    if (!container.contains(event.target)) close();
  });

  syncLabel();
  return {
    setOptions(next) {
      loaded = true;
      options = [...next].map(normalizeDropdownOption);
      if (!menu.hidden) renderList();
      syncLabel();
    },
    markFailed() {
      loaded = true;
      options = [];
      if (!menu.hidden) renderList();
      syncLabel();
    },
    reset() {
      close();
      if (filter) filter.value = '';
      touched = false;
      syncLabel();
    },
    setDefaultFromOptions,
    setValue,
    getValue: () => valueInput.value,
    setPlaceholder(text) {
      placeholder = String(text);
      syncLabel();
    },
    setDisabled(flag) {
      toggle.disabled = flag === true;
      if (flag) close();
    },
  };
}

function compareVersionsDesc(a, b) {
  const left = String(a).split('.');
  const right = String(b).split('.');
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = Number(left[i]);
    const y = Number(right[i]);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const result = String(left[i] ?? '').localeCompare(String(right[i] ?? ''));
      if (result !== 0) return result;
      continue;
    }
    if (x !== y) return y - x;
  }
  return 0;
}

async function loadCatalogOptions() {
  if (!catalogState.minecraft) {
    try {
      const data = await fetchJson('/api/minecraft/versions?type=release&limit=80');
      createDropdowns.mc?.setOptions((data.versions ?? []).map((version) => version.id));
      createDropdowns.mc?.setDefaultFromOptions();
      catalogState.minecraft = true;
    } catch {
      createDropdowns.mc?.markFailed();
    }
  }
  if (!catalogState.fabric) {
    try {
      const data = await fetchJson('/api/fabric/loaders');
      const loaders = (data.loaders ?? []).map((loader) => loader.version);
      loaders.sort(compareVersionsDesc);
      createDropdowns.fabric?.setOptions(loaders);
      createDropdowns.fabric?.setDefaultFromOptions();
      catalogState.fabric = true;
    } catch {
      createDropdowns.fabric?.markFailed();
    }
  }
}

async function runModSearch(query) {
  const results = document.getElementById('modResults');
  const errorBox = document.getElementById('modSearchError');
  const isPopular = query === '';
  errorBox.hidden = true;
  results.hidden = true;
  results.replaceChildren();
  results.appendChild(makeText('p', 'muted', isPopular ? 'Loading popular mods…' : 'Searching…'));

  try {
    const data = await fetchJson(`/api/modrinth/search?q=${encodeURIComponent(query)}&limit=8`);
    results.replaceChildren();
    if (!data.hits || data.hits.length === 0) {
      results.appendChild(
        makeText('p', 'muted', isPopular ? 'No popular mods right now' : `No results for “${query}”`)
      );
      results.hidden = false;
      return;
    }
    for (const hit of data.hits) results.appendChild(modResultRow(hit));
    results.hidden = false;
  } catch (err) {
    results.replaceChildren();
    errorBox.hidden = false;
    errorBox.textContent = err.message;
  }
}

function modIcon(hit) {
  const letter = (hit.title || '?').trim().slice(0, 1).toUpperCase() || '?';
  const fallback = makeText('span', 'mod-icon mod-icon-fallback', letter);
  if (!hit.iconUrl) return fallback;
  const img = document.createElement('img');
  img.className = 'mod-icon';
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.src = hit.iconUrl;
  img.addEventListener('error', () => img.replaceWith(fallback), { once: true });
  return img;
}

function modResultRow(hit, { kind = 'mods' } = {}) {
  const row = document.createElement('div');
  row.className = 'mod-row';
  row.appendChild(modIcon(hit));

  const info = document.createElement('div');
  info.className = 'mod-result-info';
  info.append(
    makeText('span', 'mod-name', hit.title),
    makeText('span', 'mod-size', `${Number(hit.downloads).toLocaleString()} downloads`)
  );
  if (hit.description) info.appendChild(makeText('span', 'mod-desc', hit.description));
  row.appendChild(info);

  const install = makeText('button', 'btn btn-primary btn-small', 'INSTALL');
  install.type = 'button';
  install.addEventListener('click', () => installFromSearch(hit, install, { kind }));
  row.appendChild(install);
  return row;
}

async function installFromSearch(hit, button, { kind = 'mods' } = {}) {
  const instance = instancesState.detail;
  if (!instance) return;
  const isMod = kind === 'mods';
  button.disabled = true;
  button.textContent = '…';

  try {
    const versionsUrl =
      `/api/modrinth/project/${encodeURIComponent(hit.projectId)}/versions` +
      `?game=${encodeURIComponent(instance.minecraftVersion)}` +
      (isMod ? '&loader=fabric' : '');
    const data = await fetchJson(versionsUrl);
    const versions = data.versions ?? [];
    const version =
      versions.find((entry) => entry.versionType === 'release' && entry.files.length > 0) ??
      versions.find((entry) => entry.files.length > 0);
    if (!version) {
      throw new Error(
        isMod
          ? `${hit.title} has no downloadable file for Minecraft ${instance.minecraftVersion} + Fabric`
          : `${hit.title} has no downloadable file for Minecraft ${instance.minecraftVersion}`
      );
    }

    const result = await postJson(`/api/instances/${instance.id}${isMod ? '/mods' : '/packs'}`, {
      versionId: version.id,
      ...(isMod ? {} : { kind }),
    });
    toast(`Installed ${result.files.map((file) => file.filename).join(', ')}`);
    if (isMod) {
      const refreshed = await fetchJson(`/api/instances/${encodeURIComponent(instance.id)}`);
      instancesState.detail = refreshed.instance;
      renderInstanceDetail();
      await loadMods();
      await loadInstances({ silent: true });
    } else {
      await loadPacks();
    }
    button.textContent = 'INSTALLED';
  } catch (err) {
    toast(err.message, { error: true });
    button.disabled = false;
    button.textContent = 'INSTALL';
  }
}

function setupModSearch() {
  document.getElementById('modSearchForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('modSearchInput');
    runModSearch(input.value.trim());
  });
}

async function runPackSearch(query) {
  const results = document.getElementById('packResults');
  const errorBox = document.getElementById('packSearchError');
  const typeInput = document.getElementById('packType');
  const type = typeInput?.value === 'shader' ? 'shader' : 'resourcepack';
  const isPopular = query === '';
  errorBox.hidden = true;
  results.hidden = true;
  results.replaceChildren();
  results.appendChild(makeText('p', 'muted', isPopular ? 'Loading popular…' : 'Searching…'));

  try {
    const data = await fetchJson(
      `/api/modrinth/search?q=${encodeURIComponent(query)}&limit=8&type=${type}`
    );
    results.replaceChildren();
    if (!data.hits || data.hits.length === 0) {
      results.appendChild(
        makeText('p', 'muted', isPopular ? 'No popular entries right now' : `No results for “${query}”`)
      );
      results.hidden = false;
      return;
    }
    const kind = type === 'shader' ? 'shaderpacks' : 'resourcepacks';
    for (const hit of data.hits) results.appendChild(modResultRow(hit, { kind }));
    results.hidden = false;
  } catch (err) {
    results.replaceChildren();
    errorBox.hidden = false;
    errorBox.textContent = err.message;
  }
}

function clearPackSearchResults() {
  const results = document.getElementById('packResults');
  const errorBox = document.getElementById('packSearchError');
  if (results) {
    results.replaceChildren();
    results.hidden = true;
  }
  if (errorBox) {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }
}

function ensureDefaultPackSearch() {
  const results = document.getElementById('packResults');
  const errorBox = document.getElementById('packSearchError');
  if (!results || !errorBox) return;
  if (results.childElementCount === 0 && errorBox.hidden) runPackSearch('');
}

function setupPackSearch() {
  packSearchDropdowns.type = createDropdown({ containerId: 'packTypeDropdown', valueId: 'packType' });
  packSearchDropdowns.type?.setOptions(['resourcepack', 'shader']);

  document.getElementById('packSearchForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('packSearchInput');
    runPackSearch(input.value.trim());
  });
}

function clearModSearchResults() {
  const results = document.getElementById('modResults');
  const errorBox = document.getElementById('modSearchError');
  if (results) {
    results.replaceChildren();
    results.hidden = true;
  }
  if (errorBox) {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }
}

function ensureDefaultModSearch() {
  const results = document.getElementById('modResults');
  const errorBox = document.getElementById('modSearchError');
  if (!results || !errorBox) return;
  if (results.childElementCount === 0 && errorBox.hidden) runModSearch('');
}

function main() {
  cacheElements();
  setupNavigation();
  setupInstanceDetail();
  setupImportModal();
  setupExportModal();
  setupCreateModal();
  setupAuth();
  setupServerConfigForm();
  setupOfflineNameForm();
  setupAuthFlowPicker(); // LIVE FLOW — ลบพร้อม src/auth/live.js
  setupJavaRuntimeCard();
  setupModSearch();
  setupPackSearch();
  setupVersionControls();
  refresh();
  loadSession({ silent: true });
  setInterval(refresh, REFRESH_MS);
  setInterval(pollInstanceStatus, STATUS_POLL_MS);
}

main();
