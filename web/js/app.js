// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

const REFRESH_MS = 15000;
const VALID_VIEWS = new Set(['instances', 'servers', 'instance', 'create', 'settings']);

const state = {
  health: null,
  config: null,
  signedIn: false,
  // 'checking' | 'online' | 'offline' — offline = backend หลุด → disconnect page ทับหน้าจอ
  serverStatus: 'checking',
  pendingDismissed: false,
};

const instancesState = {
  list: [],
  loaded: false,
  detail: null,
  tab: 'overview',
  kindView: 'list',
  mods: [],
  packs: { resourcepacks: [], shaderpacks: [] },
  checks: { mods: [], resourcepacks: [], shaderpacks: [] },
  removed: [],
  checking: false,
  // MC version ที่ผล checks ปัจจุบันคำนวณมาเพื่อ (≠ minecraftVersion ของ instance = ยังไม่บันทึก)
  updatesTarget: null,
  autoCheckAt: {},
};
const serversState = { list: [], loaded: false };
const importState = { token: null, manifest: null, mode: 'instance' };
const createState = { mode: 'instance' };
let versionPickerState = null;

const el = {};

function cacheElements() {
  const ids = [
    'versionPill',
    'factEndpoint',
    'factUptime',
    'factNode',
    'factPlatform',
    'toastHost',
    'accountPill',
    'skinOpenBtn',
    'disconnectPage',
    'disconnectRetryBtn',
    'pendingBanner',
    'pendingBannerClose',
  ];
  for (const id of ids) el[id] = document.getElementById(id);
}

async function fetchJson(path) {
  const response = await apiFetch(path, {
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
  if (state.serverStatus === mode) return;
  const previous = state.serverStatus;
  state.serverStatus = mode;
  if (mode === 'offline') {
    showDisconnectPage();
  } else if (mode === 'online' && previous === 'offline') {
    hideDisconnectPage();
  }
}

function showDisconnectPage() {
  if (el.disconnectPage) el.disconnectPage.hidden = false;
}

function hideDisconnectPage() {
  if (el.disconnectPage) el.disconnectPage.hidden = true;
}

// fetch ของ API ตัวเอง — response กลับมา = backend ยังอยู่, network error = หลุด
async function apiFetch(pathname, options = {}) {
  let response;
  try {
    response = await fetch(pathname, options);
  } catch (err) {
    if (err?.name !== 'AbortError') setServerStatus('offline');
    throw err;
  }
  setServerStatus('online');
  return response;
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
    javaRuntime: selectedJavaLabel() ?? '—',
  };

  for (const [key, value] of Object.entries(values)) {
    const cell = document.querySelector(`[data-config="${key}"]`);
    if (cell) cell.textContent = String(value);
  }

  fillIfIdle(document.getElementById('cfgHost'), config.server.host);
  fillIfIdle(document.getElementById('cfgPort'), config.server.port);
  fillIfIdle(document.getElementById('cfgOfflineName'), config.auth?.offlineName ?? '');
  if (fillIfIdle(document.getElementById('cfgLogLevel'), config.log.level)) {
    settingsDropdowns.logLevel?.reset();
  }
  if (fillIfIdle(document.getElementById('cfgWindow'), config.window?.platform ?? 'auto')) {
    settingsDropdowns.windowPlatform?.reset();
  }

  // banner หลังเปลี่ยน data dir — ขึ้นจนกว่า backend จะ restart (pendingDataDir ≠ dataDir จริง)
  const pendingDataDir = config.pendingDataDir ?? null;
  if (el.pendingBanner) el.pendingBanner.hidden = pendingDataDir === null || state.pendingDismissed;
}

function makeText(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function formatBytes(value) {
  if (typeof value !== 'number' || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
    await loadServers({ silent: true });
    // โหลดรายการ java runtime ตั้งแต่เปิดแอป จะได้แสดง label "Java 25 (java-runtime-…)" ได้ทันที
    // (loadJavaRuntimes มี loaded flag → refresh รอบถัดไปจะไม่ยิงซ้ำ)
    await loadJavaRuntimes();
  } catch (err) {
    // network error = backend หลุด (apiFetch ตั้ง offline ไว้แล้ว) — disconnect page แทน toast
    if (err.status === undefined && err?.name !== 'AbortError') setServerStatus('offline');
    if (state.serverStatus !== 'offline' && err.status !== 404) toast(err.message, { error: true });
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

  if (view === 'instances' && instancesState.loaded) {
    loadInstances({ silent: true });
  }
  if (view === 'servers' && serversState.loaded) {
    loadServers({ silent: true });
  }
  if (view === 'create') {
    loadCatalogOptions();
  }
  if (view === 'settings') {
    loadJavaRuntimes();
  }
  renderQuickInstances();
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
  const response = await apiFetch(pathname, {
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
  const response = await apiFetch(pathname, {
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
  const response = await apiFetch(pathname, { method: 'DELETE', headers: { accept: 'application/json' } });
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
  renderQuickInstances();
}

// รายการ instance ลัดบน sidebar (Modrinth-style quick switcher)
function renderQuickInstances() {
  const wrap = document.getElementById('sideQuick');
  const host = document.getElementById('sideQuickList');
  if (!wrap || !host) return;
  const instances = instancesState.list;
  wrap.hidden = instances.length === 0;
  host.replaceChildren();
  const activeId = location.hash.startsWith('#instance/')
    ? decodeURIComponent(location.hash.slice('#instance/'.length))
    : null;

  for (const instance of instances) {
    const item = makeText('button', 'side-quick-item', '');
    item.type = 'button';
    if (instance.id === activeId) item.classList.add('is-active');
    const icon = instanceIconNode(instance, 'side-quick-icon');
    const text = document.createElement('span');
    text.className = 'side-quick-text';
    text.append(
      makeText('span', 'side-quick-name', instance.name),
      makeText('span', 'side-quick-meta', `MC ${instance.minecraftVersion}`),
    );
    item.append(icon, text);
    if (instance.running) item.appendChild(makeText('span', 'side-quick-run', ''));
    item.addEventListener('click', () => {
      location.hash = `#instance/${encodeURIComponent(instance.id)}`;
    });
    host.appendChild(item);
  }
}

// ---------- instance icon (มีรูป = icon: true → /api/instances/:id/icon, ไม่มี = tile ตัวอักษร) ----------

function instanceIconNode(item, className) {
  if (item?.icon) {
    const img = document.createElement('img');
    img.className = className;
    img.alt = '';
    img.loading = 'lazy';
    img.src = `/api/instances/${encodeURIComponent(item.id)}/icon`;
    img.addEventListener(
      'error',
      () => {
        img.replaceWith(instanceIconNode({ ...item, icon: false }, className));
      },
      { once: true }
    );
    return img;
  }
  const initial = (item?.name ?? '').trim().charAt(0).toUpperCase() || '?';
  const fallback = makeText('span', `${className} instance-icon-fallback`, initial);
  fallback.setAttribute('aria-hidden', 'true');
  return fallback;
}

// คลิกที่ไอคอนบนหน้า detail → เลือกรูปจากเครื่อง (Prism-style custom icon)
function promptInstanceIcon(instance, { signal } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp';
  input.addEventListener(
    'change',
    () => {
      const file = input.files?.[0];
      if (file) void uploadInstanceIcon(instance, file, { signal });
    },
    { once: true }
  );
  input.click();
}

const ICON_MAX_BYTES = 2 * 1024 * 1024;

async function uploadInstanceIcon(instance, file, { signal } = {}) {
  if (file.size > ICON_MAX_BYTES) {
    toast('Icon is too large — 2 MB max', { error: true });
    return;
  }
  try {
    const response = await apiFetch(`/api/instances/${encodeURIComponent(instance.id)}/icon`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
      signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error?.message || `Icon upload responded ${response.status}`);
    }
    toast('Icon updated');
    await loadInstances({ silent: true });
    if (instance.type === 'server') await loadServers({ silent: true });
    if (instancesState.detail?.id === instance.id) await loadInstanceDetail(instance.id);
  } catch (err) {
    if (err?.name !== 'AbortError' && state.serverStatus !== 'offline') toast(err.message, { error: true });
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
  const title = makeText('div', 'instance-card-title', '');
  title.append(instanceIconNode(instance, 'instance-icon'), nameBtn);
  head.appendChild(title);
  if (instance.running) head.appendChild(makeText('span', 'pill pill-running', 'RUNNING'));
  card.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'instance-meta';
  const played = (instance.playSeconds ?? 0) + (instance.sessionSeconds ?? 0);
  meta.append(
    makeText('span', '', `Minecraft ${instance.minecraftVersion}`),
    makeText('span', '', `${instance.fabricLoaderVersion}`),
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

// ---------- Servers ----------

async function loadServers({ silent = false } = {}) {
  try {
    const data = await fetchJson('/api/servers');
    serversState.list = data.servers ?? [];
    serversState.loaded = true;
    renderServers();
  } catch (err) {
    if (!silent) toast(err.message, { error: true });
  }
}

function renderServers() {
  const grid = document.getElementById('serversGrid');
  const empty = document.getElementById('serversEmpty');
  if (!grid || !empty) return;

  grid.replaceChildren();
  const servers = serversState.list;
  grid.hidden = servers.length === 0;
  empty.hidden = servers.length > 0;

  for (const server of servers) {
    grid.appendChild(serverCard(server));
  }
}

function serverCard(server) {
  const card = document.createElement('article');
  card.className = 'instance-card card';
  card.dataset.id = server.id;

  const head = document.createElement('div');
  head.className = 'instance-card-head';

  const nameBtn = makeText('button', 'instance-name', server.name);
  nameBtn.type = 'button';
  nameBtn.addEventListener('click', () => {
    location.hash = `#instance/${encodeURIComponent(server.id)}`;
  });
  const title = makeText('div', 'instance-card-title', '');
  title.append(instanceIconNode(server, 'instance-icon'), nameBtn);
  head.appendChild(title);
  if (server.running) head.appendChild(makeText('span', 'pill pill-running', 'RUNNING'));
  card.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'instance-meta';
  meta.append(
    makeText('span', '', `Minecraft ${server.minecraftVersion}`),
    makeText('span', '', `${server.fabricLoaderVersion}`),
    makeText('span', '', `Port ${server.port ?? 25565}`),
    makeText('span', '', `${server.mods ?? 0} Mods`)
  );
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'instance-actions';

  const toggle = makeText('button', server.running ? 'btn' : 'btn btn-primary', server.running ? 'STOP' : 'START');
  toggle.type = 'button';
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      if (server.running) {
        await postJson(`/api/servers/${encodeURIComponent(server.id)}/stop`);
        toast(`${server.name} stopped`);
      } else {
        await postJson(`/api/servers/${encodeURIComponent(server.id)}/start`);
        toast(`${server.name} is starting`);
      }
      await loadServers({ silent: true });
    } catch (err) {
      toast(err.message, { error: true });
      if (err.code === 'EULA_NOT_ACCEPTED') location.hash = `#instance/${encodeURIComponent(server.id)}`;
      await loadServers({ silent: true }).catch(() => {});
    } finally {
      toggle.disabled = false;
    }
  });

  const exp = makeText('button', 'btn', 'EXPORT');
  exp.type = 'button';
  exp.addEventListener('click', () => exportInstance(server));

  const del = makeText('button', 'btn btn-danger', 'DELETE');
  del.type = 'button';
  del.addEventListener('click', () => deleteInstance(server, 'server'));

  actions.append(toggle, exp, del);
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
    subtitle.textContent = `${instance.name} · Minecraft ${instance.minecraftVersion} · ${instance.fabricLoaderVersion ?? '—'}`;
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

// confirm dialog ในแอป — แทน window.confirm (ไม่ใช้ dialog ของ browser)
function confirmDialog({ title = 'Confirm', message = '', confirmLabel = 'CONFIRM', danger = true }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    const okBtn = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    okBtn.textContent = confirmLabel;
    okBtn.classList.toggle('btn-danger', danger);
    okBtn.classList.toggle('btn-primary', !danger);
    const onKey = (event) => {
      if (event.key === 'Escape') done(false);
    };
    function done(value) {
      modal.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      cancelBtn.onclick = null;
      okBtn.onclick = null;
      modal.onclick = null;
      resolve(value);
    }
    cancelBtn.onclick = () => done(false);
    okBtn.onclick = () => done(true);
    modal.onclick = (event) => {
      if (event.target === modal) done(false);
    };
    document.addEventListener('keydown', onKey, true);
    modal.hidden = false;
    cancelBtn.focus();
  });
}

async function deleteInstance(instance, mode = 'instance') {
  const what = mode === 'server' ? 'server' : 'instance';
  const confirmed = await confirmDialog({
    title: `Delete ${what}`,
    message: `Delete "${instance.name}"? This removes its instance.json, minecraft/ directory, mods, config and ${what === 'server' ? 'world' : 'saves'} permanently.`,
    confirmLabel: 'DELETE',
  });
  if (!confirmed) return;
  try {
    await deleteJson(`/api/instances/${instance.id}`);
    toast(`${instance.name} deleted`);
    if (location.hash.startsWith('#instance/')) {
      location.hash = mode === 'server' ? '#servers' : '#instances';
    }
    await loadInstances({ silent: true });
    await loadServers({ silent: true });
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
    instancesState.checks = { mods: [], resourcepacks: [], shaderpacks: [] };
    instancesState.removed = [];
    instancesState.autoCheckAt = {};
    renderRemoved();
    for (const panel of Object.keys(PROGRESS_PANELS)) {
      const cfg = PROGRESS_PANELS[panel];
      const status = document.getElementById(cfg.status);
      if (status) {
        status.hidden = true;
        status.textContent = '';
      }
      const updateAll = document.getElementById(cfg.updateAll);
      if (updateAll) updateAll.hidden = true;
      setProgress(panel, false);
    }
    for (const searchPanel of Object.keys(SEARCH_PANELS)) clearSearchResults(searchPanel);
    resetUpdatesPanel();
    const consoleBox = document.getElementById('srvConsole');
    if (consoleBox) consoleBox.textContent = '';
    // ยังไม่รู้ว่าเป็น client หรือ server → ปิดแท็บไว้ก่อน เลือกใหม่หลังโหลดเสร็จ
    setInstanceTab(null);
  }
  document.getElementById('instanceTitle').textContent = id;
  document.getElementById('instanceSubtitle').textContent = 'Loading…';
  const settingsError = document.getElementById('instanceSettingsError');
  if (settingsError) settingsError.hidden = true;

  try {
    const data = await fetchJson(`/api/instances/${encodeURIComponent(id)}`);
    instancesState.detail = data.instance;
    renderInstanceDetail();
    // แท็บที่เปิดอยู่ใช้กับชนิดนี้ไม่ได้ → ไปแท็บแรกของชนิดนี้
    const validTabs = data.instance.type === 'server'
      ? ['start', 'mods', 'updates', 'settings']
      : ['overview', 'mods', 'resourcepacks', 'shaders', 'updates', 'settings'];
    if (!validTabs.includes(instancesState.tab)) setInstanceTab(validTabs[0]);
    else setInstanceTab(instancesState.tab, instancesState.kindView);
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
  const isServer = instance.type === 'server';

  document.getElementById('instanceTitle').textContent = instance.name;
  document.getElementById('instanceSubtitle').textContent =
    `Minecraft ${instance.minecraftVersion} · ${instance.fabricLoaderVersion} · ${instance.mods ?? 0} Mods`;

  // ไอคอนหัวหน้า detail — รูป (มี cache-bust เผื่ออัปโหลดรูปใหม่) หรือ tile ตัวอักษร
  const detailIcon = document.getElementById('iIcon');
  const detailFallback = document.getElementById('iIconFallback');
  const detailIconDel = document.getElementById('iIconDeleteBtn');
  if (detailIconDel) detailIconDel.hidden = !instance.icon;
  if (detailIcon && detailFallback) {
    if (instance.icon) {
      detailIcon.src = `/api/instances/${encodeURIComponent(instance.id)}/icon?t=${Date.now()}`;
      detailIcon.hidden = false;
      detailFallback.hidden = true;
    } else {
      detailIcon.hidden = true;
      detailIcon.removeAttribute('src');
      detailFallback.textContent = (instance.name ?? '').trim().charAt(0).toUpperCase() || '?';
      detailFallback.hidden = false;
    }
  }

  const backLabel = document.getElementById('instanceBackLabel');
  if (backLabel) backLabel.textContent = isServer ? 'Servers' : 'Instances';

  // client มี OVERVIEW/PLAY/RESOURCES/SHADERS — server มีแท็บ START แทน (หน้าอื่นเอาออก)
  document.getElementById('iOverviewBtn').hidden = isServer;
  document.getElementById('iPlayBtn').hidden = isServer;
  const startTabBtn = document.getElementById('iStartBtn');
  if (startTabBtn) startTabBtn.hidden = !isServer;
  document.getElementById('iResourcesBtn').hidden = isServer;
  document.getElementById('iShadersBtn').hidden = isServer;

  const facts = document.getElementById('instanceFacts');
  facts.replaceChildren();
  const rows = [
    ['Instance id', instance.id],
    ['Minecraft', instance.minecraftVersion],
    ['Loader', instance.fabricLoaderVersion],
    ['Mods', String(instance.mods ?? 0)],
    ['Java', selectedJavaLabel() ?? '—'],
    ['Play time', formatPlaySeconds((instance.playSeconds ?? 0) + (instance.sessionSeconds ?? 0))],
    ['Last played', formatLastPlayed(instance.lastPlayedAt)],
    ['Memory', instance.memory ? `${instance.memory.min} – ${instance.memory.max}` : '—'],
    ['Extra JVM args', instance.extraJvmArgs?.length ? instance.extraJvmArgs.join(' ') : '—'],
    ['Status', instance.running ? `running (pid ${instance.pid})` : 'stopped'],
  ];
  if (isServer) rows.push(['Port', String(instance.port ?? 25565)]);
  for (const [label, value] of rows) {
    const item = document.createElement('div');
    item.append(makeText('dt', '', label), makeText('dd', '', value));
    facts.appendChild(item);
  }
  if (isServer) {
    renderServerPanel({
      running: instance.running,
      pid: instance.pid,
      sessionSeconds: instance.sessionSeconds ?? 0,
      installed: instance.installed,
      eulaAccepted: instance.eulaAccepted,
      port: instance.port,
      busy: false,
      phase: instance.running ? 'starting' : 'idle',
    });
  }

  const play = document.getElementById('iPlayBtn');
  play.textContent = instance.running ? 'STOP' : 'PLAY';

  fillIfIdle(document.getElementById('isName'), instance.name);
  fillIfIdle(document.getElementById('isMemMin'), instance.memory?.min ?? '');
  fillIfIdle(document.getElementById('isMemMax'), instance.memory?.max ?? '');
  fillIfIdle(document.getElementById('isJvmArgs'), formatArgString(instance.extraJvmArgs));
  const portField = document.getElementById('isPortField');
  if (portField) portField.hidden = !isServer;
  fillIfIdle(document.getElementById('isPort'), String(instance.port ?? 25565));
  const readOnly = {
    isId: instance.id,
    isLoader: instance.fabricLoaderVersion,
    isJava: selectedJavaLabel() ?? '—',
  };
  for (const [id, value] of Object.entries(readOnly)) {
    const cell = document.getElementById(id);
    if (cell) cell.textContent = String(value);
  }
  const revertBtn = document.getElementById('updRevertBtn');
  if (revertBtn) {
    const prevVersion = instance.previousMinecraftVersion;
    // โชว์ REVERT เฉพาะเวอร์ชั่นก่อนหน้าที่เก่ากว่า current เท่านั้น — เก่า/ใหม่ผิดที่ไม่ย้อนให้
    const canRevert = Boolean(
      prevVersion
      && prevVersion !== instance.minecraftVersion
      && compareVersionsDesc(prevVersion, instance.minecraftVersion) > 0,
    );
    revertBtn.hidden = !canRevert;
    revertBtn.textContent = canRevert ? `REVERT TO ${prevVersion}` : '';
  }
  fetchMcVersionIds()
    .catch(() => [])
    .then((ids) => {
      if (instancesState.detail?.id !== instance.id) return;

      // dropdown เวอร์ชั่นเป้าหมายของแท็บ UPDATES — โชว์เฉพาะใหม่กว่า + ปัจจุบัน ห้ามมีเก่ากว่า
      if (ids.length > 0) {
        const current = instance.minecraftVersion;
        const idx = ids.indexOf(current);
        const options = [];
        if (idx === -1) {
          // current ไม่อยู่ใน catalog (snapshot/กำหนดเอง) → เทียบเลขเอง เก็บเฉพาะใหม่กว่า
          options.push({ value: current, label: `${current} (current)`, group: 'Current' });
          for (const id of ids) {
            // comparator นี้คืน >0 เมื่อ a เก่ากว่า (เรียง newest-first) → ใหม่กว่า current ต้องใช้ < 0
            if (compareVersionsDesc(id, current) < 0) options.push({ value: id, label: `${id} (newer)`, group: 'Newer' });
          }
        } else {
          for (const id of ids.slice(0, idx)) options.push({ value: id, label: `${id} (newer)`, group: 'Newer' });
          options.push({ value: current, label: `${current} (current)`, group: 'Current' });
        }
        // เวอร์ชั่นก่อนหน้าที่เคยใช้อยู่ — อนุญาตเฉพาะตัวนี้ตัวเดียวเพื่อให้ย้อนกลับได้ (ไม่ใช่การเปิดลิสต์เก่าทั้งหมด)
        // เฉพาะตอนที่เก่ากว่า current (compareVersionsDesc > 0) — ถ้าใหม่กว่ามันซ้ำกับกลุ่ม Newer อยู่แล้ว
        const prev = instance.previousMinecraftVersion;
        if (prev && prev !== current && compareVersionsDesc(prev, current) > 0) {
          options.push({ value: prev, label: `${prev} (previous)`, group: 'Previous' });
        }
        updatesVersionDropdown?.setOptions(options);
        const updInput = document.getElementById('updVersion');
        if (updInput?.dataset.dirty !== '1') updatesVersionDropdown?.fillIfIdle(current);
      }
    });
}

// ---------- Server console (แท็บ START) ----------

const SERVER_CONSOLE_MAX_LINES = 1000;
const SRV_PHASE_LABELS = { idle: 'Stopped', installing: 'Installing…', starting: 'Starting…', running: 'Running' };
let serverPoll = null;

function appendServerConsole(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  const box = document.getElementById('srvConsole');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  const existing = box.textContent === '' ? [] : box.textContent.split('\n');
  for (const line of lines) existing.push(line.text ?? String(line));
  if (existing.length > SERVER_CONSOLE_MAX_LINES) existing.splice(0, existing.length - SERVER_CONSOLE_MAX_LINES);
  box.textContent = existing.join('\n');
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function renderServerPanel(status) {
  const pill = document.getElementById('srvStatePill');
  const facts = document.getElementById('srvFacts');
  if (!pill || !facts) return;
  const busy = status.busy === true;
  const phase = status.phase ?? 'idle';
  pill.textContent = SRV_PHASE_LABELS[phase] ?? 'Stopped';
  pill.className = status.running === true ? 'pill pill-running' : 'pill pill-muted';

  const rows = [
    ['Status', status.running === true ? `running (pid ${status.pid})` : busy ? 'working…' : 'stopped'],
    ['Uptime', status.running === true ? formatUptime(status.sessionSeconds ?? 0) : '—'],
    ['Port', String(status.port ?? 25565)],
    ['EULA', status.eulaAccepted === true ? 'Accepted' : 'Not accepted'],
    ['Server files', status.installed === true ? 'Installed' : 'Installs on first START'],
  ];
  facts.replaceChildren();
  for (const [label, value] of rows) {
    const item = document.createElement('div');
    item.append(makeText('dt', '', label), makeText('dd', '', value));
    facts.appendChild(item);
  }

  const banner = document.getElementById('srvEulaBanner');
  if (banner) banner.hidden = status.eulaAccepted === true;
  const startBtn = document.getElementById('srvStartBtn');
  const stopBtn = document.getElementById('srvStopBtn');
  if (startBtn) {
    startBtn.hidden = status.running === true;
    startBtn.disabled = busy === true;
  }
  if (stopBtn) stopBtn.hidden = status.running !== true;
  const statusText = document.getElementById('srvStatus');
  if (statusText) {
    statusText.hidden = busy !== true;
    statusText.textContent = phase === 'installing' ? 'Installing server files…' : 'Working…';
  }
}

function stopServerPoll() {
  if (serverPoll?.timer) clearTimeout(serverPoll.timer);
  serverPoll = null;
}

// poll console + status ทุกวินาทีขณะเปิดแท็บ START — เลิกเมื่อออกจากแท็บ/เปลี่ยน instance/ปิดหน้า
function startServerPoll() {
  const detail = instancesState.detail;
  const id = detail?.type === 'server' ? detail.id : null;
  if (!id) return;
  if (serverPoll && serverPoll.id === id) return;
  stopServerPoll();
  const poll = { id, timer: null, since: 0 };
  serverPoll = poll;
  const tick = async () => {
    if (serverPoll !== poll) return;
    if (
      instancesState.detail?.id !== id
      || instancesState.tab !== 'start'
      || location.hash !== `#instance/${encodeURIComponent(id)}`
    ) {
      stopServerPoll();
      return;
    }
    try {
      const consoleData = await fetchJson(`/api/servers/${encodeURIComponent(id)}/console?since=${poll.since}`);
      if (serverPoll !== poll) return;
      poll.since = consoleData.nextSince ?? poll.since;
      appendServerConsole(consoleData.lines);
      const status = await fetchJson(`/api/servers/${encodeURIComponent(id)}/status`);
      if (serverPoll !== poll) return;
      renderServerPanel(status);
    } catch {
      /* เงียบ — รอบถัดไป convergence เอง */
    }
    if (serverPoll === poll) poll.timer = setTimeout(tick, 1000);
  };
  tick();
}

function setInstanceTab(tab, kindView = 'list') {
  instancesState.tab = tab;
  instancesState.kindView = kindView;
  const show = (panelId, active) => {
    const panel = document.getElementById(panelId);
    if (panel) panel.hidden = !active;
  };
  // แท็บ content = { แท็บ: suffix ของ panel } — แต่ละแท็บมี 2 หน้า: list (INSTALLED) + get (GET)
  const kindSuffixes = { mods: 'Mods', resourcepacks: 'Rp', shaders: 'Sp' };
  show('instancePanelOverview', tab === 'overview');
  show('instancePanelStart', tab === 'start');
  show('instancePanelSettings', tab === 'settings');
  show('instancePanelUpdates', tab === 'updates');
  for (const [kindTab, suffix] of Object.entries(kindSuffixes)) {
    const active = tab === kindTab;
    show(`instancePanel${suffix}`, active && kindView === 'list');
    show(`instancePanel${suffix}Get`, active && kindView === 'get');
  }
  document.getElementById('iOverviewBtn')?.classList.toggle('is-active', tab === 'overview');
  document.getElementById('iStartBtn')?.classList.toggle('is-active', tab === 'start');
  document.getElementById('iModsBtn')?.classList.toggle('is-active', tab === 'mods');
  document.getElementById('iResourcesBtn')?.classList.toggle('is-active', tab === 'resourcepacks');
  document.getElementById('iShadersBtn')?.classList.toggle('is-active', tab === 'shaders');
  document.getElementById('iUpdatesBtn')?.classList.toggle('is-active', tab === 'updates');
  document.getElementById('iSettingsBtn')?.classList.toggle('is-active', tab === 'settings');
  const subNav = document.getElementById('kindSubNav');
  if (subNav) subNav.hidden = !Object.hasOwn(kindSuffixes, tab);
  for (const seg of document.querySelectorAll('#kindSubNav .seg')) {
    seg.classList.toggle('is-active', (seg.dataset.kindView ?? 'list') === kindView);
  }
  // console ของ server poll ขณะเปิดแท็บ START — ออกจากแท็บ/เปลี่ยน instance ต้องหยุดด้วย
  if (tab === 'start' && instancesState.detail?.type === 'server') startServerPoll();
  else stopServerPoll();
}

// ---------- Update checks (Modrinth hash + latest version) ----------

const PROGRESS_PANELS = {
  mods: {
    wrap: 'modCheckProgress',
    fill: 'modCheckProgressFill',
    label: 'modCheckProgressLabel',
    status: 'modCheckStatus',
    check: 'modCheckBtn',
    updateAll: 'modUpdateAllBtn',
  },
  rp: {
    wrap: 'rpCheckProgress',
    fill: 'rpCheckProgressFill',
    label: 'rpCheckProgressLabel',
    status: 'rpCheckStatus',
    check: 'rpCheckBtn',
    updateAll: 'rpUpdateAllBtn',
  },
  sp: {
    wrap: 'spCheckProgress',
    fill: 'spCheckProgressFill',
    label: 'spCheckProgressLabel',
    status: 'spCheckStatus',
    check: 'spCheckBtn',
    updateAll: 'spUpdateAllBtn',
  },
  updates: {
    wrap: 'updCheckProgress',
    fill: 'updCheckProgressFill',
    label: 'updCheckProgressLabel',
    status: 'updCheckStatus',
    check: 'updCheckBtn',
    updateAll: 'updConfirmBtn',
  },
};

const AUTO_CHECK_MIN_AGE_MS = 15000;

// แท็บในหน้า instance ↔ ชนิดไฟล์ (kind ของ API) ↔ panel ที่ใช้แสดงผล/progress
const TAB_KIND = { mods: 'mods', resourcepacks: 'resourcepacks', shaders: 'shaderpacks' };
const KIND_PANEL = { mods: 'mods', resourcepacks: 'rp', shaderpacks: 'sp' };
const PANEL_KIND = { mods: 'mods', rp: 'resourcepacks', sp: 'shaderpacks' };

function panelForKind(kind) {
  return KIND_PANEL[kind] ?? 'mods';
}

function kindForPanel(panelId) {
  return PANEL_KIND[panelId] ?? 'mods';
}

function checkKindsForPanel(panelId) {
  return [kindForPanel(panelId)];
}

function panelForKinds(kinds) {
  if (kinds.includes('mods')) return 'mods';
  return kinds.includes('resourcepacks') ? 'rp' : 'sp';
}

// ฟังก์ชัน render ที่ตรงกับ kind สำหรับส่งเป็น callback หลัง check เสร็จ
function renderForKind(kind) {
  return kind === 'mods' ? renderMods : () => renderPackList(kind);
}

function checkResultFor(filename, kind) {
  return instancesState.checks[kind]?.find((entry) => entry.filename === filename) ?? null;
}

function updatesFor(kinds) {
  return kinds.flatMap((kind) =>
    (instancesState.checks[kind] ?? []).filter((entry) => entry.updateAvailable)
  );
}

function refreshUpdateAllButtons() {
  for (const panelId of Object.keys(PROGRESS_PANELS)) {
    if (panelId === 'updates') continue; // ปุ่มของแท็บ UPDATES จัดการโดย renderUpdatesPanel เอง
    const cfg = PROGRESS_PANELS[panelId];
    const button = document.getElementById(cfg.updateAll);
    if (!button) continue;
    const count = updatesFor(checkKindsForPanel(panelId)).length;
    button.hidden = count === 0;
    button.textContent = count > 0 ? `UPDATE ALL (${count})` : 'UPDATE ALL';
  }
}

// ป้ายในแถว: UPDATE (มีเวอร์ชีใหม่) / UNVERIFIED (ไฟล์นี้ Modrinth ไม่รู้จัก — ยังไม่ได้ verify)
function appendCheckOutcome(row, check, kind) {
  if (check?.updateAvailable && check.latest) {
    const update = makeText('button', 'btn btn-small', 'UPDATE');
    update.type = 'button';
    update.title = `Install ${check.latest.versionNumber ?? 'the latest version'} via Modrinth`;
    update.addEventListener('click', () => updateInstalledFile(check, kind, update));
    row.appendChild(update);
    return;
  }
  if (check?.status === 'unmatched') {
    const flag = makeText('span', 'mod-flag', 'UNVERIFIED');
    flag.title = "SHA-1 hash not found in Modrinth's catalog — installed manually or not on Modrinth";
    row.appendChild(flag);
    return;
  }
  if (check?.status === 'incompatible') {
    const flag = makeText('span', 'upd-status s-bad', 'NOT COMPATIBLE');
    flag.title = 'No release on Modrinth supports this instance\u2019s Minecraft version';
    row.appendChild(flag);
  }
}

// แปลง progress จาก server (phase/current/total) เป็นเปอร์เซ็นต์หลอด
function progressPercent(phase, current, total) {
  const ratio = total > 0 ? Math.min(Math.max(current / total, 0), 1) : 0;
  switch (phase) {
    case 'start':
      return 1;
    case 'scan':
      return 5;
    case 'hash':
      return 10 + 40 * ratio;
    case 'lookup':
      return 50 + 20 * ratio;
    case 'compare':
      return 70 + 29 * ratio;
    case 'done':
    case 'error':
      return 100;
    default:
      return 0;
  }
}

const progressHideTimers = {};

function setProgress(panelId, visible, percent = null, message = '') {
  const cfg = PROGRESS_PANELS[panelId];
  const wrap = document.getElementById(cfg.wrap);
  if (!wrap) return;
  if (visible && progressHideTimers[panelId]) {
    // ยกเลิกการซ่อนที่รออยู่ — งานใหม่กำลังแสดงผล (กัน timer เก่าปิดหลอดของ run ใหม่)
    clearTimeout(progressHideTimers[panelId]);
    delete progressHideTimers[panelId];
  }
  wrap.hidden = !visible;
  if (!visible) return;
  const fill = document.getElementById(cfg.fill);
  const label = document.getElementById(cfg.label);
  if (fill && percent !== null) fill.style.width = `${percent}%`;
  if (label) label.textContent = message;
}

function scheduleProgressHide(panelId, delayMs = 600) {
  if (progressHideTimers[panelId]) clearTimeout(progressHideTimers[panelId]);
  progressHideTimers[panelId] = setTimeout(() => {
    delete progressHideTimers[panelId];
    setProgress(panelId, false);
  }, delayMs);
}

function startProgressPoll(instanceId, panelId) {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const data = await fetchJson(`/api/instances/${encodeURIComponent(instanceId)}/check-progress`);
      if (stopped || !data || (data.running === false && data.phase === 'idle')) return;
      setProgress(panelId, true, progressPercent(data.phase, data.current, data.total), data.message ?? '');
    } catch {
      // poll แบบ best-effort — ถ้าพลาดรอบเดียวไม่เป็นไร
    }
  }, 200);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function maybeAutoCheck(kinds) {
  const panelId = panelForKinds(kinds);
  const now = Date.now();
  if (now - (instancesState.autoCheckAt[panelId] ?? 0) < AUTO_CHECK_MIN_AGE_MS) return;
  runInstanceCheck(kinds, { render: renderForKind(kinds[kinds.length - 1]) });
}

async function runInstanceCheck(kinds, { render }) {
  const instance = instancesState.detail;
  if (!instance || instancesState.checking) return;
  const panelId = panelForKinds(kinds);
  const cfg = PROGRESS_PANELS[panelId];
  instancesState.checking = true;
  instancesState.autoCheckAt[panelId] = Date.now();

  const button = document.getElementById(cfg.check);
  const status = document.getElementById(cfg.status);
  if (button) button.disabled = true;
  if (status) {
    status.hidden = false;
    status.textContent = 'Checking…';
  }
  setProgress(panelId, true, 1, 'Starting…');
  const stopPoll = startProgressPoll(instance.id, panelId);

  try {
    // เช็คหลาย kind พร้อมกัน (ทั้ง mods/resourcepacks/shaders) — server มี slot progress ต่อ kind อยู่แล้ว
    let updateCount = 0;
    let adoptedCount = 0;
    let unmatchedCount = 0;
    await mapConcurrent(kinds, kinds.length, async (kind) => {
      const result = await postJson(`/api/instances/${encodeURIComponent(instance.id)}/check`, { kind });
      instancesState.checks[kind] = result.files ?? [];
      updateCount += result.updateCount ?? 0;
      adoptedCount += result.adopted?.length ?? 0;
      unmatchedCount += result.unmatched ?? 0;
    });
    if (status) {
      const parts = [
        updateCount === 0 ? 'No updates' : `${updateCount} update${updateCount === 1 ? '' : 's'} available`,
      ];
      if (adoptedCount > 0) parts.push(`${adoptedCount} file${adoptedCount === 1 ? '' : 's'} matched on Modrinth`);
      if (unmatchedCount > 0) parts.push(`${unmatchedCount} unverified`);
      status.textContent = parts.join(' · ');
    }
    setProgress(panelId, true, 100, 'Done');
    toast(updateCount === 0 ? 'Everything is up to date' : `${updateCount} update${updateCount === 1 ? '' : 's'} available`);
    render();
    refreshUpdateAllButtons();
  } catch (err) {
    if (status) {
      status.hidden = false;
      status.textContent = err.message;
    }
    toast(err.message, { error: true });
  } finally {
    stopPoll();
    instancesState.checking = false;
    if (button) button.disabled = false;
    scheduleProgressHide(panelId, 600);
  }
}

// ติดตั้งเวอร์ชีใหม่ทับ → ลบไฟล์ชื่อเก่าถ้าเวอร์ชีใหม่ใช้ชื่อไฟล์ต่างออกไป (ไม่ reload — ผู้เรียกจัดการเอง)
async function applyUpdate(check, kind) {
  const instance = instancesState.detail;
  if (!instance || !check?.latest?.versionId) return null;
  const isMod = kind === 'mods';
  const base = `/api/instances/${encodeURIComponent(instance.id)}`;
  const result = await postJson(`${base}${isMod ? '/mods' : '/packs'}`, {
    versionId: check.latest.versionId,
    force: true,
    ...(isMod ? {} : { kind }),
  });
  const newNames = new Set((result.files ?? []).map((file) => file.filename));
  if (!newNames.has(check.filename)) {
    await deleteJson(
      `${base}${isMod ? '/mods' : '/packs'}/${encodeURIComponent(check.filename)}${isMod ? '' : `?kind=${kind}`}`
    );
  }
  return result;
}

async function updateInstalledFile(check, kind, button) {
  if (!instancesState.detail || !check?.latest?.versionId) return;
  const isMod = kind === 'mods';
  const panelId = panelForKind(kind);
  button.disabled = true;
  button.textContent = '…';
  try {
    await applyUpdate(check, kind);
    toast(`Updated ${check.filename} → ${check.latest.versionNumber}`);
    if (isMod) {
      await loadMods();
    } else {
      await loadPackList(kind);
    }
    await loadInstances({ silent: true });
    // เช็คซ้ำทันทีเพื่อล้างป้าย UPDATE ของไฟล์ที่เพิ่งอัปเดต (ข้าม throttle ของ auto-check)
    instancesState.autoCheckAt[panelId] = 0;
    await runInstanceCheck([kind], { render: renderForKind(kind) });
  } catch (err) {
    toast(err.message, { error: true });
    button.disabled = false;
    button.textContent = 'UPDATE';
  }
}

// อัปเดตทุกไฟล์ที่มีเวอร์ชีใหม่ในครั้งเดียว (แบ่งชุดเท่าจำนวน CPU → server ขนานดาวน์โหลดในชุด)
async function runUpdateAll(kinds) {
  const instance = instancesState.detail;
  if (!instance || instancesState.checking) return;
  const panelId = panelForKinds(kinds);
  const cfg = PROGRESS_PANELS[panelId];
  const targets = kinds.flatMap((kind) =>
    (instancesState.checks[kind] ?? [])
      .filter((entry) => entry.updateAvailable)
      .map((check) => ({ check, kind }))
  );
  if (targets.length === 0) return;

  instancesState.checking = true;
  const checkBtn = document.getElementById(cfg.check);
  const updateBtn = document.getElementById(cfg.updateAll);
  const status = document.getElementById(cfg.status);
  if (checkBtn) checkBtn.disabled = true;
  if (updateBtn) updateBtn.disabled = true;

  const failures = [];
  const { done, failures: batchFailures } = await applyUpdatesInBatches(targets, (processed, total, label) => {
    if (status) {
      status.hidden = false;
      status.textContent = `${label}…`;
    }
    setProgress(panelId, true, Math.round((processed / Math.max(total, 1)) * 90), label);
  });
  failures.push(...batchFailures);
  setProgress(panelId, true, 100, 'Done');

  try {
    for (const kind of kinds) {
      if (kind === 'mods') {
        const refreshed = await fetchJson(`/api/instances/${encodeURIComponent(instance.id)}`);
        instancesState.detail = refreshed.instance;
        renderInstanceDetail();
        await loadMods();
        await loadInstances({ silent: true });
      } else {
        await loadPackList(kind);
      }
    }
  } catch (err) {
    failures.push(err.message);
  }

  if (status) {
    status.hidden = false;
    status.textContent = failures.length > 0
      ? `${done} updated · ${failures.length} failed`
      : `${done} updated`;
  }
  toast(
    failures.length > 0
      ? `Updated ${done}, failed ${failures.length}`
      : `Updated ${done} file${done === 1 ? '' : 's'}`,
    { error: failures.length > 0 }
  );
  instancesState.checking = false;
  if (checkBtn) checkBtn.disabled = false;
  if (updateBtn) updateBtn.disabled = false;
  // โชว์ "N updated" ครู่หนึ่งก่อนเช็คสถานะซ้ำรอบสุดท้าย
  await new Promise((resolve) => setTimeout(resolve, 900));
  // จบแล้วเช็คซ้ำรอบหนึ่งเพื่อ sync สถานะล่าสุด (เจอ checking=false แล้วจึงรันได้)
  await runInstanceCheck(kinds, { render: renderForKind(kinds[kinds.length - 1]) });
}

// ---------- Unified update check (แท็บ UPDATES: เช็ค mods + shaders ในที่เดียว) ----------
// mods + shaders → อัปเดตให้หมดในปุ่มเดียว / resource packs → เช็ค+อัปเดตในแท็บ Resources แยกต่างหาก
const UPD_KIND_GROUPS = [
  { kind: 'mods', label: 'Mods' },
  { kind: 'shaderpacks', label: 'Shaders' },
];
// server มีแค่ mods — resourcepacks/shaders ไม่มีบน server อย่าไปเช็ค/โชว์
function activeUpdGroups() {
  if (instancesState.detail?.type === 'server') return UPD_KIND_GROUPS.filter((group) => group.kind === 'mods');
  return UPD_KIND_GROUPS;
}
// หน้า UPDATES เหลือเฉพาะ mods + shaders — resource packs ดูแลในแท็บ Resources (ไม่สน MC version ด้วย)
const UPD_KIND_LABELS = { mods: 'mods', resourcepacks: 'resource packs', shaderpacks: 'shaders' };

function updateStatusInfo(check) {
  if (check.status === 'unmatched') {
    return { label: 'UNVERIFIED', cls: 's-muted', title: "SHA-1 hash not found in Modrinth's catalog" };
  }
  if (check.status === 'unavailable') {
    return { label: 'CHECK FAILED', cls: 's-muted', title: 'Could not reach Modrinth for this file — run CHECK UPDATES again' };
  }
  if (check.status === 'incompatible') {
    return { label: 'NOT COMPATIBLE', cls: 's-bad', title: 'No Modrinth release matches the selected version' };
  }
  if (check.updateAvailable && check.latest) {
    return { label: `UPDATE → ${check.latest.versionNumber ?? '?'}`, cls: 's-update', title: 'A newer version is available on Modrinth' };
  }
  return { label: 'UP TO DATE', cls: 's-ok', title: '' };
}

function updatesSummary() {
  const summary = { upToDate: 0, updates: 0, incompatible: 0, unavailable: 0, unmatched: 0 };
  // นับเฉพาะกลุ่มของหน้า UPDATES — checks ของแท็บอื่น (เช่น resource packs) ห้ามปน
  for (const group of activeUpdGroups()) {
    for (const check of instancesState.checks[group.kind] ?? []) {
      if (check.status === 'unmatched') summary.unmatched += 1;
      else if (check.status === 'unavailable') summary.unavailable += 1;
      else if (check.status === 'incompatible') summary.incompatible += 1;
      else if (check.updateAvailable) summary.updates += 1;
      else summary.upToDate += 1;
    }
  }
  return summary;
}

// ปุ่มยืนยันตรงกลาง: UPDATE SELECTED (n) เมื่อมีของที่ติ๊กไว้ / SWITCH TO <v> เมื่อเลือกเป้าหมายใหม่แต่ไม่มีอะไรอัปเดต
function updateConfirmButtonLabel() {
  const button = document.getElementById('updConfirmBtn');
  if (!button) return;
  const selected = document.querySelectorAll('#updList .upd-skip:checked').length;
  const instance = instancesState.detail;
  const target = instancesState.updatesTarget;
  const versionChanged = Boolean(instance && target && target !== instance.minecraftVersion);
  const hasChecks = activeUpdGroups().some((group) => (instancesState.checks[group.kind] ?? []).length > 0);
  if (selected > 0) {
    button.hidden = false;
    button.textContent = `UPDATE SELECTED (${selected})`;
  } else if (versionChanged && hasChecks) {
    button.hidden = false;
    button.textContent = `SWITCH TO ${target}`;
  } else {
    button.hidden = true;
    button.textContent = 'UPDATE SELECTED';
  }
}

function resetUpdatesPanel({ keepTarget = false } = {}) {
  const status = document.getElementById('updCheckStatus');
  if (status) {
    status.hidden = true;
    status.textContent = '';
  }
  const pill = document.getElementById('updCountPill');
  if (pill) pill.textContent = 'Not checked';
  const list = document.getElementById('updList');
  if (list) list.replaceChildren(makeText('p', 'muted', 'No scan yet — press CHECK UPDATES to scan mods and shaders for the selected version.'));
  const confirmBtn = document.getElementById('updConfirmBtn');
  if (confirmBtn) {
    confirmBtn.hidden = true;
    confirmBtn.disabled = false;
  }
  const checkBtn = document.getElementById('updCheckBtn');
  if (checkBtn) checkBtn.disabled = false;
  if (!keepTarget) {
    // keepTarget = เช็คแล้วไม่มีไฟล์เลย (คนละกรณีกับสลับ instance) → เวอร์ชั่นเป้าหมายที่ผู้ใช้เลือกไว้ต้องไม่ถูกรีเซ็ต
    const versionInput = document.getElementById('updVersion');
    if (versionInput) delete versionInput.dataset.dirty; // instance ใหม่/บันทึกแล้ว → ให้ fill ตั้งค่าเป็นเวอร์ชั่นปัจจุบันเองได้
    instancesState.updatesTarget = null;
  }
  setProgress('updates', false);
}

function renderUpdatesPanel() {
  const list = document.getElementById('updList');
  const pill = document.getElementById('updCountPill');
  const status = document.getElementById('updCheckStatus');
  if (!list) return;

  const anyChecked = activeUpdGroups().some((group) => (instancesState.checks[group.kind] ?? []).length > 0);
  if (!anyChecked) {
    resetUpdatesPanel({ keepTarget: true });
    return;
  }

  const summary = updatesSummary();
  if (pill) {
    pill.textContent = summary.updates > 0
      ? `${summary.updates} update${summary.updates === 1 ? '' : 's'}`
      : summary.incompatible > 0
        ? `${summary.incompatible} incompatible`
        : 'UP TO DATE';
  }
  if (status) {
    status.hidden = false;
    const parts = [];
    if (summary.upToDate) parts.push(`${summary.upToDate} up to date`);
    if (summary.updates) parts.push(`${summary.updates} update${summary.updates === 1 ? '' : 's'}`);
    if (summary.incompatible) parts.push(`${summary.incompatible} not compatible`);
    if (summary.unavailable) parts.push(`${summary.unavailable} check failed`);
    if (summary.unmatched) parts.push(`${summary.unmatched} unverified`);
    let text = parts.length > 0 ? parts.join(' · ') : 'Nothing checked';
    const instance = instancesState.detail;
    if (instance && instancesState.updatesTarget && instancesState.updatesTarget !== instance.minecraftVersion) {
      text += ` — targeting ${instancesState.updatesTarget} (not saved)`;
    }
    status.textContent = text;
  }

  list.replaceChildren();
  for (const group of activeUpdGroups()) {
    const checks = instancesState.checks[group.kind] ?? [];
    if (checks.length === 0) continue;
    list.appendChild(makeText('h4', 'upd-group-title', `${group.label} (${checks.length})`));
    for (const check of checks) {
      const row = document.createElement('div');
      row.className = 'upd-row';
      const isRemoval = check.status === 'incompatible';
      if (check.updateAvailable || isRemoval) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'upd-skip';
        box.checked = true;
        box.dataset.filename = check.filename;
        box.dataset.kind = group.kind;
        box.title = isRemoval
          ? 'Uncheck to keep this file — confirming removes it (kept for restore)'
          : 'Uncheck to skip this file when confirming the update';
        row.appendChild(box);
      }
      row.appendChild(makeText('span', 'upd-name', check.filename));
      const info = updateStatusInfo(check);
      const chip = makeText('span', `upd-status ${info.cls}`, info.label);
      if (info.title) chip.title = info.title;
      row.appendChild(chip);
      if (isRemoval) {
        const remove = makeText('button', 'btn btn-danger btn-small', 'REMOVE');
        remove.type = 'button';
        remove.addEventListener('click', () => removeIncompatibleFile(check, group.kind, remove));
        row.appendChild(remove);
      } else if (check.updateAvailable && check.latest) {
        const update = makeText('button', 'btn btn-small', 'UPDATE');
        update.type = 'button';
        update.addEventListener('click', async () => {
          update.disabled = true;
          try {
            await applyUpdate(check, group.kind);
            toast(`Updated ${check.filename} → ${check.latest.versionNumber}`);
            instancesState.autoCheckAt.updates = 0;
            await runUnifiedCheck();
            refreshUpdateAllButtons();
          } catch (err) {
            toast(err.message, { error: true });
            update.disabled = false;
          }
        });
        row.appendChild(update);
      }
      list.appendChild(row);
    }
  }

  updateConfirmButtonLabel();
}

// ลบไฟล์ที่ไม่รองรับทีละไฟล์จากแถว NOT COMPATIBLE — ย้ายไป .removed/ จดจำไว้กู้คืนได้
async function removeIncompatibleFile(check, kind, button) {
  const instance = instancesState.detail;
  if (!instance) return;
  if (instancesState.checking) {
    toast('Another check is running — try again in a moment.', { error: true });
    return;
  }
  button.disabled = true;
  try {
    await trashRemovedFile(instance.id, check.filename, kind, instancesState.updatesTarget ?? instance.minecraftVersion, 'manual');
    dropCheck(kind, check.filename);
    toast(`Removed ${check.filename} — restorable on this page`);
    renderUpdatesPanel();
    refreshUpdateAllButtons();
    loadRemoved();
    await loadInstances({ silent: true });
  } catch (err) {
    toast(err.message, { error: true });
    button.disabled = false;
  }
}

function dropCheck(kind, filename) {
  const arr = instancesState.checks[kind] ?? [];
  const idx = arr.findIndex((entry) => entry.filename === filename);
  if (idx >= 0) arr.splice(idx, 1);
}

async function trashRemovedFile(instanceId, filename, kind, target = null, reason = 'incompatible') {
  await postJson(`/api/instances/${encodeURIComponent(instanceId)}/removed`, {
    kind,
    filename,
    reason,
    targetVersion: target ?? instancesState.updatesTarget ?? instancesState.detail?.minecraftVersion ?? null,
  });
}

// โหลดรายการไฟล์ที่ลบ + ถ้าเวอร์ชั่นเป้าหมายรองรับไฟล์ที่เคย incompatible แล้ว → auto-restore ให้เอง
// (เหตุผล 'manual' ที่ผู้ใช้กด REMOVE เอง → ไม่แตะ รอผู้ใช้กด RESTORE เอง)
async function loadRemoved({ auto = true } = {}) {
  const instance = instancesState.detail;
  if (!instance) return;
  const target = instancesState.updatesTarget ?? instance.minecraftVersion;
  try {
    const data = await fetchJson(
      `/api/instances/${encodeURIComponent(instance.id)}/removed?minecraftVersion=${encodeURIComponent(target)}`,
    );
    instancesState.removed = Array.isArray(data.removed) ? data.removed : [];
  } catch {
    instancesState.removed = [];
  }
  renderRemoved();
  if (auto) await autoRestoreSupported(target);
}

let autoRestoringRemoved = false;

// ย้ายไฟล์จาก .removed กลับเข้า instance (ทีละรายการ — server serialize ต่อ instance อยู่แล้ว)
// แล้วrefresh รายการ mods/packs ให้ตรง คืน { restored, failures }
async function restoreRemovedEntries(entries) {
  const instance = instancesState.detail;
  if (!instance || entries.length === 0) return { restored: 0, failures: [] };
  let restored = 0;
  const failures = [];
  for (const entry of entries) {
    try {
      await postJson(`/api/instances/${encodeURIComponent(instance.id)}/removed/restore`, {
        kind: entry.kind,
        filename: entry.filename,
      });
      restored += 1;
    } catch (err) {
      failures.push(`${entry.filename}: ${err.message}`);
    }
  }
  if (restored > 0) {
    if (entries.some((entry) => entry.kind === 'mods')) await loadMods().catch(() => {});
    const packKinds = [...new Set(entries.filter((entry) => entry.kind !== 'mods').map((entry) => entry.kind))];
    for (const kind of packKinds) await loadPackList(kind).catch(() => {});
    await loadInstances({ silent: true });
  }
  return { restored, failures };
}

async function autoRestoreSupported(target) {
  if (autoRestoringRemoved) return;
  const instance = instancesState.detail;
  if (!instance) return;
  const candidates = (instancesState.removed ?? []).filter(
    (entry) => entry.supported === true && entry.reason === 'incompatible',
  );
  if (candidates.length === 0) return;
  autoRestoringRemoved = true;
  // ถอดออกจาก list ทันทีก่อนย้ายไฟล์กลับ กัน restore ซ้ำสองรอบ
  instancesState.removed = (instancesState.removed ?? []).filter((entry) => !candidates.includes(entry));
  renderRemoved();
  try {
    const { restored, failures } = await restoreRemovedEntries(candidates);
    if (restored > 0) toast(`Auto-restored ${restored} file${restored === 1 ? '' : 's'} now supported on ${target}`);
    if (failures.length > 0) toast(failures.join(', '), { error: true });
    await loadRemoved({ auto: false });
  } finally {
    autoRestoringRemoved = false;
  }
}

function renderRemoved() {
  const wrap = document.getElementById('updRemoved');
  const title = document.getElementById('updRemovedTitle');
  const list = document.getElementById('updRemovedList');
  const restoreAllBtn = document.getElementById('updRestoreAllBtn');
  if (!wrap || !list) return;
  const items = instancesState.removed ?? [];
  wrap.hidden = items.length === 0;
  if (restoreAllBtn) restoreAllBtn.disabled = items.length === 0;
  if (items.length === 0) {
    list.replaceChildren();
    if (title) title.textContent = 'Removed — restorable';
    return;
  }
  if (title) title.textContent = `Removed — restorable (${items.length})`;
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'upd-row';
    row.appendChild(makeText('span', 'upd-name', item.filename));
    const reasonText =
      item.reason === 'manual'
        ? 'removed by you'
        : item.reason === 'incompatible'
          ? item.targetVersion
            ? `incompatible for ${item.targetVersion}`
            : 'incompatible'
          : item.reason ?? 'removed';
    row.appendChild(makeText('span', 'upd-status', reasonText));
    const restore = makeText('button', 'btn btn-small', 'RESTORE');
    restore.type = 'button';
    restore.addEventListener('click', async () => {
      if (!instancesState.detail) return;
      restore.disabled = true;
      try {
        const { restored, failures } = await restoreRemovedEntries([item]);
        if (restored > 0) toast(`Restored ${item.filename}`);
        if (failures.length > 0) toast(failures.join(', '), { error: true });
        await loadRemoved();
      } catch (err) {
        toast(err.message, { error: true });
        restore.disabled = false;
      }
    });
    row.appendChild(restore);
    list.appendChild(row);
  }
}

function maybeRunUnifiedCheck() {
  if (!instancesState.detail) return;
  const now = Date.now();
  const hasData = activeUpdGroups().some((group) => (instancesState.checks[group.kind] ?? []).length > 0);
  if (hasData && now - (instancesState.autoCheckAt.updates ?? 0) < AUTO_CHECK_MIN_AGE_MS) {
    renderUpdatesPanel();
    return;
  }
  runUnifiedCheck();
}

async function runUnifiedCheck() {
  const instance = instancesState.detail;
  if (!instance) return;
  if (instancesState.checking) {
    // มี check อื่นวิ่งอยู่ (เช่น auto-check แท็บ mods/packs) → บอกผู้ใช้ตรง ๆ แทนการนิ่งเฉย
    const busyStatus = document.getElementById(PROGRESS_PANELS.updates.status);
    if (busyStatus) {
      busyStatus.hidden = false;
      busyStatus.textContent = 'Another check is running — try again in a moment.';
    }
    return;
  }
  // เวอร์ชั่นเป้าหมายจาก dropdown (ค่าเริ่มต้น = เวอร์ชั่นปัจจุบันของ instance) — ยังไม่บันทึกลง instance
  const target = document.getElementById('updVersion')?.value.trim() || instance.minecraftVersion;
  instancesState.checking = true;
  instancesState.updatesTarget = target;
  instancesState.autoCheckAt.updates = Date.now();

  const cfg = PROGRESS_PANELS.updates;
  const button = document.getElementById(cfg.check);
  const status = document.getElementById(cfg.status);
  const confirmBtn = document.getElementById('updConfirmBtn');
  if (button) button.disabled = true;
  if (confirmBtn) confirmBtn.disabled = true;
  updatesVersionDropdown?.setDisabled(true);
  if (status) {
    status.hidden = false;
    status.textContent = 'Checking…';
  }
  setProgress('updates', true, 1, 'Starting…');
  const stopPoll = startProgressPoll(instance.id, 'updates');

  try {
    // เช็คทุก kind พร้อมกัน — server เก็บ progress แยก slot ต่อ kind อยู่แล้ว (กันชนเฉพาะ kind เดิมซ้ำ)
    const kindLabel = activeUpdGroups().map((group) => UPD_KIND_LABELS[group.kind]).join(' + ');
    if (status) {
      status.hidden = false;
      status.textContent = `Checking ${kindLabel} for ${target}…`;
    }
    await mapConcurrent(activeUpdGroups(), activeUpdGroups().length, async (group) => {
      if (instancesState.detail?.id !== instance.id) return; // เปลี่ยน instance ระหว่างทาง → หยุดเขียนผลลง UI
      const result = await postJson(`/api/instances/${encodeURIComponent(instance.id)}/check`, {
        kind: group.kind,
        minecraftVersion: target,
      });
      if (instancesState.detail?.id !== instance.id) return;
      instancesState.checks[group.kind] = result.files ?? [];
      instancesState.autoCheckAt[panelForKind(group.kind)] = Date.now();
    });
    setProgress('updates', true, 100, 'Done');
    renderUpdatesPanel();
    refreshUpdateAllButtons();
    const summary = updatesSummary();
    const forTarget = target !== instance.minecraftVersion ? ` for ${target}` : '';
    toast(
      summary.updates > 0
        ? `${summary.updates} update${summary.updates === 1 ? '' : 's'} available${forTarget}`
        : `Everything is up to date${forTarget}`
    );
    // target เปลี่ยน → refresh รายการไฟล์ที่ลบ + auto-restore ตัวที่เป้าหมายรองรับแล้ว
    await loadRemoved();
  } catch (err) {
    if (status) {
      status.hidden = false;
      status.textContent = err.message;
    }
    toast(err.message, { error: true });
  } finally {
    stopPoll();
    instancesState.checking = false;
    if (button) button.disabled = false;
    if (confirmBtn) confirmBtn.disabled = false;
    updatesVersionDropdown?.setDisabled(false);
    scheduleProgressHide('updates', 600);
  }
}

// ทำงานหลายตัวพร้อมกันแบบมีเพดาน (อัปเดตหลายไฟล์คู่ขนานแทนการรอทีละไฟล์)
async function mapConcurrent(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

const UPDATE_CONCURRENCY =
  typeof navigator === 'object' && Number.isInteger(navigator.hardwareConcurrency) && navigator.hardwareConcurrency > 0
    ? navigator.hardwareConcurrency
    : 4;

// อัปเดตหลายไฟล์เป็นชุด ๆ (ชุดละ = จำนวน CPU) — ยิงทีละ request ให้ server ขนานดาวน์โหลดเองภายในชุด
async function applyUpdatesInBatches(targets, report) {
  const instance = instancesState.detail;
  const failures = [];
  let done = 0;
  const total = targets.length;
  if (total === 0) return { done, failures };

  const groups = new Map();
  for (const target of targets) {
    const key = target.kind === 'mods' ? 'mods' : `packs:${target.kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(target);
  }

  for (const [key, list] of groups) {
    const isMod = key === 'mods';
    const kind = isMod ? null : key.slice('packs:'.length);
    const endpoint = `/api/instances/${encodeURIComponent(instance.id)}/${isMod ? 'mods' : 'packs'}`;
    for (let i = 0; i < list.length; i += UPDATE_CONCURRENCY) {
      const chunk = list.slice(i, i + UPDATE_CONCURRENCY);
      const label = `Updating ${done + 1}/${total} — ${chunk[0].check.filename}`;
      report?.(done + failures.length, total, label);
      let result;
      try {
        result = await postJson(endpoint, {
          versionIds: chunk.map((target) => target.check.latest.versionId),
          force: true,
          ...(isMod ? {} : { kind }),
        });
      } catch (err) {
        for (const target of chunk) failures.push(`${target.check.filename}: ${err.message}`);
        continue;
      }
      const byId = new Map((result.results ?? []).map((entry) => [entry.versionId, entry]));
      for (const target of chunk) {
        const entry = byId.get(target.check.latest.versionId);
        if (!entry) {
          failures.push(`${target.check.filename}: missing install result`);
          continue;
        }
        if (entry.ok !== true) {
          failures.push(`${target.check.filename}: ${entry.error ?? 'install failed'}`);
          continue;
        }
        const newNames = new Set((entry.files ?? []).map((file) => file.filename));
        if (!newNames.has(target.check.filename)) {
          // เวอร์ชีใหม่ใช้ชื่อไฟล์ต่างออกไป → ลบชื่อเก่าทิ้ง (เหมือน applyUpdate เดี่ยว)
          try {
            await deleteJson(
              `${endpoint}/${encodeURIComponent(target.check.filename)}${isMod ? '' : `?kind=${kind}`}`
            );
          } catch (err) {
            failures.push(`${target.check.filename}: ${err.message}`);
            continue;
          }
        }
        done += 1;
      }
      report?.(done + failures.length, total, `Updated ${done}/${total}`);
    }
  }
  return { done, failures };
}

// ยืนยัน: อัปเดตทุกไฟล์ที่ยังติ๊กค้างไว้ (ไม่ติ๊ก = ข้าม) — ถ้า dropdown ชี้เวอร์ชั่น ≠ ของ instance จะบันทึกเป้าหมายลง instance ด้วย
async function applySelectedUpdates() {
  const instance = instancesState.detail;
  if (!instance || instancesState.checking) return;

  const target = instancesState.updatesTarget ?? instance.minecraftVersion;
  const versionChanged = target !== instance.minecraftVersion;
  const selected = [...document.querySelectorAll('#updList .upd-skip:checked')]
    .map((box) => {
      const check = (instancesState.checks[box.dataset.kind] ?? []).find(
        (entry) => entry.filename === box.dataset.filename,
      );
      if (!check) return null;
      if (check.status === 'incompatible') return { check, kind: box.dataset.kind, mode: 'trash' };
      if (check.updateAvailable && check.latest) return { check, kind: box.dataset.kind, mode: 'update' };
      return null;
    })
    .filter(Boolean);
  const targets = selected.filter((action) => action.mode === 'update');
  const removals = selected.filter((action) => action.mode === 'trash');
  if (targets.length === 0 && removals.length === 0 && !versionChanged) {
    toast('Nothing to update');
    return;
  }

  instancesState.checking = true;
  const cfg = PROGRESS_PANELS.updates;
  const button = document.getElementById(cfg.check);
  const confirmBtn = document.getElementById('updConfirmBtn');
  const status = document.getElementById(cfg.status);
  if (button) button.disabled = true;
  if (confirmBtn) confirmBtn.disabled = true;
  updatesVersionDropdown?.setDisabled(true);

  let done = 0;
  let removed = 0;
  let finished = 0;
  const totalWork = targets.length + removals.length;
  const failures = [];
  const showProgress = (label) => {
    if (status) {
      status.hidden = false;
      status.textContent = `${label}…`;
    }
    setProgress('updates', true, Math.round((finished / Math.max(totalWork, 1)) * 90), label);
  };
  // ลบไฟล์ที่ไม่รองรับก่อน (งานเบาก็ขนานตามจำนวน CPU) แล้วค่อยอัปเดตเป็นชุด
  await mapConcurrent(removals, UPDATE_CONCURRENCY, async (action) => {
    const { check, kind } = action;
    showProgress(`Removing ${check.filename}`);
    try {
      await trashRemovedFile(instance.id, check.filename, kind, target);
      dropCheck(kind, check.filename);
      removed += 1;
    } catch (err) {
      failures.push(`${check.filename}: ${err.message}`);
    }
    finished += 1;
    showProgress(`Removing ${check.filename}`);
  });
  const batch = await applyUpdatesInBatches(targets, (processed, total, label) => {
    finished = removals.length + Math.min(processed, targets.length);
    showProgress(label);
  });
  done = batch.done;
  failures.push(...batch.failures);

  try {
    const refreshed = await fetchJson(`/api/instances/${encodeURIComponent(instance.id)}`);
    instancesState.detail = refreshed.instance;
    renderInstanceDetail();
    await loadInstances({ silent: true });
  } catch (err) {
    failures.push(err.message);
  }

  // เลือกเป้าหมายใหม่ → บันทึกลง instance พร้อมไฟล์ที่อัปเดต (ยืนยันครั้งเดียวจบ)
  let switched = false;
  if (versionChanged) {
    try {
      const patched = await patchJson(`/api/instances/${encodeURIComponent(instance.id)}`, {
        minecraftVersion: target,
      });
      instancesState.detail = patched.instance;
      switched = true;
    } catch (err) {
      failures.push(err.message);
    }
  }

  setProgress('updates', true, 100, 'Done');
  const resultParts = [];
  if (done > 0) resultParts.push(`${done} updated`);
  if (removed > 0) resultParts.push(`${removed} removed`);
  if (switched) resultParts.push(`Minecraft ${target} saved`);
  if (failures.length > 0) resultParts.push(`${failures.length} failed`);
  if (status) {
    status.hidden = false;
    status.textContent = resultParts.length > 0 ? resultParts.join(' · ') : 'Nothing to do';
  }
  toast(
    failures.length > 0
      ? `Updated ${done}, removed ${removed}, failed ${failures.length}`
      : resultParts.join(' · ') || 'Nothing to update',
    { error: failures.length > 0 }
  );
  if (removed > 0) await loadRemoved();

  if (switched) {
    // instance ย้ายเวอร์ชั่นแล้ว → ผลเช็คเดิมใช้ไม่ได้ เริ่มใหม่ด้วย current (คือ target ที่เพิ่งบันทึก)
    instancesState.checks = { mods: [], resourcepacks: [], shaderpacks: [] };
    instancesState.autoCheckAt = {};
    resetUpdatesPanel();
    renderInstanceDetail();
  }
  instancesState.checking = false;
  if (button) button.disabled = false;
  if (confirmBtn) confirmBtn.disabled = false;
  updatesVersionDropdown?.setDisabled(false);
  await new Promise((resolve) => setTimeout(resolve, 600));
  await runUnifiedCheck();
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
    const modCheck = checkResultFor(mod.filename, 'mods');
    if (!modCheck || modCheck.status !== 'unmatched') appendVersionsButton(row, mod.filename, 'mods');
    appendCheckOutcome(row, modCheck, 'mods');
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

async function loadPackList(kind) {
  const instance = instancesState.detail;
  if (!instance) return;
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
    return;
  }
  renderPackList(kind);
}

function renderPackList(kind) {
  const isResource = kind === 'resourcepacks';
  const list = document.getElementById(isResource ? 'rpList' : 'spList');
  const count = document.getElementById(isResource ? 'rpCountPill' : 'spCountPill');
  const files = instancesState.packs[kind];
  if (count) count.textContent = String(files.length);
  if (!list) return;
  list.replaceChildren();

  if (files.length === 0) {
    list.appendChild(
      makeText(
        'p',
        'muted',
        isResource
          ? 'No resource packs installed in this instance.'
          : 'No shaders installed in this instance.'
      )
    );
    return;
  }

  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'mod-row';
    row.append(
      makeText('span', 'mod-name', file.filename),
      makeText('span', 'mod-size', formatBytes(file.size))
    );
    const fileCheck = checkResultFor(file.filename, kind);
    if (!fileCheck || fileCheck.status !== 'unmatched') appendVersionsButton(row, file.filename, kind);
    appendCheckOutcome(row, fileCheck, kind);
    const remove = makeText('button', 'btn btn-danger btn-small', 'REMOVE');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      try {
        await deleteJson(
          `/api/instances/${encodeURIComponent(instancesState.detail.id)}/packs/${encodeURIComponent(file.filename)}?kind=${kind}`
        );
        toast(`${file.filename} removed`);
        await loadPackList(kind);
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
    row.appendChild(remove);
    list.appendChild(row);
  }
}

function setupInstanceDetail() {
  document.getElementById('instanceBackBtn')?.addEventListener('click', () => {
    location.hash = instancesState.detail?.type === 'server' ? '#servers' : '#instances';
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

  document.getElementById('iStartBtn')?.addEventListener('click', () => {
    // server: แท็บ START = สถานะ + EULA + console (ปุ่ม PLAY ของ client ถูกแทนด้วยแท็บนี้)
    setInstanceTab('start');
  });

  const runServerAction = async (button, action) => {
    const instance = instancesState.detail;
    if (!instance) return;
    button.disabled = true;
    try {
      await action();
      await loadServers({ silent: true });
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      button.disabled = false;
      // poll รอบถัดไปจะดึง status/console ล่าสุดมาอัปเดตแผงเอง
      startServerPoll();
    }
  };

  document.getElementById('srvStartBtn')?.addEventListener('click', (event) => {
    const instance = instancesState.detail;
    if (!instance) return;
    runServerAction(event.currentTarget, async () => {
      await postJson(`/api/servers/${encodeURIComponent(instance.id)}/start`);
      toast(`${instance.name} is starting`);
    });
  });

  document.getElementById('srvStopBtn')?.addEventListener('click', (event) => {
    const instance = instancesState.detail;
    if (!instance) return;
    runServerAction(event.currentTarget, async () => {
      await postJson(`/api/servers/${encodeURIComponent(instance.id)}/stop`);
      toast(`${instance.name} stopped`);
    });
  });

  document.getElementById('srvEulaBtn')?.addEventListener('click', (event) => {
    const instance = instancesState.detail;
    if (!instance) return;
    runServerAction(event.currentTarget, async () => {
      await postJson(`/api/servers/${encodeURIComponent(instance.id)}/eula`, { accept: true });
      toast('Minecraft EULA accepted');
    });
  });

  document.getElementById('srvClearBtn')?.addEventListener('click', () => {
    const box = document.getElementById('srvConsole');
    if (box) box.textContent = '';
  });

  document.getElementById('iOverviewBtn')?.addEventListener('click', () => {
    setInstanceTab('overview');
  });

  document.getElementById('iModsBtn')?.addEventListener('click', () => {
    setInstanceTab('mods');
    loadMods().then(() => maybeAutoCheck(['mods']));
  });

  document.getElementById('iResourcesBtn')?.addEventListener('click', () => {
    setInstanceTab('resourcepacks');
    loadPackList('resourcepacks').then(() => maybeAutoCheck(['resourcepacks']));
  });

  document.getElementById('iShadersBtn')?.addEventListener('click', () => {
    setInstanceTab('shaders');
    loadPackList('shaderpacks').then(() => maybeAutoCheck(['shaderpacks']));
  });

  document.getElementById('iUpdatesBtn')?.addEventListener('click', async () => {
    setInstanceTab('updates');
    await loadRemoved(); // รอ auto-restore เสร็จก่อนค่อยเริ่มเช็ค
    maybeRunUnifiedCheck();
  });
  document.getElementById('updCheckBtn')?.addEventListener('click', () => runUnifiedCheck());
  document.getElementById('updConfirmBtn')?.addEventListener('click', () => applySelectedUpdates());
  // ย้อนกลับเวอร์ชั่นก่อนหน้า = ตั้ง target เป็น previous แล้วเช็คใหม่ ยืนยันด้วยปุ่ม UPDATE SELECTED เหมือนเดิม
  document.getElementById('updRevertBtn')?.addEventListener('click', () => {
    const instance = instancesState.detail;
    const prevVersion = instance?.previousMinecraftVersion;
    if (!instance || !prevVersion || prevVersion === instance.minecraftVersion) return;
    const input = document.getElementById('updVersion');
    if (input) {
      input.value = prevVersion;
      input.dataset.dirty = '1';
    }
    updatesVersionDropdown?.setValue(prevVersion, { silent: true });
    runUnifiedCheck();
  });
  document.getElementById('updRestoreAllBtn')?.addEventListener('click', async () => {
    const items = [...(instancesState.removed ?? [])];
    if (items.length === 0) return;
    const btn = document.getElementById('updRestoreAllBtn');
    if (btn) btn.disabled = true;
    instancesState.removed = [];
    renderRemoved();
    try {
      const { restored, failures } = await restoreRemovedEntries(items);
      if (restored > 0) toast(`Restored ${restored} file${restored === 1 ? '' : 's'}`);
      if (failures.length > 0) toast(failures.join(', '), { error: true });
      await loadRemoved();
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  updatesVersionDropdown = createDropdown({ containerId: 'updVersionDropdown', valueId: 'updVersion' });
  document.getElementById('updVersion')?.addEventListener('input', (event) => {
    if (!instancesState.detail) return;
    event.currentTarget.dataset.dirty = '1';
    const value = event.currentTarget.value.trim();
    if (value === '' || value === instancesState.updatesTarget) return;
    runUnifiedCheck(); // เลือกเป้าหมายใหม่ → เช็ครายการให้ใหม่ทันที
  });
  document.getElementById('updList')?.addEventListener('change', (event) => {
    if (event.target?.classList?.contains('upd-skip')) updateConfirmButtonLabel();
  });

  // สลับ INSTALLED / GET ภายในแท็บ content เดียวกัน
  for (const seg of document.querySelectorAll('#kindSubNav .seg')) {
    seg.addEventListener('click', () => {
      const kind = TAB_KIND[instancesState.tab];
      if (!kind) return;
      const next = seg.dataset.kindView === 'get' ? 'get' : 'list';
      if (next === instancesState.kindView) return;
      setInstanceTab(instancesState.tab, next);
      if (next === 'get') ensureDefaultSearch(panelForKind(kind));
      else maybeAutoCheck([kind]);
    });
  }

  document.getElementById('iSettingsBtn')?.addEventListener('click', () => {
    setInstanceTab('settings');
  });

  const settingsForm = document.getElementById('instanceSettingsForm');
  const settingsError = document.getElementById('instanceSettingsError');
  if (settingsForm && settingsError) {
    for (const id of ['isName', 'isMemMin', 'isMemMax', 'isJvmArgs', 'isPort']) {
      document.getElementById(id)?.addEventListener('input', (event) => {
        event.currentTarget.dataset.dirty = '1';
      });
    }
    settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const instance = instancesState.detail;
      if (!instance) return;
      settingsError.hidden = true;
      const fieldIds = ['isName', 'isMemMin', 'isMemMax', 'isJvmArgs', 'isPort'];
      try {
        const payload = {
          name: document.getElementById('isName').value.trim(),
          memory: {
            min: document.getElementById('isMemMin').value.trim(),
            max: document.getElementById('isMemMax').value.trim(),
          },
          extraJvmArgs: parseArgString(document.getElementById('isJvmArgs').value),
        };
        if (instance.type === 'server') {
          const port = Number.parseInt(document.getElementById('isPort').value, 10);
          if (Number.isInteger(port)) payload.port = port;
        }
        const result = await patchJson(`/api/instances/${encodeURIComponent(instance.id)}`, payload);
        for (const id of fieldIds) {
          const input = document.getElementById(id);
          if (input) delete input.dataset.dirty;
        }
        instancesState.detail = result.instance;
        renderInstanceDetail();
        toast(instance.type === 'server' ? 'Server settings saved' : 'Instance settings saved');
        await loadInstances({ silent: true });
        await loadServers({ silent: true });
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
    const instance = instancesState.detail;
    if (instance) deleteInstance(instance, instance.type === 'server' ? 'server' : 'instance');
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

function openImportModal(mode = 'instance') {
  importState.token = null;
  importState.manifest = null;
  importState.mode = mode === 'server' ? 'server' : 'instance';
  const title = document.getElementById('importTitle');
  if (title) title.textContent = importState.mode === 'server' ? 'Import Server' : 'Import Instance';
  // wizard "Instance Name" ↔ "Server Name" ตามชนิด
  const nameWord = importState.mode === 'server' ? 'Server Name' : 'Instance Name';
  for (const span of document.querySelectorAll('#importModal .wizard-path span')) {
    if (span.textContent === 'Instance Name' || span.textContent === 'Server Name') span.textContent = nameWord;
  }
  const nameLabel = document.querySelector('#importStep2 .field-label');
  if (nameLabel) nameLabel.textContent = nameWord;
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

// preview สำเร็จ (จาก upload หรือจาก path) → สรุป + ไปขั้นชื่อ instance
function applyImportPreview(payload) {
  importState.token = payload.token;
  importState.manifest = payload.manifest;

  const summary = document.getElementById('importSummary');
  summary.replaceChildren();
  const facts = document.createElement('dl');
  facts.className = 'facts';
  for (const [label, value] of [
    ['Archive name', payload.manifest.name],
    ['Minecraft', payload.manifest.minecraftVersion],
    ['Loader', payload.manifest.fabricLoaderVersion],
  ]) {
    const item = document.createElement('div');
    item.append(makeText('dt', '', label), makeText('dd', '', value));
    facts.appendChild(item);
  }
  summary.appendChild(facts);

  document.getElementById('importName').value = payload.manifest.name;
  setImportStep(2);
}

// path ของ import endpoint ตามชนิดที่เลือก — client กับ server คนละประตูกัน
function importEndpoint() {
  return importState.mode === 'server' ? '/api/servers/import' : '/api/instances/import';
}

async function handleImportFile(file) {
  if (!file) return;
  const error = document.getElementById('importError');
  error.hidden = true;

  try {
    const response = await apiFetch(`${importEndpoint()}?preview=1`, {
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

    applyImportPreview(payload);
  } catch (err) {
    showImportError(err.message);
  }
}

async function confirmImport() {
  const name = document.getElementById('importName').value.trim();
  const confirmBtn = document.getElementById('importConfirmBtn');
  confirmBtn.disabled = true;
  try {
    const result = await postJson(importEndpoint(), { token: importState.token, name });
    document.getElementById('importDoneName').textContent = result.name;
    document.getElementById('importDoneMeta').textContent =
      `Minecraft ${result.manifest.minecraftVersion} · ${result.manifest.fabricLoaderVersion} · ${result.files} files`;
    setImportStep(3);
    await loadInstances({ silent: true });
    await loadServers({ silent: true });
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    confirmBtn.disabled = false;
  }
}

function setupImportModal() {
  document.getElementById('importInstanceBtn')?.addEventListener('click', () => openImportModal('instance'));
  document.getElementById('importServerBtn')?.addEventListener('click', () => openImportModal('server'));
  document.querySelectorAll('[data-open-import]').forEach((button) => {
    button.addEventListener('click', () => openImportModal('instance'));
  });
  document.querySelectorAll('[data-open-server-import]').forEach((button) => {
    button.addEventListener('click', () => openImportModal('server'));
  });
  document.getElementById('importChooseBtn')?.addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = ''; // เคลียร์เพื่อให้เลือกไฟล์เดิมซ้ำได้ (change ไม่ fire ถ้า value ไม่เปลี่ยน)
    handleImportFile(file);
  });
  document.getElementById('importCancelBtn')?.addEventListener('click', closeImportModal);
  document.getElementById('importConfirmBtn')?.addEventListener('click', confirmImport);
  document.getElementById('importDoneBtn')?.addEventListener('click', () => {
    const mode = importState.mode;
    closeImportModal();
    showView(mode === 'server' ? 'servers' : 'instances');
  });
  document.getElementById('importModal')?.addEventListener('click', (event) => {
    if (event.target.id === 'importModal' && event.target.dataset.step === '1') closeImportModal();
  });
}

function openCreatePage(mode = 'instance') {
  createState.mode = mode === 'server' ? 'server' : 'instance';
  const isServer = createState.mode === 'server';
  const title = document.getElementById('createTitle');
  if (title) title.textContent = isServer ? 'Create Server' : 'Create Instance';
  const subtitle = document.getElementById('createSubtitle');
  if (subtitle) {
    subtitle.textContent = isServer
      ? 'Name it, pick a Minecraft version and a loader — server files install on first START.'
      : 'Name it, pick a Minecraft version and a loader, then hit CREATE.';
  }
  const backLabel = document.getElementById('createBackLabel');
  if (backLabel) backLabel.textContent = isServer ? 'Servers' : 'Instances';
  document.getElementById('createError').hidden = true;
  document.getElementById('createForm').reset();
  createDropdowns.mc?.reset();
  createDropdowns.fabric?.reset();
  createDropdowns.mc?.setDefaultFromOptions();
  createDropdowns.fabric?.setDefaultFromOptions();
  showView('create');
}

function closeCreatePage() {
  location.hash = createState.mode === 'server' ? '#servers' : '#instances';
}

function setupCreatePage() {
  createDropdowns.mc = createDropdown({ containerId: 'createMcDropdown', valueId: 'createMc' });
  createDropdowns.fabric = createDropdown({ containerId: 'createFabricDropdown', valueId: 'createFabric' });

  document.getElementById('createInstanceBtn')?.addEventListener('click', () => openCreatePage('instance'));
  document.getElementById('createServerBtn')?.addEventListener('click', () => openCreatePage('server'));
  document.querySelectorAll('[data-open-create]').forEach((button) => {
    button.addEventListener('click', () => openCreatePage('instance'));
  });
  document.querySelectorAll('[data-open-create-server]').forEach((button) => {
    button.addEventListener('click', () => openCreatePage('server'));
  });
  document.getElementById('createCancelBtn')?.addEventListener('click', closeCreatePage);
  document.getElementById('createBackBtn')?.addEventListener('click', closeCreatePage);

  document.getElementById('createForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = document.getElementById('createError');
    errorBox.hidden = true;
    const minecraftVersion = document.getElementById('createMc').value.trim();
    const fabricLoaderVersion = document.getElementById('createFabric').value.trim();
    if (minecraftVersion === '' || fabricLoaderVersion === '') {
      errorBox.hidden = false;
      errorBox.textContent = 'Pick a Minecraft version and a loader version first';
      return;
    }
    const isServer = createState.mode === 'server';
    try {
      const result = await postJson(isServer ? '/api/servers' : '/api/instances', {
        name: document.getElementById('createName').value.trim(),
        minecraftVersion,
        fabricLoaderVersion,
      });
      const created = result.server ?? result.instance;
      toast(`${created.name} created`);
      await loadInstances({ silent: true });
      await loadServers({ silent: true });
      location.hash = `#instance/${encodeURIComponent(created.id)}`;
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
let updatesVersionDropdown = null;
const javaRuntimeState = { loaded: false, failed: false, list: [], chosen: null };
let javaRtDropdown = null;

async function loadSession({ silent = false } = {}) {
  try {
    const session = await fetchJson('/api/auth/session');
    renderSession(session);
    return session;
  } catch (err) {
    // backend หลุดแล้ว → disconnect page คุมหน้าจออยู่ ไม่ต้อง toast ซ้ำ
    if (!silent && state.serverStatus !== 'offline') toast(err.message, { error: true });
    return null;
  }
}

// หมดอายุ → logout auto: server ลบ session เองตอนอ่าน ฝั่ง UI แค่ตั้งเวลาไปเรียกอ่านใหม่เมื่อครบอายุ
let sessionLogoutTimer = null;
function scheduleSessionLogout(expiresAt) {
  if (sessionLogoutTimer !== null) {
    clearTimeout(sessionLogoutTimer);
    sessionLogoutTimer = null;
  }
  if (!Number.isFinite(expiresAt)) return;
  sessionLogoutTimer = setTimeout(() => {
    sessionLogoutTimer = null;
    loadSession({ silent: true });
  }, Math.max(expiresAt - Date.now(), 0) + 1500);
}

function renderSession(session) {
  const signedIn = session?.signedIn === true;
  state.signedIn = signedIn;
  el.skinOpenBtn.hidden = !signedIn; // ปุ่มสกินข้างชื่อผู้เล่น — มีเฉพาะตอน sign in
  // ป้ายชื่อใน sidebar เป็นปุ่มเปิด account โดยตรง (แทนปุ่ม Account เดิม) — ไม่ login โชว์ "SIGN IN"
  el.accountPill.textContent = signedIn ? (session.username ?? '—') : 'SIGN IN';
  const offlineForm = document.getElementById('offlineNameForm');
  if (offlineForm) offlineForm.hidden = signedIn;
  // ถูก sign out ระหว่างเปิดหน้าต่างสกินค้างไว้ → ปิดทันที ห้ามใช้สกินโดยไม่ login
  if (!signedIn) closeSkinOverlay();
  scheduleSessionLogout(signedIn ? session.expiresAt : null);
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
  const signedIn = session?.signedIn === true;
  document.getElementById('authSignedIn').hidden = !signedIn;
  document.getElementById('authSignedOut').hidden = signedIn;
  document.getElementById('authStartBtn').disabled = session?.clientConfigured === false;

  if (signedIn) {
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
      ['Expires', expires],
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
  // ห้ามเปิดหน้าต่างสกินโดยไม่ได้ sign in (ปุ่มถูกซ่อนอยู่แล้ว — guard กันเรียกซ้ำผ่านช่องทางอื่น)
  if (!state.signedIn) return;
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

  // ปุ่ม SKIN ข้างชื่อผู้เล่น (sidebar) → เปิดหน้าต่างสกิน
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

function setupAuth() {
  setupSkinControls();
  el.accountPill?.addEventListener('click', openAuthModal);
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
    { value: 'wayland', label: 'Wayland only' },
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

// ---------- Data directory (ย้ายข้อมูลเดิมไปที่ใหม่ — apply ตอน restart backend) ----------

function setupDataDirForm() {
  const form = document.getElementById('dataDirForm');
  const input = document.getElementById('cfgDataDir');
  const errorBox = document.getElementById('dataDirError');
  if (!form || !input || !errorBox) return;

  input.addEventListener('input', () => {
    input.dataset.dirty = '1';
    errorBox.hidden = true;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const target = input.value.trim();
    if (!target) return;

    const current = state.config?.paths?.dataDir ?? '';
    const ok = await confirmDialog({
      title: 'Move data directory',
      message: `Move all TML data from ${current} to ${target}? The new folder is used after restart.`,
      confirmLabel: 'MOVE DATA',
      danger: true,
    });
    if (!ok) return;

    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      await patchJson('/api/config', { dataDir: target });
      input.value = '';
      delete input.dataset.dirty;
      toast('Data moved — restart TML to use the new folder');
      await refresh();
    } catch (err) {
      errorBox.hidden = false;
      errorBox.textContent = err.message;
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

// ---------- Disconnect page (หน้า error ใหญ่ ตอน backend หลุด) ----------

function setupDisconnectPage() {
  el.disconnectRetryBtn?.addEventListener('click', () => {
    refresh();
  });
}

// ---------- Pending banner (data dir เปลี่ยนแล้ว — รอ restart) ----------

function setupPendingBanner() {
  el.pendingBannerClose?.addEventListener('click', () => {
    state.pendingDismissed = true;
    if (el.pendingBanner) el.pendingBanner.hidden = true;
  });
}

// ---------- Instance icon (เปลี่ยนรูปด้วยการคลิกที่ไอคอนหัวหน้า detail, ลบด้วยปุ่ม ×) ----------

function setupInstanceIcons() {
  document.getElementById('iIconBtn')?.addEventListener('click', () => {
    const instance = instancesState.detail;
    if (instance) promptInstanceIcon(instance);
  });
  document.getElementById('iIconDeleteBtn')?.addEventListener('click', async () => {
    const instance = instancesState.detail;
    if (!instance) return;
    try {
      await deleteJson(`/api/instances/${encodeURIComponent(instance.id)}/icon`);
      toast('Icon removed');
      await loadInstances({ silent: true });
      if (instance.type === 'server') await loadServers({ silent: true });
      await loadInstanceDetail(instance.id);
    } catch (err) {
      if (state.serverStatus !== 'offline') toast(err.message, { error: true });
    }
  });
  document.getElementById('iIcon')?.addEventListener('error', () => {
    const iconImg = document.getElementById('iIcon');
    const fallback = document.getElementById('iIconFallback');
    const del = document.getElementById('iIconDeleteBtn');
    if (iconImg) iconImg.hidden = true;
    if (del) del.hidden = true;
    if (fallback && instancesState.detail) {
      fallback.textContent = (instancesState.detail.name ?? '').trim().charAt(0).toUpperCase() || '?';
      fallback.hidden = false;
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

  // pill = สถานะ (ยังไม่เลือก → —), ปุ่ม = การกระทำ (โหลดแล้วยังไม่เลือก → SELECT)
  const selected = Boolean(runtime) && runtime.name === javaRuntimeState.chosen;
  pill.textContent = selected ? 'SELECTED' : '—';
  if (!runtime) {
    actionBtn.textContent = '—';
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
    actionBtn.textContent = 'SELECT';
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
  javaRtDropdown?.setPlaceholder('—');

  const errorBox = document.getElementById('javaRtError');
  const valueInput = document.getElementById('javaRtValue');
  const actionBtn = document.getElementById('javaRtActionBtn');
  const deleteBtn = document.getElementById('javaRtDeleteBtn');

  // dropdown ใช้ดูรายละเอียดอย่างเดียว — การเลือกใช้จริงทำผ่านปุ่ม SELECT → SELECTED
  valueInput?.addEventListener('input', () => {
    renderJavaRuntimeCard();
    if (errorBox) errorBox.hidden = true;
  });

  // ปุ่มเดียว 4 สถานะ: — (ยังไม่มี runtime) / DOWNLOAD (ยังไม่โหลด) / SELECT (โหลดแล้วยังไม่เลือก) / SELECTED (เลือกแล้ว)
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
    const confirmed = await confirmDialog({
      title: 'Delete Java runtime',
      message:
        `Delete downloaded Java runtime "${name}"? This removes its files from disk permanently.` +
        (wasChosen ? ' It is the selected runtime — PLAY will need a downloaded runtime to be selected again.' : ''),
      confirmLabel: 'DELETE',
    });
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
    // เติมค่าจากภายนอก (poll ทุก 3 วิ) — ห้ามแตะระหว่างผู้ใช้เปิดเมนูเลือกค่าอยู่
    // (setValue() กลางทางจะปิดเมนูทิ้ง → คลิกเลือกค่าไม่โดน = "ปุ่ม version ไม่ทำงาน")
    fillIfIdle(value) {
      if (!menu.hidden) return;
      const next = String(value);
      if (valueInput.value !== next) valueInput.value = next;
      syncLabel();
    },
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

let mcVersionsCache = null;
async function fetchMcVersionIds() {
  if (mcVersionsCache) return mcVersionsCache;
  const data = await fetchJson('/api/minecraft/versions?type=release&limit=80');
  const ids = (data.versions ?? []).map((version) => version.id);
  if (ids.length > 0) mcVersionsCache = ids;
  return ids;
}

async function loadCatalogOptions() {
  if (!catalogState.minecraft) {
    try {
      const ids = await fetchMcVersionIds();
      createDropdowns.mc?.setOptions(ids);
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

// โหลดจาก search → ดึงรายการเวอร์ชีที่เข้ากับ instance นี้ แล้วเปิดตัวเลือกเวอร์ชี (ไม่ auto-pick)
async function installFromSearch(hit, button, { kind = 'mods' } = {}) {
  const instance = instancesState.detail;
  if (!instance) return;
  const isMod = kind === 'mods';
  button.disabled = true;
  button.textContent = '…';

  try {
    // mods กรองด้วย Minecraft + Fabric / packs (resource+shader) ไม่กรองอะไรเลย → โชว์ทุกเวอร์ชีให้ผู้ใช้เลือกเอง
    const versionsUrl =
      `/api/modrinth/project/${encodeURIComponent(hit.projectId)}/versions` +
      (isMod
        ? `?game=${encodeURIComponent(instance.minecraftVersion)}&loader=fabric`
        : '');
    const data = await fetchJson(versionsUrl);
    const versions = data.versions ?? [];
    if (versions.length === 0) {
      throw new Error(
        isMod
          ? `${hit.title} has no downloadable file for Minecraft ${instance.minecraftVersion} + Fabric`
          : `${hit.title} has no versions on Modrinth`
      );
    }
    openVersionPicker(hit, versions, { kind, button });
  } catch (err) {
    toast(err.message, { error: true });
    button.disabled = false;
    button.textContent = 'INSTALL';
  }
}

// ปุ่ม VERSIONS ในแถว mods/packs — เรียกรายการเวอร์ชีของไฟล์นี้บน Modrinth มาเลือกติดตั้งแทน
async function openVersionsFor(filename, kind, button) {
  const instance = instancesState.detail;
  if (!instance) return;
  if (instancesState.checking) {
    toast('A check is already running — try again in a moment.');
    return;
  }
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '…';
  try {
    let check = checkResultFor(filename, kind);
    if (!check) {
      // ยังไม่เคยเช็ค → เช็คก่อนเพื่อหา projectId ของไฟล์นี้
      await runInstanceCheck([kind], { render: renderForKind(kind) });
      check = checkResultFor(filename, kind);
    }
    if (!check?.projectId) {
      throw new Error(`${filename} isn't identified on Modrinth — this file has no project to browse`);
    }
    const isMod = kind === 'mods';
    // mods กรอง Minecraft + Fabric / packs โชว์ทุกเวอร์ชีให้เลือกเอง (รีซอสไม่สน MC version)
    const versionsUrl =
      `/api/modrinth/project/${encodeURIComponent(check.projectId)}/versions` +
      (isMod
        ? `?game=${encodeURIComponent(instance.minecraftVersion)}&loader=fabric`
        : '');
    const data = await fetchJson(versionsUrl);
    const versions = data.versions ?? [];
    if (versions.length === 0) {
      throw new Error(
        isMod
          ? `No versions of ${filename} for Minecraft ${instance.minecraftVersion} + Fabric`
          : `No versions of ${filename} on Modrinth`
      );
    }
    button.disabled = false;
    button.textContent = original;
    openVersionPicker({ projectId: check.projectId, title: filename }, versions, {
      kind,
      button,
      replaceFilename: filename,
    });
  } catch (err) {
    toast(err.message, { error: true });
    button.disabled = false;
    button.textContent = original;
  }
}

function appendVersionsButton(row, filename, kind) {
  const versions = makeText('button', 'btn btn-small', 'VERSIONS');
  versions.type = 'button';
  versions.title = 'Browse every Modrinth version of this file and install one instead';
  versions.addEventListener('click', () => openVersionsFor(filename, kind, versions));
  row.appendChild(versions);
}

function openVersionPicker(hit, versions, { kind = 'mods', button = null, replaceFilename = null } = {}) {
  versionPickerState = { hit, versions, kind, button, replaceFilename, buttonDefault: button?.textContent ?? 'INSTALL' };
  document.getElementById('versionPickTitle').textContent = `Choose a version — ${hit.title}`;
  document.getElementById('versionPickMeta').textContent =
    kind === 'mods'
      ? 'Compatible with this instance (Minecraft + Fabric). Newest first.'
      : 'Every version on Modrinth — not filtered by Minecraft. Newest first.';
  const error = document.getElementById('versionPickError');
  error.hidden = true;
  error.textContent = '';

  const listEl = document.getElementById('versionPickList');
  listEl.replaceChildren();
  for (const version of versions) {
    const row = document.createElement('div');
    row.className = 'version-row-pick';

    const info = document.createElement('div');
    info.className = 'version-row-info';
    const metaBits = [version.name, version.versionType, version.datePublished ? String(version.datePublished).slice(0, 10) : '']
      .filter(Boolean)
      .join(' · ');
    info.append(
      makeText('span', 'version-row-name', version.versionNumber ?? version.id),
      makeText('span', 'version-row-meta', metaBits)
    );
    row.appendChild(info);

    const size = version.files?.[0]?.size;
    if (typeof size === 'number') row.appendChild(makeText('span', 'version-row-size', formatBytes(size)));

    const installBtn = makeText('button', 'btn btn-primary btn-small', 'INSTALL');
    installBtn.type = 'button';
    installBtn.addEventListener('click', () => pickVersionAndInstall(version));
    row.appendChild(installBtn);
    listEl.appendChild(row);
  }
  document.getElementById('versionPickModal').hidden = false;
}

async function pickVersionAndInstall(version) {
  const state = versionPickerState;
  const instance = instancesState.detail;
  if (!state || !instance) return;
  const isMod = state.kind === 'mods';
  const panelId = panelForKind(state.kind);
  const listEl = document.getElementById('versionPickList');
  const error = document.getElementById('versionPickError');
  error.hidden = true;
  for (const button of listEl.querySelectorAll('button')) button.disabled = true;

  try {
    // เปลี่ยนเวอร์ชีไฟล์ที่ติดตั้งอยู่แล้ว → ติดตั้งทับผ่าน applyUpdate (ลบไฟล์ชื่อเก่าถ้าชื่อเปลี่ยน)
    if (state.replaceFilename) {
      await applyUpdate(
        { filename: state.replaceFilename, latest: { versionId: version.id, versionNumber: version.versionNumber } },
        state.kind
      );
      toast(`Updated ${state.replaceFilename} → ${version.versionNumber ?? version.id}`);
      closeVersionPicker({ keepButton: true });
      if (isMod) {
        const refreshed = await fetchJson(`/api/instances/${encodeURIComponent(instance.id)}`);
        instancesState.detail = refreshed.instance;
        renderInstanceDetail();
        await loadMods();
        await loadInstances({ silent: true });
      } else {
        await loadPackList(state.kind);
      }
      // เช็คซ้ำทันทีเพื่อล้าง/อัปเดตป้ายของไฟล์ที่เพิ่งเปลี่ยน (ข้าม throttle ของ auto-check)
      instancesState.autoCheckAt[panelId] = 0;
      await runInstanceCheck([state.kind], { render: renderForKind(state.kind) });
      return;
    }
    const result = await postJson(`/api/instances/${encodeURIComponent(instance.id)}${isMod ? '/mods' : '/packs'}`, {
      versionId: version.id,
      ...(isMod ? {} : { kind: state.kind }),
    });
    toast(`Installed ${result.files.map((file) => file.filename).join(', ')}`);
    if (state.button) state.button.textContent = 'INSTALLED';
    closeVersionPicker({ keepButton: true });
    if (isMod) {
      const refreshed = await fetchJson(`/api/instances/${encodeURIComponent(instance.id)}`);
      instancesState.detail = refreshed.instance;
      renderInstanceDetail();
      await loadMods();
      await loadInstances({ silent: true });
    } else {
      await loadPackList(state.kind);
    }
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message;
    for (const button of listEl.querySelectorAll('button')) button.disabled = false;
  }
}

function closeVersionPicker({ keepButton = false } = {}) {
  document.getElementById('versionPickModal').hidden = true;
  const state = versionPickerState;
  versionPickerState = null;
  if (!keepButton && state?.button) {
    state.button.disabled = false;
    state.button.textContent = state.buttonDefault;
  }
}

function setupVersionPicker() {
  document.getElementById('versionPickCancelBtn')?.addEventListener('click', () => closeVersionPicker());
  document.getElementById('versionPickModal')?.addEventListener('click', (event) => {
    if (event.target.id === 'versionPickModal') closeVersionPicker();
  });
}

// หน้า GET ต่อ panel — mod/rp/sp มี form/input/error/results คนละชุด
const SEARCH_PANELS = {
  mods: { form: 'modSearchForm', input: 'modSearchInput', error: 'modSearchError', results: 'modResults' },
  rp: { form: 'rpSearchForm', input: 'rpSearchInput', error: 'rpSearchError', results: 'rpResults' },
  sp: { form: 'spSearchForm', input: 'spSearchInput', error: 'spSearchError', results: 'spResults' },
};

function setupModSearch() {
  document.getElementById('modSearchForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('modSearchInput');
    runModSearch(input.value.trim());
  });
  document.getElementById('modCheckBtn')?.addEventListener('click', () =>
    runInstanceCheck(['mods'], { render: renderMods })
  );
  document.getElementById('modUpdateAllBtn')?.addEventListener('click', () => runUpdateAll(['mods']));
}

async function runPackSearch(query, panel) {
  const cfg = SEARCH_PANELS[panel];
  const type = panel === 'sp' ? 'shader' : 'resourcepack';
  const kind = panel === 'sp' ? 'shaderpacks' : 'resourcepacks';
  const results = document.getElementById(cfg.results);
  const errorBox = document.getElementById(cfg.error);
  if (!results || !errorBox) return;
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
    for (const hit of data.hits) results.appendChild(modResultRow(hit, { kind }));
    results.hidden = false;
  } catch (err) {
    results.replaceChildren();
    errorBox.hidden = false;
    errorBox.textContent = err.message;
  }
}

function clearSearchResults(panel) {
  const cfg = SEARCH_PANELS[panel];
  const results = cfg ? document.getElementById(cfg.results) : null;
  const errorBox = cfg ? document.getElementById(cfg.error) : null;
  if (results) {
    results.replaceChildren();
    results.hidden = true;
  }
  if (errorBox) {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }
}

function ensureDefaultSearch(panel) {
  const cfg = SEARCH_PANELS[panel];
  if (!cfg) return;
  const results = document.getElementById(cfg.results);
  const errorBox = document.getElementById(cfg.error);
  if (!results || !errorBox) return;
  if (results.childElementCount === 0 && errorBox.hidden) {
    if (panel === 'mods') runModSearch('');
    else runPackSearch('', panel);
  }
}

function setupPackSearch() {
  for (const [panel, kind] of [['rp', 'resourcepacks'], ['sp', 'shaderpacks']]) {
    const cfg = SEARCH_PANELS[panel];
    document.getElementById(cfg.form)?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = document.getElementById(cfg.input);
      runPackSearch(input.value.trim(), panel);
    });
    document.getElementById(PROGRESS_PANELS[panel].check)?.addEventListener('click', () =>
      runInstanceCheck([kind], { render: renderForKind(kind) })
    );
    document.getElementById(PROGRESS_PANELS[panel].updateAll)?.addEventListener('click', () =>
      runUpdateAll([kind])
    );
  }
}

function main() {
  cacheElements();
  setupNavigation();
  setupInstanceDetail();
  setupImportModal();
  setupExportModal();
  setupCreatePage();
  setupAuth();
  setupServerConfigForm();
  setupOfflineNameForm();
  setupDataDirForm();
  setupDisconnectPage();
  setupPendingBanner();
  setupInstanceIcons();
  setupJavaRuntimeCard();
  setupModSearch();
  setupPackSearch();
  setupVersionPicker();
  refresh();
  loadSession({ silent: true });
  setInterval(refresh, REFRESH_MS);
  setInterval(pollInstanceStatus, STATUS_POLL_MS);
}

main();
