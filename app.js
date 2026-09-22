const STORAGE_LAYOUT_KEY = "infraMonitor.layout.v1";
const STORAGE_SETTINGS_KEY = "infraMonitor.settings.v1";
const STORAGE_ALERTS_KEY = "infraMonitor.alerts.v1";
const API_BASE = window.location.origin || "http://localhost:5041";

const DEFAULT_LAYOUT = {
  deviceName: 220,
  status: 90,
  latency: 80,
  ipAddress: 150,
  actions: 180,
};

const MIN_WIDTHS = {
  deviceName: 180,
  status: 72,
  latency: 70,
  ipAddress: 120,
  actions: 150,
};

const DEFAULT_SETTINGS = {
  defaultPingInterval: 5,
  pingTimeout: 2000,
  historyRetention: 72,
  monitoringEnabled: true,
  tvMode: false,
};

const state = {
  groups: [],
  devices: [],
  alerts: [],
  settings: loadSettings(),
  filters: { search: "", group: "all", status: "all" },
  layout: loadLayout(),
  modal: { type: null, id: null },
  historyRange: "24H",
};

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

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
  if (device.lastChecked == null && device.lastSeen == null && device.lastLatencyMs == null) {
    return "unknown";
  }
  return device.isUp === true ? "up" : device.isUp === false ? "down" : "unknown";
}

async function refreshDashboard() {
  try {
    const [groups, devices, summary, alerts, settings] = await Promise.all([
      apiRequest("/api/groups"),
      apiRequest("/api/devices"),
      apiRequest("/api/monitoring/summary"),
      apiRequest("/api/alerts?limit=20"),
      apiRequest("/api/settings"),
    ]);

    state.groups = Array.isArray(groups) ? groups : [];
    state.devices = Array.isArray(devices) ? devices.map(normalizeDevice) : [];
    state.alerts = Array.isArray(alerts) ? alerts.map((alert) => ({
      id: alert.id,
      event: alert.eventType || alert.message || "Alert",
      device: alert.device || alert.deviceName || "Unknown device",
      ip: alert.ipAddress || "",
      time: alert.createdAt ? formatDateTime(alert.createdAt) : "Unknown",
      acknowledged: Boolean(alert.isAcknowledged),
    })) : [];
    state.settings = {
      ...DEFAULT_SETTINGS,
      ...state.settings,
      defaultPingInterval: Number(settings?.defaultPingIntervalSeconds ?? state.settings.defaultPingInterval ?? 5),
      pingTimeout: Number(settings?.pingTimeoutMilliseconds ?? state.settings.pingTimeout ?? 2000),
      historyRetention: Number(settings?.historyRetentionHours ?? state.settings.historyRetention ?? 72),
      monitoringEnabled: settings?.monitoringEnabled ?? state.settings.monitoringEnabled ?? true,
    };

    saveSettings();
    renderSettingsForm();
    renderGroupFilter();
    renderSummaryFromApi(summary);
    renderMonitor();
    renderAlerts();
    renderAlertsPanel();
    updateStatusBadge();
  } catch (error) {
    console.error("Unable to load backend data", error);
    showToast("Backend unavailable. Please check the API service.");
  }
}

function renderSummaryFromApi(summary) {
  const total = Number(summary?.total ?? state.devices.length ?? 0);
  const up = Number(summary?.up ?? state.devices.filter((device) => getStatusKey(device) === "up").length ?? 0);
  const down = Number(summary?.down ?? state.devices.filter((device) => getStatusKey(device) === "down").length ?? 0);
  const unknown = Math.max(0, total - up - down);

  document.getElementById("totalDevices").textContent = String(total);
  document.getElementById("upDevices").textContent = String(up);
  document.getElementById("downDevices").textContent = String(down);
  document.getElementById("unknownDevices").textContent = String(unknown);
}

let dragState = null;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_SETTINGS_KEY) || "null");
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  } catch (error) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(state.settings));
}

function loadAlerts() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_ALERTS_KEY) || "null");
    if (Array.isArray(saved)) {
      return saved;
    }
  } catch (error) {
    // ignore
  }
  return [];
}

function saveAlerts() {
  localStorage.setItem(STORAGE_ALERTS_KEY, JSON.stringify(state.alerts));
}

function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_LAYOUT_KEY);
    if (!raw) {
      return { ...DEFAULT_LAYOUT };
    }

    const parsed = JSON.parse(raw);
    return {
      deviceName: clampNumber(parsed.deviceName, MIN_WIDTHS.deviceName, 340, DEFAULT_LAYOUT.deviceName),
      status: clampNumber(parsed.status, MIN_WIDTHS.status, 180, DEFAULT_LAYOUT.status),
      latency: clampNumber(parsed.latency, MIN_WIDTHS.latency, 180, DEFAULT_LAYOUT.latency),
      ipAddress: clampNumber(parsed.ipAddress, MIN_WIDTHS.ipAddress, 240, DEFAULT_LAYOUT.ipAddress),
      actions: clampNumber(parsed.actions, MIN_WIDTHS.actions, 260, DEFAULT_LAYOUT.actions),
    };
  } catch (error) {
    return { ...DEFAULT_LAYOUT };
  }
}

function saveLayout() {
  localStorage.setItem(STORAGE_LAYOUT_KEY, JSON.stringify(state.layout));
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

function updateStatusBadge() {
  const badge = document.getElementById("backendStatus");
  if (!badge) return;
  badge.classList.remove("status-sample");
  badge.innerHTML = "<span></span>READY";
}

function applyColumnLayout() {
  const root = document.documentElement;
  root.style.setProperty("--device-col-width", `${state.layout.deviceName}px`);
  root.style.setProperty("--status-col-width", `${state.layout.status}px`);
  root.style.setProperty("--latency-col-width", `${state.layout.latency}px`);
  root.style.setProperty("--ip-col-width", `${state.layout.ipAddress}px`);
  root.style.setProperty("--action-col-width", `${state.layout.actions}px`);
}

function resetLayout() {
  state.layout = { ...DEFAULT_LAYOUT };
  saveLayout();
  applyColumnLayout();
  renderMonitor();
  showToast("Layout reset.");
}

async function init() {
  applyColumnLayout();
  updateStatusBadge();
  bindEvents();
  renderSettingsForm();
  applyTvMode();

  try {
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    showToast("Unable to load the backend dashboard data.");
  }
}

function bindEvents() {
  document.getElementById("refreshButton").addEventListener("click", async () => {
    try {
      await refreshDashboard();
      showToast("Dashboard refreshed.");
    } catch (error) {
      console.error(error);
      showToast("Refresh failed.");
    }
  });

  document.getElementById("resetLayoutBtn").addEventListener("click", resetLayout);
  document.getElementById("addDeviceButton").addEventListener("click", () => openDeviceModal("add"));
  document.getElementById("addGroupButton").addEventListener("click", () => openGroupModal("add"));
  document.getElementById("generateReportButton").addEventListener("click", () => openReportModal());
  document.getElementById("tvModeButton").addEventListener("click", () => {
    state.settings.tvMode = !state.settings.tvMode;
    saveSettings();
    applyTvMode();
    showToast(state.settings.tvMode ? "TV Mode enabled." : "TV Mode disabled.");
  });

  document.getElementById("searchInput").addEventListener("input", (event) => {
    state.filters.search = event.target.value.trim();
    renderMonitor();
  });

  document.getElementById("groupFilter").addEventListener("change", (event) => {
    state.filters.group = event.target.value;
    renderMonitor();
  });

  document.getElementById("statusFilter").addEventListener("change", (event) => {
    state.filters.status = event.target.value;
    renderMonitor();
  });

  document.getElementById("deviceForm").addEventListener("submit", handleDeviceSubmit);
  document.getElementById("groupForm").addEventListener("submit", handleGroupSubmit);
  document.getElementById("settingsForm").addEventListener("submit", handleSettingsSubmit);
  document.getElementById("reportForm").addEventListener("submit", handleReportSubmit);
  document.getElementById("exportConfigButton").addEventListener("click", exportConfiguration);
  document.getElementById("importConfigInput").addEventListener("change", importConfiguration);

  document.body.addEventListener("click", (event) => {
    const closeTarget = event.target.closest("[data-close-modal]");
    if (closeTarget) {
      const modalId = closeTarget.getAttribute("data-close-modal");
      closeModal(modalId);
    }

    const navButton = event.target.closest("[data-view]");
    if (navButton) {
      switchPanel(navButton.dataset.view);
    }

    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      const action = actionButton.dataset.action;
      const deviceId = Number(actionButton.dataset.deviceId || 0);
      if (action === "history") {
        openHistoryModal(deviceId);
      }
      if (action === "edit") {
        openDeviceModal("edit", deviceId);
      }
      if (action === "delete") {
        deleteDevice(deviceId);
      }
      if (action === "details") {
        openDeviceDetails(deviceId);
      }
    }

    const groupAction = event.target.closest("[data-group-action]");
    if (groupAction) {
      const action = groupAction.dataset.groupAction;
      const groupId = Number(groupAction.dataset.groupId || 0);
      if (action === "edit") {
        openGroupModal("edit", groupId);
      }
      if (action === "delete") {
        deleteGroup(groupId);
      }
    }

    const alertAction = event.target.closest("[data-alert-action]");
    if (alertAction) {
      const action = alertAction.dataset.alertAction;
      const alertId = Number(alertAction.dataset.alertId || 0);
      if (action === "ack") {
        acknowledgeAlert(alertId);
      }
      if (action === "delete") {
        deleteAlert(alertId);
      }
    }

    const rangeButton = event.target.closest("[data-range]");
    if (rangeButton) {
      state.historyRange = rangeButton.dataset.range;
      const lookupModal = document.getElementById("historyModal");
      const lookupDetail = document.getElementById("detailHistoryList");
      const deviceId = Number((lookupDetail && lookupDetail.dataset.deviceId) || (lookupModal && lookupModal.dataset.deviceId) || 0);
      if (lookupDetail) {
        renderDetailHistory(deviceId, state.historyRange);
      }
      if (lookupModal) {
        renderHistory(deviceId, state.historyRange);
      }
      document.querySelectorAll(".range-button").forEach((button) => {
        button.classList.toggle("active", button.dataset.range === state.historyRange);
      });
    }
  });

  document.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".resize-handle");
    if (!handle) {
      return;
    }

    event.preventDefault();
    const key = handle.dataset.column;
    dragState = {
      key,
      startX: event.clientX,
      startWidth: state.layout[key],
    };

    document.addEventListener("pointermove", handleResizeMove);
    document.addEventListener("pointerup", handleResizeEnd, { once: true });
  });
}

function switchPanel(panelName) {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === panelName);
  });

  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${panelName}Panel`);
  });
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
  filter.innerHTML = '<option value="all">All Groups</option>' + state.groups
    .map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`)
    .join("");

  filter.value = state.filters.group;

  const reportGroup = document.querySelector('select[name="reportGroup"]');
  if (reportGroup) {
    reportGroup.innerHTML = '<option value="all">All Groups</option>' + state.groups
      .map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`)
      .join("");
  }

  const reportDevice = document.querySelector('select[name="reportDevice"]');
  if (reportDevice) {
    reportDevice.innerHTML = '<option value="all">All Devices</option>' + state.devices
      .map((device) => `<option value="${device.id}">${escapeHtml(device.name)}</option>`)
      .join("");
  }
}

function renderMonitor() {
  const header = document.getElementById("monitorHeader");
  const list = document.getElementById("monitorList");

  if (!header || !list) return;

  header.innerHTML = [
    createHeaderCell("deviceName", "Device Name"),
    createHeaderCell("status", "Status"),
    createHeaderCell("latency", "Latency"),
    createHeaderCell("ipAddress", "IP Address"),
    createHeaderCell("actions", "Actions"),
  ].join("");

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
    list.innerHTML = `
      <div class="empty-state">
        <div class="inner">
          <h3>No infrastructure configured.</h3>
          <p>Create your first group or device to begin monitoring.</p>
          <div class="empty-actions">
            <button class="primary-button" type="button" data-close-modal="deviceModal" onclick="openGroupModal('add')">+ Create Group</button>
            <button class="primary-button" type="button" onclick="openDeviceModal('add')">+ Add Device</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const groupsInOrder = [...state.groups].sort((a, b) => String(a.name).localeCompare(String(b.name)));

  groupsInOrder.forEach((group) => {
    const groupDevices = filtered.filter((device) => Number(device.groupId) === Number(group.id));
    if (!groupDevices.length) {
      return;
    }

    const summary = summarizeGroup(groupDevices);
    const section = document.createElement("section");
    section.className = "group-block";

    const headerRow = document.createElement("div");
    headerRow.className = "group-header";
    headerRow.innerHTML = `
      <div class="group-title">${escapeHtml(group.name)}</div>
      <div class="group-meta">
        <strong>${summary.total} devices</strong>
        <span>${summary.up} UP</span>
        <span>${summary.down} DOWN</span>
      </div>
      <div class="group-actions-inline">
        <button class="inline-action" type="button" data-group-action="edit" data-group-id="${group.id}">Edit</button>
        <button class="inline-action" type="button" data-group-action="delete" data-group-id="${group.id}">Delete</button>
      </div>
    `;

    section.appendChild(headerRow);

    groupDevices.forEach((device) => {
      section.appendChild(createDeviceRow(device));
    });

    list.appendChild(section);
  });

  if (!list.children.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="inner">
          <h3>No devices match the current filters.</h3>
          <p>Adjust the group or status filters to continue.</p>
        </div>
      </div>
    `;
  }
}

function summarizeGroup(groupDevices) {
  return groupDevices.reduce((summary, device) => {
    const status = getStatusKey(device);
    summary.total += 1;
    if (status === "up") summary.up += 1;
    if (status === "down") summary.down += 1;
    return summary;
  }, { total: 0, up: 0, down: 0 });
}

function createHeaderCell(columnKey, label) {
  return `
    <div class="header-cell">
      ${label}
      <span class="resize-handle" data-column="${columnKey}" aria-label="Resize ${label}"></span>
    </div>
  `;
}

function createDeviceRow(device) {
  const status = getDeviceStatus(device);
  const row = document.createElement("div");
  row.className = `monitor-row ${status.label === "DOWN" ? "down-row" : ""}`;
  row.innerHTML = `
    <div class="monitor-cell">
      <div class="device-name"><button class="device-name-button" type="button" data-action="details" data-device-id="${device.id}">${escapeHtml(device.name)}</button></div>
      <span class="resize-handle" data-column="deviceName" aria-label="Resize Device Name"></span>
    </div>
    <div class="monitor-cell">
      <div class="status-pill ${status.className}">
        <span class="status-dot"></span>
        <span>${status.label}</span>
      </div>
      <span class="resize-handle" data-column="status" aria-label="Resize Status"></span>
    </div>
    <div class="monitor-cell">
      <div class="latency-value">${formatLatency(device.lastLatencyMs, device.status)}</div>
      <span class="resize-handle" data-column="latency" aria-label="Resize Latency"></span>
    </div>
    <div class="monitor-cell">
      <div class="ip-value">${escapeHtml(device.ipAddress)}</div>
      <span class="resize-handle" data-column="ipAddress" aria-label="Resize IP Address"></span>
    </div>
    <div class="monitor-cell">
      <div class="action-group">
        <button class="action-button" type="button" data-action="history" data-device-id="${device.id}">History</button>
        <button class="action-button" type="button" data-action="edit" data-device-id="${device.id}">Edit</button>
        <button class="action-button delete" type="button" data-action="delete" data-device-id="${device.id}">Delete</button>
      </div>
      <span class="resize-handle" data-column="actions" aria-label="Resize Actions"></span>
    </div>
  `;

  return row;
}

function getDeviceStatus(device) {
  if (device.status === "up") return { label: "UP", className: "status-up" };
  if (device.status === "down") return { label: "DOWN", className: "status-down" };
  return { label: "UNKNOWN", className: "status-unknown" };
}

function getStatusKey(device) {
  if (device.status === "up") return "up";
  if (device.status === "down") return "down";
  return "unknown";
}

function formatLatency(value, status) {
  if (status === "down" || value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return `${Number(value)} ms`;
}

function openDeviceModal(mode, id = null) {
  if (!state.groups.length) {
    showToast("Create a group before adding a device.");
    openGroupModal("add");
    return;
  }

  state.modal.type = mode;
  state.modal.id = id;

  const form = document.getElementById("deviceForm");
  const modal = document.getElementById("deviceModal");
  const modalTitle = document.getElementById("deviceModalTitle");
  const groupSelect = form.elements.groupId;

  form.reset();
  groupSelect.innerHTML = state.groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");

  if (mode === "edit") {
    const device = state.devices.find((entry) => Number(entry.id) === Number(id));
    if (!device) return;
    form.elements.name.value = device.name;
    form.elements.ipAddress.value = device.ipAddress;
    form.elements.groupId.value = String(device.groupId);
    form.elements.pingIntervalSeconds.value = device.pingIntervalSeconds || state.settings.defaultPingInterval;
    form.elements.enabled.checked = Boolean(device.enabled);
    modalTitle.textContent = "Edit Device";
  } else {
    form.elements.groupId.value = String(state.groups[0]?.id || 1);
    form.elements.pingIntervalSeconds.value = state.settings.defaultPingInterval;
    form.elements.enabled.checked = true;
    modalTitle.textContent = "Add Device";
  }

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");

  if (modalId === "deviceModal") {
    document.getElementById("deviceForm").reset();
  }

  if (modalId === "groupModal") {
    document.getElementById("groupForm").reset();
  }
}

async function handleDeviceSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const payload = {
    name: String(formData.get("name") || "").trim(),
    ipAddress: String(formData.get("ipAddress") || "").trim(),
    groupId: Number(formData.get("groupId") || 1),
    pingIntervalSeconds: Number(formData.get("pingIntervalSeconds") || state.settings.defaultPingInterval),
    enabled: formData.get("enabled") === "on",
  };

  if (!payload.name || !payload.ipAddress) {
    showToast("Device name and IP address are required.");
    return;
  }

  try {
    if (state.modal.type === "edit") {
      await apiRequest(`/api/devices/${state.modal.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...payload, id: Number(state.modal.id) }),
      });
      showToast(`${payload.name} updated.`);
    } else {
      await apiRequest("/api/devices", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showToast(`${payload.name} added.`);
    }

    closeModal("deviceModal");
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to save device.");
  }
}

async function deleteDevice(deviceId) {
  const device = state.devices.find((entry) => Number(entry.id) === Number(deviceId));
  if (!device) return;

  const confirmed = window.confirm(`Delete ${device.name}?`);
  if (!confirmed) return;

  try {
    await apiRequest(`/api/devices/${deviceId}`, { method: "DELETE" });
    showToast(`${device.name} removed.`);
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to delete device.");
  }
}

function openGroupModal(mode, id = null) {
  state.modal.type = mode;
  state.modal.id = id;

  const form = document.getElementById("groupForm");
  const modal = document.getElementById("groupModal");
  const title = document.getElementById("groupModalTitle");
  form.reset();

  if (mode === "edit") {
    const group = state.groups.find((entry) => Number(entry.id) === Number(id));
    if (!group) return;
    form.elements.name.value = group.name;
    form.elements.description.value = group.description || "";
    title.textContent = "Edit Group";
  } else {
    title.textContent = "Create Group";
  }

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

async function handleGroupSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const name = String(formData.get("name") || "").trim();
  const description = String(formData.get("description") || "").trim();

  if (!name) {
    showToast("Group name is required.");
    return;
  }

  try {
    if (state.modal.type === "edit") {
      await apiRequest(`/api/groups/${state.modal.id}`, {
        method: "PUT",
        body: JSON.stringify({ id: Number(state.modal.id), name, description }),
      });
      showToast(`${name} updated.`);
    } else {
      await apiRequest("/api/groups", {
        method: "POST",
        body: JSON.stringify({ name, description }),
      });
      showToast(`${name} created.`);
    }

    closeModal("groupModal");
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to save group.");
  }
}

async function deleteGroup(groupId) {
  const group = state.groups.find((entry) => Number(entry.id) === Number(groupId));
  if (!group) return;

  const groupDevices = state.devices.filter((device) => Number(device.groupId) === Number(groupId));
  if (groupDevices.length > 0) {
    showToast("Move or delete the devices in this group before deleting it.");
    return;
  }

  const confirmed = window.confirm(`Delete group ${group.name}?`);
  if (!confirmed) return;

  try {
    await apiRequest(`/api/groups/${groupId}`, { method: "DELETE" });
    showToast(`${group.name} deleted.`);
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to delete group.");
  }
}

function buildDeviceStatusSummary(device) {
  const history = Array.isArray(device.history) ? device.history : [];
  const downEvents = history.filter((entry) => String(entry.newStatus || "").toLowerCase() === "down");
  const recoveredEvents = history.filter((entry) => String(entry.newStatus || "").toLowerCase() === "up");

  const downSince = downEvents.length ? downEvents[downEvents.length - 1].timestamp : null;
  let recoveredAt = null;
  let downtimeSeconds = null;

  if (downSince) {
    const recovery = recoveredEvents
      .filter((entry) => new Date(entry.timestamp).getTime() > new Date(downSince).getTime())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    recoveredAt = recovery ? recovery.timestamp : null;

    if (recoveredAt) {
      downtimeSeconds = Math.max(0, Math.round((new Date(recoveredAt) - new Date(downSince)) / 1000));
    }
  }

  return {
    downSince,
    recoveredAt,
    downtimeSeconds,
  };
}

function openDeviceDetails(deviceId) {
  const device = state.devices.find((entry) => Number(entry.id) === Number(deviceId));
  if (!device) return;

  const modal = document.getElementById("deviceDetailModal");
  const content = document.getElementById("deviceDetailContent");
  const group = state.groups.find((entry) => Number(entry.id) === Number(device.groupId));
  const status = getDeviceStatus(device);
  const statusSummary = buildDeviceStatusSummary(device);
  const downSince = statusSummary.downSince ? formatDateTime(statusSummary.downSince) : "—";
  const recoveredAt = statusSummary.recoveredAt ? formatDateTime(statusSummary.recoveredAt) : "—";
  const downtimeLabel = statusSummary.downtimeSeconds !== null ? formatDuration(statusSummary.downtimeSeconds) : "—";

  const historyHtml = renderHistorySvg(device);

  content.innerHTML = `
    <div class="detail-header">
      <h4>${escapeHtml(device.name)}</h4>
      <div class="status-pill ${status.className}"><span class="status-dot"></span><span>${status.label}</span></div>
    </div>

    <div class="detail-grid">
      <div class="detail-card">
        <span class="label">Device Name</span>
        <div class="value">${escapeHtml(device.name)}</div>
      </div>
      <div class="detail-card">
        <span class="label">IP Address</span>
        <div class="value">${escapeHtml(device.ipAddress)}</div>
      </div>
      <div class="detail-card">
        <span class="label">Group</span>
        <div class="value">${escapeHtml(group ? group.name : "Unassigned")}</div>
      </div>
      <div class="detail-card">
        <span class="label">Current Status</span>
        <div class="value">${status.label}</div>
      </div>
      <div class="detail-card">
        <span class="label">Current Latency</span>
        <div class="value">${formatLatency(device.lastLatencyMs, device.status)}</div>
      </div>
      <div class="detail-card">
        <span class="label">Ping Interval</span>
        <div class="value">${device.pingIntervalSeconds || state.settings.defaultPingInterval} sec</div>
      </div>
      <div class="detail-card">
        <span class="label">Last Checked</span>
        <div class="value">${device.lastChecked ? formatDateTime(device.lastChecked) : "Never"}</div>
      </div>
      <div class="detail-card">
        <span class="label">Last Status Change</span>
        <div class="value">${downSince}</div>
      </div>
      <div class="detail-card">
        <span class="label">Down Since</span>
        <div class="value">${downSince}</div>
      </div>
      <div class="detail-card">
        <span class="label">Recovered</span>
        <div class="value">${recoveredAt}</div>
      </div>
      <div class="detail-card">
        <span class="label">Downtime</span>
        <div class="value">${downtimeLabel}</div>
      </div>
      <div class="detail-card">
        <span class="label">History</span>
        <div class="value">${Array.isArray(device.history) && device.history.length ? `${device.history.length} events` : "No monitoring history available"}</div>
      </div>
    </div>

    <div class="detail-graph">
      ${historyHtml}
    </div>

    <div class="history-toolbar" style="padding: 12px 0; border: 0;">
      <div class="history-meta">Monitoring history</div>
      <div class="time-range-group">
        <button class="range-button ${state.historyRange === '1H' ? 'active' : ''}" type="button" data-range="1H">1H</button>
        <button class="range-button ${state.historyRange === '6H' ? 'active' : ''}" type="button" data-range="6H">6H</button>
        <button class="range-button ${state.historyRange === '12H' ? 'active' : ''}" type="button" data-range="12H">12H</button>
        <button class="range-button ${state.historyRange === '24H' ? 'active' : ''}" type="button" data-range="24H">24H</button>
        <button class="range-button ${state.historyRange === '48H' ? 'active' : ''}" type="button" data-range="48H">48H</button>
        <button class="range-button ${state.historyRange === '72H' ? 'active' : ''}" type="button" data-range="72H">72H</button>
        <button class="range-button ${state.historyRange === '7D' ? 'active' : ''}" type="button" data-range="7D">7D</button>
      </div>
    </div>

    <div id="detailHistoryList" class="history-list" data-device-id="${device.id}"></div>

    <div class="status-select-row">
      <label class="field" style="flex:1">
        <span>Set Status</span>
        <select id="statusOverrideSelect">
          <option value="unknown" ${device.status === "unknown" ? "selected" : ""}>UNKNOWN</option>
          <option value="up" ${device.status === "up" ? "selected" : ""}>UP</option>
          <option value="down" ${device.status === "down" ? "selected" : ""}>DOWN</option>
        </select>
      </label>
      <button class="primary-button" type="button" id="saveStatusButton">Save Status</button>
    </div>
  `;

  renderDetailHistory(device.id, state.historyRange);

  const saveButton = document.getElementById("saveStatusButton");
  saveButton.addEventListener("click", () => {
    const select = document.getElementById("statusOverrideSelect");
    updateDeviceStatus(device.id, select.value);
  });

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function renderHistorySvg(device) {
  const history = Array.isArray(device.history) && device.history.length ? device.history : [];
  if (!history.length) {
    return `
      <div style="display:grid;place-items:center;height:220px;color:var(--text-muted);font-size:14px;">
        No monitoring history available.
      </div>
    `;
  }

  const sorted = [...history].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const points = sorted.map((point, index) => {
    const x = 20 + (index * (430 / Math.max(sorted.length - 1, 1)));
    const y = 170 - Number(point.latency || 0);
    return `<circle cx="${x}" cy="${y}" r="4" fill="${point.status === 'down' ? '#ff6b6b' : '#34d399'}" />`;
  }).join("");

  return `
    <svg viewBox="0 0 480 200" aria-label="Latency graph">
      <g stroke="rgba(255,255,255,0.12)" stroke-width="1">
        <line x1="20" y1="160" x2="460" y2="160" />
        <line x1="20" y1="20" x2="20" y2="160" />
      </g>
      <g fill="rgba(255,255,255,0.7)" font-size="10">
        <text x="20" y="175">0 ms</text>
        <text x="408" y="175">now</text>
      </g>
      ${points}
    </svg>
  `;
}

function updateDeviceStatus(deviceId, nextStatus) {
  const device = state.devices.find((entry) => Number(entry.id) === Number(deviceId));
  if (!device) return;

  const previous = device.status || "unknown";
  const now = new Date().toISOString();

  if (previous !== nextStatus) {
    const event = {
      timestamp: now,
      previousStatus: previous,
      newStatus: nextStatus,
      latency: device.lastLatencyMs || null,
      note: nextStatus === "down" ? "DOWN" : nextStatus === "up" ? "RECOVERED" : "UNKNOWN",
    };

    device.history = Array.isArray(device.history) ? [...device.history, event] : [event];
    device.status = nextStatus;
    device.statusChangedAt = now;
    if (nextStatus === "down") {
      device.lastChecked = now;
    }
  }

  renderSummary();
  renderMonitor();
  openDeviceDetails(device.id);
  showToast(`Status updated to ${nextStatus.toUpperCase()}.`);
}

function openHistoryModal(deviceId) {
  const device = state.devices.find((entry) => Number(entry.id) === Number(deviceId));
  if (!device) return;

  const modal = document.getElementById("historyModal");
  modal.dataset.deviceId = String(deviceId);

  const info = document.getElementById("historyInfo");
  info.textContent = `${device.name} • ${device.ipAddress} • ${getDeviceStatus(device).label}`;

  renderHistory(deviceId, state.historyRange);
  document.querySelectorAll(".range-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === state.historyRange);
  });

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function renderDetailHistory(deviceId, range) {
  const list = document.getElementById("detailHistoryList");
  const device = state.devices.find((entry) => Number(entry.id) === Number(deviceId));
  if (!list || !device) return;

  const entries = buildHistoryEntries(device, range);
  if (!entries.length) {
    list.innerHTML = '<div class="history-item"><div><strong>No monitoring history available.</strong></div></div>';
    return;
  }

  list.innerHTML = entries.map((entry) => `
    <div class="history-item">
      <div>
        <strong>${entry.status}</strong>
        <div><span>${entry.time}</span></div>
      </div>
      <div>
        <span>${entry.latency}</span>
      </div>
    </div>
  `).join("");
}

function renderHistory(deviceId, range) {
  const list = document.getElementById("historyList");
  const device = state.devices.find((entry) => Number(entry.id) === Number(deviceId));
  if (!device) return;

  const entries = buildHistoryEntries(device, range);
  if (!entries.length) {
    if (list) list.innerHTML = '<div class="history-item"><div><strong>No monitoring history available.</strong></div></div>';
    return;
  }

  if (!list) return;
  list.innerHTML = entries.map((entry) => `
    <div class="history-item">
      <div>
        <strong>${entry.status}</strong>
        <div><span>${entry.time}</span></div>
      </div>
      <div>
        <span>${entry.latency}</span>
      </div>
    </div>
  `).join("");
}

function buildHistoryEntries(device, range) {
  const history = Array.isArray(device.history) ? device.history : [];
  if (!history.length) {
    return [];
  }

  const now = Date.now();
  const windowMs = {
    "1H": 3600000,
    "6H": 21600000,
    "12H": 43200000,
    "24H": 86400000,
    "48H": 172800000,
    "72H": 259200000,
    "7D": 604800000,
  }[range] || 86400000;

  const filtered = history.filter((entry) => now - new Date(entry.timestamp).getTime() <= windowMs);
  return filtered.slice(-10).map((entry) => ({
    status: entry.newStatus ? entry.newStatus.toUpperCase() : "UNKNOWN",
    latency: entry.latency ? `${entry.latency} ms` : "—",
    time: formatDateTime(entry.timestamp),
  }));
}

function renderAlerts() {
  const list = document.getElementById("alertsList");
  if (!list) return;
  list.innerHTML = state.alerts.slice(0, 4).map((alert) => `
    <div class="alert-item">
      <strong>${escapeHtml(alert.event)}</strong>
      <div>
        <div>${escapeHtml(alert.device)}</div>
        <small>${escapeHtml(alert.ip)}</small>
      </div>
      <span>${escapeHtml(alert.time)}</span>
      <div class="alert-actions">
        <button class="secondary-button" type="button" data-alert-action="ack" data-alert-id="${alert.id}">Acknowledge</button>
        <button class="secondary-button" type="button" data-alert-action="delete" data-alert-id="${alert.id}">Delete</button>
      </div>
    </div>
  `).join("");
}

function renderAlertsPanel() {
  const panelList = document.getElementById("alertsPanelList");
  if (!panelList) return;
  panelList.innerHTML = state.alerts.map((alert) => `
    <div class="alert-item">
      <strong>${escapeHtml(alert.event)}</strong>
      <div>
        <div>${escapeHtml(alert.device)}</div>
        <small>${escapeHtml(alert.ip)}</small>
      </div>
      <span>${escapeHtml(alert.time)}</span>
      <div class="alert-actions">
        <button class="secondary-button" type="button" data-alert-action="ack" data-alert-id="${alert.id}">Acknowledge</button>
        <button class="secondary-button" type="button" data-alert-action="delete" data-alert-id="${alert.id}">Delete</button>
      </div>
    </div>
  `).join("");
}

function acknowledgeAlert(alertId) {
  state.alerts = state.alerts.map((alert) => Number(alert.id) === Number(alertId)
    ? { ...alert, acknowledged: true }
    : alert);
  saveAlerts();
  renderAlerts();
  renderAlertsPanel();
  showToast("Alert acknowledged.");
}

function deleteAlert(alertId) {
  state.alerts = state.alerts.filter((alert) => Number(alert.id) !== Number(alertId));
  saveAlerts();
  renderAlerts();
  renderAlertsPanel();
  showToast("Alert deleted.");
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);

  const payload = {
    defaultPingIntervalSeconds: Number(formData.get("defaultPingInterval") || 5),
    pingTimeoutMilliseconds: Number(formData.get("pingTimeout") || 2000),
    historyRetentionHours: Number(formData.get("historyRetention") || 72),
    monitoringEnabled: formData.get("monitoringEnabled") === "on",
  };

  try {
    await apiRequest("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });

    state.settings.defaultPingInterval = payload.defaultPingIntervalSeconds;
    state.settings.pingTimeout = payload.pingTimeoutMilliseconds;
    state.settings.historyRetention = payload.historyRetentionHours;
    state.settings.monitoringEnabled = payload.monitoringEnabled;

    saveSettings();
    renderSettingsForm();
    showToast("Settings saved.");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to save settings.");
  }
}

function renderSettingsForm() {
  const form = document.getElementById("settingsForm");
  if (!form) return;

  form.elements.defaultPingInterval.value = state.settings.defaultPingInterval;
  form.elements.pingTimeout.value = state.settings.pingTimeout;
  form.elements.historyRetention.value = state.settings.historyRetention;
  form.elements.monitoringEnabled.checked = Boolean(state.settings.monitoringEnabled);
}

function exportConfiguration() {
  const payload = {
    groups: state.groups,
    devices: state.devices,
    alerts: state.alerts,
    settings: state.settings,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "inframonitor-config.json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast("Configuration exported.");
}

async function importConfiguration(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const json = JSON.parse(text);

    if (!json || !Array.isArray(json.groups) || !Array.isArray(json.devices)) {
      throw new Error("Invalid configuration file");
    }

    state.groups = json.groups;
    state.devices = json.devices;
    state.alerts = Array.isArray(json.alerts) ? json.alerts : state.alerts;
    state.settings = { ...DEFAULT_SETTINGS, ...(json.settings || {}) };

    saveSettings();
    saveAlerts();
    renderGroupFilter();
    renderSummary();
    renderMonitor();
    renderAlerts();
    renderAlertsPanel();
    renderSettingsForm();
    showToast("Configuration imported.");
  } catch (error) {
    console.error(error);
    showToast("Invalid JSON configuration.");
  } finally {
    event.target.value = "";
  }
}

function handleResizeMove(event) {
  if (!dragState) return;
  const delta = event.clientX - dragState.startX;
  const nextValue = dragState.startWidth + delta;
  const min = MIN_WIDTHS[dragState.key];
  const max = dragState.key === "deviceName" ? 340 : 220;
  state.layout[dragState.key] = clampNumber(nextValue, min, max, DEFAULT_LAYOUT[dragState.key]);
  applyColumnLayout();
  saveLayout();
}

function handleResizeEnd() {
  dragState = null;
  document.removeEventListener("pointermove", handleResizeMove);
}

function openReportModal() {
  const reportGroup = document.querySelector('select[name="reportGroup"]');
  const reportDevice = document.querySelector('select[name="reportDevice"]');
  if (reportGroup) {
    reportGroup.innerHTML = '<option value="all">All Groups</option>' + state.groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");
  }
  if (reportDevice) {
    reportDevice.innerHTML = '<option value="all">All Devices</option>' + state.devices.map((device) => `<option value="${device.id}">${escapeHtml(device.name)}</option>`).join("");
  }

  const modal = document.getElementById("reportModal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function handleReportSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const reportRange = formData.get("reportRange");
  const reportGroup = formData.get("reportGroup") || "all";
  const reportDevice = formData.get("reportDevice") || "all";
  const reportStatus = formData.get("reportStatus") || "all";

  const filtered = state.devices.filter((device) => {
    const groupMatch = reportGroup === "all" || String(device.groupId) === String(reportGroup);
    const deviceMatch = reportDevice === "all" || String(device.id) === String(reportDevice);
    const statusMatch = reportStatus === "all" || getStatusKey(device) === reportStatus;
    return groupMatch && deviceMatch && statusMatch;
  });

  const summary = {
    total: filtered.length,
    up: filtered.filter((device) => getStatusKey(device) === "up").length,
    down: filtered.filter((device) => getStatusKey(device) === "down").length,
    unknown: filtered.filter((device) => getStatusKey(device) === "unknown").length,
  };

  const availability = filtered.reduce((acc, device) => {
    const status = getStatusKey(device);
    acc.uptime += status === "up" ? 1 : 0;
    acc.downtime += status === "down" ? 1 : 0;
    acc.outages += Array.isArray(device.history) ? device.history.filter((entry) => String(entry.newStatus || "").toLowerCase() === "down").length : 0;
    if (device.statusChangedAt) {
      acc.lastRecovery = acc.lastRecovery || device.statusChangedAt;
    }
    return acc;
  }, { uptime: 0, downtime: 0, outages: 0, lastRecovery: null });

  const reportWindow = window.open("", "_blank", "width=1000,height=800");
  if (!reportWindow) {
    showToast("Popup blocked. Allow popups to generate the report.");
    return;
  }

  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const groupRows = state.groups.map((group) => {
    const groupDevices = filtered.filter((device) => Number(device.groupId) === Number(group.id));
    const groupSummary = {
      total: groupDevices.length,
      up: groupDevices.filter((device) => getStatusKey(device) === "up").length,
      down: groupDevices.filter((device) => getStatusKey(device) === "down").length,
      unknown: groupDevices.filter((device) => getStatusKey(device) === "unknown").length,
    };
    return `
      <tr>
        <td>${escapeHtml(group.name)}</td>
        <td>${groupSummary.total}</td>
        <td>${groupSummary.up}</td>
        <td>${groupSummary.down}</td>
        <td>${groupSummary.unknown}</td>
      </tr>
    `;
  }).join("");

  const deviceRows = filtered.map((device) => `
    <tr>
      <td>${escapeHtml(device.name)}</td>
      <td>${escapeHtml(device.ipAddress)}</td>
      <td>${escapeHtml(state.groups.find((group) => Number(group.id) === Number(device.groupId))?.name || "Unassigned")}</td>
      <td>${getDeviceStatus(device).label}</td>
      <td>${formatLatency(device.lastLatencyMs, device.status)}</td>
      <td>${device.lastChecked ? formatDateTime(device.lastChecked) : "Never"}</td>
    </tr>
  `).join("");

  const content = `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>InfraMonitor Report</title>
      <style>
        body { font-family: Arial, sans-serif; color: #0f172a; background: #ffffff; margin: 32px; }
        h1, h2 { margin-bottom: 8px; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; font-size: 12px; }
        th { background: #e2e8f0; }
        .section { margin-top: 24px; }
        .muted { color: #475569; }
      </style>
    </head>
    <body>
      <h1>INFRA MONITOR</h1>
      <h2>Infrastructure Monitoring Report</h2>
      <div class="muted">Report Generated: ${generatedAt}</div>
      <div class="section">
        <h3>SUMMARY</h3>
        <table>
          <tr><th>Total Devices</th><th>UP</th><th>DOWN</th><th>UNKNOWN</th></tr>
          <tr><td>${summary.total}</td><td>${summary.up}</td><td>${summary.down}</td><td>${summary.unknown}</td></tr>
        </table>
      </div>
      <div class="section">
        <h3>GROUP SUMMARY</h3>
        <table>
          <tr><th>Group</th><th>Total</th><th>UP</th><th>DOWN</th><th>UNKNOWN</th></tr>
          ${groupRows || '<tr><td colspan="5">No groups configured.</td></tr>'}
        </table>
      </div>
      <div class="section">
        <h3>DEVICE STATUS</h3>
        <table>
          <tr><th>Device Name</th><th>IP Address</th><th>Group</th><th>Status</th><th>Latency</th><th>Last Checked</th></tr>
          ${deviceRows || '<tr><td colspan="6">No devices configured.</td></tr>'}
        </table>
      </div>
      <div class="section">
        <h3>ALERTS / EVENTS</h3>
        <table>
          <tr><th>Timestamp</th><th>Device</th><th>Event</th><th>Status</th><th>Latency</th></tr>
          ${
            state.alerts.length
              ? state.alerts.map((alert) => `
                  <tr>
                    <td>${escapeHtml(alert.time)}</td>
                    <td>${escapeHtml(alert.device)}</td>
                    <td>${escapeHtml(alert.event)}</td>
                    <td>${escapeHtml(alert.acknowledged ? "ACKNOWLEDGED" : "OPEN")}</td>
                    <td>—</td>
                  </tr>
                `).join("")
              : '<tr><td colspan="5">No alerts available.</td></tr>'
          }
        </table>
      </div>
      <div class="section">
        <h3>AVAILABILITY</h3>
        <table>
          <tr><th>Uptime</th><th>Downtime</th><th>Outages</th><th>Last Outage</th><th>Last Recovery</th></tr>
          <tr>
            <td>${availability.uptime}</td>
            <td>${availability.downtime}</td>
            <td>${availability.outages}</td>
            <td>—</td>
            <td>${availability.lastRecovery ? formatDateTime(availability.lastRecovery) : "—"}</td>
          </tr>
        </table>
      </div>
      <div class="section">
        <h3>HISTORY</h3>
        <div class="muted">No monitoring history available.</div>
      </div>
    </body>
    </html>
  `;

  reportWindow.document.write(content);
  reportWindow.document.close();
  reportWindow.focus();
  reportWindow.print?.();
  closeModal("reportModal");
  showToast("Report generated.");
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function applyTvMode() {
  document.body.classList.toggle("tv-mode", Boolean(state.settings.tvMode));
  const tvButton = document.getElementById("tvModeButton");
  if (tvButton) {
    tvButton.classList.toggle("active", Boolean(state.settings.tvMode));
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 1800);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

document.addEventListener("DOMContentLoaded", init);
