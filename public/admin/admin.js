"use strict";

/* ---------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------- */
const REDACTED = "••••••••";
const SENSITIVE_KEY = /pass|secret|token|apikey|api_key|credential/i;
const THEME_KEY = "naimix-admin-theme";

let TOKEN = null;
let META = { methods: [], backendTypes: [], transforms: [], sqlClients: [], paramLocations: [], paramTypes: [] };
let ENDPOINTS = [];
let GATEWAYS = {};
let ACTIVE_DETAIL = null; // null | "endpoint" | "gateway" -- which panel is showing on the right
let EDITING_ENDPOINT_ID = null; // null = creating a new endpoint
let EDITING_GATEWAY_NAME = null; // null = creating a new gateway
let LAST_RAW_SAMPLE;
let HAS_RAW_SAMPLE = false;
let CURRENT_SETTINGS = { configDir: null };

/* ---------------------------------------------------------------------
 * Theme (light / dark). Defaults to the OS preference until the user
 * explicitly picks one, then that choice is remembered.
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
  // Keep the icon correct if the OS-level preference changes while no
  // explicit in-app choice overrides it.
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
 * API helper
 * ------------------------------------------------------------------- */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    logout();
    throw new Error("Session expired — please sign in again.");
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message = data?.message || data?.error || `Request failed (${res.status})`;
    const detail = data?.issues
      ? " — " + data.issues.map((i) => (i.path?.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ")
      : "";
    throw new Error(message + detail);
  }
  return data;
}

/* ---------------------------------------------------------------------
 * Toast + small DOM helpers
 * ------------------------------------------------------------------- */
function toast(message, isError) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.toggle("toast-error", Boolean(isError));
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3500);
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

function looseParse(str) {
  if (str === "") return "";
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

/* ---------------------------------------------------------------------
 * Field info icons -- a small "i" next to a label that, on click, pops up
 * a short explanation of what that field is for. One popup element is
 * created lazily and reused for every icon (rather than one per field),
 * positioned next to whichever icon was just clicked and closed on the
 * next outside click, Escape, tab switch, or panel change.
 * ------------------------------------------------------------------- */
const FIELD_INFO = {
  endpointId: "A unique identifier for this endpoint (letters, digits, _ and - only). Used in the config filename and log messages -- renaming it is safe, the app moves the file for you.",
  endpointMethod: "The HTTP method this middleware listens for on Path -- GET, POST, PUT, PATCH, or DELETE.",
  endpointPathAuto: "When on, Path is computed automatically as /<gateway-or-backend-type>/<endpoint id> and kept in sync as you type. Turn it off to type a fully custom path by hand.",
  endpointPath: "The URL callers hit on THIS middleware -- not the backend's URL. Must start with / and can include path params, e.g. /:id.",
  endpointExtraPath: "Appended after the auto-generated base path. This is also where you add path params, e.g. /:id.",
  endpointDescription: "An optional human-readable note shown in the endpoint list -- purely for your own reference, it has no effect on requests.",
  backendGateway: "Which named gateway (from the Gateways list) supplies the base URL, WSDL, or DB connection for this call. Leave as (none) to call an absolute URL directly.",
  backendType: "Which kind of backend this is -- json, xml, soap, or sql. Set automatically from the selected Gateway's kind, since the two can never disagree; only editable when no gateway is selected.",
  backendUrl: "The backend URL to call, relative to the gateway's Base URL (or absolute if there's no gateway). Supports {param} placeholders filled in from this endpoint's input parameters.",
  backendMethod: "The HTTP method used to call the backend -- independent of this endpoint's own Method on the Basic tab.",
  backendHeaders: "Extra HTTP headers sent with the backend request, layered on top of the gateway's own headers. Values support {param} placeholders.",
  backendQuery: "Query-string parameters appended to the backend request URL. Values support {param} placeholders.",
  backendBody: "The request body sent to the backend. For a JSON backend this is parsed as JSON; for XML it's sent through as a literal string template.",
  soapWsdl: "Overrides the WSDL URL for this one operation. Leave blank to use the gateway's own WSDL.",
  soapEndpoint: "Overrides the actual SOAP endpoint the operation is called against. Leave blank to use the WSDL URL with its query string stripped.",
  soapOperation: "The name of the SOAP operation to call, exactly as declared in the WSDL.",
  soapArgs: "Arguments passed to the SOAP operation, by name. Values support {param} placeholders from this endpoint's input parameters.",
  sqlQuery: "A parameterized SQL query using named :param bindings (e.g. :id) that map to this endpoint's input parameters.",
  paramName: "The parameter's name -- this becomes the {name} placeholder you can use in the backend config on the previous tab.",
  paramIn: "Where the caller supplies this value: a URL path segment, a query-string parameter, an HTTP header, the JSON request body, or (env) this server's own environment variable.",
  paramEnvVar: "The environment variable name to read from. Defaults to the parameter's own name if left blank.",
  paramType: "The value is coerced to this type (string, number, or boolean) before it's used.",
  paramRequired: "If on, a request missing this parameter is rejected with a 400 error before the backend is ever called.",
  paramDefault: "The value used when the caller doesn't supply one and it isn't required.",
  outputRoot: "An optional JSONPath selecting a collection to map, e.g. $.items[*], for a list response. Leave blank to map a single object.",
  outputTarget: "The field name in this endpoint's JSON response -- can be nested, e.g. name.first.",
  outputSource: "A JSONPath into the backend's raw response, e.g. $.firstName.",
  outputTransform: "An optional conversion applied to the extracted value before it's placed in the response.",
  outputDefault: "The value used when Source doesn't match anything in the backend's response.",
  gatewayName: "A unique identifier for this gateway (letters, digits, _ and - only). Endpoints reference it by this exact name in their Gateway field.",
  gatewayKind: "The type of backend this gateway connects to -- json, xml, soap, or sql. Determines which fields below apply and which connector handles requests through it.",
  gatewayBaseUrl: "The base URL every endpoint using this gateway calls relative to, e.g. https://api.example.com.",
  gatewayWsdl: "The WSDL URL describing this SOAP service's available operations.",
  gatewayClient: "Which database driver (knex client) to use -- must match the actual database you're connecting to.",
  gatewayConnection: "The database driver's own connection fields (e.g. host, port, user, password, database, or filename for SQLite) -- passed straight through to the driver.",
  gatewayUseNullAsDefault: "Required by SQLite (better-sqlite3/sqlite3) -- tells the query builder to use NULL for columns you didn't specify, instead of erroring.",
  gatewayCommonParams: "Default parameter values shared by every endpoint that uses this gateway, available as {name}. An endpoint's own input parameter of the same name takes precedence.",
};

let INFO_POPUP_EL = null;
let INFO_POPUP_FOR = null;

function closeInfoPopup() {
  if (INFO_POPUP_EL) INFO_POPUP_EL.hidden = true;
  if (INFO_POPUP_FOR) INFO_POPUP_FOR.classList.remove("active");
  INFO_POPUP_FOR = null;
}

// Shared popup plumbing -- one popup element, reused by both the plain-text
// field-help popups (openInfoPopup) and the richer gateway quick-view
// (openGatewayPreview). `content` is either a string (shown as plain text)
// or a DOM node (appended as-is, for structured content); `extraClass` is
// an optional modifier class (e.g. "gateway-preview" for a wider popup).
function showPopup(anchorEl, content, extraClass) {
  if (INFO_POPUP_FOR === anchorEl) {
    closeInfoPopup();
    return;
  }
  closeInfoPopup();
  if (!INFO_POPUP_EL) {
    INFO_POPUP_EL = el("div", { class: "info-popup", role: "tooltip" }, []);
    document.body.appendChild(INFO_POPUP_EL);
  }
  INFO_POPUP_EL.className = "info-popup" + (extraClass ? ` ${extraClass}` : "");
  INFO_POPUP_EL.innerHTML = "";
  if (typeof content === "string") INFO_POPUP_EL.textContent = content;
  else INFO_POPUP_EL.appendChild(content);
  INFO_POPUP_EL.hidden = false;
  anchorEl.classList.add("active");
  INFO_POPUP_FOR = anchorEl;

  const anchorRect = anchorEl.getBoundingClientRect();
  const popupRect = INFO_POPUP_EL.getBoundingClientRect();
  let left = Math.min(anchorRect.left, window.innerWidth - popupRect.width - 10);
  left = Math.max(10, left);
  let top = anchorRect.bottom + 6;
  if (top + popupRect.height > window.innerHeight - 10) top = anchorRect.top - popupRect.height - 6;
  INFO_POPUP_EL.style.left = `${left}px`;
  INFO_POPUP_EL.style.top = `${top}px`;
}

function openInfoPopup(iconEl) {
  showPopup(iconEl, FIELD_INFO[iconEl.dataset.infoKey] || "No description available for this field.");
}

function infoIcon(key) {
  return el("button", { type: "button", class: "info-icon", "data-info-key": key, "aria-label": "What is this?" }, ["i"]);
}

// A <label> is flex-direction: column (see admin.css), so each of its direct
// children -- including an .info-icon <button>, which is an element rather
// than a text run -- becomes its own flex item on its own line. Grouping a
// label's title word + icon (+ any trailing muted qualifier) inside one
// plain inline span keeps them together as a single flex item, so the icon
// stays right next to the title instead of landing on the line below it.
function fieldTitle(...parts) {
  return el("span", { class: "field-title" }, parts);
}

/* ---------------------------------------------------------------------
 * Gateway quick-view -- the "View gateway" button next to the Backend
 * tab's Gateway select (see openGatewayPreview()) shows the currently
 * selected gateway's real definition (kind, connection details, common
 * params) without leaving the endpoint editor to go look it up.
 * ------------------------------------------------------------------- */
function kvList(obj) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return null;
  return el(
    "ul",
    { class: "gw-preview-list" },
    entries.map(([k, v]) => el("li", {}, [`${k}: ${v == null ? "" : v}`]))
  );
}

function buildGatewayPreview(name) {
  const gw = GATEWAYS[name];
  if (!gw) return el("div", { class: "gw-preview-empty" }, ["This gateway no longer exists -- try reloading."]);

  const rows = [el("div", { class: "gw-preview-title" }, [name])];
  const row = (label, value) => rows.push(el("div", { class: "gw-preview-row" }, [el("strong", {}, [`${label}: `]), String(value ?? "")]));

  row("Kind", gw.kind || "json");
  if (gw.kind === "sql") {
    row("Client", gw.client || "");
    const conn = kvList(gw.connection);
    rows.push(el("div", { class: "gw-preview-row" }, [el("strong", {}, ["Connection:"])]));
    rows.push(conn || el("p", { class: "gw-preview-empty" }, ["(none)"]));
    row("useNullAsDefault", gw.useNullAsDefault ? "yes" : "no");
  } else if (gw.kind === "soap") {
    row("WSDL", gw.wsdl || "");
  } else {
    row("Base URL", gw.baseUrl || "");
    const headers = kvList(gw.headers);
    if (headers) {
      rows.push(el("div", { class: "gw-preview-row" }, [el("strong", {}, ["Headers:"])]));
      rows.push(headers);
    }
  }
  const common = kvList(gw.commonParams);
  if (common) {
    rows.push(el("div", { class: "gw-preview-row" }, [el("strong", {}, ["Common parameters:"])]));
    rows.push(common);
  }
  return el("div", { class: "gw-preview" }, rows);
}

function openGatewayPreview(btn) {
  const form = document.getElementById("endpoint-form");
  const name = form.backendGateway.value;
  if (!name) return;
  showPopup(btn, buildGatewayPreview(name), "gateway-preview");
}

function refreshViewGatewayBtn() {
  const form = document.getElementById("endpoint-form");
  const btn = document.getElementById("view-gateway-btn");
  btn.disabled = !form.backendGateway.value;
  if (!form.backendGateway.value && INFO_POPUP_FOR === btn) closeInfoPopup();
}

function initInfoIcons() {
  document.addEventListener("click", (ev) => {
    const icon = ev.target.closest(".info-icon");
    if (icon) {
      ev.preventDefault();
      openInfoPopup(icon);
      return;
    }
    // The "View gateway" button (and any future popup-opening button) has
    // its own click listener that does the open/toggle -- don't let this
    // generic outside-click check immediately re-close what it just opened.
    if (ev.target.closest("#view-gateway-btn")) return;
    if (INFO_POPUP_FOR && !ev.target.closest(".info-popup")) closeInfoPopup();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeInfoPopup();
  });
  window.addEventListener("resize", closeInfoPopup);
  document.addEventListener("scroll", closeInfoPopup, true);
}

/* ---------------------------------------------------------------------
 * Auth
 * ------------------------------------------------------------------- */
async function login(token) {
  const prevToken = TOKEN;
  TOKEN = token;
  try {
    await api("GET", "/admin/api/endpoints");
  } catch (err) {
    TOKEN = prevToken;
    throw err;
  }
  localStorage.setItem("naimix-admin-token", token);
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app").hidden = false;
  await loadAll();
}

function logout() {
  TOKEN = null;
  localStorage.removeItem("naimix-admin-token");
  document.getElementById("app").hidden = true;
  document.getElementById("login-screen").hidden = false;
}

/* ---------------------------------------------------------------------
 * Load + render
 * ------------------------------------------------------------------- */
async function loadAll() {
  const [meta, endpoints, gateways, settings] = await Promise.all([
    api("GET", "/admin/api/meta"),
    api("GET", "/admin/api/endpoints"),
    api("GET", "/admin/api/gateways"),
    api("GET", "/admin/api/settings"),
  ]);
  META = meta;
  ENDPOINTS = endpoints;
  GATEWAYS = gateways;
  renderEndpointsTree();
  renderGatewaysList();
  renderWorkspaceBar(settings);
}

/* ---------------------------------------------------------------------
 * Workspace -- the folder (endpoints/ + gateways.yaml) this instance is
 * currently pointed at. Still persisted/transmitted under the field name
 * `configDir` (see workspaceSettings.ts / the /admin/api/settings API) --
 * that's a stable data contract, not the user-facing name.
 * ------------------------------------------------------------------- */
function renderWorkspaceBar(settings) {
  CURRENT_SETTINGS = settings;
  const pathEl = document.getElementById("workspace-path");
  pathEl.textContent = settings.configDir || `${settings.endpointsDir}  +  ${settings.gatewaysFile}`;
  pathEl.title = pathEl.textContent;
  document.getElementById("workspace-counts").textContent =
    `${settings.endpointCount} endpoint(s), ${settings.gatewayCount} gateway(s)`;
}

function openWorkspaceEditor(currentConfigDir) {
  showError("workspace-form-error", "");
  const form = document.getElementById("workspace-form");
  form.configDir.value = currentConfigDir || "";
  document.getElementById("workspace-editor").hidden = false;
  form.configDir.focus();
}

async function saveWorkspace(ev) {
  ev.preventDefault();
  showError("workspace-form-error", "");
  const configDir = ev.target.configDir.value.trim();
  try {
    const result = await api("PUT", "/admin/api/settings", { configDir });
    closeDrawer("workspace-editor");
    toast(
      `Switched to ${configDir} — ${result.endpointCount} endpoint(s)${result.endpointErrors.length ? `, ${result.endpointErrors.length} error(s)` : ""}, ${result.gatewayCount} gateway(s)`,
      result.endpointErrors.length > 0
    );
    closeDetail();
    await loadAll();
  } catch (err) {
    showError("workspace-form-error", err.message);
  }
}

/* ---------------------------------------------------------------------
 * Detail panel (right side) -- shows a placeholder until an endpoint or
 * gateway is selected from the sidebar, then that item's inline
 * edit/test/save form. Only one of the three ever shows at a time.
 * ------------------------------------------------------------------- */
function showDetailView(kind) {
  ACTIVE_DETAIL = kind;
  document.getElementById("detail-empty").hidden = kind !== null;
  document.getElementById("endpoint-detail").hidden = kind !== "endpoint";
  document.getElementById("gateway-detail").hidden = kind !== "gateway";
  renderEndpointsTree();
  renderGatewaysList();
}

function closeDetail() {
  EDITING_ENDPOINT_ID = null;
  EDITING_GATEWAY_NAME = null;
  showDetailView(null);
  closeInfoPopup();
}

/* ---------------------------------------------------------------------
 * Endpoints tree (sidebar) -- grouped into folders mirroring each
 * endpoint's path, matching how config/endpoints/ is organized on disk
 * (see src/server/endpointFileLayout.ts). Multiple endpoints sharing the
 * same path (e.g. a generated table's GET/POST/PATCH/DELETE) land in the
 * same folder, one row each. Clicking a row opens it in the detail panel.
 * ------------------------------------------------------------------- */
let COLLAPSED_ENDPOINT_FOLDERS = new Set();

function buildEndpointTree(endpoints) {
  const root = { path: "", children: new Map(), endpoints: [] };
  for (const r of endpoints) {
    let node = root;
    let acc = "";
    for (const segment of r.path.split("/").filter(Boolean)) {
      acc += "/" + segment;
      if (!node.children.has(segment)) {
        node.children.set(segment, { name: segment, path: acc, children: new Map(), endpoints: [] });
      }
      node = node.children.get(segment);
    }
    node.endpoints.push(r);
  }
  return root;
}

function countEndpointsInNode(node) {
  let count = node.endpoints.length;
  for (const child of node.children.values()) count += countEndpointsInNode(child);
  return count;
}

function renderEndpointsTree() {
  const container = document.getElementById("endpoints-tree");
  container.innerHTML = "";
  document.getElementById("endpoints-empty").hidden = ENDPOINTS.length > 0;
  container.appendChild(renderEndpointTreeNode(buildEndpointTree(ENDPOINTS)));
}

function renderEndpointTreeNode(node) {
  const frag = document.createDocumentFragment();

  for (const r of node.endpoints.slice().sort((a, b) => a.method.localeCompare(b.method))) {
    frag.appendChild(renderEndpointRow(r));
  }

  for (const name of [...node.children.keys()].sort()) {
    const child = node.children.get(name);
    const isCollapsed = COLLAPSED_ENDPOINT_FOLDERS.has(child.path);
    const header = el(
      "div",
      {
        class: "endpoint-folder-header" + (isCollapsed ? " is-collapsed" : ""),
        onclick: () => {
          if (isCollapsed) COLLAPSED_ENDPOINT_FOLDERS.delete(child.path);
          else COLLAPSED_ENDPOINT_FOLDERS.add(child.path);
          renderEndpointsTree();
        },
      },
      [
        el("button", { type: "button", class: "chevron-btn", tabindex: "-1", "aria-hidden": "true" }, [
          el("span", { class: "chevron" }, [isCollapsed ? "▸" : "▾"]),
        ]),
        el("span", { class: "endpoint-folder-name" }, [name]),
        el("span", { class: "endpoint-folder-count muted" }, [`(${countEndpointsInNode(child)})`]),
      ]
    );
    const body = el("div", { class: "endpoint-folder-body" + (isCollapsed ? " collapsed" : "") }, [
      renderEndpointTreeNode(child),
    ]);
    frag.appendChild(el("div", { class: "endpoint-folder" }, [header, body]));
  }

  return frag;
}

function renderEndpointRow(r) {
  const isSelected = ACTIVE_DETAIL === "endpoint" && EDITING_ENDPOINT_ID === r.id;
  return el(
    "div",
    { class: "endpoint-row" + (isSelected ? " selected" : ""), title: r.description || r.id, onclick: () => openEndpointEditor(r.id) },
    [
      el("span", { class: "method-badge" }, [r.method]),
      el("code", { class: "endpoint-row-path" }, [r.path]),
      el("span", { class: "muted endpoint-row-id" }, [r.id]),
    ]
  );
}

/* ---------------------------------------------------------------------
 * Gateways list (sidebar) -- same row language as the endpoints tree.
 * Clicking a row opens it in the detail panel.
 * ------------------------------------------------------------------- */
function renderGatewaysList() {
  const container = document.getElementById("gateways-list");
  container.innerHTML = "";
  const names = Object.keys(GATEWAYS);
  document.getElementById("gateways-empty").hidden = names.length > 0;
  for (const name of names) {
    const gw = GATEWAYS[name];
    const summary =
      gw.kind === "sql"
        ? `${gw.client} · ${Object.keys(gw.connection || {}).join(", ")}`
        : gw.baseUrl || gw.wsdl || "";
    const isSelected = ACTIVE_DETAIL === "gateway" && EDITING_GATEWAY_NAME === name;
    container.appendChild(
      el("div", { class: "gateway-row" + (isSelected ? " selected" : ""), onclick: () => openGatewayEditor(name) }, [
        el("span", { class: "gateway-row-kind" }, [gw.kind || "json"]),
        el("span", { class: "gateway-row-name" }, [name]),
        el("span", { class: "gateway-row-summary" }, [summary]),
      ])
    );
  }
}

async function deleteEndpoint(id) {
  if (!confirm(`Delete endpoint "${id}"? This removes its config file too.`)) return;
  try {
    await api("DELETE", `/admin/api/endpoints/${encodeURIComponent(id)}`);
    toast(`Deleted endpoint "${id}"`);
    closeDetail();
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteGateway(name) {
  if (!confirm(`Delete gateway "${name}"?`)) return;
  try {
    await api("DELETE", `/admin/api/gateways/${encodeURIComponent(name)}`);
    toast(`Deleted gateway "${name}"`);
    closeDetail();
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------------------------------------------------------------
 * Generic key/value editor (used for headers, query, args, sql connection)
 * ------------------------------------------------------------------- */
function renderKeyValueEditor(container, initialObj, opts) {
  opts = opts || {};
  container.innerHTML = "";

  function addRow(k, v) {
    const isRedacted = v === REDACTED;
    const keyInput = el("input", { placeholder: "key", value: k || "" });
    const valueInput = el("input", {
      placeholder: isRedacted ? "(unchanged — leave blank to keep)" : "value",
      type: SENSITIVE_KEY.test(k || "") ? "password" : "text",
      value: isRedacted ? "" : v == null ? "" : String(v),
    });
    keyInput.addEventListener("input", () => {
      valueInput.type = SENSITIVE_KEY.test(keyInput.value) ? "password" : "text";
    });
    const removeBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => row.remove() }, ["✕"]);
    const row = el("div", { class: "repeatable-row" }, [
      el("label", {}, [opts.keyLabel || "Key", keyInput]),
      el("label", {}, [opts.valueLabel || "Value", valueInput]),
      removeBtn,
    ]);
    row._keyInput = keyInput;
    row._valueInput = valueInput;
    container.appendChild(row);
  }

  for (const [k, v] of Object.entries(initialObj || {})) addRow(k, v);
  container._addRow = addRow;
  return container;
}

function readKeyValueEditor(container) {
  const out = {};
  for (const row of container.children) {
    const k = row._keyInput.value.trim();
    if (!k) continue;
    out[k] = row._valueInput.value;
  }
  return out;
}

function readKeyValueEditorParsed(container) {
  const raw = readKeyValueEditor(container);
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = looseParse(v);
  return out;
}

/* ---------------------------------------------------------------------
 * Endpoint editor
 * ------------------------------------------------------------------- */
function populateSelect(select, values, { includeBlank, blankLabel } = {}) {
  select.innerHTML = "";
  if (includeBlank) select.appendChild(el("option", { value: "" }, [blankLabel || "(none)"]));
  for (const v of values) select.appendChild(el("option", { value: v }, [v]));
}

/* ---------------------------------------------------------------------
 * Endpoint path auto-generation (gateway + endpoint id, plus a free-form
 * "extra path" suffix the user can use for path params like /:id).
 * ------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
 * Backend type is redundant once a gateway is picked -- a gateway's own
 * `kind` (json/xml/soap/sql) is exactly what determines which connector
 * runs it (see src/connectors/index.ts's switch on backend.type), and the
 * two are only allowed to match: pairing e.g. a SQL gateway with a json
 * backend type would call the wrong connector and just error out. So
 * rather than let the user pick a Type that has to agree with the Gateway
 * they also picked, the Gateway is what's picked and Type follows it,
 * locked and greyed out; Type is only left editable for a gateway-less
 * backend (json/xml calling an absolute URL directly, or soap with its
 * own inline wsdl), where there's nothing to infer it from.
 * ------------------------------------------------------------------- */
function applyGatewayInferredType() {
  const form = document.getElementById("endpoint-form");
  const hint = document.getElementById("backend-type-hint");
  const gwName = form.backendGateway.value;
  const gw = gwName ? GATEWAYS[gwName] : null;
  if (gw) {
    const kind = gw.kind || "json";
    const kindChanged = form.backendType.value !== kind;
    form.backendType.value = kind;
    form.backendType.disabled = true;
    hint.hidden = false;
    if (kindChanged) renderBackendFields(kind, {}); // switching to a different-kind gateway means a different field set
  } else {
    form.backendType.disabled = false;
    hint.hidden = true;
  }
  refreshViewGatewayBtn();
}

function computeAutoBasePath(gatewayName, backendType, endpointId) {
  const seg1 = (gatewayName || backendType || "").trim();
  const seg2 = (endpointId || "").trim();
  if (!seg1 || !seg2) return null;
  return `/${seg1}/${seg2}`;
}

function recomputeAutoPath() {
  const form = document.getElementById("endpoint-form");
  if (!form.pathAuto.checked) return;
  const base = computeAutoBasePath(form.backendGateway.value, form.backendType.value, form.id.value);
  if (!base) return; // not enough info yet (no id / no gateway or type) -- leave path as-is
  const extra = form.extraPath.value.trim();
  const extraNorm = extra ? (extra.startsWith("/") ? extra : "/" + extra) : "";
  form.path.value = base + extraNorm;
}

function setPathAutoMode(auto) {
  const form = document.getElementById("endpoint-form");
  form.pathAuto.checked = auto;
  form.path.readOnly = auto;
  document.getElementById("extra-path-row").hidden = !auto;
  if (auto) recomputeAutoPath();
}

function inputParamRow(param) {
  param = param || { name: "", in: "query", required: false, type: "string", default: "" };
  const nameInput = el("input", { value: param.name, placeholder: "name", oninput: syncTestParams });
  const inSelect = el("select", {}, []);
  populateSelect(inSelect, META.paramLocations);
  inSelect.value = param.in;
  const typeSelect = el("select", {}, []);
  populateSelect(typeSelect, META.paramTypes);
  typeSelect.value = param.type || "string";
  const requiredCheckbox = el("input", { type: "checkbox" });
  requiredCheckbox.checked = Boolean(param.required);
  const defaultInput = el("input", { placeholder: "default (optional)", value: param.default ?? "" });
  const envVarInput = el("input", { placeholder: "defaults to Name", value: param.envVar || "" });
  const envVarLabel = el("label", {}, [fieldTitle("Env var ", infoIcon("paramEnvVar")), envVarInput]);
  envVarLabel.hidden = inSelect.value !== "env";
  const removeBtn = el("button", { type: "button", class: "btn-secondary btn-sm remove-btn", onclick: () => { row.remove(); syncTestParams(); } }, ["✕"]);

  inSelect.addEventListener("change", () => {
    envVarLabel.hidden = inSelect.value !== "env";
    syncTestParams();
  });

  const row = el("div", { class: "repeatable-row" }, [
    el("label", {}, [fieldTitle("Name ", infoIcon("paramName")), nameInput]),
    el("label", {}, [fieldTitle("In ", infoIcon("paramIn")), inSelect]),
    envVarLabel,
    el("label", {}, [fieldTitle("Type ", infoIcon("paramType")), typeSelect]),
    el("label", { class: "checkbox-field" }, [requiredCheckbox, "Required ", infoIcon("paramRequired")]),
    el("label", {}, [fieldTitle("Default ", infoIcon("paramDefault")), defaultInput]),
    removeBtn,
  ]);
  row._read = () => ({
    name: nameInput.value.trim(),
    in: inSelect.value,
    ...(inSelect.value === "env" && envVarInput.value.trim() ? { envVar: envVarInput.value.trim() } : {}),
    type: typeSelect.value,
    required: requiredCheckbox.checked,
    ...(defaultInput.value !== "" ? { default: looseParse(defaultInput.value) } : {}),
  });
  row._name = () => nameInput.value.trim();
  return row;
}

function outputFieldRow(field) {
  field = field || { target: "", source: "", default: "", transform: "" };
  const targetInput = el("input", { placeholder: "e.g. name.first", value: field.target });
  const sourceInput = el("input", { placeholder: "e.g. $.firstName", value: field.source });
  const transformSelect = el("select", {}, []);
  populateSelect(transformSelect, META.transforms, { includeBlank: true });
  transformSelect.value = field.transform || "";
  const defaultInput = el("input", { placeholder: "default (optional)", value: field.default ?? "" });
  const removeBtn = el("button", { type: "button", class: "btn-secondary btn-sm remove-btn", onclick: () => { row.remove(); refreshSectionCounts(); } }, ["✕"]);

  const row = el("div", { class: "repeatable-row" }, [
    el("label", {}, [fieldTitle("Target ", infoIcon("outputTarget")), targetInput]),
    el("label", {}, [fieldTitle("Source ", infoIcon("outputSource"), " (JSONPath)"), sourceInput]),
    el("label", {}, [fieldTitle("Transform ", infoIcon("outputTransform")), transformSelect]),
    el("label", {}, [fieldTitle("Default ", infoIcon("outputDefault")), defaultInput]),
    removeBtn,
  ]);
  row._read = () => ({
    target: targetInput.value.trim(),
    source: sourceInput.value.trim(),
    ...(transformSelect.value ? { transform: transformSelect.value } : {}),
    ...(defaultInput.value !== "" ? { default: looseParse(defaultInput.value) } : {}),
  });
  return row;
}

function syncTestParams() {
  const inputRows = [...document.getElementById("input-params-list").children];
  const testList = document.getElementById("test-params-list");
  const existing = new Map([...testList.children].map((r) => [r._paramName, r]));
  testList.innerHTML = "";
  for (const inputRow of inputRows) {
    const def = inputRow._read();
    const name = def.name;
    if (!name) continue;
    let row = existing.get(name);
    if (!row) {
      const isEnv = def.in === "env";
      const valueInput = el("input", {
        placeholder: isEnv ? `optional override — defaults to env ${def.envVar || name}` : `value for ${name}`,
      });
      row = el("div", { class: "repeatable-row" }, [el("label", {}, [name, valueInput])]);
      row._paramName = name;
      row._valueInput = valueInput;
    }
    testList.appendChild(row);
  }
  refreshSectionCounts();
}

/* ---------------------------------------------------------------------
 * Endpoint editor tabs (Basic / Backend / Parameters / Output / Test).
 * Only one tab's panel is shown at a time -- switching just toggles
 * [hidden] and the active tab button's styling, no re-rendering.
 * ------------------------------------------------------------------- */
function switchEndpointTab(tab) {
  for (const btn of document.querySelectorAll("#endpoint-form .editor-tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  for (const panel of document.querySelectorAll("#endpoint-form .editor-tab-panel")) {
    panel.hidden = panel.dataset.tabPanel !== tab;
  }
  closeInfoPopup();
}

function initEndpointTabs() {
  for (const btn of document.querySelectorAll("#endpoint-form .editor-tab-btn")) {
    btn.addEventListener("click", () => switchEndpointTab(btn.dataset.tab));
  }
  // A required field can be on a tab that isn't showing when Save is
  // clicked -- the browser's own validation only "sees" visible fields, so
  // jump to whichever tab holds the first invalid one before it reports it.
  document.getElementById("endpoint-form").addEventListener(
    "invalid",
    (ev) => {
      const panel = ev.target.closest(".editor-tab-panel");
      if (panel) switchEndpointTab(panel.dataset.tabPanel);
    },
    true
  );
}

function refreshSectionCounts() {
  const form = document.getElementById("endpoint-form");
  if (!form) return;

  const inputCount = document.getElementById("input-params-list").children.length;
  document.getElementById("count-input").textContent = inputCount ? `(${inputCount})` : "";

  const outputCount = document.getElementById("output-fields-list").children.length;
  document.getElementById("count-output").textContent = outputCount ? `(${outputCount})` : "";

  const type = form.backendType.value;
  const gw = form.backendGateway.value;
  document.getElementById("count-backend").textContent = type ? `(${type}${gw ? " · " + gw : ""})` : "";
}

function renderBackendFields(type, backend) {
  backend = backend || {};
  const container = document.getElementById("backend-fields");
  container.innerHTML = "";

  if (type === "json" || type === "xml") {
    const urlInput = el("input", { name: "url", value: backend.url || "", placeholder: "/customers/{id}", required: true });
    const methodSelect = el("select", { name: "beMethod" }, []);
    populateSelect(methodSelect, META.methods);
    methodSelect.value = backend.method || "GET";
    const headersContainer = el("div", { class: "repeatable-list" });
    renderKeyValueEditor(headersContainer, backend.headers, {});
    const addHeaderBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => headersContainer._addRow("", "") }, ["+ Add header"]);

    const rows = [
      el("div", { class: "field-grid" }, [
        el("label", { class: "span-2" }, [fieldTitle("URL ", infoIcon("backendUrl"), " (supports {param} placeholders)"), urlInput]),
        el("label", {}, [fieldTitle("Method ", infoIcon("backendMethod")), methodSelect]),
      ]),
      el("div", { class: "section-header" }, [el("h4", {}, ["Headers ", infoIcon("backendHeaders")]), addHeaderBtn]),
      headersContainer,
    ];

    let queryContainer, bodyInput;
    if (type === "json") {
      queryContainer = el("div", { class: "repeatable-list" });
      renderKeyValueEditor(queryContainer, backend.query, {});
      const addQueryBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => queryContainer._addRow("", "") }, ["+ Add query param"]);
      rows.push(el("div", { class: "section-header" }, [el("h4", {}, ["Query string ", infoIcon("backendQuery")]), addQueryBtn]));
      rows.push(queryContainer);
      bodyInput = el("textarea", { placeholder: "JSON request body (optional)" }, [
        backend.body !== undefined ? JSON.stringify(backend.body, null, 2) : "",
      ]);
      rows.push(el("label", { class: "block" }, [fieldTitle("Body ", infoIcon("backendBody"), " (JSON, optional)"), bodyInput]));
    } else {
      bodyInput = el("textarea", { placeholder: "<xml>request body template</xml> (optional)" }, [backend.body || ""]);
      rows.push(el("label", { class: "block" }, [fieldTitle("Body ", infoIcon("backendBody"), " (XML string, optional)"), bodyInput]));
    }

    rows.forEach((r) => container.appendChild(r));
    container._read = () => {
      const base = {
        type,
        url: urlInput.value.trim(),
        method: methodSelect.value,
        headers: readKeyValueEditor(headersContainer),
      };
      if (type === "json") {
        base.query = readKeyValueEditor(queryContainer);
        const bodyText = bodyInput.value.trim();
        if (bodyText) base.body = JSON.parse(bodyText);
      } else {
        const bodyText = bodyInput.value.trim();
        if (bodyText) base.body = bodyText;
      }
      return base;
    };
  } else if (type === "soap") {
    const wsdlInput = el("input", { value: backend.wsdl || "", placeholder: "leave blank to use the gateway's WSDL" });
    const endpointInput = el("input", { value: backend.endpoint || "", placeholder: "optional override" });
    const operationInput = el("input", { value: backend.operation || "", required: true, placeholder: "GetCustomer" });
    const argsContainer = el("div", { class: "repeatable-list" });
    renderKeyValueEditor(argsContainer, backend.args, { valueLabel: "Value (supports {param})" });
    const addArgBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => argsContainer._addRow("", "") }, ["+ Add argument"]);

    container.appendChild(
      el("div", { class: "field-grid" }, [
        el("label", { class: "span-2" }, [fieldTitle("WSDL URL ", infoIcon("soapWsdl"), " (optional)"), wsdlInput]),
        el("label", { class: "span-2" }, [fieldTitle("Endpoint override ", infoIcon("soapEndpoint"), " (optional)"), endpointInput]),
        el("label", { class: "span-2" }, [fieldTitle("Operation ", infoIcon("soapOperation")), operationInput]),
      ])
    );
    container.appendChild(el("div", { class: "section-header" }, [el("h4", {}, ["Arguments ", infoIcon("soapArgs")]), addArgBtn]));
    container.appendChild(argsContainer);

    container._read = () => {
      const base = { type: "soap", operation: operationInput.value.trim(), args: readKeyValueEditor(argsContainer) };
      if (wsdlInput.value.trim()) base.wsdl = wsdlInput.value.trim();
      if (endpointInput.value.trim()) base.endpoint = endpointInput.value.trim();
      return base;
    };
  } else if (type === "sql" && (backend.table || backend.procedure)) {
    // An endpoint created by "Generate CRUD endpoints" (gateway editor) --
    // its backend is table/operation/procedure fields, not a raw query, and
    // isn't meant to be hand-edited here. Show a read-only summary and
    // preserve the backend exactly as-is on save, rather than falling
    // through to the raw-query editor below and silently discarding it.
    const summary = backend.table
      ? `Auto-generated table endpoint — table "${backend.table}", operation "${backend.operation}"` +
        (backend.primaryKey?.length ? `, primary key [${backend.primaryKey.join(", ")}]` : ", no primary key")
      : `Auto-generated stored-procedure endpoint — calls "${backend.procedure}"` +
        (backend.procedureParams?.length ? ` with params: ${backend.procedureParams.join(", ")}` : " (no params)");
    container.appendChild(
      el("p", { class: "muted" }, [
        summary +
          ". Created by \"Generate CRUD endpoints\" on the gateway — not editable as raw SQL here. " +
          "Delete this endpoint and generate again if the table/procedure shape changed.",
      ])
    );
    container._read = () => backend;
  } else if (type === "sql") {
    const queryInput = el("textarea", { required: true, placeholder: "SELECT * FROM customers WHERE id = :id" }, [backend.query || ""]);
    container.appendChild(el("label", { class: "block" }, [fieldTitle("SQL ", infoIcon("sqlQuery"), " (named :param bindings)"), queryInput]));
    container._read = () => ({ type: "sql", query: queryInput.value.trim() });
  }
}

function openEndpointEditor(endpointId) {
  closeInfoPopup();
  EDITING_ENDPOINT_ID = endpointId || null;
  const endpoint = endpointId ? ENDPOINTS.find((r) => r.id === endpointId) : null;

  document.getElementById("endpoint-editor-title").textContent = endpoint ? `Edit endpoint: ${endpoint.id}` : "New endpoint";
  const deleteBtn = document.getElementById("endpoint-delete-btn");
  deleteBtn.hidden = !endpoint;
  deleteBtn.onclick = () => deleteEndpoint(EDITING_ENDPOINT_ID);
  showError("endpoint-form-error", "");
  document.getElementById("test-raw-output").textContent = "—";
  document.getElementById("test-mapped-output").textContent = "—";
  document.getElementById("apply-mapping-btn").disabled = true;
  HAS_RAW_SAMPLE = false;

  const form = document.getElementById("endpoint-form");
  form.id.value = endpoint?.id || "";
  form.id.disabled = false; // renaming is allowed; the registry moves the file
  populateSelect(form.method, META.methods);
  form.method.value = endpoint?.method || "GET";
  form.description.value = endpoint?.description || "";

  populateSelect(form.backendGateway, Object.keys(GATEWAYS), { includeBlank: true, blankLabel: "(none) -- call a URL directly" });
  form.backendGateway.value = endpoint?.backend?.gateway || "";

  populateSelect(form.backendType, META.backendTypes);
  form.backendType.value = endpoint?.backend?.type || "json";
  renderBackendFields(form.backendType.value, endpoint?.backend);
  form.backendType.onchange = () => { renderBackendFields(form.backendType.value, {}); recomputeAutoPath(); refreshSectionCounts(); };
  applyGatewayInferredType(); // locks Type to the gateway's kind when one's already selected, above

  // Path: a brand-new endpoint defaults to auto-generating from gateway +
  // endpoint id. An existing endpoint stays in auto mode (with its extra
  // suffix split back out) only if its saved path actually matches that
  // pattern -- otherwise it was written by hand (or predates this feature)
  // and we leave it alone rather than silently rewriting it.
  const base = endpoint ? computeAutoBasePath(form.backendGateway.value, form.backendType.value, endpoint.id) : null;
  if (endpoint && base && endpoint.path.startsWith(base)) {
    form.extraPath.value = endpoint.path.slice(base.length);
    setPathAutoMode(true);
  } else {
    form.path.value = endpoint?.path || "";
    form.extraPath.value = "";
    setPathAutoMode(!endpoint);
  }

  const inputList = document.getElementById("input-params-list");
  inputList.innerHTML = "";
  for (const p of endpoint?.input || []) inputList.appendChild(inputParamRow(p));

  form.outputRoot.value = endpoint?.output?.root || "";
  const outputList = document.getElementById("output-fields-list");
  outputList.innerHTML = "";
  for (const f of endpoint?.output?.fields || []) outputList.appendChild(outputFieldRow(f));

  switchEndpointTab("basic"); // always open on the same tab, regardless of what was showing last time

  syncTestParams(); // also calls refreshSectionCounts()

  // Generated table-CRUD endpoints (list/bulkCreate/bulkUpdate/bulkDelete)
  // read straight from the raw query string / JSON body rather than
  // declared `input` params -- the Try it panel only has fields for the
  // latter, so point users at curl/the README instead of leaving it
  // looking broken. A generated stored-procedure endpoint isn't affected:
  // its params ARE declared `input` (in: "body"), so it works fine in this
  // panel.
  document.getElementById("tryit-bulk-note").hidden = !(endpoint?.backend?.type === "sql" && endpoint?.backend?.table);

  showDetailView("endpoint");
  document.getElementById("detail-panel").scrollTop = 0;
}

function readEndpointForm() {
  const form = document.getElementById("endpoint-form");
  const input = [...document.getElementById("input-params-list").children].map((r) => r._read()).filter((p) => p.name);
  const fields = [...document.getElementById("output-fields-list").children].map((r) => r._read()).filter((f) => f.target && f.source);

  const backend = document.getElementById("backend-fields")._read();
  const gw = form.backendGateway.value;
  if (gw) backend.gateway = gw;

  const output = { fields };
  if (form.outputRoot.value.trim()) output.root = form.outputRoot.value.trim();

  return {
    id: form.id.value.trim(),
    description: form.description.value.trim() || undefined,
    method: form.method.value,
    path: form.path.value.trim(),
    input,
    backend,
    output,
  };
}

async function saveEndpoint(ev) {
  ev.preventDefault();
  showError("endpoint-form-error", "");
  let endpoint;
  try {
    endpoint = readEndpointForm();
  } catch (err) {
    showError("endpoint-form-error", "Couldn't read the form: " + err.message);
    return;
  }
  try {
    if (EDITING_ENDPOINT_ID) {
      await api("PUT", `/admin/api/endpoints/${encodeURIComponent(EDITING_ENDPOINT_ID)}`, endpoint);
    } else {
      await api("POST", "/admin/api/endpoints", endpoint);
    }
    toast(`Saved endpoint "${endpoint.id}" — it's live now.`);
    await loadAll();
    openEndpointEditor(endpoint.id); // stay in the panel, now showing it as a saved endpoint
  } catch (err) {
    showError("endpoint-form-error", err.message);
  }
}

async function fetchSample() {
  showError("endpoint-form-error", "");
  try {
    const backend = document.getElementById("backend-fields")._read();
    const form = document.getElementById("endpoint-form");
    if (form.backendGateway.value) backend.gateway = form.backendGateway.value;
    const input = [...document.getElementById("input-params-list").children].map((r) => r._read()).filter((p) => p.name);
    const params = {};
    for (const row of document.getElementById("test-params-list").children) {
      if (row._valueInput.value !== "") params[row._paramName] = row._valueInput.value;
    }

    const { raw } = await api("POST", "/admin/api/test-backend", { input, backend, params });
    LAST_RAW_SAMPLE = raw;
    HAS_RAW_SAMPLE = true;
    document.getElementById("test-raw-output").textContent = JSON.stringify(raw, null, 2);
    document.getElementById("apply-mapping-btn").disabled = false;
    await applyMappingToSample();
  } catch (err) {
    document.getElementById("test-raw-output").textContent = "Error: " + err.message;
    showError("endpoint-form-error", err.message);
  }
}

async function applyMappingToSample() {
  if (!HAS_RAW_SAMPLE) return;
  try {
    const form = document.getElementById("endpoint-form");
    const fields = [...document.getElementById("output-fields-list").children].map((r) => r._read()).filter((f) => f.target && f.source);
    const output = { fields };
    if (form.outputRoot.value.trim()) output.root = form.outputRoot.value.trim();
    const { mapped } = await api("POST", "/admin/api/test-mapping", { raw: LAST_RAW_SAMPLE, output });
    document.getElementById("test-mapped-output").textContent = JSON.stringify(mapped, null, 2);
  } catch (err) {
    document.getElementById("test-mapped-output").textContent = "Error: " + err.message;
  }
}

/* ---------------------------------------------------------------------
 * Gateway editor
 * ------------------------------------------------------------------- */
const GATEWAY_KINDS = ["json", "xml", "soap", "sql"];

function renderGatewayKindFields(kind, gw) {
  gw = gw || {};
  const container = document.getElementById("gateway-fields");
  container.innerHTML = "";

  if (kind === "json" || kind === "xml") {
    const baseUrlInput = el("input", { value: gw.baseUrl || "", placeholder: "https://api.example.com", required: true });
    const headersContainer = el("div", { class: "repeatable-list" });
    renderKeyValueEditor(headersContainer, gw.headers, {});
    const addBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => headersContainer._addRow("", "") }, ["+ Add header"]);
    container.appendChild(el("label", { class: "block" }, [fieldTitle("Base URL ", infoIcon("gatewayBaseUrl"), " (required)"), baseUrlInput]));
    container.appendChild(el("div", { class: "section-header" }, [el("h4", {}, ["Headers ", infoIcon("backendHeaders")]), addBtn]));
    container.appendChild(headersContainer);
    container._read = () => ({ kind, baseUrl: baseUrlInput.value.trim(), headers: readKeyValueEditor(headersContainer) });
  } else if (kind === "soap") {
    const wsdlInput = el("input", { value: gw.wsdl || "", placeholder: "https://service.example.com/Service.svc?wsdl", required: true });
    container.appendChild(el("label", { class: "block" }, [fieldTitle("WSDL URL ", infoIcon("gatewayWsdl"), " (required)"), wsdlInput]));
    container._read = () => ({ kind, wsdl: wsdlInput.value.trim() });
  } else if (kind === "sql") {
    const clientSelect = el("select", {}, []);
    populateSelect(clientSelect, META.sqlClients);
    clientSelect.value = gw.client || "pg";
    // NOTE: this "connection" fields block is knex's own required config
    // shape (host/user/password/database/filename for the driver) -- it
    // keeps that name deliberately, even though the gateway that CONTAINS
    // it was renamed from "connection" to "gateway" everywhere else.
    const connFieldsContainer = el("div", { class: "repeatable-list" });
    renderKeyValueEditor(connFieldsContainer, gw.connection, { keyLabel: "Field", valueLabel: "Value" });
    const addBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => connFieldsContainer._addRow("", "") }, ["+ Add field"]);
    const nullDefaultCheckbox = el("input", { type: "checkbox" });
    nullDefaultCheckbox.checked = Boolean(gw.useNullAsDefault);

    const testResult = el("p", { id: "gateway-test-result", class: "test-result" }, []);
    testResult.hidden = true;
    const testBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: testDbConnection }, ["Test connection"]);

    container.appendChild(el("label", { class: "block" }, [fieldTitle("Client ", infoIcon("gatewayClient")), clientSelect]));
    container.appendChild(
      el("div", { class: "section-header" }, [
        el("h4", {}, ["Connection fields ", infoIcon("gatewayConnection"), el("span", { class: "muted" }, [" (e.g. host, port, user, password, database, or filename for sqlite)"])]),
        addBtn,
      ])
    );
    container.appendChild(connFieldsContainer);
    container.appendChild(el("label", { class: "checkbox-field block" }, [nullDefaultCheckbox, "useNullAsDefault ", infoIcon("gatewayUseNullAsDefault"), " (sqlite requires this)"]));
    container.appendChild(el("div", { class: "test-actions" }, [testBtn]));
    container.appendChild(testResult);

    // Only meaningful for an already-saved gateway -- generation
    // introspects the version on disk, so a brand-new draft has nothing to
    // introspect yet (save first, then reopen to generate).
    if (EDITING_GATEWAY_NAME) {
      const generateResult = el("p", { id: "gateway-generate-result", class: "test-result" }, []);
      generateResult.hidden = true;
      const generateBtn = el(
        "button",
        { type: "button", class: "btn-secondary btn-sm", onclick: generateCrudEndpoints },
        ["Generate CRUD + procedure endpoints"]
      );
      container.appendChild(
        el("div", { class: "editor-section" }, [
          el("div", { class: "section-header" }, [el("h4", {}, ["Auto-generate endpoints for this gateway"])]),
          el("p", { class: "muted" }, [
            "Creates list / bulk-create / bulk-update / bulk-delete endpoints for every table " +
              "(a table with no primary key only gets list/create), plus one endpoint per stored " +
              "procedure where this database supports them. Never overwrites an existing endpoint -- " +
              "a conflicting id or path is skipped and reported, so this is safe to run again later " +
              "(e.g. after adding a table). Uses the currently SAVED version of this gateway, so " +
              "save any pending edits above first.",
          ]),
          el("div", { class: "test-actions" }, [generateBtn]),
          generateResult,
        ])
      );
    }

    container._read = () => ({
      kind: "sql",
      client: clientSelect.value,
      connection: readKeyValueEditorParsed(connFieldsContainer),
      useNullAsDefault: nullDefaultCheckbox.checked,
    });
  }
}

async function generateCrudEndpoints() {
  const resultEl = document.getElementById("gateway-generate-result");
  resultEl.hidden = false;
  resultEl.className = "test-result";
  resultEl.textContent = "Introspecting and generating…";
  try {
    const summary = await api(
      "POST",
      `/admin/api/gateways/${encodeURIComponent(EDITING_GATEWAY_NAME)}/generate-crud`,
      {}
    );
    const lines = [
      `${summary.tablesFound} table(s) found -- ${summary.created.length} endpoint(s) created, ${summary.skipped.length} skipped.`,
      summary.proceduresSupported
        ? `${summary.proceduresFound} stored procedure(s) found.`
        : "This database client doesn't support stored procedures.",
    ];
    if (summary.created.length > 0) {
      lines.push("Created: " + summary.created.map((r) => `${r.method} ${r.path}`).join(", "));
    }
    if (summary.skipped.length > 0) {
      lines.push("Skipped: " + summary.skipped.map((s) => `${s.name} (${s.reason})`).join("; "));
    }
    // 0 created isn't necessarily a failure -- re-running after nothing
    // changed correctly skips everything -- so only green-flag an actual
    // success, and leave the neutral style otherwise (red is reserved for
    // the catch block below, i.e. an actual request failure).
    if (summary.created.length > 0) resultEl.classList.add("test-result-ok");
    resultEl.textContent = lines.join(" ");

    if (summary.created.length > 0) {
      await loadAll();
      toast(`Generated ${summary.created.length} endpoint(s) for "${EDITING_GATEWAY_NAME}" — see the Endpoints list.`);
    }
  } catch (err) {
    resultEl.classList.add("test-result-error");
    resultEl.textContent = `✕ ${err.message}`;
  }
}

async function testDbConnection() {
  const resultEl = document.getElementById("gateway-test-result");
  resultEl.hidden = false;
  resultEl.className = "test-result";
  resultEl.textContent = "Testing…";
  try {
    const config = document.getElementById("gateway-fields")._read();
    const body = { config };
    if (EDITING_GATEWAY_NAME) body.name = EDITING_GATEWAY_NAME;
    const result = await api("POST", "/admin/api/gateways/test-connection", body);
    resultEl.classList.add(result.ok ? "test-result-ok" : "test-result-error");
    resultEl.textContent = result.ok ? "✓ Connected successfully" : `✕ ${result.message}`;
  } catch (err) {
    resultEl.classList.add("test-result-error");
    resultEl.textContent = `✕ ${err.message}`;
  }
}

function openGatewayEditor(name) {
  closeInfoPopup();
  EDITING_GATEWAY_NAME = name || null;
  const gw = name ? GATEWAYS[name] : null;
  document.getElementById("gateway-editor-title").textContent = gw ? `Edit gateway: ${name}` : "New gateway";
  const deleteBtn = document.getElementById("gateway-delete-btn");
  deleteBtn.hidden = !gw;
  deleteBtn.onclick = () => deleteGateway(EDITING_GATEWAY_NAME);
  showError("gateway-form-error", "");

  const form = document.getElementById("gateway-form");
  form.name.value = name || "";
  form.name.disabled = Boolean(name); // renaming would orphan the old entry; delete+recreate instead

  populateSelect(form.kind, GATEWAY_KINDS);
  form.kind.value = gw?.kind || "json";
  renderGatewayKindFields(form.kind.value, gw);
  form.kind.onchange = () => renderGatewayKindFields(form.kind.value, {});

  const commonParamsList = document.getElementById("gateway-common-params-list");
  renderKeyValueEditor(commonParamsList, gw?.commonParams, {});

  showDetailView("gateway");
  document.getElementById("detail-panel").scrollTop = 0;
}

async function saveGateway(ev) {
  ev.preventDefault();
  showError("gateway-form-error", "");
  const form = document.getElementById("gateway-form");
  const name = form.name.value.trim();
  try {
    const config = document.getElementById("gateway-fields")._read();
    const commonParams = readKeyValueEditor(document.getElementById("gateway-common-params-list"));
    if (Object.keys(commonParams).length > 0) config.commonParams = commonParams;
    if (EDITING_GATEWAY_NAME) {
      await api("PUT", `/admin/api/gateways/${encodeURIComponent(EDITING_GATEWAY_NAME)}`, { config });
    } else {
      await api("POST", "/admin/api/gateways", { name, config });
    }
    toast(`Saved gateway "${name}"`);
    await loadAll();
    openGatewayEditor(name); // stay in the panel, now showing it as a saved gateway
  } catch (err) {
    showError("gateway-form-error", err.message);
  }
}

/* ---------------------------------------------------------------------
 * Drawer (settings dialog) + wiring
 * ------------------------------------------------------------------- */
function closeDrawer(id) {
  document.getElementById(id).hidden = true;
}

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

  document.getElementById("reload-btn").addEventListener("click", async () => {
    try {
      const result = await api("POST", "/admin/api/reload");
      toast(`Reloaded — ${result.endpointCount} endpoint(s)${result.errors.length ? `, ${result.errors.length} error(s)` : ""}`, result.errors.length > 0);
      await loadAll();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById("new-endpoint-btn").addEventListener("click", () => openEndpointEditor(null));
  document.getElementById("new-gateway-btn").addEventListener("click", () => openGatewayEditor(null));
  document.getElementById("endpoint-close-btn").addEventListener("click", closeDetail);
  document.getElementById("gateway-close-btn").addEventListener("click", closeDetail);
  document.getElementById("change-workspace-btn").addEventListener("click", () => openWorkspaceEditor(CURRENT_SETTINGS.configDir));
  document.getElementById("workspace-form").addEventListener("submit", saveWorkspace);

  for (const closer of document.querySelectorAll("[data-close]")) {
    closer.addEventListener("click", () => closeDrawer(closer.dataset.close));
  }

  const endpointForm = document.getElementById("endpoint-form");
  endpointForm.pathAuto.addEventListener("change", (ev) => setPathAutoMode(ev.target.checked));
  endpointForm.id.addEventListener("input", recomputeAutoPath);
  endpointForm.extraPath.addEventListener("input", recomputeAutoPath);
  endpointForm.backendGateway.addEventListener("change", () => {
    applyGatewayInferredType();
    recomputeAutoPath();
    refreshSectionCounts();
  });
  initEndpointTabs();
  initInfoIcons();
  document.getElementById("view-gateway-btn").addEventListener("click", (ev) => openGatewayPreview(ev.currentTarget));

  document.getElementById("add-input-btn").addEventListener("click", () => {
    document.getElementById("input-params-list").appendChild(inputParamRow());
    syncTestParams();
  });
  document.getElementById("add-output-btn").addEventListener("click", () => {
    document.getElementById("output-fields-list").appendChild(outputFieldRow());
  });
  document.getElementById("add-common-param-btn").addEventListener("click", () => {
    document.getElementById("gateway-common-params-list")._addRow("", "");
  });

  document.getElementById("endpoint-form").addEventListener("submit", saveEndpoint);
  document.getElementById("gateway-form").addEventListener("submit", saveGateway);
  document.getElementById("fetch-sample-btn").addEventListener("click", fetchSample);
  document.getElementById("apply-mapping-btn").addEventListener("click", applyMappingToSample);

  const savedToken = localStorage.getItem("naimix-admin-token");
  if (savedToken) {
    login(savedToken).catch(() => {
      // Stored token no longer valid -- fall back to the login screen silently.
    });
  }
});
