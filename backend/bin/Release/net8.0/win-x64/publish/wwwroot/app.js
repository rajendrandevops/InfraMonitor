const STORAGE_LAYOUT_KEY = "infraMonitor.layout.v1";
const STORAGE_SETTINGS_KEY = "infraMonitor.settings.v1";
const STORAGE_THEME_KEY = "infraMonitor.theme.v1";
const STORAGE_ALERTS_KEY = "infraMonitor.alerts.v1";
const API_BASE = window.location.origin || "http://localhost:5041";

const DEFAULT_LAYOUT = { deviceName: 220, status: 90, latency: 80, ipAddress: 150, actions: 180 };
const MIN_WIDTHS = { deviceName: 180, status: 72, latency: 70, ipAddress: 120, actions: 150 };
const DEFAULT_SETTINGS = { defaultPingInterval: 5, pingTimeout: 2000, historyRetention: 72, monitoringEnabled: true, tvMode: false, alertSoundEnabled: true, alertVolume: 0.35 };

const state = { groups: [], devices: [], alerts: [], dashboardHistory: [], dashboardRange: "24H", dashboardDeviceId: "all", dashboardHistorySignature: "", lastDashboardHistoryAt: 0, unreadAlertCount: 0, settings: loadSettings(), theme: localStorage.getItem(STORAGE_THEME_KEY) || "dark", filters: { search: "", group: "all", status: "all" }, layout: loadLayout(), modal: { type: null, id: null }, historyRange: "24H", lastDeviceStatuses: new Map(), audioContext: null, tvTimer: null, tvScrollPaused: false, tvScrollDirection: 1, tvResumeTimer: null, refreshTimer: null, refreshInFlight: false, detailDeviceId: null };

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) { const text = await response.text(); throw new Error(text || `Request failed: ${response.status}`); }
  if (response.status === 204) return null;
  return response.json();
}

function normalizeDevice(device) {
  const normalized = { ...device };
  const status = deriveStatus(device);
  normalized.groupId = Number(device.groupId ?? 0);
  normalized.pingIntervalSeconds = Number(device.pingIntervalSeconds ?? state.settings.defaultPingInterval ?? 5);
  normalized.enabled = Boolean(device.enabled ?? true);
  normalized.status = status;
  normalized.lastLatencyMs = device.lastLatencyMs ?? null;
  normalized.history = Array.isArray(device.history) ? device.history : [];
  normalized.lastChecked = device.lastChecked ?? null;
  normalized.lastSeen = device.lastSeen ?? null;
  return normalized;
}

function deriveStatus(device) {
  if (device == null) return "unknown";
  if (device.lastChecked == null) return "checking";
  return device.isUp === true ? "up" : device.isUp === false ? "down" : "unknown";
}

async function refreshDashboard() {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    const previousGroups = state.groups;
    const previousDevices = state.devices;
    const previousAlerts = state.alerts;
    const [groups, devices, summary, alerts, alertCount, settings] = await Promise.all([
      apiRequest("/api/groups"),
      apiRequest("/api/devices"),
      apiRequest("/api/monitoring/summary"),
      apiRequest("/api/alerts?limit=20"),
      apiRequest("/api/alerts/count"),
      apiRequest("/api/settings")
    ]);

    state.groups = Array.isArray(groups) ? groups : [];
    state.devices = Array.isArray(devices) ? devices.map(normalizeDevice) : [];
    state.alerts = Array.isArray(alerts) ? alerts.map((alert) => ({ id: alert.id, event: alert.eventType || alert.message || "Alert", device: alert.device || alert.deviceName || "Unknown device", ip: alert.ipAddress || "", group: alert.group || "Unknown", time: alert.createdAt ? formatDateTime(alert.createdAt) : "Unknown", acknowledged: Boolean(alert.isAcknowledged) })) : [];
    const structureChanged = groupsChanged(previousGroups, state.groups) || devicesStructureChanged(previousDevices, state.devices);
    const alertsChanged = alertsSignature(previousAlerts) !== alertsSignature(state.alerts);
    state.unreadAlertCount = Number(alertCount?.count ?? state.alerts.filter((alert) => !alert.acknowledged).length);
    state.settings = { ...DEFAULT_SETTINGS, ...state.settings, defaultPingInterval: Number(settings?.defaultPingIntervalSeconds ?? state.settings.defaultPingInterval ?? 5), pingTimeout: Number(settings?.pingTimeoutMilliseconds ?? state.settings.pingTimeout ?? 2000), historyRetention: Number(settings?.historyRetentionHours ?? state.settings.historyRetention ?? 72), monitoringEnabled: settings?.monitoringEnabled ?? state.settings.monitoringEnabled ?? true };

    saveSettings();
    const settingsForm = document.getElementById("settingsForm");
    if (!settingsForm || !settingsForm.contains(document.activeElement)) renderSettingsForm();
    if (structureChanged) renderGroupFilter();
    updateDashboardDeviceFilter();
    renderSummaryFromApi(summary);
    if (structureChanged || !document.querySelector("#monitorList .monitor-row")) renderMonitor();
    else updateRenderedDevices();
    if (state.settings.tvMode) startTvScroll();
    if (alertsChanged) { renderAlerts(); renderAlertsPanel(); }
    if (await loadDashboardHistory(structureChanged)) renderDashboardAnalytics();
    updateStatusBadge(summary);
    updateAlertCount();
    detectStatusTransitions();
  } catch (error) {
    console.error("Unable to load backend data", error);
    showToast("Backend unavailable. Please check the API service.");
  } finally {
    state.refreshInFlight = false;
  }
}

function groupsChanged(previous, current) { if (previous.length !== current.length) return true; return previous.some((group, index) => Number(group.id) !== Number(current[index]?.id) || group.name !== current[index]?.name); }
function devicesStructureChanged(previous, current) { if (previous.length !== current.length) return true; const oldById = new Map(previous.map((device) => [device.id, device])); return current.some((device) => { const old = oldById.get(device.id); return !old || old.name !== device.name || old.ipAddress !== device.ipAddress || old.groupId !== device.groupId || old.enabled !== device.enabled; }); }
function alertsSignature(alerts) { return alerts.map((alert) => `${alert.id}:${alert.event}:${alert.acknowledged}:${alert.time}`).join("|"); }

function renderSummaryFromApi(summary) {
  const total = state.devices.length;
  const up = state.devices.filter((device) => getStatusKey(device) === "up").length;
  const down = state.devices.filter((device) => getStatusKey(device) === "down").length;
  const unknown = state.devices.filter((device) => getStatusKey(device) === "unknown" || getStatusKey(device) === "checking").length;

  document.getElementById("totalDevices").textContent = String(total);
  document.getElementById("upDevices").textContent = String(up);
  document.getElementById("downDevices").textContent = String(down);
  document.getElementById("unknownDevices").textContent = String(unknown);
}

let dragState = null;
let searchTimer = null;

function loadSettings() { try { const saved = JSON.parse(localStorage.getItem(STORAGE_SETTINGS_KEY) || "null"); return { ...DEFAULT_SETTINGS, ...(saved || {}) }; } catch { return { ...DEFAULT_SETTINGS }; } }
function saveSettings() { localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(state.settings)); }
function loadAlerts() { try { const saved = JSON.parse(localStorage.getItem(STORAGE_ALERTS_KEY) || "null"); if (Array.isArray(saved)) return saved; } catch {} return []; }
function saveAlerts() { localStorage.setItem(STORAGE_ALERTS_KEY, JSON.stringify(state.alerts)); }
function loadLayout() { try { const raw = localStorage.getItem(STORAGE_LAYOUT_KEY); if (!raw) return { ...DEFAULT_LAYOUT }; const parsed = JSON.parse(raw); return { deviceName: clampNumber(parsed.deviceName, MIN_WIDTHS.deviceName, 340, DEFAULT_LAYOUT.deviceName), status: clampNumber(parsed.status, MIN_WIDTHS.status, 180, DEFAULT_LAYOUT.status), latency: clampNumber(parsed.latency, MIN_WIDTHS.latency, 180, DEFAULT_LAYOUT.latency), ipAddress: clampNumber(parsed.ipAddress, MIN_WIDTHS.ipAddress, 240, DEFAULT_LAYOUT.ipAddress), actions: clampNumber(parsed.actions, MIN_WIDTHS.actions, 260, DEFAULT_LAYOUT.actions) }; } catch { return { ...DEFAULT_LAYOUT }; } }
function saveLayout() { localStorage.setItem(STORAGE_LAYOUT_KEY, JSON.stringify(state.layout)); }
function clampNumber(value, min, max, fallback) { const num = Number(value); if (!Number.isFinite(num)) return fallback; return Math.min(max, Math.max(min, num)); }
function updateStatusBadge(summary) { const badge = document.getElementById("backendStatus"); if (!badge) return; const monitoring = summary?.monitoring !== false && state.settings.monitoringEnabled; badge.classList.toggle("status-offline", !monitoring); badge.innerHTML = `<span></span>${monitoring ? "All Systems Normal" : "Monitoring Paused"}`; }
function updateAlertCount() { const badge = document.getElementById("alertCount"); if (!badge) return; const count = state.unreadAlertCount; badge.textContent = String(count); badge.hidden = count === 0; }
function applyTheme() { document.documentElement.dataset.theme = state.theme; const button = document.getElementById("themeToggleButton"); if (!button) return; const light = state.theme === "light"; button.title = light ? "Switch to dark mode" : "Switch to light mode"; button.setAttribute("aria-label", button.title); button.innerHTML = light ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A8 8 0 0 1 8.5 4 8 8 0 1 0 20 15.5Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.8"/></svg>'; }
function toggleTheme() { state.theme = state.theme === "light" ? "dark" : "light"; localStorage.setItem(STORAGE_THEME_KEY, state.theme); applyTheme(); }
function detectStatusTransitions() { state.devices.forEach((device) => { const previous = state.lastDeviceStatuses.get(device.id); if (previous === "up" && device.status === "down") playDownAlert(); state.lastDeviceStatuses.set(device.id, device.status); }); }
function getAudioContext() { const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) return null; state.audioContext ||= new AudioContextClass(); return state.audioContext; }
function playAlertSound() { if (!state.settings.alertSoundEnabled) return false; const context = getAudioContext(); if (!context) return false; const play = () => { const now = context.currentTime; const volume = Math.max(0.01, Math.min(1, Number(state.settings.alertVolume) || 0.35)); [0, 0.22, 0.44].forEach((offset) => { const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.type = "sine"; oscillator.frequency.value = 660; gain.gain.setValueAtTime(volume, now + offset); gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.14); oscillator.connect(gain).connect(context.destination); oscillator.start(now + offset); oscillator.stop(now + offset + 0.15); }); }; if (context.state === "suspended") { context.resume().then(play).catch(() => {}); } else { play(); } return true; }
function playDownAlert() { try { playAlertSound(); } catch (error) { console.debug("Alert sound unavailable", error); } }
async function enableAlertSound() { const context = getAudioContext(); if (!context) { showToast("This browser does not support alert audio."); return; } try { state.settings.alertSoundEnabled = true; saveSettings(); await context.resume(); updateAlertSoundButtons(); showToast("Alert sound enabled."); } catch (error) { console.debug("Unable to enable alert sound", error); showToast("Click again to enable alert sound."); } }
function updateAlertSoundButtons() { const button = document.getElementById("tvSoundButton"); if (!button) return; button.textContent = state.settings.alertSoundEnabled ? "Alert Sound On" : "Enable Alert Sound"; button.classList.toggle("enabled", state.settings.alertSoundEnabled); }
function testAlertSound() { if (!state.settings.alertSoundEnabled) { showToast("Enable Alert Sound first."); return; } if (playAlertSound()) showToast("Test alert sound played."); else showToast("Alert audio is unavailable in this browser."); }
function applyColumnLayout() { const root = document.documentElement; root.style.setProperty("--device-col-width", `${state.layout.deviceName}px`); root.style.setProperty("--status-col-width", `${state.layout.status}px`); root.style.setProperty("--latency-col-width", `${state.layout.latency}px`); root.style.setProperty("--ip-col-width", `${state.layout.ipAddress}px`); root.style.setProperty("--action-col-width", `${state.layout.actions}px`); }
function resetLayout() { state.layout = { ...DEFAULT_LAYOUT }; saveLayout(); applyColumnLayout(); renderMonitor(); showToast("Layout reset."); }

async function init() { applyColumnLayout(); applyTheme(); updateStatusBadge(); bindEvents(); renderSettingsForm(); applyTvMode(); try { await refreshDashboard(); state.refreshTimer = setInterval(refreshDashboard, 5000); } catch (error) { console.error(error); showToast("Unable to load the backend dashboard data."); } }

function bindEvents() {
  document.getElementById("refreshButton").addEventListener("click", async () => { try { await refreshDashboard(); showToast("Dashboard refreshed."); } catch (error) { console.error(error); showToast("Refresh failed."); } });

  document.getElementById("resetLayoutBtn").addEventListener("click", resetLayout);
  document.getElementById("addDeviceButton").addEventListener("click", () => openDeviceModal("add"));
  document.getElementById("addGroupButton").addEventListener("click", () => openGroupModal("add"));
  document.getElementById("generateReportButton").addEventListener("click", () => openReportModal());
  document.getElementById("tvModeButton").addEventListener("click", () => { state.settings.tvMode = !state.settings.tvMode; saveSettings(); applyTvMode(); showToast(state.settings.tvMode ? "TV Mode enabled." : "TV Mode disabled."); });
  document.getElementById("tvModeBackButton").addEventListener("click", () => { state.settings.tvMode = false; saveSettings(); applyTvMode(); showToast("Back to Monitor."); });
  document.getElementById("tvSoundButton").addEventListener("click", enableAlertSound);
  document.getElementById("testAlertSoundButton").addEventListener("click", testAlertSound);
  document.getElementById("themeToggleButton").addEventListener("click", toggleTheme);
  let sidebarHideTimer;
  document.addEventListener("pointermove", (event) => {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar || document.body.classList.contains("tv-mode") || window.innerWidth <= 900) return;
    if (event.clientX <= 24) {
      clearTimeout(sidebarHideTimer);
      sidebar.classList.add("sidebar-peek");
      return;
    }
    if (!sidebar.matches(":hover")) {
      clearTimeout(sidebarHideTimer);
      sidebarHideTimer = setTimeout(() => sidebar.classList.remove("sidebar-peek"), 260);
    }
  });

  document.getElementById("searchInput").addEventListener("input", (event) => { state.filters.search = event.target.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(renderMonitor, 120); });
  document.getElementById("groupFilter").addEventListener("change", (event) => { state.filters.group = event.target.value; renderMonitor(); });
  document.getElementById("statusFilter").addEventListener("change", (event) => { state.filters.status = event.target.value; renderMonitor(); });
  document.querySelectorAll("[data-dashboard-range]").forEach((button) => button.addEventListener("click", () => { state.dashboardRange = button.dataset.dashboardRange; document.querySelectorAll("[data-dashboard-range]").forEach((item) => item.classList.toggle("active", item === button)); loadDashboardHistory(true).then(renderDashboardAnalytics); }));
  document.getElementById("dashboardDeviceFilter").addEventListener("change", (event) => { state.dashboardDeviceId = event.target.value; renderDashboardAnalytics(); });
  document.getElementById("deviceForm").addEventListener("submit", handleDeviceSubmit);
  document.getElementById("groupForm").addEventListener("submit", handleGroupSubmit);
  document.getElementById("settingsForm").addEventListener("submit", handleSettingsSubmit);
  document.getElementById("reportForm").addEventListener("submit", handleReportSubmit);
  document.getElementById("exportConfigButton").addEventListener("click", exportConfiguration);
  document.getElementById("importConfigInput").addEventListener("change", importConfiguration);
  document.body.addEventListener("click", (event) => {
    const closeTarget = event.target.closest("[data-close-modal]");
    if (closeTarget) { const modalId = closeTarget.getAttribute("data-close-modal"); closeModal(modalId); }

    const navButton = event.target.closest("[data-view]");
    if (navButton) { switchPanel(navButton.dataset.view); }

    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      const action = actionButton.dataset.action;
      const deviceId = Number(actionButton.dataset.deviceId || 0);
      if (action === "history") openHistoryModal(deviceId);
      if (action === "edit") openDeviceModal("edit", deviceId);
      if (action === "delete") deleteDevice(deviceId);
      if (action === "details") openDeviceDetails(deviceId);
    }

    const groupAction = event.target.closest("[data-group-action]");
    if (groupAction) {
      const action = groupAction.dataset.groupAction;
      const groupId = Number(groupAction.dataset.groupId || 0);
      if (action === "edit") openGroupModal("edit", groupId);
      if (action === "delete") deleteGroup(groupId);
    }

    const alertAction = event.target.closest("[data-alert-action]");
    if (alertAction) {
      const action = alertAction.dataset.alertAction;
      const alertId = Number(alertAction.dataset.alertId || 0);
      if (action === "ack") acknowledgeAlert(alertId);
      if (action === "delete") deleteAlert(alertId);
    }

    const rangeButton = event.target.closest("[data-range]");
    if (rangeButton) {
      state.historyRange = rangeButton.dataset.range;
      const lookupModal = document.getElementById("historyModal");
      const lookupDetail = document.getElementById("detailHistoryList");
      const deviceId = Number((lookupDetail && lookupDetail.dataset.deviceId) || (lookupModal && lookupModal.dataset.deviceId) || 0);
      if (lookupDetail) renderDetailHistory(deviceId, state.historyRange);
      if (lookupModal) renderHistory(deviceId, state.historyRange);
      document.querySelectorAll(".range-button").forEach((button) => { button.classList.toggle("active", button.dataset.range === state.historyRange); });
    }
  });

  document.body.addEventListener("dblclick", (event) => {
    if (!document.body.classList.contains("tv-mode")) return;
    const deviceRow = event.target.closest(".monitor-row[data-device-id]");
    if (deviceRow) openDeviceDetails(Number(deviceRow.dataset.deviceId));
  });

  document.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".resize-handle");
    if (!handle) return;
    event.preventDefault();
    const key = handle.dataset.column;
    dragState = { key, startX: event.clientX, startWidth: state.layout[key] };
    document.addEventListener("pointermove", handleResizeMove);
    document.addEventListener("pointerup", handleResizeEnd, { once: true });
  });
}

function switchPanel(panelName) {
  document.querySelectorAll(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.view === panelName));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `${panelName}Panel`));
}

function renderSummary() {
  const total = state.devices.length;
  const up = state.devices.filter((device) => getStatusKey(device) === "up").length;
  const down = state.devices.filter((device) => getStatusKey(device) === "down").length;
  const unknown = Math.max(0, total - up - down);
  document.getElementById("totalDevices").textContent = String(total);
  document.getElementById("upDevices").textContent = String(up);
  document.getElementById("downDevices").textContent = String(down);
  document.getElementById("unknownDevices").textContent = String(unknown);
}

function renderGroupFilter() {
  const filter = document.getElementById("groupFilter");
  if (!filter) return;
  filter.innerHTML = '<option value="all">All Groups</option>' + state.groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");
  filter.value = state.filters.group;
  const reportGroup = document.querySelector('select[name="reportGroup"]');
  if (reportGroup) {
    reportGroup.innerHTML = '<option value="all">All Groups</option>' + state.groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");
  }
  const reportDevice = document.querySelector('select[name="reportDevice"]');
  if (reportDevice) {
    reportDevice.innerHTML = '<option value="all">All Devices</option>' + state.devices.map((device) => `<option value="${device.id}">${escapeHtml(device.name)}</option>`).join("");
  }
}
function updateDashboardDeviceFilter() { const filter = document.getElementById("dashboardDeviceFilter"); if (!filter) return; const value = state.dashboardDeviceId; filter.innerHTML = '<option value="all">All devices</option>' + state.devices.map((device) => `<option value="${device.id}">${escapeHtml(device.name)} Â· ${escapeHtml(device.ipAddress)}</option>`).join(""); filter.value = state.devices.some((device) => String(device.id) === String(value)) ? value : "all"; state.dashboardDeviceId = filter.value; }

function renderMonitor() {
  const list = document.getElementById("monitorList");
  if (!list) return;

  const filtered = [...state.devices].filter((device) => {
    const search = state.filters.search.toLowerCase();
    const matchesSearch = !search || device.name.toLowerCase().includes(search) || device.ipAddress.toLowerCase().includes(search);
    const matchesGroup = state.filters.group === "all" || String(device.groupId) === String(state.filters.group);
    const statusKey = getStatusKey(device);
    const matchesStatus = state.filters.status === "all" || statusKey === state.filters.status;
    return matchesSearch && matchesGroup && matchesStatus;
  });

  list.innerHTML = "";
  if (!state.groups.length && !state.devices.length) {
    list.innerHTML = `<div class="empty-state"><div class="inner"><h3>No infrastructure configured.</h3><p>Create your first group or device to begin monitoring.</p><div class="empty-actions"><button class="primary-button" type="button" onclick="openGroupModal('add')">+ Create Group</button><button class="primary-button" type="button" onclick="openDeviceModal('add')">+ Add Device</button></div></div></div>`;
    return;
  }

  const groupsInOrder = [...state.groups].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  groupsInOrder.forEach((group) => {
    const groupDevices = filtered.filter((device) => Number(device.groupId) === Number(group.id));
    if (!groupDevices.length) return;

    const summary = summarizeGroup(groupDevices);
    const section = document.createElement("section");
    section.className = "group-block";
    section.dataset.groupId = String(group.id);

    const headerRow = document.createElement("div");
    headerRow.className = "group-header";
    headerRow.innerHTML = `<div class="group-heading"><span class="group-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="15" width="16" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></span><div class="group-title">${escapeHtml(group.name)}</div></div><div class="group-meta"><strong>${summary.total} Devices</strong><span class="group-up">${summary.up} UP</span><span class="group-down">${summary.down} DOWN</span></div><div class="group-actions-inline"><button class="inline-action" type="button" data-group-action="edit" data-group-id="${group.id}">Edit</button><button class="inline-action" type="button" data-group-action="delete" data-group-id="${group.id}">Delete</button></div>`;
    section.appendChild(headerRow);

    const columns = document.createElement("div");
    columns.className = "device-columns";
    const column = document.createElement("div");
    column.className = "device-column";
    column.innerHTML = '<div class="device-column-header"><span>Device Name</span><span>Status</span><span>Latency</span><span>IP Address</span><span></span></div>';
    groupDevices.forEach((device) => {
      const row = createDeviceRow(device);
      row.dataset.deviceId = String(device.id);
      column.appendChild(row);
    });
    columns.appendChild(column);
    const scroll = document.createElement("div");
    scroll.className = "group-scroll";
    scroll.appendChild(columns);
    section.appendChild(scroll);
    list.appendChild(section);
  });

  if (!list.children.length) { list.innerHTML = `<div class="empty-state"><div class="inner"><h3>No devices match the current filters.</h3><p>Adjust the group or status filters to continue.</p></div></div>`; }
}

function summarizeGroup(groupDevices) { return groupDevices.reduce((summary, device) => { const status = getStatusKey(device); summary.total += 1; if (status === "up") summary.up += 1; if (status === "down") summary.down += 1; return summary; }, { total: 0, up: 0, down: 0 }); }
function updateRenderedDevices() { const rows = new Map([...document.querySelectorAll(".monitor-row[data-device-id]")].map((row) => [Number(row.dataset.deviceId), row])); state.devices.forEach((device) => { const row = rows.get(Number(device.id)); if (row) updateDeviceRow(row, device); }); document.querySelectorAll(".group-block[data-group-id]").forEach((section) => { const groupDevices = state.devices.filter((device) => Number(device.groupId) === Number(section.dataset.groupId)); const summary = summarizeGroup(groupDevices); const meta = section.querySelector(".group-meta"); if (meta) meta.innerHTML = `<strong>${summary.total} Devices</strong><span class="group-up">${summary.up} UP</span><span class="group-down">${summary.down} DOWN</span>`; }); }
function updateDeviceRow(row, device) { const status = getDeviceStatus(device); const previous = row.dataset.status; row.classList.toggle("down-row", status.label === "DOWN"); row.dataset.status = status.label; if (previous === status.label && row.dataset.latency === String(device.lastLatencyMs)) return; row.querySelector(".status-pill").className = `status-pill ${status.className}`; row.querySelector(".status-pill span:last-child").textContent = status.label; row.querySelector(".latency-value").textContent = formatLatency(device.lastLatencyMs, device.status); row.dataset.latency = String(device.lastLatencyMs); }
function createHeaderCell(columnKey, label) { return `<div class="header-cell">${label}<span class="resize-handle" data-column="${columnKey}" aria-label="Resize ${label}"></span></div>`; }
function createDeviceRow(device) { const status = getDeviceStatus(device); const row = document.createElement("div"); row.className = `monitor-row ${status.label === "DOWN" ? "down-row" : ""}`; row.dataset.status = status.label; row.dataset.latency = String(device.lastLatencyMs); row.innerHTML = `<div class="monitor-cell"><span class="device-type-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="15" width="16" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 7h.01M8 18h.01" stroke="currentColor" stroke-linecap="round" stroke-width="2"/></svg></span><div class="device-name"><button class="device-name-button" type="button" data-action="details" data-device-id="${device.id}">${escapeHtml(device.name)}</button></div><span class="resize-handle" data-column="deviceName" aria-label="Resize Device Name"></span></div><div class="monitor-cell"><div class="status-pill ${status.className}"><span class="status-dot"></span><span>${status.label}</span></div><span class="resize-handle" data-column="status" aria-label="Resize Status"></span></div><div class="monitor-cell"><div class="latency-value">${formatLatency(device.lastLatencyMs, device.status)}</div><span class="resize-handle" data-column="latency" aria-label="Resize Latency"></span></div><div class="monitor-cell"><div class="ip-value">${escapeHtml(device.ipAddress)}</div><span class="resize-handle" data-column="ipAddress" aria-label="Resize IP Address"></span></div><div class="monitor-cell row-actions"><button class="detail-arrow" type="button" data-action="details" data-device-id="${device.id}" aria-label="View ${escapeHtml(device.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg></button><div class="action-group"><button class="action-button" type="button" data-action="history" data-device-id="${device.id}">History</button><button class="action-button" type="button" data-action="edit" data-device-id="${device.id}">Edit</button><button class="action-button delete" type="button" data-action="delete" data-device-id="${device.id}">Delete</button></div><span class="resize-handle" data-column="actions" aria-label="Resize Actions"></span></div>`; return row; }
function getDeviceStatus(device) { if (device.status === "up") return { label: "UP", className: "status-up" }; if (device.status === "down") return { label: "DOWN", className: "status-down" }; if (device.status === "checking") return { label: "CHECKING", className: "status-checking" }; return { label: "UNKNOWN", className: "status-unknown" }; }
function getStatusKey(device) { if (device.status === "up") return "up"; if (device.status === "down") return "down"; if (device.status === "checking") return "checking"; return "unknown"; }
function formatLatency(value, status) { if (status === "down" || value === null || value === undefined || Number.isNaN(Number(value))) return "â€”"; return `${Number(value)} ms`; }

function openDeviceModal(mode, id = null) {
  if (!state.groups.length) { showToast("Create a group before adding a device."); openGroupModal("add"); return; }
  state.modal.type = mode; state.modal.id = id;
  const form = document.getElementById("deviceForm"); const modal = document.getElementById("deviceModal"); const modalTitle = document.getElementById("deviceModalTitle"); const groupSelect = form.elements.groupId;
  form.reset(); groupSelect.innerHTML = state.groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");
  if (mode === "edit") { const device = state.devices.find((entry) => Number(entry.id) === Number(id)); if (!device) return; form.elements.name.value = device.name; form.elements.ipAddress.value = device.ipAddress; form.elements.groupId.value = String(device.groupId); form.elements.pingIntervalSeconds.value = device.pingIntervalSeconds || state.settings.defaultPingInterval; form.elements.enabled.checked = Boolean(device.enabled); modalTitle.textContent = "Edit Device"; } else { form.elements.groupId.value = String(state.groups[0]?.id || 1); form.elements.pingIntervalSeconds.value = state.settings.defaultPingInterval; form.elements.enabled.checked = true; modalTitle.textContent = "Add Device"; }
  modal.classList.remove("hidden"); modal.setAttribute("aria-hidden", "false");
}

function closeModal(modalId) { const modal = document.getElementById(modalId); if (!modal) return; modal.classList.add("hidden"); modal.setAttribute("aria-hidden", "true"); if (modalId === "deviceModal") document.getElementById("deviceForm").reset(); if (modalId === "groupModal") document.getElementById("groupForm").reset(); }

async function handleDeviceSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget; const formData = new FormData(form); const payload = { name: String(formData.get("name") || "").trim(), ipAddress: String(formData.get("ipAddress") || "").trim(), groupId: Number(formData.get("groupId") || 1), pingIntervalSeconds: Number(formData.get("pingIntervalSeconds") || state.settings.defaultPingInterval), enabled: formData.get("enabled") === "on" };
  if (!payload.name || !payload.ipAddress) { showToast("Device name and IP address are required."); return; }
  if (!/^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(payload.ipAddress)) { showToast("Enter a valid IPv4 address."); return; }
  try {
    if (state.modal.type === "edit") { await apiRequest(`/api/devices/${state.modal.id}`, { method: "PUT", body: JSON.stringify({ ...payload, id: Number(state.modal.id) }) }); showToast(`${payload.name} updated.`); } else { await apiRequest("/api/devices", { method: "POST", body: JSON.stringify(payload) }); showToast(`${payload.name} added.`); }
    closeModal("deviceModal"); await refreshDashboard();
  } catch (error) { console.error(error); showToast(error.message || "Unable to save device."); }
}

async function deleteDevice(deviceId) { const device = state.devices.find((entry) => Number(entry.id) === Number(deviceId)); if (!device) return; const confirmed = window.confirm(`Delete device?\n\nDevice: ${device.name}\nIP: ${device.ipAddress}\n\nThis will stop monitoring this IP.`); if (!confirmed) return; try { await apiRequest(`/api/devices/${deviceId}`, { method: "DELETE" }); state.devices = state.devices.filter((entry) => Number(entry.id) !== Number(deviceId)); renderSummaryFromApi(); renderMonitor(); updateDashboardDeviceFilter(); showToast(`${device.name} removed.`); await refreshDashboard(); } catch (error) { console.error(error); showToast(error.message || "Unable to delete device."); } }

function openGroupModal(mode, id = null) { state.modal.type = mode; state.modal.id = id; const form = document.getElementById("groupForm"); const modal = document.getElementById("groupModal"); const title = document.getElementById("groupModalTitle"); form.reset(); if (mode === "edit") { const group = state.groups.find((entry) => Number(entry.id) === Number(id)); if (!group) return; form.elements.name.value = group.name; form.elements.description.value = group.description || ""; title.textContent = "Edit Group"; } else { title.textContent = "Create Group"; }
  modal.classList.remove("hidden"); modal.setAttribute("aria-hidden", "false"); }

async function handleGroupSubmit(event) { event.preventDefault(); const form = event.currentTarget; const formData = new FormData(form); const name = String(formData.get("name") || "").trim(); const description = String(formData.get("description") || "").trim(); if (!name) { showToast("Group name is required."); return; }
  try { if (state.modal.type === "edit") { await apiRequest(`/api/groups/${state.modal.id}`, { method: "PUT", body: JSON.stringify({ id: Number(state.modal.id), name, description }) }); showToast(`${name} updated.`); } else { await apiRequest("/api/groups", { method: "POST", body: JSON.stringify({ name, description }) }); showToast(`${name} created.`); } closeModal("groupModal"); await refreshDashboard(); } catch (error) { console.error(error); showToast(error.message || "Unable to save group."); } }

async function deleteGroup(groupId) { const group = state.groups.find((entry) => Number(entry.id) === Number(groupId)); if (!group) return; const groupDevices = state.devices.filter((device) => Number(device.groupId) === Number(groupId)); if (groupDevices.length > 0) { showToast("Move or delete the devices in this group before deleting it."); return; } const confirmed = window.confirm(`Delete group ${group.name}?`); if (!confirmed) return; try { await apiRequest(`/api/groups/${groupId}`, { method: "DELETE" }); showToast(`${group.name} deleted.`); await refreshDashboard(); } catch (error) { console.error(error); showToast(error.message || "Unable to delete group."); } }

function buildDeviceStatusSummary(device) { const history = Array.isArray(device.history) ? [...device.history].sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt)) : []; let downSince = null; let recoveredAt = null; let downtimeSeconds = null; for (const entry of history) { if (!entry.isUp && !downSince) downSince = entry.checkedAt; if (entry.isUp && downSince) { recoveredAt = entry.checkedAt; downtimeSeconds = Math.max(0, Math.round((new Date(recoveredAt) - new Date(downSince)) / 1000)); downSince = null; } } const lastDown = history.filter((entry) => !entry.isUp).at(-1); if (lastDown && device.status === "down") { downSince = lastDown.checkedAt; recoveredAt = null; downtimeSeconds = Math.max(0, Math.round((Date.now() - new Date(downSince).getTime()) / 1000)); } return { downSince, recoveredAt, downtimeSeconds }; }

function openDeviceDetails(deviceId) { const device = state.devices.find((entry) => Number(entry.id) === Number(deviceId)); if (!device) return; const modal = document.getElementById("deviceDetailModal"); const content = document.getElementById("deviceDetailContent"); const group = state.groups.find((entry) => Number(entry.id) === Number(device.groupId)); const status = getDeviceStatus(device); const statusSummary = buildDeviceStatusSummary(device); const downSince = statusSummary.downSince ? formatDateTime(statusSummary.downSince) : "â€”"; const recoveredAt = statusSummary.recoveredAt ? formatDateTime(statusSummary.recoveredAt) : "â€”"; const downtimeLabel = statusSummary.downtimeSeconds !== null ? formatDuration(statusSummary.downtimeSeconds) : "â€”"; const historyHtml = renderHistorySvg(device); content.innerHTML = `<div class="detail-header"><h4>${escapeHtml(device.name)}</h4><div class="status-pill ${status.className}"><span class="status-dot"></span><span>${status.label}</span></div></div><div class="detail-grid"><div class="detail-card"><span class="label">Device Name</span><div class="value">${escapeHtml(device.name)}</div></div><div class="detail-card"><span class="label">IP Address</span><div class="value">${escapeHtml(device.ipAddress)}</div></div><div class="detail-card"><span class="label">Group</span><div class="value">${escapeHtml(group ? group.name : "Unassigned")}</div></div><div class="detail-card"><span class="label">Current Status</span><div class="value">${status.label}</div></div><div class="detail-card"><span class="label">Current Latency</span><div class="value">${formatLatency(device.lastLatencyMs, device.status)}</div></div><div class="detail-card"><span class="label">Ping Interval</span><div class="value">${device.pingIntervalSeconds || state.settings.defaultPingInterval} sec</div></div><div class="detail-card"><span class="label">Last Checked</span><div class="value">${device.lastChecked ? formatDateTime(device.lastChecked) : "Never"}</div></div><div class="detail-card"><span class="label">Last Status Change</span><div class="value">${downSince}</div></div><div class="detail-card"><span class="label">Down Since</span><div class="value">${downSince}</div></div><div class="detail-card"><span class="label">Recovered</span><div class="value">${recoveredAt}</div></div><div class="detail-card"><span class="label">Downtime</span><div class="value">${downtimeLabel}</div></div><div class="detail-card"><span class="label">History</span><div class="value">${Array.isArray(device.history) && device.history.length ? `${device.history.length} events` : "No monitoring history available"}</div></div></div><div class="detail-graph">${historyHtml}</div><div class="history-toolbar" style="padding: 12px 0; border: 0;"><div class="history-meta">Monitoring history</div><div class="time-range-group"><button class="range-button ${state.historyRange === "1H" ? "active" : ""}" type="button" data-range="1H">1H</button><button class="range-button ${state.historyRange === "6H" ? "active" : ""}" type="button" data-range="6H">6H</button><button class="range-button ${state.historyRange === "12H" ? "active" : ""}" type="button" data-range="12H">12H</button><button class="range-button ${state.historyRange === "24H" ? "active" : ""}" type="button" data-range="24H">24H</button><button class="range-button ${state.historyRange === "48H" ? "active" : ""}" type="button" data-range="48H">48H</button><button class="range-button ${state.historyRange === "72H" ? "active" : ""}" type="button" data-range="72H">72H</button><button class="range-button ${state.historyRange === "7D" ? "active" : ""}" type="button" data-range="7D">7D</button></div></div><div id="detailHistoryList" class="history-list" data-device-id="${device.id}"></div><div class="status-select-row"><label class="field" style="flex:1"><span>Set Status</span><select id="statusOverrideSelect"><option value="unknown" ${device.status === "unknown" ? "selected" : ""}>UNKNOWN</option><option value="up" ${device.status === "up" ? "selected" : ""}>UP</option><option value="down" ${device.status === "down" ? "selected" : ""}>DOWN</option></select></label><button class="primary-button" type="button" id="saveStatusButton">Save Status</button></div>`; renderDetailHistory(device.id, state.historyRange); const saveButton = document.getElementById("saveStatusButton"); saveButton.addEventListener("click", () => { const select = document.getElementById("statusOverrideSelect"); updateDeviceStatus(device.id, select.value); }); modal.classList.remove("hidden"); modal.setAttribute("aria-hidden", "false"); }

function renderHistorySvg(device) { const history = Array.isArray(device.history) && device.history.length ? device.history : []; if (!history.length) return `<div style="display:grid;place-items:center;height:220px;color:var(--text-muted);font-size:14px;">No monitoring history available.</div>`; const sorted = [...history].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); const points = sorted.map((point, index) => { const x = 20 + (index * (430 / Math.max(sorted.length - 1, 1))); const y = 170 - Number(point.latency || 0); return `<circle cx="${x}" cy="${y}" r="4" fill="${point.status === 'down' ? '#ff6b6b' : '#34d399'}" />`; }).join(""); return `<svg viewBox="0 0 480 200" aria-label="Latency graph"><g stroke="rgba(255,255,255,0.12)" stroke-width="1"><line x1="20" y1="160" x2="460" y2="160" /><line x1="20" y1="20" x2="20" y2="160" /></g><g fill="rgba(255,255,255,0.7)" font-size="10"><text x="20" y="175">0 ms</text><text x="408" y="175">now</text></g>${points}</svg>`; }

function updateDeviceStatus(deviceId) { refreshDashboard().then(() => openDeviceDetails(deviceId)); }
function openHistoryModal(deviceId) { const device = state.devices.find((entry) => Number(entry.id) === Number(deviceId)); if (!device) return; const modal = document.getElementById("historyModal"); modal.dataset.deviceId = String(deviceId); const info = document.getElementById("historyInfo"); info.textContent = `${device.name} â€¢ ${device.ipAddress} â€¢ ${getDeviceStatus(device).label}`; modal.classList.remove("hidden"); modal.setAttribute("aria-hidden", "false"); document.querySelectorAll(".range-button").forEach((button) => button.classList.toggle("active", button.dataset.range === state.historyRange)); renderHistory(deviceId, state.historyRange); }

function historyHours(range) { return { LIVE: 1, "1H": 1, "6H": 6, "12H": 12, "24H": 24, "48H": 48, "72H": 72, "7D": 168, "30D": 720 }[range] || 24; }
function normalizeMonitoringTimestamp(value) { if (!value) return value; const text = String(value); return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`; }
async function fetchHistory(deviceId, range) { const history = await apiRequest(`/api/monitoring/history/${deviceId}?hours=${historyHours(range)}`); return (Array.isArray(history) ? history : []).map((entry) => { const checkedAt = normalizeMonitoringTimestamp(entry.checkedAt); return { deviceId, status: entry.isUp ? "UP" : "DOWN", latency: entry.latencyMs == null ? "â€”" : `${entry.latencyMs} ms`, time: formatDateTime(checkedAt), checkedAt, latencyMs: entry.latencyMs, isUp: entry.isUp, errorMessage: entry.errorMessage || null }; }); }
async function loadDashboardHistory(force = false) { const now = Date.now(); if (!force && state.lastDashboardHistoryAt && now - state.lastDashboardHistoryAt < 15000) return false; const histories = await Promise.all(state.devices.map(async (device) => { try { return await fetchHistory(device.id, state.dashboardRange); } catch (error) { console.error(`Unable to load history for device ${device.id}`, error); return []; } })); const nextHistory = histories.flat().sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt)); const signature = nextHistory.map((entry) => `${entry.checkedAt}:${entry.latencyMs}:${entry.isUp}`).join("|"); const changed = signature !== state.dashboardHistorySignature; state.dashboardHistory = nextHistory; state.dashboardHistorySignature = signature; state.lastDashboardHistoryAt = now; return changed; }
function renderDashboardAnalytics() {
  const chart = document.getElementById("dashboardLatencyChart");
  const averageSummary = document.getElementById("dashboardAverageLatencySummary");
  const averageStat = document.getElementById("dashboardAverageLatencyStat");
  const max = document.getElementById("dashboardMaxLatency");
  const current = document.getElementById("dashboardCurrentLatency");
  const alertList = document.getElementById("dashboardRecentAlerts");
  const alertCount = document.getElementById("dashboardAlertCount");
  if (!chart || !alertList) return;

  const filteredHistory = filterHistoryByRange(state.dashboardHistory, state.dashboardRange);
  const visibleHistory = state.dashboardDeviceId === "all"
    ? aggregateDashboardHistory(filteredHistory)
    : filteredHistory.filter((entry) => String(entry.deviceId) === String(state.dashboardDeviceId));

  const numericSamples = visibleHistory
    .map((entry) => Number(entry.latencyMs))
    .filter((value) => Number.isFinite(value));

  const averageValue = numericSamples.length ? numericSamples.reduce((sum, value) => sum + value, 0) / numericSamples.length : null;
  const maxValue = numericSamples.length ? Math.max(...numericSamples) : null;
  const currentValue = numericSamples.length ? numericSamples[numericSamples.length - 1] : null;

  if (averageSummary) averageSummary.textContent = averageValue === null ? "--" : `${formatMetricValue(averageValue)} ms`;
  if (averageStat) averageStat.textContent = averageValue === null ? "--" : `${formatMetricValue(averageValue)} ms`;
  if (max) max.textContent = maxValue === null ? "--" : `${formatMetricValue(maxValue)} ms`;
  if (current) current.textContent = currentValue === null ? "--" : `${formatMetricValue(currentValue)} ms`;

  chart.innerHTML = renderDashboardChart(visibleHistory);
  alertCount.textContent = String(state.alerts.length);
  alertList.innerHTML = state.alerts.length
    ? state.alerts.slice(0, 5).map((alert) => `<div class="recent-alert"><span class="recent-alert-dot ${String(alert.event).toLowerCase().includes("down") ? "down" : String(alert.event).toLowerCase().includes("recover") ? "recovery" : "neutral"}"></span><div><strong>${escapeHtml(alert.event)}</strong><span>${escapeHtml(alert.device)}${alert.ip ? ` · ${escapeHtml(alert.ip)}` : ""}</span></div><time>${escapeHtml(alert.time)}</time></div>`).join("")
    : '<div class="recent-alert"><span class="recent-alert-dot neutral"></span><div><strong>No recent alerts</strong><span>All systems are healthy.</span></div><time>Now</time></div>';
}

function filterHistoryByRange(history, range) {
  if (!Array.isArray(history) || !history.length) return [];
  const hours = historyHours(range);
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  return history.filter((entry) => {
    const time = new Date(entry.checkedAt).getTime();
    return Number.isFinite(time) && time >= cutoff;
  });
}

function aggregateDashboardHistory(history) {
  if (!Array.isArray(history) || !history.length) return [];

  const cutoffHours = historyHours(state.dashboardRange);
  const start = Date.now() - (cutoffHours * 60 * 60 * 1000);
  const bucketMs = Math.max(300000, ((cutoffHours * 60 * 60 * 1000) / 30));
  const buckets = new Map();

  for (const entry of history) {
    const checkedAt = new Date(entry.checkedAt).getTime();
    if (!Number.isFinite(checkedAt)) continue;
    const bucketKey = Math.floor((checkedAt - start) / bucketMs) * bucketMs + start;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { checkedAt: new Date(bucketKey).toISOString(), values: [], down: false });
    }
    const bucket = buckets.get(bucketKey);
    const value = Number(entry.latencyMs);
    if (Number.isFinite(value)) bucket.values.push(value);
    if (entry.isUp === false) bucket.down = true;
  }

  return Array.from(buckets.values())
    .map((bucket) => ({
      checkedAt: bucket.checkedAt,
      deviceId: "all",
      latencyMs: bucket.values.length ? bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length : null,
      isUp: !bucket.down
    }))
    .sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt));
}

function formatMetricValue(value) {
  if (!Number.isFinite(Number(value))) return "--";
  const numeric = Number(value);
  if (numeric >= 100) return numeric.toFixed(0);
  if (numeric >= 10) return numeric.toFixed(1);
  return numeric.toFixed(2);
}

function getDashboardMaxY(values) {
  const highest = Math.max(1, ...values.filter((value) => Number.isFinite(value)));
  if (highest <= 1.5) return 2;
  if (highest <= 2.5) return 5;
  if (highest <= 5) return 10;
  if (highest <= 10) return 20;
  if (highest <= 20) return 50;
  if (highest <= 50) return 100;
  if (highest <= 100) return 200;
  return 500;
}

function renderDashboardChart(history) {
  const series = (Array.isArray(history) ? history : [])
    .filter((entry) => entry && entry.checkedAt)
    .sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt));

  if (!series.length) return '<div class="dashboard-chart-empty">No monitoring data available.</div>';

  const width = 760;
  const height = 240;
  const left = 44;
  const right = 18;
  const top = 16;
  const bottom = 30;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const baseY = height - bottom;

  const numericValues = series.map((entry) => Number(entry.latencyMs)).filter((value) => Number.isFinite(value));
  if (!numericValues.length) return '<div class="dashboard-chart-empty">No monitoring data available.</div>';

  const maxValue = getDashboardMaxY(numericValues);
  const minTime = new Date(series[0].checkedAt).getTime();
  const maxTime = new Date(series[series.length - 1].checkedAt).getTime();
  const timeRange = Math.max(1, maxTime - minTime);

  const points = series
    .map((entry) => {
      const latency = Number(entry.latencyMs);
      const time = new Date(entry.checkedAt).getTime();
      const xRatio = timeRange === 0 ? 0.5 : (time - minTime) / timeRange;
      const x = left + xRatio * plotWidth;
      const y = Number.isFinite(latency)
        ? top + plotHeight - (latency / maxValue) * plotHeight
        : baseY;
      return { x, y, latency, checkedAt: entry.checkedAt, isUp: entry.isUp };
    })
    .filter((point) => point && Number.isFinite(point.x));

  if (!points.length) return '<div class="dashboard-chart-empty">No monitoring data available.</div>';

  const path = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const areaPath = `${path} L ${points[points.length - 1].x.toFixed(2)} ${baseY} L ${points[0].x.toFixed(2)} ${baseY} Z`;

  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = top + (plotHeight * ratio);
    const label = Math.round(maxValue * (1 - ratio));
    return `<line class="dashboard-grid-line" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="dashboard-axis" x="8" y="${y + 4}">${label} ms</text>`;
  }).join("");

  const xTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const x = left + ratio * plotWidth;
    const timeValue = minTime + timeRange * ratio;
    return `<line class="dashboard-grid-line vertical" x1="${x}" y1="${top}" x2="${x}" y2="${baseY}"/><text class="dashboard-axis" x="${x}" y="${height - 8}" text-anchor="middle">${formatChartTime(new Date(timeValue), state.dashboardRange)}</text>`;
  }).join("");

  const downMarkers = series
    .filter((entry) => entry.isUp === false)
    .map((entry) => {
      const time = new Date(entry.checkedAt).getTime();
      const x = left + ((time - minTime) / timeRange) * plotWidth;
      const latency = Number(entry.latencyMs);
      const y = Number.isFinite(latency) ? top + plotHeight - (latency / maxValue) * plotHeight : baseY;
      return `<circle class="dashboard-point down" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="4.5"><title>${escapeHtml(formatDateTime(entry.checkedAt))} | ${Number.isFinite(latency) ? `${formatMetricValue(latency)} ms` : "DOWN"}</title></circle>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Real network latency history"><defs><linearGradient id="dashboardAreaFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#34d399" stop-opacity="0.38"/><stop offset="100%" stop-color="#34d399" stop-opacity="0.04"/></linearGradient></defs><g>${yTicks}${xTicks}</g><path class="dashboard-area" d="${areaPath}"/><path class="dashboard-line" d="${path}"/>${downMarkers}</svg>`;
}

function formatChartTime(value, range = "24H") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const hours = historyHours(range);
  if (hours <= 12) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (hours <= 72) return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return date.toLocaleString([], { month: "short", day: "numeric" });
}

function renderHistoryEntries(list, entries) { if (!list) return; list.innerHTML = entries.length ? entries.slice(-100).reverse().map((entry) => `<div class="history-item"><div><strong>${entry.status}</strong><div><span>${entry.time}</span></div></div><div><span>${entry.latency}</span></div></div>`).join("") : '<div class="history-item"><div><strong>No monitoring history available.</strong></div></div>'; }
async function renderDetailHistory(deviceId, range) { try { renderHistoryEntries(document.getElementById("detailHistoryList"), await fetchHistory(deviceId, range)); } catch (error) { console.error(error); renderHistoryEntries(document.getElementById("detailHistoryList"), []); } }
async function renderHistory(deviceId, range) { try { renderHistoryEntries(document.getElementById("historyList"), await fetchHistory(deviceId, range)); } catch (error) { console.error(error); renderHistoryEntries(document.getElementById("historyList"), []); } }

function renderAlerts() { const list = document.getElementById("alertsList"); if (!list) return; list.innerHTML = state.alerts.slice(0, 4).map((alert) => `<div class="alert-item"><strong>${escapeHtml(alert.event)}</strong><div><div>${escapeHtml(alert.device)}</div><small>${escapeHtml(alert.ip)}</small></div><span>${escapeHtml(alert.time)}</span><div class="alert-actions"><button class="secondary-button" type="button" data-alert-action="ack" data-alert-id="${alert.id}">Acknowledge</button><button class="secondary-button" type="button" data-alert-action="delete" data-alert-id="${alert.id}">Delete</button></div></div>`).join(""); }
function renderAlertsPanel() { const panelList = document.getElementById("alertsPanelList"); if (!panelList) return; panelList.innerHTML = state.alerts.length ? state.alerts.map((alert) => `<div class="alert-item ${alert.event === "DOWN" ? "alert-down" : "alert-recovery"}"><strong>${escapeHtml(alert.event)}</strong><div><div>${escapeHtml(alert.device)}</div><small>${escapeHtml(alert.ip)}</small></div><div><small>Group</small><div>${escapeHtml(alert.group)}</div></div><span>${escapeHtml(alert.time)}</span><div class="alert-actions"><button class="secondary-button" type="button" data-alert-action="ack" data-alert-id="${alert.id}">${alert.acknowledged ? "Acknowledged" : "Acknowledge"}</button><button class="secondary-button" type="button" data-alert-action="delete" data-alert-id="${alert.id}">Delete</button></div></div>`).join("") : '<div class="empty-state alert-empty"><div class="inner"><h3>No active alerts</h3><p>All monitored devices are operating normally.</p></div></div>'; }
async function acknowledgeAlert(alertId) { try { await apiRequest(`/api/alerts/${alertId}/acknowledge`, { method: "PATCH" }); await refreshDashboard(); showToast("Alert acknowledged."); } catch (error) { console.error(error); showToast("Unable to acknowledge alert."); } }
async function deleteAlert(alertId) { try { await apiRequest(`/api/alerts/${alertId}`, { method: "DELETE" }); await refreshDashboard(); showToast("Alert deleted."); } catch (error) { console.error(error); showToast("Unable to delete alert."); } }

async function handleSettingsSubmit(event) { event.preventDefault(); const form = event.currentTarget; const formData = new FormData(form); const payload = { defaultPingIntervalSeconds: Number(formData.get("defaultPingInterval") || 5), pingTimeoutMilliseconds: Number(formData.get("pingTimeout") || 2000), historyRetentionHours: Number(formData.get("historyRetention") || 72), monitoringEnabled: formData.get("monitoringEnabled") === "on" }; try { await apiRequest("/api/settings", { method: "PUT", body: JSON.stringify(payload) }); state.settings.defaultPingInterval = payload.defaultPingIntervalSeconds; state.settings.pingTimeout = payload.pingTimeoutMilliseconds; state.settings.historyRetention = payload.historyRetentionHours; state.settings.monitoringEnabled = payload.monitoringEnabled; state.settings.alertSoundEnabled = formData.get("alertSoundEnabled") === "on"; state.settings.alertVolume = Number(formData.get("alertVolume") || 0); saveSettings(); renderSettingsForm(); showToast("Settings saved."); } catch (error) { console.error(error); showToast(error.message || "Unable to save settings."); } }
function renderSettingsForm() { const form = document.getElementById("settingsForm"); if (!form) return; form.elements.defaultPingInterval.value = state.settings.defaultPingInterval; form.elements.pingTimeout.value = state.settings.pingTimeout; form.elements.historyRetention.value = state.settings.historyRetention; form.elements.monitoringEnabled.checked = Boolean(state.settings.monitoringEnabled); form.elements.alertSoundEnabled.checked = Boolean(state.settings.alertSoundEnabled); form.elements.alertVolume.value = Number(state.settings.alertVolume ?? 0.35); }

function exportConfiguration() { const payload = { groups: state.groups, devices: state.devices, alerts: state.alerts, settings: state.settings }; const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "inframonitor-config.json"; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); showToast("Configuration exported."); }

async function importConfiguration(event) { const file = event.target.files && event.target.files[0]; if (!file) return; try { const text = await file.text(); const json = JSON.parse(text); if (!json || !Array.isArray(json.groups) || !Array.isArray(json.devices)) throw new Error("Invalid configuration file"); state.groups = json.groups; state.devices = json.devices; state.alerts = Array.isArray(json.alerts) ? json.alerts : state.alerts; state.settings = { ...DEFAULT_SETTINGS, ...(json.settings || {}) }; saveSettings(); saveAlerts(); renderGroupFilter(); renderSummary(); renderMonitor(); renderAlerts(); renderAlertsPanel(); renderSettingsForm(); showToast("Configuration imported."); } catch (error) { console.error(error); showToast("Invalid JSON configuration."); } finally { event.target.value = ""; } }

function handleResizeMove(event) { if (!dragState) return; const delta = event.clientX - dragState.startX; const nextValue = dragState.startWidth + delta; const min = MIN_WIDTHS[dragState.key]; const max = dragState.key === "deviceName" ? 340 : 220; state.layout[dragState.key] = clampNumber(nextValue, min, max, DEFAULT_LAYOUT[dragState.key]); applyColumnLayout(); saveLayout(); }
function handleResizeEnd() { dragState = null; document.removeEventListener("pointermove", handleResizeMove); }
function openReportModal() { const reportGroup = document.querySelector('select[name="reportGroup"]'); const reportDevice = document.querySelector('select[name="reportDevice"]'); if (reportGroup) reportGroup.innerHTML = '<option value="all">All Groups</option>' + state.groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join(""); if (reportDevice) reportDevice.innerHTML = '<option value="all">All Devices</option>' + state.devices.map((device) => `<option value="${device.id}">${escapeHtml(device.name)}</option>`).join(""); const modal = document.getElementById("reportModal"); modal.classList.remove("hidden"); modal.setAttribute("aria-hidden", "false"); }

function handleReportSubmit(event) { event.preventDefault(); const formData = new FormData(event.currentTarget); const reportRange = formData.get("reportRange"); const reportGroup = formData.get("reportGroup") || "all"; const reportDevice = formData.get("reportDevice") || "all"; const reportStatus = formData.get("reportStatus") || "all"; const filtered = state.devices.filter((device) => { const groupMatch = reportGroup === "all" || String(device.groupId) === String(reportGroup); const deviceMatch = reportDevice === "all" || String(device.id) === String(reportDevice); const statusMatch = reportStatus === "all" || getStatusKey(device) === reportStatus; return groupMatch && deviceMatch && statusMatch; }); const summary = { total: filtered.length, up: filtered.filter((device) => getStatusKey(device) === "up").length, down: filtered.filter((device) => getStatusKey(device) === "down").length, unknown: filtered.filter((device) => getStatusKey(device) === "unknown").length }; const availability = filtered.reduce((acc, device) => { const status = getStatusKey(device); acc.uptime += status === "up" ? 1 : 0; acc.downtime += status === "down" ? 1 : 0; acc.outages += Array.isArray(device.history) ? device.history.filter((entry) => String(entry.newStatus || "").toLowerCase() === "down").length : 0; if (device.statusChangedAt) acc.lastRecovery = acc.lastRecovery || device.statusChangedAt; return acc; }, { uptime: 0, downtime: 0, outages: 0, lastRecovery: null }); const reportWindow = window.open("", "_blank", "width=1000,height=800"); if (!reportWindow) { showToast("Popup blocked. Allow popups to generate the report."); return; } const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19); const groupRows = state.groups.map((group) => { const groupDevices = filtered.filter((device) => Number(device.groupId) === Number(group.id)); const groupSummary = { total: groupDevices.length, up: groupDevices.filter((device) => getStatusKey(device) === "up").length, down: groupDevices.filter((device) => getStatusKey(device) === "down").length, unknown: groupDevices.filter((device) => getStatusKey(device) === "unknown").length }; return `<tr><td>${escapeHtml(group.name)}</td><td>${groupSummary.total}</td><td>${groupSummary.up}</td><td>${groupSummary.down}</td><td>${groupSummary.unknown}</td></tr>`; }).join(""); const deviceRows = filtered.map((device) => `<tr><td>${escapeHtml(device.name)}</td><td>${escapeHtml(device.ipAddress)}</td><td>${escapeHtml(state.groups.find((group) => Number(group.id) === Number(device.groupId))?.name || "Unassigned")}</td><td>${getDeviceStatus(device).label}</td><td>${formatLatency(device.lastLatencyMs, device.status)}</td><td>${device.lastChecked ? formatDateTime(device.lastChecked) : "Never"}</td></tr>`).join(""); const content = `<!doctype html><html><head><meta charset="utf-8" /><title>InfraMonitor Report</title><style>body{font-family:Arial,sans-serif;color:#0f172a;background:#fff;margin:32px;}h1,h2{margin-bottom:8px;}table{width:100%;border-collapse:collapse;margin-top:12px;}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left;font-size:12px;}th{background:#e2e8f0;}.section{margin-top:24px;}.muted{color:#475569;}</style></head><body><h1>INFRA MONITOR</h1><h2>Infrastructure Monitoring Report</h2><div class="muted">Report Generated: ${generatedAt}</div><div class="section"><h3>SUMMARY</h3><table><tr><th>Total Devices</th><th>UP</th><th>DOWN</th><th>UNKNOWN</th></tr><tr><td>${summary.total}</td><td>${summary.up}</td><td>${summary.down}</td><td>${summary.unknown}</td></tr></table></div><div class="section"><h3>GROUP SUMMARY</h3><table><tr><th>Group</th><th>Total</th><th>UP</th><th>DOWN</th><th>UNKNOWN</th></tr>${groupRows || '<tr><td colspan="5">No groups configured.</td></tr>'}</table></div><div class="section"><h3>DEVICE STATUS</h3><table><tr><th>Device Name</th><th>IP Address</th><th>Group</th><th>Status</th><th>Latency</th><th>Last Checked</th></tr>${deviceRows || '<tr><td colspan="6">No devices configured.</td></tr>'}</table></div><div class="section"><h3>ALERTS / EVENTS</h3><table><tr><th>Timestamp</th><th>Device</th><th>Event</th><th>Status</th><th>Latency</th></tr>${state.alerts.length ? state.alerts.map((alert) => `<tr><td>${escapeHtml(alert.time)}</td><td>${escapeHtml(alert.device)}</td><td>${escapeHtml(alert.event)}</td><td>${escapeHtml(alert.acknowledged ? "ACKNOWLEDGED" : "OPEN")}</td><td>â€”</td></tr>`).join("") : '<tr><td colspan="5">No alerts available.</td></tr>'}</table></div><div class="section"><h3>AVAILABILITY</h3><table><tr><th>Uptime</th><th>Downtime</th><th>Outages</th><th>Last Outage</th><th>Last Recovery</th></tr><tr><td>${availability.uptime}</td><td>${availability.downtime}</td><td>${availability.outages}</td><td>â€”</td><td>${availability.lastRecovery ? formatDateTime(availability.lastRecovery) : "â€”"}</td></tr></table></div><div class="section"><h3>HISTORY</h3><div class="muted">No monitoring history available.</div></div></body></html>`; reportWindow.document.write(content); reportWindow.document.close(); reportWindow.focus(); reportWindow.print?.(); closeModal("reportModal"); showToast("Report generated."); }

function formatDateTime(value) { if (!value) return "Never"; const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value); return date.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function formatDuration(seconds) { if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "â€”"; const mins = Math.floor(seconds / 60); const secs = seconds % 60; return `${mins}m ${secs}s`; }
function applyTvMode() { document.body.classList.toggle("tv-mode", Boolean(state.settings.tvMode)); const tvButton = document.getElementById("tvModeButton"); if (tvButton) tvButton.classList.toggle("active", Boolean(state.settings.tvMode)); stopTvScroll(); if (state.settings.tvMode) startTvScroll(); }
function stopTvScroll() { if (state.tvTimer) cancelAnimationFrame(state.tvTimer); clearTimeout(state.tvResumeTimer); state.tvTimer = null; state.tvResumeTimer = null; }
function pauseTvScroll() { state.tvScrollPaused = true; clearTimeout(state.tvResumeTimer); state.tvResumeTimer = setTimeout(() => { state.tvScrollPaused = false; }, 4000); }
function startTvScroll() { stopTvScroll(); const wall = document.querySelector("body.tv-mode #monitorList"); if (!wall) return; const tick = () => { const maxScroll = wall.scrollHeight - wall.clientHeight; if (!state.tvScrollPaused && maxScroll > 0) { wall.scrollTop += 0.35 * state.tvScrollDirection; if (wall.scrollTop >= maxScroll - 1) { state.tvScrollDirection = -1; pauseTvScroll(); } else if (wall.scrollTop <= 1) { state.tvScrollDirection = 1; pauseTvScroll(); } } state.tvTimer = requestAnimationFrame(tick); }; if (!wall.dataset.scrollBound) { wall.onpointerenter = pauseTvScroll; wall.onpointerleave = () => { clearTimeout(state.tvResumeTimer); state.tvResumeTimer = setTimeout(() => { state.tvScrollPaused = false; }, 1200); }; wall.onwheel = pauseTvScroll; wall.onpointerdown = pauseTvScroll; wall.dataset.scrollBound = "true"; } state.tvTimer = requestAnimationFrame(tick); }
function showToast(message) { const toast = document.getElementById("toast"); toast.textContent = message; toast.classList.add("visible"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("visible"), 1800); }
function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;"); }

const legacyOpenDeviceDetails = openDeviceDetails;
openDeviceDetails = async function (deviceId) {
  const device = state.devices.find((entry) => Number(entry.id) === Number(deviceId));
  if (!device) return;
  try {
    device.history = await apiRequest(`/api/monitoring/history/${device.id}?hours=${historyHours(state.historyRange)}`);
  } catch (error) {
    console.error(error);
    device.history = [];
  }
  document.getElementById("deviceDetailModal").dataset.deviceId = String(deviceId);
  legacyOpenDeviceDetails(deviceId);
  const rangeGroup = document.querySelector("#deviceDetailContent .time-range-group");
  if (rangeGroup && !rangeGroup.querySelector('[data-range="LIVE"]')) {
    rangeGroup.insertAdjacentHTML("afterbegin", `<button class="range-button live-range ${state.historyRange === "LIVE" ? "active" : ""}" type="button" data-range="LIVE">LIVE</button>`);
  }
};

renderHistorySvg = function (device) {
  const history = Array.isArray(device.history) ? [...device.history].sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt)) : [];
  if (!history.length) return `<div class="history-empty">No monitoring history available.</div>`;
  const width = 760;
  const height = 220;
  const left = 42;
  const right = 12;
  const top = 22;
  const bottom = 34;
  const latencyValues = history.map((entry) => Number(entry.latencyMs)).filter(Number.isFinite);
  const maxLatency = Math.max(10, ...latencyValues);
  const averageLatency = latencyValues.length ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length * 10) / 10 : 0;
  const latest = history.at(-1);
  const downCount = history.filter((entry) => !entry.isUp).length;
  const upPercent = Math.round(history.filter((entry) => entry.isUp).length / history.length * 100);
  const samples = downsampleHistory(history.filter((entry) => Number.isFinite(Number(entry.latencyMs))), 260);
  const firstTime = new Date(history[0].checkedAt).getTime();
  const lastTime = new Date(latencyValues.length ? history.at(-1).checkedAt : history[0].checkedAt).getTime();
  const x = (entry, index) => left + (index * (width - left - right)) / Math.max(1, samples.length - 1);
  const timeX = (entry) => left + (width - left - right) * Math.max(0, Math.min(1, (new Date(entry.checkedAt).getTime() - firstTime) / Math.max(1, lastTime - firstTime)));
  const y = (entry) => top + (height - top - bottom) * (1 - Number(entry.latencyMs) / maxLatency);
  const line = samples.map((entry, index) => `${x(entry, index)},${y(entry)}`).join(" ");
  const events = history.filter((entry, index) => index > 0 && entry.isUp !== history[index - 1].isUp).map((entry) => ({ entry, type: entry.isUp ? "RECOVERED" : "DOWN" }));
  const markers = events.map(({ entry, type }) => `<circle class="${type === "DOWN" ? "status-down" : "status-recovery"}" cx="${timeX(entry)}" cy="${entry.isUp && Number.isFinite(Number(entry.latencyMs)) ? y(entry) : height - bottom}" r="5"><title>${escapeHtml(formatDateTime(entry.checkedAt))} | ${type} | ${entry.latencyMs == null ? (entry.errorMessage || "ICMP timeout") : `${entry.latencyMs} ms`}</title></circle>`).join("");
  const timeline = events.slice(-8).reverse().map(({ entry, type }) => `<div class="event-timeline-item ${type === "DOWN" ? "event-down" : "event-recovery"}"><span class="event-timeline-dot"></span><time>${escapeHtml(formatDateTime(entry.checkedAt))}</time><strong>${type}</strong><span>${entry.latencyMs == null ? escapeHtml(entry.errorMessage || "ICMP timeout") : `${entry.latencyMs} ms`}</span></div>`).join("");
  return `<div class="history-chart-shell"><div class="history-chart-summary"><div><span class="chart-kicker">CURRENT LATENCY</span><strong>${latest.latencyMs == null ? "TIMEOUT" : `${latest.latencyMs} ms`}</strong></div><div><span class="chart-kicker">AVERAGE</span><strong>${averageLatency} ms</strong></div><div><span class="chart-kicker">AVAILABILITY</span><strong>${upPercent}%</strong></div><div><span class="chart-kicker">EVENTS</span><strong>${events.length}</strong></div></div><div class="history-chart-key"><span><i class="key-line"></i>LATENCY</span><span><i class="key-dot down"></i>DOWN</span><span><i class="key-dot recovery"></i>RECOVERED</span>${downCount ? `<span class="down-count">${downCount} DOWN SAMPLES</span>` : ""}</div><svg class="history-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Real monitoring latency and status history"><g class="chart-grid"><line x1="${left}" y1="${top}" x2="${width - right}" y2="${top}" /><line x1="${left}" y1="${(top + height - bottom) / 2}" x2="${width - right}" y2="${(top + height - bottom) / 2}" /><line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" /><line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" /></g>${line ? `<polyline class="latency-line" points="${line}" />` : ""}${markers}<text class="chart-axis" x="4" y="${top + 4}">${maxLatency} ms</text><text class="chart-axis" x="8" y="${height - bottom + 4}">0 ms</text><text class="chart-axis" x="${left}" y="${height - 8}">${escapeHtml(formatChartTime(history[0].checkedAt))}</text><text class="chart-axis" text-anchor="end" x="${width - right}" y="${height - 8}">${escapeHtml(formatChartTime(history.at(-1).checkedAt))}</text></svg>${timeline ? `<div class="event-timeline"><span class="chart-kicker">EVENT TIMELINE</span>${timeline}</div>` : ""}</div>`;
};

handleReportSubmit = async function (event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const groupId = data.get("reportGroup") || "all";
  const deviceId = data.get("reportDevice") || "all";
  const status = data.get("reportStatus") || "all";
  const devices = state.devices.filter((device) => (groupId === "all" || String(device.groupId) === String(groupId)) && (deviceId === "all" || String(device.id) === String(deviceId)) && (status === "all" || getStatusKey(device) === status));
  const reportRange = data.get("reportRange") || "24H";
  const histories = await Promise.all(devices.map(async (device) => ({ device, history: await fetchHistory(device.id, reportRange) })));
  const rows = histories.flatMap(({ device, history }) => history.map((entry) => `<tr><td>${escapeHtml(device.name)}</td><td>${escapeHtml(device.ipAddress)}</td><td>${entry.time}</td><td>${entry.status}</td><td>${entry.latency}</td></tr>`)).join("");
  const generated = formatDateTime(new Date().toISOString());
  const reportWindow = window.open("", "_blank", "width=1000,height=800");
  if (!reportWindow) { showToast("Popup blocked. Allow popups to generate the report."); return; }
  reportWindow.document.write(`<!doctype html><html><head><title>Infrastructure Monitoring Report</title><style>body{font:14px Arial;color:#102030;margin:32px}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #b9c6d2;padding:8px;text-align:left}th{background:#e7eef5}.muted{color:#596b7b}</style></head><body><h1>INFRASTRUCTURE MONITORING REPORT</h1><p class="muted">Generated: ${generated}</p><h2>SUMMARY</h2><p>Total: ${devices.length} | UP: ${devices.filter((d) => getStatusKey(d) === "up").length} | DOWN: ${devices.filter((d) => getStatusKey(d) === "down").length} | UNKNOWN: ${devices.filter((d) => ["unknown", "checking"].includes(getStatusKey(d))).length}</p><h2>MONITORING HISTORY</h2><table><thead><tr><th>Device</th><th>IP Address</th><th>Timestamp</th><th>Status</th><th>Latency</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No monitoring history available.</td></tr>'}</tbody></table></body></html>`);
  reportWindow.document.close();
  reportWindow.focus();
  reportWindow.print?.();
};

document.addEventListener("DOMContentLoaded", init);


