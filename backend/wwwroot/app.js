/* =========================================================
   InfraMonitor
   Frontend Application
   File: backend/wwwroot/app.js
   ========================================================= */

"use strict";

/* =========================================================
   STORAGE
   ========================================================= */

const STORAGE_SETTINGS = "infraMonitor.settings.v2";
const STORAGE_THEME = "infraMonitor.theme.v2";
const STORAGE_LAYOUT = "infraMonitor.layout.v2";

const API_BASE = window.location.origin;


/* =========================================================
   DEFAULTS
   ========================================================= */

const DEFAULT_SETTINGS = {
    defaultPingInterval: 5,
    pingTimeout: 2000,
    historyRetention: 72,
    monitoringEnabled: true,
    alertSoundEnabled: true,
    alertVolume: 0.35,
    tvMode: false
};

const DEFAULT_LAYOUT = {
    deviceName: 220,
    status: 90,
    latency: 90,
    ipAddress: 160,
    actions: 160
};

const state = {
    groups: [],
    devices: [],
    alerts: [],

    settings: loadSettings(),

    theme: localStorage.getItem(STORAGE_THEME) || "dark",

    filters: {
        search: "",
        group: "all",
        status: "all"
    },

    layout: loadLayout(),

    deviceModalMode: "add",
    editingDeviceId: null,

    groupModalMode: "add",
    editingGroupId: null,

    selectedDeviceId: null,

    historyRange: "24H",

    dashboardRange: "24H",
    dashboardDeviceId: "all",

    lastStatuses: new Map(),

    refreshTimer: null,
    refreshInProgress: false,

    audioContext: null,

    tvAnimation: null,
    tvPaused: false,
    tvResumeTimer: null,

    searchTimer: null
};


/* =========================================================
   BASIC HELPERS
   ========================================================= */

function $(id) {
    return document.getElementById(id);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function formatDateTime(value) {
    if (!value) return "Never";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

function formatShortTime(value) {
    if (!value) return "--";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "--";
    }

    return date.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit"
    });
}

function formatLatency(value, status) {
    if (status === "down") {
        return "TIMEOUT";
    }

    if (value === null || value === undefined || value === "") {
        return "--";
    }

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "--";
    }

    return `${Math.round(number)} ms`;
}

function getRangeHours(range) {
    switch (range) {
        case "LIVE":
            return 1;

        case "1H":
            return 1;

        case "6H":
            return 6;

        case "12H":
            return 12;

        case "24H":
            return 24;

        case "48H":
            return 48;

        case "72H":
            return 72;

        case "7D":
            return 168;

        case "30D":
            return 720;

        default:
            return 24;
    }
}

function getStatus(device) {
    if (!device) return "unknown";

    if (device.lastChecked === null || device.lastChecked === undefined) {
        return "unknown";
    }

    if (device.isUp === true) {
        return "up";
    }

    if (device.isUp === false) {
        return "down";
    }

    return "unknown";
}

function getStatusLabel(status) {
    switch (status) {
        case "up":
            return "UP";

        case "down":
            return "DOWN";

        default:
            return "UNKNOWN";
    }
}

function getGroupName(groupId) {
    const group = state.groups.find(
        group => Number(group.id) === Number(groupId)
    );

    return group?.name || "Unassigned";
}


/* =========================================================
   STORAGE
   ========================================================= */

function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_SETTINGS);

        if (!raw) {
            return { ...DEFAULT_SETTINGS };
        }

        return {
            ...DEFAULT_SETTINGS,
            ...JSON.parse(raw)
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    localStorage.setItem(
        STORAGE_SETTINGS,
        JSON.stringify(state.settings)
    );
}

function loadLayout() {
    try {
        const raw = localStorage.getItem(STORAGE_LAYOUT);

        if (!raw) {
            return { ...DEFAULT_LAYOUT };
        }

        return {
            ...DEFAULT_LAYOUT,
            ...JSON.parse(raw)
        };
    } catch {
        return { ...DEFAULT_LAYOUT };
    }
}

function saveLayout() {
    localStorage.setItem(
        STORAGE_LAYOUT,
        JSON.stringify(state.layout)
    );
}


/* =========================================================
   API
   ========================================================= */

async function apiRequest(path, options = {}) {
    const response = await fetch(
        `${API_BASE}${path}`,
        {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {})
            }
        }
    );

    if (!response.ok) {
        let message = `Request failed (${response.status})`;

        try {
            const text = await response.text();

            if (text) {
                message = text;
            }
        } catch {
            // Ignore response parsing errors.
        }

        throw new Error(message);
    }

    if (response.status === 204) {
        return null;
    }

    const contentType =
        response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
        return null;
    }

    return response.json();
}


/* =========================================================
   INITIALIZATION
   ========================================================= */

document.addEventListener(
    "DOMContentLoaded",
    initialize
);

async function initialize() {
    applyTheme();
    applyLayout();
    bindEvents();
    updateSettingsForm();
    applyTvMode();

    await refreshDashboard();

    state.refreshTimer = setInterval(
        refreshDashboard,
        5000
    );
}


/* =========================================================
   EVENT BINDING
   ========================================================= */

function bindEvents() {

    /* -----------------------------
       Refresh
       ----------------------------- */

    $("refreshButton")?.addEventListener(
        "click",
        async () => {
            await refreshDashboard(true);
        }
    );


    /* -----------------------------
       Theme
       ----------------------------- */

    $("themeToggleButton")?.addEventListener(
        "click",
        toggleTheme
    );


    /* -----------------------------
       TV Mode
       ----------------------------- */

    $("tvModeButton")?.addEventListener(
        "click",
        toggleTvMode
    );

    $("tvModeBackButton")?.addEventListener(
        "click",
        () => {
            state.settings.tvMode = false;

            saveSettings();

            applyTvMode();

            showToast(
                "TV Mode disabled.",
                "info"
            );
        }
    );

    $("tvSoundButton")?.addEventListener(
        "click",
        enableAlertSound
    );


    /* -----------------------------
       Main buttons
       ----------------------------- */

    $("addDeviceButton")?.addEventListener(
        "click",
        () => openDeviceModal("add")
    );

    $("addGroupButton")?.addEventListener(
        "click",
        () => openGroupModal("add")
    );

    $("generateReportButton")?.addEventListener(
        "click",
        openReportModal
    );

    $("resetLayoutBtn")?.addEventListener(
        "click",
        resetLayout
    );


    /* -----------------------------
       Settings shortcut
       ----------------------------- */

    $("settingsToolbarButton")?.addEventListener(
        "click",
        () => switchPanel("settings")
    );


    /* -----------------------------
       Search
       ----------------------------- */

    $("searchInput")?.addEventListener(
        "input",
        event => {
            state.filters.search =
                event.target.value.trim();

            clearTimeout(state.searchTimer);

            state.searchTimer = setTimeout(
                renderMonitor,
                100
            );
        }
    );


    /* -----------------------------
       Filters
       ----------------------------- */

    $("groupFilter")?.addEventListener(
        "change",
        event => {
            state.filters.group =
                event.target.value;

            renderMonitor();
        }
    );

    $("statusFilter")?.addEventListener(
        "change",
        event => {
            state.filters.status =
                event.target.value;

            renderMonitor();
        }
    );


    /* -----------------------------
       Dashboard device filter
       ----------------------------- */

    $("dashboardDeviceFilter")?.addEventListener(
        "change",
        event => {
            state.dashboardDeviceId =
                event.target.value;

            loadDashboardHistory()
                .then(renderDashboardAnalytics);
        }
    );


    /* -----------------------------
       Dashboard ranges
       ----------------------------- */

    document
        .querySelectorAll(
            "[data-dashboard-range]"
        )
        .forEach(button => {

            button.addEventListener(
                "click",
                async () => {

                    state.dashboardRange =
                        button.dataset.dashboardRange;

                    document
                        .querySelectorAll(
                            "[data-dashboard-range]"
                        )
                        .forEach(item => {
                            item.classList.toggle(
                                "active",
                                item === button
                            );
                        });

                    await loadDashboardHistory();

                    renderDashboardAnalytics();
                }
            );
        });


    /* -----------------------------
       Forms
       ----------------------------- */

    $("deviceForm")?.addEventListener(
        "submit",
        handleDeviceSubmit
    );

    $("groupForm")?.addEventListener(
        "submit",
        handleGroupSubmit
    );

    $("settingsForm")?.addEventListener(
        "submit",
        handleSettingsSubmit
    );

    $("reportForm")?.addEventListener(
        "submit",
        handleReportSubmit
    );


    /* -----------------------------
       Settings actions
       ----------------------------- */

    $("testAlertSoundButton")?.addEventListener(
        "click",
        testAlertSound
    );

    $("exportConfigButton")?.addEventListener(
        "click",
        exportConfiguration
    );

    $("importConfigInput")?.addEventListener(
        "change",
        importConfiguration
    );


    /* -----------------------------
       Navigation + delegated actions
       ----------------------------- */

    document.body.addEventListener(
        "click",
        handleBodyClick
    );


    /* -----------------------------
       Escape key
       ----------------------------- */

    document.addEventListener(
        "keydown",
        event => {

            if (event.key === "Escape") {
                closeAllModals();
            }
        }
    );


    /* -----------------------------
       Pause TV scrolling
       ----------------------------- */

    document.addEventListener(
        "pointerdown",
        event => {

            if (!document.body.classList.contains("tv-mode")) {
                return;
            }

            if (
                event.target.closest(
                    ".monitor-row, button, select, input"
                )
            ) {
                pauseTvScroll();
            }
        }
    );
}


/* =========================================================
   BODY CLICK HANDLER
   ========================================================= */

function handleBodyClick(event) {

    /* Navigation */

    const nav =
        event.target.closest("[data-view]");

    if (nav) {
        switchPanel(
            nav.dataset.view
        );

        return;
    }


    /* Close modal */

    const close =
        event.target.closest(
            "[data-close-modal]"
        );

    if (close) {
        closeModal(
            close.dataset.closeModal
        );

        return;
    }


    /* Device actions */

    const deviceAction =
        event.target.closest(
            "[data-action]"
        );

    if (deviceAction) {

        const action =
            deviceAction.dataset.action;

        const deviceId =
            Number(
                deviceAction.dataset.deviceId
            );

        if (action === "details") {
            openDeviceDetails(deviceId);
        }

        if (action === "edit") {
            openDeviceModal(
                "edit",
                deviceId
            );
        }

        if (action === "delete") {
            deleteDevice(deviceId);
        }

        if (action === "history") {
            openHistoryModal(deviceId);
        }

        return;
    }


    /* Group actions */

    const groupAction =
        event.target.closest(
            "[data-group-action]"
        );

    if (groupAction) {

        const action =
            groupAction.dataset.groupAction;

        const groupId =
            Number(
                groupAction.dataset.groupId
            );

        if (action === "edit") {
            openGroupModal(
                "edit",
                groupId
            );
        }

        if (action === "delete") {
            deleteGroup(groupId);
        }

        return;
    }


    /* History ranges */

    const range =
        event.target.closest(
            "[data-range]"
        );

    if (range) {

        state.historyRange =
            range.dataset.range;

        document
            .querySelectorAll(
                "#historyModal [data-range]"
            )
            .forEach(button => {
                button.classList.toggle(
                    "active",
                    button === range
                );
            });

        if (state.selectedDeviceId) {
            renderHistory(
                state.selectedDeviceId
            );
        }

        return;
    }
}


/* =========================================================
   PANEL NAVIGATION
   ========================================================= */

function switchPanel(view) {

    const panels = {
        dashboard: $("dashboardPanel"),
        alerts: $("alertsPanel"),
        settings: $("settingsPanel")
    };

    Object.values(panels)
        .forEach(panel => {
            panel?.classList.remove("active");
        });

    panels[view]?.classList.add("active");


    document
        .querySelectorAll(
            ".nav-button"
        )
        .forEach(button => {

            button.classList.toggle(
                "active",
                button.dataset.view === view
            );
        });
}


/* =========================================================
   REFRESH DASHBOARD
   ========================================================= */

async function refreshDashboard(showMessage = false) {

    if (state.refreshInProgress) {
        return;
    }

    state.refreshInProgress = true;

    try {

        const [
            groups,
            devices,
            summary,
            alerts,
            settings
        ] = await Promise.all([
            apiRequest("/api/groups"),
            apiRequest("/api/devices"),
            apiRequest("/api/monitoring/summary"),
            apiRequest("/api/alerts?limit=50"),
            apiRequest("/api/settings")
        ]);


        const previousDevices =
            state.devices;


        state.groups =
            Array.isArray(groups)
                ? groups
                : [];


        state.devices =
            Array.isArray(devices)
                ? devices
                : [];


        state.alerts =
            Array.isArray(alerts)
                ? alerts
                : [];


        if (settings) {

            state.settings.defaultPingInterval =
                safeNumber(
                    settings.defaultPingIntervalSeconds,
                    state.settings.defaultPingInterval
                );

            state.settings.pingTimeout =
                safeNumber(
                    settings.pingTimeoutMilliseconds,
                    state.settings.pingTimeout
                );

            state.settings.historyRetention =
                safeNumber(
                    settings.historyRetentionHours,
                    state.settings.historyRetention
                );

            state.settings.monitoringEnabled =
                settings.monitoringEnabled !== false;
        }


        saveSettings();


        updateSummary();

        updateBackendStatus(
            summary
        );

        renderGroupFilter();

        renderDashboardDeviceFilter();

        renderMonitor();

        renderAlerts();

        renderAlertsPanel();

        updateSettingsForm();

        detectStatusChanges(
            previousDevices
        );

        await loadDashboardHistory();

        renderDashboardAnalytics();

        updateAlertCount();


        if (state.settings.tvMode) {
            startTvScroll();
        }


        if (showMessage) {
            showToast(
                "Dashboard refreshed.",
                "success"
            );
        }

    } catch (error) {

        console.error(
            "InfraMonitor refresh failed:",
            error
        );

        updateBackendStatus(
            null,
            false
        );

        if (showMessage) {
            showToast(
                "Unable to refresh monitoring data.",
                "error"
            );
        }

    } finally {

        state.refreshInProgress = false;
    }
}


/* =========================================================
   SUMMARY
   ========================================================= */

function updateSummary() {

    const enabledDevices =
        state.devices.filter(
            device => device.enabled !== false
        );


    const up =
        enabledDevices.filter(
            device => getStatus(device) === "up"
        ).length;


    const down =
        enabledDevices.filter(
            device => getStatus(device) === "down"
        ).length;


    const unknown =
        enabledDevices.filter(
            device => getStatus(device) === "unknown"
        ).length;


    $("totalDevices").textContent =
        enabledDevices.length;


    $("upDevices").textContent =
        up;


    $("downDevices").textContent =
        down;


    $("unknownDevices").textContent =
        unknown;
}


/* =========================================================
   BACKEND STATUS
   ========================================================= */

function updateBackendStatus(
    summary,
    online = true
) {

    const element =
        $("backendStatus");

    if (!element) return;


    if (!online) {

        element.className =
            "backend-status offline";

        element.innerHTML =
            "<span></span>Backend Offline";

        return;
    }


    const monitoring =
        summary?.monitoring !== false &&
        state.settings.monitoringEnabled;


    element.className =
        monitoring
            ? "backend-status"
            : "backend-status warning";


    element.innerHTML =
        monitoring
            ? "<span></span>All Systems Normal"
            : "<span></span>Monitoring Paused";
}


/* =========================================================
   GROUP FILTER
   ========================================================= */

function renderGroupFilter() {

    const select =
        $("groupFilter");

    if (!select) return;


    const current =
        state.filters.group;


    select.innerHTML =
        `<option value="all">All Groups</option>` +
        state.groups
            .map(
                group =>
                    `<option value="${group.id}">
                        ${escapeHtml(group.name)}
                    </option>`
            )
            .join("");


    if (
        state.groups.some(
            group =>
                String(group.id) === String(current)
        )
    ) {
        select.value = current;
    } else {
        select.value = "all";
        state.filters.group = "all";
    }
}


/* =========================================================
   DASHBOARD DEVICE FILTER
   ========================================================= */

function renderDashboardDeviceFilter() {

    const select =
        $("dashboardDeviceFilter");

    if (!select) return;


    const current =
        state.dashboardDeviceId;


    select.innerHTML =
        `<option value="all">All devices</option>` +
        state.devices
            .map(
                device =>
                    `<option value="${device.id}">
                        ${escapeHtml(device.name)}
                    </option>`
            )
            .join("");


    if (
        state.devices.some(
            device =>
                String(device.id) === String(current)
        )
    ) {
        select.value = current;
    } else {
        select.value = "all";
        state.dashboardDeviceId = "all";
    }
}


/* =========================================================
   MONITOR FILTERING
   ========================================================= */

function getFilteredDevices() {

    const search =
        state.filters.search.toLowerCase();


    return state.devices.filter(
        device => {

            const status =
                getStatus(device);


            const groupMatch =
                state.filters.group === "all" ||
                String(device.groupId) ===
                String(state.filters.group);


            const statusMatch =
                state.filters.status === "all" ||
                status === state.filters.status;


            const searchMatch =
                !search ||
                String(device.name || "")
                    .toLowerCase()
                    .includes(search) ||
                String(device.ipAddress || "")
                    .toLowerCase()
                    .includes(search) ||
                getGroupName(device.groupId)
                    .toLowerCase()
                    .includes(search);


            return (
                groupMatch &&
                statusMatch &&
                searchMatch
            );
        }
    );
}


/* =========================================================
   MONITOR RENDER
   ========================================================= */

function renderMonitor() {

    const container =
        $("monitorList");

    if (!container) return;


    const devices =
        getFilteredDevices();


    if (!devices.length) {

        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">—</div>
                <div class="empty-title">
                    No infrastructure found
                </div>
                <div class="empty-text">
                    Create a group and add your first
                    monitored device to begin.
                </div>
            </div>
        `;

        return;
    }


    const groupsToRender =
        state.groups.filter(
            group =>
                devices.some(
                    device =>
                        Number(device.groupId) ===
                        Number(group.id)
                )
        );


    const html =
        groupsToRender
            .map(
                group =>
                    renderGroup(
                        group,
                        devices.filter(
                            device =>
                                Number(device.groupId) ===
                                Number(group.id)
                        )
                    )
            )
            .join("");


    container.innerHTML =
        html ||
        `
            <div class="empty-state">
                <div class="empty-title">
                    No matching devices
                </div>
            </div>
        `;


    if (state.settings.tvMode) {
        requestAnimationFrame(
            startTvScroll
        );
    }
}


/* =========================================================
   GROUP
   ========================================================= */

function renderGroup(
    group,
    devices
) {

    const up =
        devices.filter(
            device => getStatus(device) === "up"
        ).length;


    const down =
        devices.filter(
            device => getStatus(device) === "down"
        ).length;


    const unknown =
        devices.filter(
            device => getStatus(device) === "unknown"
        ).length;


    return `
        <section class="group-section">

            <div class="group-header">

                <div class="group-info">

                    <span class="group-indicator"></span>

                    <span class="group-name">
                        ${escapeHtml(group.name)}
                    </span>

                    <span class="group-count">
                        ${devices.length}
                    </span>

                </div>


                <div class="group-health">

                    <span class="up-count">
                        ${up} UP
                    </span>

                    <span class="down-count">
                        ${down} DOWN
                    </span>

                    ${
                        unknown
                            ? `<span>${unknown} UNKNOWN</span>`
                            : ""
                    }

                    <div class="group-actions">

                        <button
                            class="secondary-button small-button"
                            type="button"
                            data-group-action="edit"
                            data-group-id="${group.id}">
                            Edit
                        </button>

                        <button
                            class="secondary-button small-button danger-button"
                            type="button"
                            data-group-action="delete"
                            data-group-id="${group.id}">
                            Delete
                        </button>

                    </div>

                </div>

            </div>


            <div class="group-scroll">

                <div class="monitor-header">

                    <span>DEVICE</span>
                    <span>STATUS</span>
                    <span>LATENCY</span>
                    <span>IP ADDRESS</span>
                    <span>ACTIONS</span>

                </div>


                ${devices
                    .map(renderDeviceRow)
                    .join("")}

            </div>

        </section>
    `;
}


/* =========================================================
   DEVICE ROW
   ========================================================= */

function renderDeviceRow(device) {

    const status =
        getStatus(device);


    const latency =
        device.lastLatencyMs;


    const latencyClass =
        getLatencyClass(
            latency,
            status
        );


    return `
        <div
            class="monitor-row ${
                status === "down"
                    ? "alert-down"
                    : ""
            }"
            data-device-id="${device.id}">

            <div class="device-name">

                <span class="device-icon">
                    ${device.enabled === false ? "OFF" : "IP"}
                </span>

                <div>

                    <div class="device-name-text">
                        ${escapeHtml(device.name)}
                    </div>

                    <div class="device-subtext">
                        ${escapeHtml(
                            getGroupName(device.groupId)
                        )}
                    </div>

                </div>

            </div>


            <div class="status-cell">

                <span class="status-badge ${status}">
                    ${getStatusLabel(status)}
                </span>

            </div>


            <div>

                <span class="latency-value ${latencyClass}">
                    ${formatLatency(
                        latency,
                        status
                    )}
                </span>

            </div>


            <div>

                <span
                    class="ip-value"
                    title="${escapeHtml(device.ipAddress)}">

                    ${escapeHtml(device.ipAddress)}

                </span>

            </div>


            <div class="device-actions">

                <button
                    class="secondary-button small-button"
                    type="button"
                    data-action="details"
                    data-device-id="${device.id}">
                    Details
                </button>

                <button
                    class="secondary-button small-button"
                    type="button"
                    data-action="history"
                    data-device-id="${device.id}">
                    History
                </button>

                <button
                    class="secondary-button small-button"
                    type="button"
                    data-action="edit"
                    data-device-id="${device.id}">
                    Edit
                </button>

                <button
                    class="secondary-button small-button danger-button"
                    type="button"
                    data-action="delete"
                    data-device-id="${device.id}">
                    Delete
                </button>

            </div>

        </div>
    `;
}


function getLatencyClass(
    latency,
    status
) {

    if (status === "down") {
        return "high";
    }

    if (
        latency === null ||
        latency === undefined
    ) {
        return "muted";
    }


    const number =
        Number(latency);


    if (number <= 50) {
        return "good";
    }

    if (number <= 150) {
        return "medium";
    }

    return "high";
}


/* =========================================================
   DEVICE DETAILS
   ========================================================= */

async function openDeviceDetails(
    deviceId
) {

    const device =
        state.devices.find(
            item =>
                Number(item.id) ===
                Number(deviceId)
        );


    if (!device) {
        showToast(
            "Device not found.",
            "error"
        );

        return;
    }


    state.selectedDeviceId =
        Number(deviceId);


    const modal =
        $("deviceDetailModal");

    const content =
        $("deviceDetailContent");


    modal?.classList.remove("hidden");
    modal?.setAttribute(
        "aria-hidden",
        "false"
    );


    if (!content) return;


    content.innerHTML = `
        <div class="loading-state">
            Loading device information...
        </div>
    `;


    let history = [];

    try {

        history =
            await apiRequest(
                `/api/monitoring/history/${device.id}?hours=${getRangeHours(
                    state.historyRange
                )}`
            );

    } catch (error) {

        console.error(error);
    }


    const status =
        getStatus(device);


    const latest =
        history.length
            ? history[history.length - 1]
            : null;


    content.innerHTML = `

        <div class="detail-grid">

            <div class="detail-item">
                <div class="detail-label">
                    Device
                </div>
                <div class="detail-value">
                    ${escapeHtml(device.name)}
                </div>
            </div>


            <div class="detail-item">
                <div class="detail-label">
                    IP Address
                </div>
                <div class="detail-value font-mono">
                    ${escapeHtml(device.ipAddress)}
                </div>
            </div>


            <div class="detail-item">
                <div class="detail-label">
                    Group
                </div>
                <div class="detail-value">
                    ${escapeHtml(
                        getGroupName(device.groupId)
                    )}
                </div>
            </div>


            <div class="detail-item">
                <div class="detail-label">
                    Status
                </div>
                <div class="detail-value">
                    ${getStatusLabel(status)}
                </div>
            </div>


            <div class="detail-item">
                <div class="detail-label">
                    Current Latency
                </div>
                <div class="detail-value">
                    ${formatLatency(
                        device.lastLatencyMs,
                        status
                    )}
                </div>
            </div>


            <div class="detail-item">
                <div class="detail-label">
                    Last Checked
                </div>
                <div class="detail-value">
                    ${formatDateTime(
                        device.lastChecked
                    )}
                </div>
            </div>


            <div class="detail-item">
                <div class="detail-label">
                    Last Seen
                </div>
                <div class="detail-value">
                    ${formatDateTime(
                        device.lastSeen
                    )}
                </div>
            </div>


            <div class="detail-item">
                <div class="detail-label">
                    Ping Interval
                </div>
                <div class="detail-value">
                    ${safeNumber(
                        device.pingIntervalSeconds,
                        5
                    )} seconds
                </div>
            </div>

        </div>


        <div class="detail-history">

            <div class="detail-history-header">

                <div>
                    <strong>
                        Recent Monitoring
                    </strong>

                    <span>
                        ${
                            latest
                                ? formatDateTime(
                                    latest.checkedAt
                                )
                                : "No history"
                        }
                    </span>
                </div>

                <button
                    class="secondary-button"
                    type="button"
                    data-action="history"
                    data-device-id="${device.id}">
                    Open History
                </button>

            </div>


            ${renderHistoryMini(history)}

        </div>
    `;
}


/* =========================================================
   MINI HISTORY
   ========================================================= */

function renderHistoryMini(history) {

    if (!history.length) {

        return `
            <div class="empty-state compact">
                No monitoring history available.
            </div>
        `;
    }


    const recent =
        history
            .slice(-10)
            .reverse();


    return `
        <div class="history-mini-list">

            ${recent
                .map(
                    entry => {

                        const status =
                            entry.isUp
                                ? "UP"
                                : "DOWN";


                        return `
                            <div class="history-mini-row">

                                <span>
                                    ${formatShortTime(
                                        entry.checkedAt
                                    )}
                                </span>

                                <strong class="${
                                    entry.isUp
                                        ? "text-success"
                                        : "text-danger"
                                }">
                                    ${status}
                                </strong>

                                <span>
                                    ${
                                        entry.latencyMs !== null &&
                                        entry.latencyMs !== undefined
                                            ? `${entry.latencyMs} ms`
                                            : "TIMEOUT"
                                    }
                                </span>

                            </div>
                        `;
                    }
                )
                .join("")}

        </div>
    `;
}


/* =========================================================
   DEVICE MODAL
   ========================================================= */

function openDeviceModal(
    mode,
    deviceId = null
) {

    const modal =
        $("deviceModal");

    const form =
        $("deviceForm");


    if (!modal || !form) return;


    state.deviceModalMode =
        mode;

    state.editingDeviceId =
        deviceId;


    form.reset();


    const title =
        $("deviceModalTitle");


    if (mode === "edit") {

        const device =
            state.devices.find(
                item =>
                    Number(item.id) ===
                    Number(deviceId)
            );


        if (!device) {
            showToast(
                "Device not found.",
                "error"
            );

            return;
        }


        title.textContent =
            "Edit Device";


        form.elements.name.value =
            device.name || "";


        form.elements.ipAddress.value =
            device.ipAddress || "";


        form.elements.groupId.value =
            device.groupId;


        form.elements.pingIntervalSeconds.value =
            safeNumber(
                device.pingIntervalSeconds,
                state.settings.defaultPingInterval
            );


        form.elements.enabled.checked =
            device.enabled !== false;

    } else {

        title.textContent =
            "Add Device";


        form.elements.pingIntervalSeconds.value =
            state.settings.defaultPingInterval;


        form.elements.enabled.checked =
            true;
    }


    populateDeviceGroups(
        form.elements.groupId
    );


    if (mode === "edit") {

        const device =
            state.devices.find(
                item =>
                    Number(item.id) ===
                    Number(deviceId)
            );

        if (device) {
            form.elements.groupId.value =
                device.groupId;
        }
    }


    openModal(
        "deviceModal"
    );
}


function populateDeviceGroups(select) {

    if (!select) return;


    select.innerHTML =
        state.groups
            .map(
                group =>
                    `<option value="${group.id}">
                        ${escapeHtml(group.name)}
                    </option>`
            )
            .join("");


    if (!state.groups.length) {

        select.innerHTML =
            `<option value="">
                Create a group first
            </option>`;
    }
}


/* =========================================================
   DEVICE SAVE
   ========================================================= */

async function handleDeviceSubmit(
    event
) {

    event.preventDefault();


    const form =
        event.currentTarget;


    const formData =
        new FormData(form);


    const payload = {

        name:
            String(
                formData.get("name") || ""
            ).trim(),

        ipAddress:
            String(
                formData.get("ipAddress") || ""
            ).trim(),

        groupId:
            Number(
                formData.get("groupId")
            ),

        pingIntervalSeconds:
            Number(
                formData.get(
                    "pingIntervalSeconds"
                ) || 5
            ),

        enabled:
            form.elements.enabled.checked
    };


    if (!payload.name) {

        showToast(
            "Device name is required.",
            "error"
        );

        return;
    }


    if (!isValidIPv4(
        payload.ipAddress
    )) {

        showToast(
            "Enter a valid IPv4 address.",
            "error"
        );

        return;
    }


    if (!payload.groupId) {

        showToast(
            "Create/select a group first.",
            "error"
        );

        return;
    }


    try {

        if (
            state.deviceModalMode ===
            "edit"
        ) {

            await apiRequest(
                `/api/devices/${state.editingDeviceId}`,
                {
                    method: "PUT",
                    body: JSON.stringify(payload)
                }
            );

            showToast(
                "Device updated.",
                "success"
            );

        } else {

            await apiRequest(
                "/api/devices",
                {
                    method: "POST",
                    body: JSON.stringify(payload)
                }
            );

            showToast(
                "Device added.",
                "success"
            );
        }


        closeModal(
            "deviceModal"
        );


        await refreshDashboard();

    } catch (error) {

        console.error(error);

        showToast(
            error.message ||
            "Unable to save device.",
            "error"
        );
    }
}


/* =========================================================
   IPv4 VALIDATION
   ========================================================= */

function isValidIPv4(
    value
) {

    const parts =
        String(value).split(".");


    if (parts.length !== 4) {
        return false;
    }


    return parts.every(
        part => {

            if (!/^\d+$/.test(part)) {
                return false;
            }

            const number =
                Number(part);

            return (
                number >= 0 &&
                number <= 255
            );
        }
    );
}


/* =========================================================
   DELETE DEVICE
   ========================================================= */

async function deleteDevice(
    deviceId
) {

    const device =
        state.devices.find(
            item =>
                Number(item.id) ===
                Number(deviceId)
        );


    if (!device) return;


    const confirmed =
        window.confirm(
            `Delete device "${device.name}"?\n\n` +
            "Its monitoring history and alerts will also be deleted."
        );


    if (!confirmed) return;


    try {

        await apiRequest(
            `/api/devices/${deviceId}`,
            {
                method: "DELETE"
            }
        );


        showToast(
            "Device deleted.",
            "success"
        );


        await refreshDashboard();

    } catch (error) {

        console.error(error);

        showToast(
            error.message ||
            "Unable to delete device.",
            "error"
        );
    }
}


/* =========================================================
   GROUP MODAL
   ========================================================= */

function openGroupModal(
    mode,
    groupId = null
) {

    const modal =
        $("groupModal");

    const form =
        $("groupForm");


    if (!modal || !form) return;


    state.groupModalMode =
        mode;

    state.editingGroupId =
        groupId;


    form.reset();


    const title =
        $("groupModalTitle");


    if (mode === "edit") {

        const group =
            state.groups.find(
                item =>
                    Number(item.id) ===
                    Number(groupId)
            );


        if (!group) return;


        title.textContent =
            "Edit Group";


        form.elements.name.value =
            group.name || "";


        form.elements.description.value =
            group.description || "";

    } else {

        title.textContent =
            "Create Group";
    }


    openModal(
        "groupModal"
    );
}


/* =========================================================
   GROUP SAVE
   ========================================================= */

async function handleGroupSubmit(
    event
) {

    event.preventDefault();


    const form =
        event.currentTarget;


    const formData =
        new FormData(form);


    const payload = {

        name:
            String(
                formData.get("name") || ""
            ).trim(),

        description:
            String(
                formData.get("description") || ""
            ).trim()
    };


    if (!payload.name) {

        showToast(
            "Group name is required.",
            "error"
        );

        return;
    }


    try {

        if (
            state.groupModalMode ===
            "edit"
        ) {

            await apiRequest(
                `/api/groups/${state.editingGroupId}`,
                {
                    method: "PUT",
                    body: JSON.stringify(payload)
                }
            );

            showToast(
                "Group updated.",
                "success"
            );

        } else {

            await apiRequest(
                "/api/groups",
                {
                    method: "POST",
                    body: JSON.stringify(payload)
                }
            );

            showToast(
                "Group created.",
                "success"
            );
        }


        closeModal(
            "groupModal"
        );


        await refreshDashboard();

    } catch (error) {

        console.error(error);

        showToast(
            error.message ||
            "Unable to save group.",
            "error"
        );
    }
}


/* =========================================================
   DELETE GROUP
   ========================================================= */

async function deleteGroup(
    groupId
) {

    const group =
        state.groups.find(
            item =>
                Number(item.id) ===
                Number(groupId)
        );


    if (!group) return;


    const devices =
        state.devices.filter(
            device =>
                Number(device.groupId) ===
                Number(groupId)
        );


    if (devices.length) {

        showToast(
            `Cannot delete "${group.name}". Move or delete its devices first.`,
            "error"
        );

        return;
    }


    if (
        !window.confirm(
            `Delete group "${group.name}"?`
        )
    ) {
        return;
    }


    try {

        await apiRequest(
            `/api/groups/${groupId}`,
            {
                method: "DELETE"
            }
        );


        showToast(
            "Group deleted.",
            "success"
        );


        await refreshDashboard();

    } catch (error) {

        console.error(error);

        showToast(
            error.message ||
            "Unable to delete group.",
            "error"
        );
    }
}


/* =========================================================
   ALERTS
   ========================================================= */

function renderAlerts() {

    const container =
        $("dashboardRecentAlerts");

    if (!container) return;


    const alerts =
        state.alerts.slice(0, 8);


    $("dashboardAlertCount").textContent =
        state.alerts.length;


    if (!alerts.length) {

        container.innerHTML = `
            <div class="empty-state compact">
                No recent alerts.
            </div>
        `;

        return;
    }


    container.innerHTML =
        alerts
            .map(
                alert =>
                    renderAlertItem(
                        alert
                    )
            )
            .join("");
}


function renderAlertsPanel() {

    const container =
        $("alertsPanelList");

    if (!container) return;


    if (!state.alerts.length) {

        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-title">
                    No alerts
                </div>
                <div class="empty-text">
                    Infrastructure events will appear here.
                </div>
            </div>
        `;

        return;
    }


    container.innerHTML =
        state.alerts
            .map(
                alert =>
                    renderFullAlert(
                        alert
                    )
            )
            .join("");
}


function renderAlertItem(
    alert
) {

    const message =
        alert.message ||
        alert.eventType ||
        "Infrastructure event";


    const device =
        alert.device ||
        alert.deviceName ||
        "Unknown device";


    const time =
        alert.createdAt ||
        alert.time;


    const isDown =
        String(
            alert.eventType ||
            alert.event ||
            ""
        )
            .toLowerCase()
            .includes("down");


    return `
        <div class="recent-alert-item">

            <span class="alert-dot ${
                isDown
                    ? "down"
                    : "up"
            }"></span>

            <div class="recent-alert-content">

                <strong>
                    ${escapeHtml(device)}
                </strong>

                <span>
                    ${escapeHtml(message)}
                </span>

            </div>

            <time>
                ${escapeHtml(
                    formatDateTime(time)
                )}
            </time>

        </div>
    `;
}


function renderFullAlert(
    alert
) {

    const message =
        alert.message ||
        alert.eventType ||
        "Infrastructure event";


    const device =
        alert.device ||
        alert.deviceName ||
        "Unknown device";


    return `
        <div class="alert-row">

            <div class="alert-row-status"></div>

            <div class="alert-row-main">

                <strong>
                    ${escapeHtml(device)}
                </strong>

                <span>
                    ${escapeHtml(message)}
                </span>

            </div>

            <time>
                ${escapeHtml(
                    formatDateTime(
                        alert.createdAt
                    )
                )}
            </time>

        </div>
    `;
}


function updateAlertCount() {

    const count =
        $("alertCount");

    if (!count) return;


    const value =
        state.alerts.length;


    count.textContent =
        value;


    count.hidden =
        value === 0;
}


/* =========================================================
   STATUS CHANGE + DOWN ALARM
   ========================================================= */

function detectStatusChanges(
    previousDevices
) {

    const previous =
        new Map(
            previousDevices.map(
                device => [
                    Number(device.id),
                    getStatus(device)
                ]
            )
        );


    state.devices.forEach(
        device => {

            const oldStatus =
                previous.get(
                    Number(device.id)
                );


            const newStatus =
                getStatus(device);


            if (
                oldStatus === "up" &&
                newStatus === "down"
            ) {

                playDownAlert();
            }
        }
    );


    state.lastStatuses.clear();


    state.devices.forEach(
        device => {

            state.lastStatuses.set(
                Number(device.id),
                getStatus(device)
            );
        }
    );
}


/* =========================================================
   AUDIO
   ========================================================= */

function getAudioContext() {

    const AudioContext =
        window.AudioContext ||
        window.webkitAudioContext;


    if (!AudioContext) {
        return null;
    }


    if (!state.audioContext) {
        state.audioContext =
            new AudioContext();
    }


    return state.audioContext;
}


async function enableAlertSound() {

    const context =
        getAudioContext();


    if (!context) {

        showToast(
            "Alert audio is not supported by this browser.",
            "error"
        );

        return;
    }


    try {

        await context.resume();

        state.settings.alertSoundEnabled =
            true;

        saveSettings();

        playThreeBeeps();

        updateTvSoundButton();

        showToast(
            "Alert sound enabled.",
            "success"
        );

    } catch (error) {

        console.error(error);

        showToast(
            "Click the alert button again to enable sound.",
            "error"
        );
    }
}


function playDownAlert() {

    if (
        !state.settings.alertSoundEnabled
    ) {
        return;
    }


    playThreeBeeps();
}


function playThreeBeeps() {

    const context =
        getAudioContext();


    if (!context) {
        return;
    }


    const play =
        () => {

            const volume =
                Math.max(
                    0.01,
                    Math.min(
                        1,
                        safeNumber(
                            state.settings.alertVolume,
                            0.35
                        )
                    )
                );


            const start =
                context.currentTime;


            [0, 0.24, 0.48]
                .forEach(
                    offset => {

                        const oscillator =
                            context.createOscillator();

                        const gain =
                            context.createGain();


                        oscillator.type =
                            "sine";

                        oscillator.frequency.value =
                            700;


                        gain.gain.setValueAtTime(
                            volume,
                            start + offset
                        );

                        gain.gain.exponentialRampToValueAtTime(
                            0.001,
                            start + offset + 0.16
                        );


                        oscillator
                            .connect(gain)
                            .connect(
                                context.destination
                            );


                        oscillator.start(
                            start + offset
                        );

                        oscillator.stop(
                            start + offset + 0.17
                        );
                    }
                );
        };


    if (
        context.state ===
        "suspended"
    ) {

        context.resume()
            .then(play)
            .catch(
                () => {}
            );

    } else {

        play();
    }
}


function testAlertSound() {

    if (
        !state.settings.alertSoundEnabled
    ) {

        showToast(
            "Enable Alert Sound first.",
            "error"
        );

        return;
    }


    playThreeBeeps();


    showToast(
        "Test alert sound played.",
        "success"
    );
}


function updateTvSoundButton() {

    const button =
        $("tvSoundButton");

    if (!button) return;


    button.textContent =
        state.settings.alertSoundEnabled
            ? "Alert Sound On"
            : "Enable Alert Sound";
}


/* =========================================================
   SETTINGS
   ========================================================= */

function updateSettingsForm() {

    const form =
        $("settingsForm");

    if (!form) return;


    if (form.elements.defaultPingInterval) {
        form.elements.defaultPingInterval.value =
            state.settings.defaultPingInterval;
    }


    if (form.elements.pingTimeout) {
        form.elements.pingTimeout.value =
            state.settings.pingTimeout;
    }


    if (form.elements.historyRetention) {
        form.elements.historyRetention.value =
            state.settings.historyRetention;
    }


    if (form.elements.monitoringEnabled) {
        form.elements.monitoringEnabled.checked =
            state.settings.monitoringEnabled;
    }


    if (form.elements.alertSoundEnabled) {
        form.elements.alertSoundEnabled.checked =
            state.settings.alertSoundEnabled;
    }


    if (form.elements.alertVolume) {
        form.elements.alertVolume.value =
            state.settings.alertVolume;
    }


    updateTvSoundButton();
}


async function handleSettingsSubmit(
    event
) {

    event.preventDefault();


    const form =
        event.currentTarget;


    const payload = {

        defaultPingIntervalSeconds:
            Number(
                form.elements
                    .defaultPingInterval
                    .value
            ),

        pingTimeoutMilliseconds:
            Number(
                form.elements
                    .pingTimeout
                    .value
            ),

        historyRetentionHours:
            Number(
                form.elements
                    .historyRetention
                    .value
            ),

        monitoringEnabled:
            form.elements
                .monitoringEnabled
                .checked
    };


    try {

        await apiRequest(
            "/api/settings",
            {
                method: "PUT",
                body: JSON.stringify(payload)
            }
        );


        state.settings.defaultPingInterval =
            payload.defaultPingIntervalSeconds;


        state.settings.pingTimeout =
            payload.pingTimeoutMilliseconds;


        state.settings.historyRetention =
            payload.historyRetentionHours;


        state.settings.monitoringEnabled =
            payload.monitoringEnabled;


        state.settings.alertSoundEnabled =
            form.elements
                .alertSoundEnabled
                .checked;


        state.settings.alertVolume =
            Number(
                form.elements
                    .alertVolume
                    .value
            );


        saveSettings();


        applyTvMode();

        updateSettingsForm();


        showToast(
            "Settings saved.",
            "success"
        );


        await refreshDashboard();

    } catch (error) {

        console.error(error);

        showToast(
            error.message ||
            "Unable to save settings.",
            "error"
        );
    }
}


/* =========================================================
   THEME
   ========================================================= */

function applyTheme() {

    document.documentElement.dataset.theme =
        state.theme;


    document.body.classList.toggle(
        "light-theme",
        state.theme === "light"
    );


    const button =
        $("themeToggleButton");


    if (!button) return;


    button.title =
        state.theme === "light"
            ? "Switch to dark mode"
            : "Switch to light mode";
}


function toggleTheme() {

    state.theme =
        state.theme === "light"
            ? "dark"
            : "light";


    localStorage.setItem(
        STORAGE_THEME,
        state.theme
    );


    applyTheme();
}


/* =========================================================
   LAYOUT
   ========================================================= */

function applyLayout() {

    const root =
        document.documentElement;


    root.style.setProperty(
        "--device-col-width",
        `${state.layout.deviceName}px`
    );


    root.style.setProperty(
        "--status-col-width",
        `${state.layout.status}px`
    );


    root.style.setProperty(
        "--latency-col-width",
        `${state.layout.latency}px`
    );


    root.style.setProperty(
        "--ip-col-width",
        `${state.layout.ipAddress}px`
    );


    root.style.setProperty(
        "--action-col-width",
        `${state.layout.actions}px`
    );
}


function resetLayout() {

    state.layout =
        { ...DEFAULT_LAYOUT };


    saveLayout();

    applyLayout();

    renderMonitor();


    showToast(
        "Layout reset.",
        "success"
    );
}


/* =========================================================
   HISTORY API
   ========================================================= */

async function fetchHistory(
    deviceId,
    range
) {

    return apiRequest(
        `/api/monitoring/history/${deviceId}?hours=${getRangeHours(
            range
        )}`
    );
}


/* =========================================================
   HISTORY MODAL
   ========================================================= */

async function openHistoryModal(
    deviceId
) {

    const device =
        state.devices.find(
            item =>
                Number(item.id) ===
                Number(deviceId)
        );


    if (!device) return;


    state.selectedDeviceId =
        Number(deviceId);


    $("historyModal")?.classList.remove(
        "hidden"
    );


    $("historyModal")?.setAttribute(
        "aria-hidden",
        "false"
    );


    $("historyInfo").textContent =
        `${device.name} • ${device.ipAddress}`;


    await renderHistory(
        deviceId
    );
}


async function renderHistory(
    deviceId
) {

    const container =
        $("historyList");


    if (!container) return;


    container.innerHTML = `
        <div class="loading-state">
            Loading real monitoring history...
        </div>
    `;


    try {

        const history =
            await fetchHistory(
                deviceId,
                state.historyRange
            );


        container.innerHTML =
            renderHistoryChart(
                history
            );

    } catch (error) {

        console.error(error);

        container.innerHTML = `
            <div class="empty-state">
                Unable to load monitoring history.
            </div>
        `;
    }
}


/* =========================================================
   HISTORY CHART
   ========================================================= */

function renderHistoryChart(
    history
) {

    if (!history?.length) {

        return `
            <div class="empty-state">
                <div class="empty-title">
                    No monitoring history
                </div>
                <div class="empty-text">
                    There are no PingResults for this range.
                </div>
            </div>
        `;
    }


    const points =
        history.filter(
            item =>
                item.latencyMs !== null &&
                item.latencyMs !== undefined
        );


    const max =
        Math.max(
            10,
            ...points.map(
                item =>
                    Number(item.latencyMs)
            )
        );


    const average =
        points.length
            ? (
                points.reduce(
                    (sum, item) =>
                        sum +
                        Number(item.latencyMs),
                    0
                ) /
                points.length
            ).toFixed(1)
            : "--";


    const up =
        history.filter(
            item => item.isUp
        ).length;


    const availability =
        Math.round(
            (up / history.length) * 100
        );


    return `

        <div class="history-summary-grid">

            <div class="stat-box">
                <span>Samples</span>
                <strong>${history.length}</strong>
            </div>

            <div class="stat-box">
                <span>Average</span>
                <strong>${average} ms</strong>
            </div>

            <div class="stat-box">
                <span>Maximum</span>
                <strong>${max} ms</strong>
            </div>

            <div class="stat-box">
                <span>Availability</span>
                <strong>${availability}%</strong>
            </div>

        </div>


        <div class="history-table-wrap">

            <table class="history-table">

                <thead>
                    <tr>
                        <th>TIME</th>
                        <th>STATUS</th>
                        <th>LATENCY</th>
                        <th>ERROR</th>
                    </tr>
                </thead>

                <tbody>

                    ${history
                        .slice()
                        .reverse()
                        .map(
                            item => `

                                <tr>

                                    <td>
                                        ${escapeHtml(
                                            formatDateTime(
                                                item.checkedAt
                                            )
                                        )}
                                    </td>

                                    <td>
                                        <strong class="${
                                            item.isUp
                                                ? "text-success"
                                                : "text-danger"
                                        }">
                                            ${
                                                item.isUp
                                                    ? "UP"
                                                    : "DOWN"
                                            }
                                        </strong>
                                    </td>

                                    <td>
                                        ${
                                            item.latencyMs !== null &&
                                            item.latencyMs !== undefined
                                                ? `${item.latencyMs} ms`
                                                : "TIMEOUT"
                                        }
                                    </td>

                                    <td>
                                        ${escapeHtml(
                                            item.errorMessage || "--"
                                        )}
                                    </td>

                                </tr>

                            `
                        )
                        .join("")}

                </tbody>

            </table>

        </div>
    `;
}


/* =========================================================
   DASHBOARD HISTORY
   ========================================================= */

let dashboardHistory = [];


async function loadDashboardHistory() {

    let devices =
        state.devices;


    if (
        state.dashboardDeviceId !==
        "all"
    ) {

        devices =
            devices.filter(
                device =>
                    String(device.id) ===
                    String(
                        state.dashboardDeviceId
                    )
            );
    }


    if (!devices.length) {

        dashboardHistory = [];

        return;
    }


    const results =
        await Promise.all(
            devices.map(
                async device => {

                    try {

                        const history =
                            await fetchHistory(
                                device.id,
                                state.dashboardRange
                            );


                        return {
                            device,
                            history
                        };

                    } catch {

                        return {
                            device,
                            history: []
                        };
                    }
                }
            )
        );


    dashboardHistory =
        results;
}


/* =========================================================
   DASHBOARD ANALYTICS
   ========================================================= */

function renderDashboardAnalytics() {

    const allEntries =
        dashboardHistory.flatMap(
            item =>
                item.history.map(
                    entry => ({
                        ...entry,
                        deviceName:
                            item.device.name
                    })
                )
        );


    const points =
        allEntries.filter(
            entry =>
                entry.latencyMs !== null &&
                entry.latencyMs !== undefined
        );


    const values =
        points.map(
            entry =>
                Number(entry.latencyMs)
        );


    const max =
        values.length
            ? Math.max(...values)
            : null;


    const average =
        values.length
            ? (
                values.reduce(
                    (sum, value) =>
                        sum + value,
                    0
                ) /
                values.length
            )
            : null;


    const latest =
        allEntries.length
            ? allEntries[
                allEntries.length - 1
            ]
            : null;


    $("dashboardMaxLatency").textContent =
        max !== null
            ? `${Math.round(max)} ms`
            : "--";


    $("dashboardAverageLatencyStat").textContent =
        average !== null
            ? `${Math.round(average)} ms`
            : "--";


    $("dashboardAverageLatencySummary").textContent =
        average !== null
            ? `${Math.round(average)} ms`
            : "--";


    $("dashboardCurrentLatency").textContent =
        latest?.latencyMs !== null &&
        latest?.latencyMs !== undefined
            ? `${latest.latencyMs} ms`
            : "--";


    renderDashboardChart(
        allEntries
    );
}


/* =========================================================
   DASHBOARD SVG CHART
   ========================================================= */

function renderDashboardChart(
    entries
) {

    const container =
        $("dashboardLatencyChart");


    if (!container) return;


    const points =
        entries.filter(
            entry =>
                entry.latencyMs !== null &&
                entry.latencyMs !== undefined
        );


    if (!points.length) {

        container.innerHTML = `
            <div class="chart-empty">
                No latency history available.
            </div>
        `;

        return;
    }


    const width = 1000;
    const height = 260;

    const left = 48;
    const right = 20;
    const top = 20;
    const bottom = 34;


    const values =
        points.map(
            item =>
                Number(item.latencyMs)
        );


    const max =
        Math.max(
            10,
            ...values
        );


    const usableWidth =
        width - left - right;


    const usableHeight =
        height - top - bottom;


    const coordinates =
        points.map(
            (point, index) => {

                const x =
                    left +
                    (
                        index /
                        Math.max(
                            1,
                            points.length - 1
                        )
                    ) *
                    usableWidth;


                const y =
                    top +
                    (
                        1 -
                        (
                            Number(
                                point.latencyMs
                            ) /
                            max
                        )
                    ) *
                    usableHeight;


                return {
                    x,
                    y
                };
            }
        );


    const line =
        coordinates
            .map(
                point =>
                    `${point.x},${point.y}`
            )
            .join(" ");


    const area =
        `${left},${height - bottom} ` +
        line +
        ` ${left + usableWidth},${height - bottom}`;


    const downMarkers =
        entries
            .filter(
                entry =>
                    entry.isUp === false
            )
            .slice(-60)
            .map(
                entry => {

                    const index =
                        points.indexOf(
                            entry
                        );


                    if (index < 0) {
                        return "";
                    }


                    const point =
                        coordinates[index];


                    return `
                        <circle
                            cx="${point.x}"
                            cy="${height - bottom}"
                            r="4"
                            class="chart-down-dot">
                        </circle>
                    `;
                }
            )
            .join("");


    container.innerHTML = `

        <svg
            class="latency-svg"
            viewBox="0 0 ${width} ${height}"
            preserveAspectRatio="none">

            <defs>

                <linearGradient
                    id="latencyArea"
                    x1="0"
                    x2="0"
                    y1="0"
                    y2="1">

                    <stop
                        offset="0%"
                        stop-color="currentColor"
                        stop-opacity="0.20" />

                    <stop
                        offset="100%"
                        stop-color="currentColor"
                        stop-opacity="0" />

                </linearGradient>

            </defs>


            <g class="chart-grid-lines">

                <line
                    x1="${left}"
                    y1="${top}"
                    x2="${width - right}"
                    y2="${top}" />

                <line
                    x1="${left}"
                    y1="${top + usableHeight / 2}"
                    x2="${width - right}"
                    y2="${top + usableHeight / 2}" />

                <line
                    x1="${left}"
                    y1="${height - bottom}"
                    x2="${width - right}"
                    y2="${height - bottom}" />

            </g>


            <polygon
                class="latency-area"
                points="${area}" />


            <polyline
                class="latency-line"
                points="${line}" />


            ${downMarkers}


            <text
                class="chart-label"
                x="8"
                y="${top + 4}">
                ${Math.round(max)} ms
            </text>


            <text
                class="chart-label"
                x="12"
                y="${height - bottom + 4}">
                0 ms
            </text>

        </svg>
    `;
}


/* =========================================================
   REPORT MODAL
   ========================================================= */

function openReportModal() {

    const modal =
        $("reportModal");


    if (!modal) return;


    const groupSelect =
        document.querySelector(
            '[name="reportGroup"]'
        );


    const deviceSelect =
        document.querySelector(
            '[name="reportDevice"]'
        );


    if (groupSelect) {

        groupSelect.innerHTML =
            `<option value="all">
                All Groups
            </option>` +
            state.groups
                .map(
                    group =>
                        `<option value="${group.id}">
                            ${escapeHtml(group.name)}
                        </option>`
                )
                .join("");
    }


    if (deviceSelect) {

        deviceSelect.innerHTML =
            `<option value="all">
                All Devices
            </option>` +
            state.devices
                .map(
                    device =>
                        `<option value="${device.id}">
                            ${escapeHtml(device.name)}
                        </option>`
                )
                .join("");
    }


    openModal(
        "reportModal"
    );
}


/* =========================================================
   REPORT GENERATION
   ========================================================= */

async function handleReportSubmit(
    event
) {

    event.preventDefault();


    const form =
        event.currentTarget;


    const data =
        new FormData(form);


    const range =
        data.get("reportRange") ||
        "24H";


    const groupId =
        data.get("reportGroup") ||
        "all";


    const deviceId =
        data.get("reportDevice") ||
        "all";


    const status =
        data.get("reportStatus") ||
        "all";


    let devices =
        state.devices.filter(
            device => {

                const groupMatch =
                    groupId === "all" ||
                    String(device.groupId) ===
                    String(groupId);


                const deviceMatch =
                    deviceId === "all" ||
                    String(device.id) ===
                    String(deviceId);


                const statusMatch =
                    status === "all" ||
                    getStatus(device) ===
                    status;


                return (
                    groupMatch &&
                    deviceMatch &&
                    statusMatch
                );
            }
        );


    showToast(
        "Collecting monitoring history...",
        "info"
    );


    const histories =
        await Promise.all(
            devices.map(
                async device => {

                    let history = [];

                    try {

                        history =
                            await fetchHistory(
                                device.id,
                                range
                            );

                    } catch {
                        history = [];
                    }


                    return {
                        device,
                        history
                    };
                }
            )
        );


    const total =
        devices.length;


    const up =
        devices.filter(
            device =>
                getStatus(device) ===
                "up"
        ).length;


    const down =
        devices.filter(
            device =>
                getStatus(device) ===
                "down"
        ).length;


    const unknown =
        devices.filter(
            device =>
                getStatus(device) ===
                "unknown"
        ).length;


    const rows =
        histories
            .flatMap(
                result =>
                    result.history.map(
                        entry => `

                            <tr>

                                <td>
                                    ${escapeHtml(
                                        result.device.name
                                    )}
                                </td>

                                <td class="mono">
                                    ${escapeHtml(
                                        result.device.ipAddress
                                    )}
                                </td>

                                <td>
                                    ${escapeHtml(
                                        formatDateTime(
                                            entry.checkedAt
                                        )
                                    )}
                                </td>

                                <td>
                                    <strong class="${
                                        entry.isUp
                                            ? "up"
                                            : "down"
                                    }">
                                        ${
                                            entry.isUp
                                                ? "UP"
                                                : "DOWN"
                                        }
                                    </strong>
                                </td>

                                <td>
                                    ${
                                        entry.latencyMs !== null &&
                                        entry.latencyMs !== undefined
                                            ? `${entry.latencyMs} ms`
                                            : "TIMEOUT"
                                    }
                                </td>

                                <td>
                                    ${escapeHtml(
                                        entry.errorMessage || "--"
                                    )}
                                </td>

                            </tr>

                        `
                    )
            )
            .join("");


    const generated =
        formatDateTime(
            new Date()
        );


    const popup =
        window.open(
            "",
            "_blank",
            "width=1100,height=850"
        );


    if (!popup) {

        showToast(
            "Popup blocked. Allow popups to generate the report.",
            "error"
        );

        return;
    }


    popup.document.write(`

        <!DOCTYPE html>

        <html>

        <head>

            <meta charset="UTF-8">

            <title>
                InfraMonitor Report
            </title>

            <style>

                body {
                    font-family:
                        Arial,
                        sans-serif;

                    color: #17202a;

                    margin: 32px;
                }

                h1 {
                    margin-bottom: 4px;
                }

                h2 {
                    margin-top: 30px;
                }

                .meta {
                    color: #64748b;
                    font-size: 13px;
                }

                .summary {
                    display: grid;
                    grid-template-columns:
                        repeat(4, 1fr);
                    gap: 12px;
                    margin-top: 20px;
                }

                .card {
                    border: 1px solid #d7dee7;
                    padding: 14px;
                }

                .label {
                    font-size: 11px;
                    color: #64748b;
                }

                .value {
                    font-size: 25px;
                    font-weight: 700;
                    margin-top: 5px;
                }

                table {
                    width: 100%;
                    border-collapse:
                        collapse;
                    margin-top: 12px;
                }

                th,
                td {
                    border:
                        1px solid #d7dee7;
                    padding: 8px;
                    text-align: left;
                    font-size: 12px;
                }

                th {
                    background:
                        #eef3f7;
                }

                .up {
                    color: #15803d;
                }

                .down {
                    color: #dc2626;
                }

                .mono {
                    font-family:
                        Consolas,
                        monospace;
                }

                @media print {

                    body {
                        margin: 15mm;
                    }

                }

            </style>

        </head>

        <body>

            <h1>
                INFRA MONITOR
            </h1>

            <div class="meta">
                Infrastructure Monitoring Report
            </div>

            <div class="meta">
                Generated:
                ${escapeHtml(generated)}
            </div>

            <div class="meta">
                Range:
                ${escapeHtml(range)}
            </div>


            <div class="summary">

                <div class="card">
                    <div class="label">
                        TOTAL
                    </div>
                    <div class="value">
                        ${total}
                    </div>
                </div>

                <div class="card">
                    <div class="label">
                        UP
                    </div>
                    <div class="value up">
                        ${up}
                    </div>
                </div>

                <div class="card">
                    <div class="label">
                        DOWN
                    </div>
                    <div class="value down">
                        ${down}
                    </div>
                </div>

                <div class="card">
                    <div class="label">
                        UNKNOWN
                    </div>
                    <div class="value">
                        ${unknown}
                    </div>
                </div>

            </div>


            <h2>
                MONITORING HISTORY
            </h2>


            <table>

                <thead>

                    <tr>
                        <th>Device</th>
                        <th>IP Address</th>
                        <th>Timestamp</th>
                        <th>Status</th>
                        <th>Latency</th>
                        <th>Error</th>
                    </tr>

                </thead>

                <tbody>

                    ${
                        rows ||
                        `
                            <tr>
                                <td colspan="6">
                                    No monitoring history available.
                                </td>
                            </tr>
                        `
                    }

                </tbody>

            </table>


            <script>

                window.onload = function () {

                    setTimeout(
                        function () {
                            window.print();
                        },
                        350
                    );

                };

            <\/script>

        </body>

        </html>

    `);


    popup.document.close();


    closeModal(
        "reportModal"
    );


    showToast(
        "Report generated.",
        "success"
    );
}


/* =========================================================
   EXPORT
   ========================================================= */

function exportConfiguration() {

    const payload = {

        exportedAt:
            new Date().toISOString(),

        groups:
            state.groups,

        devices:
            state.devices,

        settings:
            state.settings
    };


    const blob =
        new Blob(
            [
                JSON.stringify(
                    payload,
                    null,
                    2
                )
            ],
            {
                type:
                    "application/json"
            }
        );


    const url =
        URL.createObjectURL(
            blob
        );


    const link =
        document.createElement("a");


    link.href =
        url;


    link.download =
        "inframonitor-config.json";


    document.body.appendChild(
        link
    );


    link.click();


    link.remove();


    URL.revokeObjectURL(
        url
    );


    showToast(
        "Configuration exported.",
        "success"
    );
}


/* =========================================================
   IMPORT
   ========================================================= */

async function importConfiguration(
    event
) {

    const file =
        event.target.files?.[0];


    if (!file) return;


    try {

        const text =
            await file.text();


        const json =
            JSON.parse(text);


        if (
            !Array.isArray(
                json.groups
            ) ||
            !Array.isArray(
                json.devices
            )
        ) {

            throw new Error(
                "Invalid configuration"
            );
        }


        /*
         * Important:
         * Import is intentionally local-only.
         * We do not blindly write imported IDs into
         * the backend database.
         *
         * This prevents accidental corruption of the
         * production SQLite database.
         */

        showToast(
            "Configuration file loaded. Backend import is not destructive.",
            "info"
        );

    } catch (error) {

        console.error(error);

        showToast(
            "Invalid configuration file.",
            "error"
        );

    } finally {

        event.target.value = "";
    }
}


/* =========================================================
   MODALS
   ========================================================= */

function openModal(
    id
) {

    const modal =
        $(id);


    if (!modal) return;


    modal.classList.remove(
        "hidden"
    );


    modal.setAttribute(
        "aria-hidden",
        "false"
    );


    const firstInput =
        modal.querySelector(
            "input:not([type='hidden']), select, textarea"
        );


    setTimeout(
        () => firstInput?.focus(),
        80
    );
}


function closeModal(
    id
) {

    const modal =
        $(id);


    if (!modal) return;


    modal.classList.add(
        "hidden"
    );


    modal.setAttribute(
        "aria-hidden",
        "true"
    );
}


function closeAllModals() {

    [
        "deviceModal",
        "groupModal",
        "reportModal",
        "deviceDetailModal",
        "historyModal"
    ]
        .forEach(
            closeModal
        );
}


/* =========================================================
   TV MODE
   ========================================================= */

function toggleTvMode() {

    state.settings.tvMode =
        !state.settings.tvMode;


    saveSettings();

    applyTvMode();


    showToast(
        state.settings.tvMode
            ? "TV Mode enabled."
            : "TV Mode disabled.",
        "info"
    );
}


function applyTvMode() {

    document.body.classList.toggle(
        "tv-mode",
        Boolean(
            state.settings.tvMode
        )
    );


    $("tvModeButton")
        ?.classList.toggle(
            "active",
            Boolean(
                state.settings.tvMode
            )
        );


    $("tvModeBackButton")
        ?.classList.toggle(
            "hidden",
            !state.settings.tvMode
        );


    $("tvSoundButton")
        ?.classList.toggle(
            "hidden",
            !state.settings.tvMode
        );


    if (
        state.settings.tvMode
    ) {

        startTvScroll();

    } else {

        stopTvScroll();
    }


    updateTvSoundButton();
}


/* =========================================================
   TV AUTO SCROLL
   ========================================================= */

function stopTvScroll() {

    if (
        state.tvAnimation
    ) {

        cancelAnimationFrame(
            state.tvAnimation
        );
    }


    state.tvAnimation =
        null;


    clearTimeout(
        state.tvResumeTimer
    );
}


function pauseTvScroll() {

    state.tvPaused =
        true;


    clearTimeout(
        state.tvResumeTimer
    );


    state.tvResumeTimer =
        setTimeout(
            () => {
                state.tvPaused =
                    false;
            },
            3500
        );
}


function startTvScroll() {

    if (
        !state.settings.tvMode
    ) {
        return;
    }


    stopTvScroll();


    const content =
        document.querySelector(
            ".main-panel"
        );


    if (!content) {
        return;
    }


    const tick =
        () => {

            if (
                !state.settings.tvMode
            ) {
                return;
            }


            if (
                !state.tvPaused
            ) {

                const max =
                    content.scrollHeight -
                    content.clientHeight;


                if (max > 20) {

                    content.scrollTop +=
                        0.25;


                    if (
                        content.scrollTop >=
                        max - 2
                    ) {

                        pauseTvScroll();

                        content.scrollTop =
                            0;
                    }
                }
            }


            state.tvAnimation =
                requestAnimationFrame(
                    tick
                );
        };


    state.tvAnimation =
        requestAnimationFrame(
            tick
        );
}


/* =========================================================
   TOAST
   ========================================================= */

let toastTimer = null;


function showToast(
    message,
    type = "info"
) {

    const toast =
        $("toast");


    if (!toast) return;


    toast.textContent =
        message;


    toast.className =
        `toast visible ${type}`;


    clearTimeout(
        toastTimer
    );


    toastTimer =
        setTimeout(
            () => {

                toast.classList.remove(
                    "visible"
                );

            },
            2600
        );
}


/* =========================================================
   END
   ========================================================= */