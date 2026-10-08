"use strict";

/* ---------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------- */
const THEME_KEY = "naimix-ops-theme";
const TOKEN_KEY = "naimix-ops-token";

let TOKEN = null;
let REFRESH_TIMER = null;
let LATEST_ENV = {};

/* ---------------------------------------------------------------------
 * Theme (light / dark) -- identical logic to the Developer Console's own,
 * duplicated rather than shared since each console's static files must
 * work standalone (see ops.css's own note on why).
 * ------------------------------------------------------------------- */
function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
}

function effectiveTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit) return explicit;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeToggleIcon() {
  const btn = document.getElementById("theme-toggle-btn");
  if (btn) btn.dataset.effective = effectiveTheme();
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") applyTheme(saved);
  updateThemeToggleIcon();
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (!document.documentElement.getAttribute("data-theme")) updateThemeToggleIcon();
    });
  }
}

function toggleTheme() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
  updateThemeToggleIcon();
}

initTheme();

/* ---------------------------------------------------------------------
 * API helper + small DOM/toast helpers
 * ------------------------------------------------------------------- */
async function api(path) {
  const res = await fetch(path, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  if (res.status === 401) {
    logout();
    throw new Error("Session expired — please sign in again.");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Request failed (${res.status})`);
  }
  return data;
}

function toast(message, isError) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.toggle("toast-error", Boolean(isError));
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (node.hidden = true), 3500);
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of children || []) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function showError(elId, message) {
  const node = document.getElementById(elId);
  if (!message) {
    node.hidden = true;
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

/* ---------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------- */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(totalSeconds) {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

/* ---------------------------------------------------------------------
 * Auth
 * ------------------------------------------------------------------- */
async function login(token) {
  const prevToken = TOKEN;
  TOKEN = token;
  try {
    await api("/ops/api/system");
  } catch (err) {
    TOKEN = prevToken;
    throw err;
  }
  localStorage.setItem(TOKEN_KEY, token);
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app").hidden = false;
  await loadSystem();
  await loadEnv();
  startAutoRefresh();
}

function logout() {
  TOKEN = null;
  stopAutoRefresh();
  localStorage.removeItem(TOKEN_KEY);
  document.getElementById("app").hidden = true;
  document.getElementById("login-screen").hidden = false;
}

/* ---------------------------------------------------------------------
 * System panel
 * ------------------------------------------------------------------- */
function statTile(label, value, sub) {
  return el("div", { class: "stat-tile" }, [
    el("div", { class: "stat-tile-label" }, [label]),
    el("div", { class: "stat-tile-value" }, [value]),
    sub ? el("div", { class: "stat-tile-sub" }, [sub]) : null,
  ]);
}

function renderSystem(data) {
  document.getElementById("instance-id").textContent = data.instanceId;
  const s = data.latest;
  const grid = document.getElementById("system-stats");
  grid.innerHTML = "";
  grid.append(
    statTile("CPU", `${s.cpu.percent}%`, `${s.cpu.coreCount} core(s)`),
    statTile("Memory (RSS)", formatBytes(s.memory.rss)),
    statTile("Heap used / total", `${formatBytes(s.memory.heapUsed)} / ${formatBytes(s.memory.heapTotal)}`),
    statTile("System memory free / total", `${formatBytes(s.memory.freeSystemMem)} / ${formatBytes(s.memory.totalSystemMem)}`),
    statTile("Load average (1m)", s.loadavg[0].toFixed(2), `5m ${s.loadavg[1].toFixed(2)}, 15m ${s.loadavg[2].toFixed(2)}`),
    statTile("Uptime", formatUptime(s.uptimeSec))
  );
}

async function loadSystem() {
  try {
    const data = await api("/ops/api/system");
    renderSystem(data);
  } catch (err) {
    toast(err.message, true);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  REFRESH_TIMER = setInterval(loadSystem, 5000);
}

function stopAutoRefresh() {
  if (REFRESH_TIMER) {
    clearInterval(REFRESH_TIMER);
    REFRESH_TIMER = null;
  }
}

/* ---------------------------------------------------------------------
 * Env panel
 * ------------------------------------------------------------------- */
function renderEnvRows(filterText) {
  const tbody = document.getElementById("env-rows");
  const emptyNote = document.getElementById("env-empty");
  tbody.innerHTML = "";
  const needle = (filterText || "").trim().toLowerCase();
  const names = Object.keys(LATEST_ENV).sort((a, b) => a.localeCompare(b));
  const shown = needle ? names.filter((n) => n.toLowerCase().includes(needle)) : names;

  for (const name of shown) {
    tbody.appendChild(
      el("tr", {}, [el("td", {}, [name]), el("td", {}, [String(LATEST_ENV[name])])])
    );
  }
  emptyNote.hidden = shown.length > 0;
}

async function loadEnv() {
  try {
    const data = await api("/ops/api/env");
    LATEST_ENV = data.env || {};
    renderEnvRows(document.getElementById("env-filter").value);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------------------------------------------------------------
 * Wiring
 * ------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showError("login-error", "");
    const token = document.getElementById("login-token").value.trim();
    try {
      await login(token);
    } catch (err) {
      showError("login-error", "Couldn't sign in: " + err.message);
    }
  });

  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("theme-toggle-btn").addEventListener("click", toggleTheme);
  document.getElementById("env-refresh-btn").addEventListener("click", loadEnv);
  document.getElementById("env-filter").addEventListener("input", (ev) => renderEnvRows(ev.target.value));

  const savedToken = localStorage.getItem(TOKEN_KEY);
  if (savedToken) {
    login(savedToken).catch(() => {
      // Stored token no longer valid -- fall back to the login screen silently.
    });
  }
});
