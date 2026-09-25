"use strict";

/* ---------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------- */
const REDACTED = "••••••••";
const SENSITIVE_KEY = /pass|secret|token|apikey|api_key|credential/i;
const THEME_KEY = "naimix-admin-theme";

let TOKEN = null;
let META = { methods: [], backendTypes: [], transforms: [], sqlClients: [], paramLocations: [], paramTypes: [], devMode: false };
let ENDPOINTS = [];
let GATEWAYS = {};
let AUTH_PROVIDERS = {};
let SESSIONS = [];
let ACTIVE_DETAIL = null; // null | "endpoint" | "gateway" | "authProvider" | "session" -- which panel is showing on the right
let EDITING_ENDPOINT_ID = null; // null = creating a new endpoint
let EDITING_GATEWAY_NAME = null; // null = creating a new gateway
let EDITING_AUTH_PROVIDER_NAME = null; // null = creating a new auth provider
let SELECTED_SESSION_ID = null;
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

/**
 * Downloads a file from an authenticated /admin/api/* route. A plain
 * `<a href>` can't carry the Authorization header these routes require, so
 * this fetches the response as a Blob and clicks a synthetic, throwaway
 * `<a download>` pointed at an object URL for it -- the standard workaround
 * for a browser download that needs a custom header.
 */
async function downloadFile(path, fallbackFilename) {
  const res = await fetch(path, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  if (res.status === 401) {
    logout();
    throw new Error("Session expired — please sign in again.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Download failed (${res.status})${text ? `: ${text}` : ""}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match ? match[1] : fallbackFilename;

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
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
  gatewayRequiresAuth: "Names an entry in the Auth providers list. When set, every endpoint that calls through this gateway requires a caller session obtained by logging in against that provider (POST /auth/login/<name>) -- the real backend token it holds is available to this gateway's config as {__authToken}.",
  authProviderName: "A unique identifier for this auth provider (letters, digits, _ and - only). A gateway references it by this exact name in its Requires auth field, and callers log in against it at POST /auth/login/<name>.",
  authProviderKind: "basicLogin authenticates against a bespoke backend login API (POST credentials, extract a token from the JSON response with JSONPath). oauth2 authenticates against a standard RFC 6749 token endpoint (password or client_credentials grant), and additionally supports automatic refresh. ldap authenticates against an LDAP/AD directory with a plain simple bind.",
  authProviderLoginUrl: "The backend's login endpoint -- this provider POSTs the caller's credentials here.",
  authProviderMethod: "The HTTP method used to call Login URL -- almost always POST.",
  authProviderUsernameField: "The JSON field name the username is sent under. Defaults to \"username\" if left blank.",
  authProviderPasswordField: "The JSON field name the password is sent under. Defaults to \"password\" if left blank.",
  authProviderStaticFields: "Extra fixed fields sent with every login request alongside the caller's username/password (e.g. a fixed API key or client identifier the backend's login API expects).",
  authProviderTokenPath: "A JSONPath into the login response that contains the real backend token this middleware should hold and inject into calls on the caller's behalf, e.g. $.accessToken.",
  authProviderRefreshTokenPath: "An optional JSONPath into the login response for a refresh token. basicLogin doesn't refresh in this phase (an expired session just requires logging in again), so this is currently only stored for future use.",
  authProviderExpiresInPath: "An optional JSONPath into the login response for how many seconds until the token expires, e.g. $.expiresIn. Used to know when a session needs attention.",
  authProviderSubjectPath: "An optional JSONPath into the login response identifying the logged-in subject/user (e.g. $.sub or $.userId) -- stored on the session for reference.",
  authProviderClaims: "Optional extra fields pulled out of the login response using the same JSONPath mapping as an endpoint's Output fields, e.g. exposing a display name or role from the login response.",
  activeSessions: "Every caller session currently held in memory across all auth providers. This is a live view of the session store, showing enough to identify a session (provider, subject, claims, timestamps) and revoke it if needed. Outside production (NODE_ENV != \"production\"), opening a session also shows its real session/backend/refresh tokens for local debugging; a real deployment run with NODE_ENV=production always withholds them.",
  exportSection: "Download a standard OpenAPI (Swagger) description of this workspace's endpoints and auth routes, or a ready-to-run MCP server that talks to this same live instance -- both always reflect the current config, so re-download after making changes rather than reusing an older copy.",
  authProviderTokenUrl: "The OAuth2 token endpoint this provider requests tokens from, per RFC 6749, e.g. https://api.example.com/oauth/token.",
  authProviderGrantType: "password sends the caller's own username/password (a person logging in). client_credentials authenticates this middleware itself with no end-user credentials at all -- use it when callers shouldn't need individual backend accounts.",
  authProviderClientId: "This middleware's own OAuth2 client identifier, issued by the backend's authorization server.",
  authProviderClientSecret: "This middleware's own OAuth2 client secret. Leave blank when editing an existing provider to keep the currently stored value unchanged.",
  authProviderScope: "An optional space-separated list of OAuth2 scopes to request.",
  authProviderLdapUrl: "The LDAP/AD server URL, e.g. ldap://localhost:3389 or ldaps://ad.example.com:636.",
  authProviderLdapTlsRejectUnauthorized: "Only meaningful for ldaps:// URLs. Leave on (verify the server's TLS certificate) unless connecting to a trusted internal test directory with a self-signed certificate.",
  authProviderLdapBindMode: "Direct bind builds the DN to bind as directly from a predictable template. Search-then-bind uses a service account to look up the real user DN first, then binds as that user -- the realistic pattern for Active Directory and most enterprise directories where usernames don't map predictably to a DN.",
  authProviderLdapUserDnTemplate: "Direct-bind mode: a DN template with a {username} placeholder, e.g. uid={username},ou=people,dc=example,dc=com. The substituted username is DN-escaped automatically.",
  authProviderLdapBindDn: "Search-then-bind mode: the service account's DN, used only to search for the real user DN -- not to log the caller in.",
  authProviderLdapBindPassword: "Search-then-bind mode: the service account's password. Leave blank when editing an existing provider to keep the currently stored value unchanged.",
  authProviderLdapSearchBase: "Search-then-bind mode: the base DN to search under for the user entry, e.g. ou=people,dc=example,dc=com.",
  authProviderLdapSearchFilter: "Search-then-bind mode: a filter with a {username} placeholder, e.g. (uid={username}) or (sAMAccountName={username}) for Active Directory. The substituted value is filter-escaped automatically.",
  authProviderLdapGroupLookup: "Optional -- after a successful bind, looks up the user's group memberships and folds them into the session's claims.groups (and the signed backend token's own groups claim). Leave Group search base blank to skip this entirely.",
  authProviderLdapGroupSearchBase: "Base DN to search under for group entries, e.g. ou=groups,dc=example,dc=com. Leave blank to skip group lookup.",
  authProviderLdapGroupSearchFilter: "A filter with {dn} and/or {username} placeholders, e.g. (member={dn}). Required when Group search base is set.",
  authProviderLdapGroupNameAttribute: "The attribute holding each matched group's display name. Defaults to \"cn\" if left blank.",
  authProviderLdapAttributes: "Extra directory attributes to capture off the resolved user entry into claims.attributes, e.g. mail, title, departmentNumber.",
  authProviderLdapTokenSecret: "LDAP/AD has no native token to relay to a backend, so this provider mints its own signed JWT as a stand-in \"backend token\" using this secret. Any backend that separately trusts this middleware (holds this same secret) can verify it. Leave blank when editing an existing provider to keep the currently stored value unchanged.",
  authProviderLdapTokenTtlSeconds: "How many seconds until the minted backend token (and the session) expires. Defaults to 3600 (1 hour).",
  authProviderTestLogin: "Sends the username/password below through provider.login() using the settings currently in this form -- including edits you haven't saved yet -- and reports whether it succeeds, without creating a session or exposing the resulting backend token.",
  testRawQuery: "For an auto-generated \"list\" endpoint: the query-string filters/sort/paging a real caller would send, as a JSON object, e.g. {\"status\": \"active\", \"limit\": \"20\"}. Ignored for the other table operations.",
  testRawBody: "For an auto-generated bulk-create/bulk-update/bulk-delete endpoint: the exact JSON body a real caller would send. Ignored for \"list\", which reads Query params instead.",
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
  const [meta, endpoints, gateways, authProviders, sessions, settings] = await Promise.all([
    api("GET", "/admin/api/meta"),
    api("GET", "/admin/api/endpoints"),
    api("GET", "/admin/api/gateways"),
    api("GET", "/admin/api/auth-providers"),
    api("GET", "/admin/api/sessions"),
    api("GET", "/admin/api/settings"),
  ]);
  META = meta;
  ENDPOINTS = endpoints;
  GATEWAYS = gateways;
  AUTH_PROVIDERS = authProviders;
  SESSIONS = sessions;
  renderEndpointsTree();
  renderGatewaysList();
  renderAuthProvidersList();
  renderSessionsList();
  renderWorkspaceBar(settings);
}

/** Re-fetches just the session list -- used by the sidebar's "Refresh"
 * button and after a revoke, without re-loading every other section. */
async function refreshSessions() {
  SESSIONS = await api("GET", "/admin/api/sessions");
  renderSessionsList();
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
 * Detail panel (right side) -- shows a placeholder until an endpoint,
 * gateway, auth provider, or session is selected from the sidebar, then
 * that item's inline view (edit/test/save for the first three; read-only
 * for a session). Only one of the four ever shows at a time.
 * ------------------------------------------------------------------- */
function showDetailView(kind) {
  ACTIVE_DETAIL = kind;
  document.getElementById("detail-empty").hidden = kind !== null;
  document.getElementById("endpoint-detail").hidden = kind !== "endpoint";
  document.getElementById("gateway-detail").hidden = kind !== "gateway";
  document.getElementById("auth-provider-detail").hidden = kind !== "authProvider";
  document.getElementById("session-detail").hidden = kind !== "session";
  renderEndpointsTree();
  renderGatewaysList();
  renderAuthProvidersList();
  renderSessionsList();
}

function closeDetail() {
  EDITING_ENDPOINT_ID = null;
  EDITING_GATEWAY_NAME = null;
  EDITING_AUTH_PROVIDER_NAME = null;
  SELECTED_SESSION_ID = null;
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

/* ---------------------------------------------------------------------
 * Auth providers list (sidebar) -- same row language as gateways (reuses
 * the .gateway-list/.gateway-row styles, since the shape is identical:
 * kind badge, name, one-line summary).
 * ------------------------------------------------------------------- */
function renderAuthProvidersList() {
  const container = document.getElementById("auth-providers-list");
  container.innerHTML = "";
  const names = Object.keys(AUTH_PROVIDERS);
  document.getElementById("auth-providers-empty").hidden = names.length > 0;
  for (const name of names) {
    const provider = AUTH_PROVIDERS[name];
    const summary = provider.kind === "oauth2" ? provider.tokenUrl || "" : provider.loginUrl || "";
    const isSelected = ACTIVE_DETAIL === "authProvider" && EDITING_AUTH_PROVIDER_NAME === name;
    container.appendChild(
      el("div", { class: "gateway-row" + (isSelected ? " selected" : ""), onclick: () => openAuthProviderEditor(name) }, [
        el("span", { class: "gateway-row-kind" }, [provider.kind || "basicLogin"]),
        el("span", { class: "gateway-row-name" }, [name]),
        el("span", { class: "gateway-row-summary" }, [summary]),
      ])
    );
  }
}

/* ---------------------------------------------------------------------
 * Active sessions (sidebar + read-only detail) -- what's actually held in
 * the server's in-memory session store right now (see
 * AuthService.listSessions()): every logged-in caller across every
 * provider, for whoever runs this instance to see without a debugger.
 * Never shows a session's real bearer token or the backend/refresh token
 * it wraps -- the admin API itself never sends those out either.
 * ------------------------------------------------------------------- */
function formatSessionExpiry(expiresAt) {
  if (expiresAt === undefined) return "No expiry";
  const msLeft = expiresAt - Date.now();
  if (msLeft <= 0) return "Expired";
  const minutes = Math.round(msLeft / 60000);
  if (minutes < 1) return "Expires <1m";
  if (minutes < 60) return `Expires in ${minutes}m`;
  return `Expires in ${Math.round(minutes / 60)}h`;
}

function renderSessionsList() {
  const container = document.getElementById("sessions-list");
  container.innerHTML = "";
  document.getElementById("sessions-empty").hidden = SESSIONS.length > 0;
  for (const session of SESSIONS) {
    const isSelected = ACTIVE_DETAIL === "session" && SELECTED_SESSION_ID === session.id;
    container.appendChild(
      el("div", { class: "gateway-row" + (isSelected ? " selected" : ""), onclick: () => openSessionDetail(session.id) }, [
        el("span", { class: "gateway-row-kind" }, [session.providerName]),
        el("span", { class: "gateway-row-name" }, [session.subject || "(no subject)"]),
        el("span", { class: "gateway-row-summary" }, [formatSessionExpiry(session.expiresAt)]),
      ])
    );
  }
}

function openSessionDetail(id) {
  closeInfoPopup();
  const session = SESSIONS.find((s) => s.id === id);
  if (!session) return; // e.g. it expired and was swept between render and click
  SELECTED_SESSION_ID = id;

  document.getElementById("session-detail-title").textContent = `Session — ${session.providerName}`;
  document.getElementById("session-detail-provider").textContent = session.providerName;
  document.getElementById("session-detail-subject").textContent = session.subject || "(none)";
  document.getElementById("session-detail-created").textContent = new Date(session.createdAt).toLocaleString();
  document.getElementById("session-detail-expires").textContent = session.expiresAt
    ? `${new Date(session.expiresAt).toLocaleString()} (${formatSessionExpiry(session.expiresAt).toLowerCase()})`
    : "No expiry";
  document.getElementById("session-detail-refreshable").textContent = session.hasRefreshToken ? "Yes" : "No";
  document.getElementById("session-detail-claims").textContent =
    session.claims && Object.keys(session.claims).length > 0 ? JSON.stringify(session.claims, null, 2) : "—";
  document.getElementById("session-revoke-btn").onclick = () => revokeSession(id);

  // The server only ever includes these three fields outside production
  // (AuthService.listSessions()'s isDevMode() gate) -- their presence here
  // is the authoritative signal, not META.devMode, since it reflects what
  // this particular response actually carried.
  const devFieldsPresent = session.token !== undefined || session.backendToken !== undefined;
  document.getElementById("session-detail-prod-note").hidden = devFieldsPresent;
  document.getElementById("session-detail-dev-banner").hidden = !devFieldsPresent;
  document.getElementById("session-detail-dev-fields").hidden = !devFieldsPresent;
  if (devFieldsPresent) {
    document.getElementById("session-detail-token").textContent = session.token || "—";
    document.getElementById("session-detail-backend-token").textContent = session.backendToken || "—";
    document.getElementById("session-detail-refresh-token").textContent = session.refreshToken || "(none)";
  }

  showDetailView("session");
  document.getElementById("detail-panel").scrollTop = 0;
}

async function revokeSession(id) {
  const session = SESSIONS.find((s) => s.id === id);
  const label = session ? `${session.providerName} / ${session.subject || "(no subject)"}` : "this session";
  if (!confirm(`Revoke ${label}? That caller's current session token will stop working immediately.`)) return;
  try {
    await api("DELETE", `/admin/api/sessions/${encodeURIComponent(id)}`);
    toast("Session revoked");
    closeDetail();
    await refreshSessions();
  } catch (err) {
    toast(err.message, true);
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

async function deleteAuthProvider(name) {
  if (!confirm(`Delete auth provider "${name}"?`)) return;
  try {
    await api("DELETE", `/admin/api/auth-providers/${encodeURIComponent(name)}`);
    toast(`Deleted auth provider "${name}"`);
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
  document.getElementById("test-raw-query").value = "";
  document.getElementById("test-raw-body").value = "";
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
  // declared `input` params -- the Try it panel has no fields for the
  // latter by default, so swap in a raw query-params or request-body
  // textarea (whichever this operation actually reads) instead of leaving
  // it looking broken. A generated stored-procedure endpoint isn't
  // affected: its params ARE declared `input` (in: "body"), so it works
  // fine with the normal per-parameter fields above.
  const isBulkTableEndpoint = Boolean(endpoint?.backend?.type === "sql" && endpoint?.backend?.table);
  document.getElementById("tryit-bulk-note").hidden = !isBulkTableEndpoint;
  const rawQueryRow = document.getElementById("test-raw-query-row");
  const rawBodyRow = document.getElementById("test-raw-body-row");
  if (isBulkTableEndpoint) {
    const op = endpoint.backend.operation;
    rawQueryRow.hidden = op !== "list";
    rawBodyRow.hidden = op === "list";
    document.getElementById("test-raw-body").placeholder =
      op === "bulkUpdate"
        ? '{"updates": [ { "key": {"id": 1}, "fields": {"...": "..."} } ]}'
        : op === "bulkDelete"
          ? '{"keys": [ {"id": 1} ]}'
          : '{"rows": [ {"...": "..."} ]}';
  } else {
    rawQueryRow.hidden = true;
    rawBodyRow.hidden = true;
  }

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

    let rawQuery, rawBody;
    const rawQueryText = document.getElementById("test-raw-query").value.trim();
    if (rawQueryText) {
      try {
        rawQuery = JSON.parse(rawQueryText);
      } catch (err) {
        throw new Error("Query params: invalid JSON -- " + err.message);
      }
    }
    const rawBodyText = document.getElementById("test-raw-body").value.trim();
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText);
      } catch (err) {
        throw new Error("Request body: invalid JSON -- " + err.message);
      }
    }

    const { raw } = await api("POST", "/admin/api/test-backend", { input, backend, params, rawQuery, rawBody });
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

/** Renders a test-login result the same way testDbConnection() renders a
 * connection-test result, plus the extra bits a login carries: the
 * resolved subject and any captured claims. Never shows the backend token
 * (the admin API doesn't return one) -- just enough to confirm the config
 * actually authenticates. */
async function testAuthProviderLogin() {
  const resultEl = document.getElementById("auth-provider-test-result");
  resultEl.hidden = false;
  resultEl.className = "test-result";
  resultEl.textContent = "Testing…";
  try {
    const config = document.getElementById("auth-provider-fields")._read();
    const credentials = {
      username: document.getElementById("auth-provider-test-username").value,
      password: document.getElementById("auth-provider-test-password").value,
    };
    const body = { config, credentials };
    if (EDITING_AUTH_PROVIDER_NAME) body.name = EDITING_AUTH_PROVIDER_NAME;
    const result = await api("POST", "/admin/api/auth-providers/test-login", body);
    resultEl.classList.add(result.ok ? "test-result-ok" : "test-result-error");
    if (!result.ok) {
      resultEl.textContent = `✕ ${result.message}`;
      return;
    }
    const bits = ["✓ Login succeeded"];
    if (result.subject) bits.push(`subject: ${result.subject}`);
    if (result.expiresAt) bits.push(`expires: ${new Date(result.expiresAt).toLocaleString()}`);
    if (result.claims && Object.keys(result.claims).length > 0) bits.push(`claims: ${JSON.stringify(result.claims)}`);
    resultEl.textContent = bits.join(" — ");
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

  populateSelect(form.requiresAuth, Object.keys(AUTH_PROVIDERS), { includeBlank: true, blankLabel: "(none)" });
  form.requiresAuth.value = gw?.requiresAuth || "";

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
    if (form.requiresAuth.value) config.requiresAuth = form.requiresAuth.value;
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
 * Auth provider editor -- same shape/conventions as the gateway editor
 * above (name/kind + kind-specific fields, save via upsert, delete
 * blocked server-side while a gateway still requires this provider).
 * ------------------------------------------------------------------- */
const AUTH_PROVIDER_KINDS = ["basicLogin", "oauth2", "ldap"];
const OAUTH_GRANT_TYPES = ["password", "client_credentials"];
const LDAP_BIND_MODES = ["search", "direct"];

function renderAuthProviderKindFields(kind, provider) {
  provider = provider || {};
  const container = document.getElementById("auth-provider-fields");
  container.innerHTML = "";

  const claimsList = el("div", { class: "repeatable-list" });
  for (const c of provider.claims || []) claimsList.appendChild(outputFieldRow(c));
  const addClaimBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => claimsList.appendChild(outputFieldRow()) }, ["+ Add claim"]);
  const claimsSectionNodes = [
    el("div", { class: "section-header" }, [el("h4", {}, ["Claims ", infoIcon("authProviderClaims")]), addClaimBtn]),
    el("p", { class: "muted" }, [
      "Optional -- extracts extra fields from the login response using the same JSONPath mapping as an endpoint's Output fields (e.g. exposing a subject or display name from the login response).",
    ]),
    claimsList,
  ];
  const readClaims = () => {
    const claims = [...claimsList.children].map((r) => r._read()).filter((c) => c.target && c.source);
    return claims.length ? claims : undefined;
  };

  if (kind === "basicLogin") {
    const loginUrlInput = el("input", { value: provider.loginUrl || "", required: true, placeholder: "https://api.example.com/login" });
    const methodSelect = el("select", {}, []);
    populateSelect(methodSelect, META.methods);
    methodSelect.value = provider.method || "POST";
    const headersContainer = el("div", { class: "repeatable-list" });
    renderKeyValueEditor(headersContainer, provider.headers, {});
    const addHeaderBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => headersContainer._addRow("", "") }, ["+ Add header"]);
    const usernameFieldInput = el("input", { value: provider.usernameField || "", placeholder: 'defaults to "username"' });
    const passwordFieldInput = el("input", { value: provider.passwordField || "", placeholder: 'defaults to "password"' });
    const staticFieldsContainer = el("div", { class: "repeatable-list" });
    renderKeyValueEditor(staticFieldsContainer, provider.staticFields, {});
    const addStaticFieldBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => staticFieldsContainer._addRow("", "") }, ["+ Add field"]);
    const tokenPathInput = el("input", { value: provider.tokenPath || "", required: true, placeholder: "$.accessToken" });
    const refreshTokenPathInput = el("input", { value: provider.refreshTokenPath || "", placeholder: "$.refreshToken (optional)" });
    const expiresInPathInput = el("input", { value: provider.expiresInPath || "", placeholder: "$.expiresIn (optional, seconds)" });
    const subjectPathInput = el("input", { value: provider.subjectPath || "", placeholder: "$.sub (optional)" });

    container.appendChild(
      el("div", { class: "field-grid" }, [
        el("label", { class: "span-2" }, [fieldTitle("Login URL ", infoIcon("authProviderLoginUrl")), loginUrlInput]),
        el("label", {}, [fieldTitle("Method ", infoIcon("authProviderMethod")), methodSelect]),
      ])
    );
    container.appendChild(el("div", { class: "section-header" }, [el("h4", {}, ["Headers ", infoIcon("backendHeaders")]), addHeaderBtn]));
    container.appendChild(headersContainer);
    container.appendChild(
      el("div", { class: "field-grid" }, [
        el("label", {}, [fieldTitle("Username field ", infoIcon("authProviderUsernameField")), usernameFieldInput]),
        el("label", {}, [fieldTitle("Password field ", infoIcon("authProviderPasswordField")), passwordFieldInput]),
      ])
    );
    container.appendChild(el("div", { class: "section-header" }, [el("h4", {}, ["Static fields ", infoIcon("authProviderStaticFields")]), addStaticFieldBtn]));
    container.appendChild(staticFieldsContainer);
    container.appendChild(
      el("div", { class: "field-grid" }, [
        el("label", { class: "span-2" }, [fieldTitle("Token path ", infoIcon("authProviderTokenPath"), " (JSONPath, required)"), tokenPathInput]),
        el("label", {}, [fieldTitle("Refresh token path ", infoIcon("authProviderRefreshTokenPath")), refreshTokenPathInput]),
        el("label", {}, [fieldTitle("Expires-in path ", infoIcon("authProviderExpiresInPath")), expiresInPathInput]),
        el("label", { class: "span-2" }, [fieldTitle("Subject path ", infoIcon("authProviderSubjectPath")), subjectPathInput]),
      ])
    );
    claimsSectionNodes.forEach((n) => container.appendChild(n));

    container._read = () => {
      const out = {
        kind: "basicLogin",
        loginUrl: loginUrlInput.value.trim(),
        method: methodSelect.value,
        headers: readKeyValueEditor(headersContainer),
        staticFields: readKeyValueEditor(staticFieldsContainer),
        tokenPath: tokenPathInput.value.trim(),
      };
      if (usernameFieldInput.value.trim()) out.usernameField = usernameFieldInput.value.trim();
      if (passwordFieldInput.value.trim()) out.passwordField = passwordFieldInput.value.trim();
      if (refreshTokenPathInput.value.trim()) out.refreshTokenPath = refreshTokenPathInput.value.trim();
      if (expiresInPathInput.value.trim()) out.expiresInPath = expiresInPathInput.value.trim();
      if (subjectPathInput.value.trim()) out.subjectPath = subjectPathInput.value.trim();
      const claims = readClaims();
      if (claims) out.claims = claims;
      return out;
    };
  } else if (kind === "oauth2") {
    const tokenUrlInput = el("input", { value: provider.tokenUrl || "", required: true, placeholder: "https://api.example.com/oauth/token" });
    const grantTypeSelect = el("select", {}, []);
    populateSelect(grantTypeSelect, OAUTH_GRANT_TYPES);
    grantTypeSelect.value = provider.grantType || "password";
    const clientIdInput = el("input", { value: provider.clientId || "", required: true, placeholder: "my-client-id" });
    const isRedactedSecret = provider.clientSecret === REDACTED;
    const clientSecretInput = el("input", {
      type: "password",
      value: isRedactedSecret ? "" : provider.clientSecret || "",
      placeholder: isRedactedSecret ? "(unchanged — leave blank to keep)" : "required",
      ...(EDITING_AUTH_PROVIDER_NAME ? {} : { required: true }),
    });
    const scopeInput = el("input", { value: provider.scope || "", placeholder: "optional" });
    const headersContainer = el("div", { class: "repeatable-list" });
    renderKeyValueEditor(headersContainer, provider.headers, {});
    const addHeaderBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => headersContainer._addRow("", "") }, ["+ Add header"]);

    container.appendChild(
      el("div", { class: "field-grid" }, [
        el("label", { class: "span-2" }, [fieldTitle("Token URL ", infoIcon("authProviderTokenUrl")), tokenUrlInput]),
        el("label", {}, [fieldTitle("Grant type ", infoIcon("authProviderGrantType")), grantTypeSelect]),
        el("label", {}, [fieldTitle("Client id ", infoIcon("authProviderClientId")), clientIdInput]),
        el("label", {}, [fieldTitle("Client secret ", infoIcon("authProviderClientSecret")), clientSecretInput]),
        el("label", { class: "span-2" }, [fieldTitle("Scope ", infoIcon("authProviderScope")), scopeInput]),
      ])
    );
    container.appendChild(el("div", { class: "section-header" }, [el("h4", {}, ["Headers ", infoIcon("backendHeaders")]), addHeaderBtn]));
    container.appendChild(headersContainer);
    claimsSectionNodes.forEach((n) => container.appendChild(n));

    container._read = () => {
      const out = {
        kind: "oauth2",
        tokenUrl: tokenUrlInput.value.trim(),
        grantType: grantTypeSelect.value,
        clientId: clientIdInput.value.trim(),
        clientSecret: clientSecretInput.value,
        headers: readKeyValueEditor(headersContainer),
      };
      if (scopeInput.value.trim()) out.scope = scopeInput.value.trim();
      const claims = readClaims();
      if (claims) out.claims = claims;
      return out;
    };
  } else if (kind === "ldap") {
    const urlInput = el("input", { value: provider.url || "", required: true, placeholder: "ldap://localhost:3389" });
    const tlsRejectCheckbox = el("input", { type: "checkbox" });
    tlsRejectCheckbox.checked = provider.tlsRejectUnauthorized !== false;

    const initialMode = provider.userDnTemplate ? "direct" : "search";
    const bindModeSelect = el("select", {}, []);
    populateSelect(bindModeSelect, LDAP_BIND_MODES);
    bindModeSelect.value = initialMode;

    const userDnTemplateInput = el("input", {
      value: provider.userDnTemplate || "",
      placeholder: "uid={username},ou=people,dc=example,dc=com",
    });

    const bindDnInput = el("input", { value: provider.bindDn || "", placeholder: "cn=admin,dc=example,dc=com" });
    const isRedactedBindPassword = provider.bindPassword === REDACTED;
    const bindPasswordInput = el("input", {
      type: "password",
      value: isRedactedBindPassword ? "" : provider.bindPassword || "",
      placeholder: isRedactedBindPassword ? "(unchanged — leave blank to keep)" : "",
    });
    const searchBaseInput = el("input", { value: provider.searchBase || "", placeholder: "ou=people,dc=example,dc=com" });
    const searchFilterInput = el("input", { value: provider.searchFilter || "", placeholder: "(uid={username})" });

    const directModeFields = el("div", { class: "field-grid" }, [
      el("label", { class: "span-2" }, [
        fieldTitle("User DN template ", infoIcon("authProviderLdapUserDnTemplate")),
        userDnTemplateInput,
      ]),
    ]);
    const searchModeFields = el("div", { class: "field-grid" }, [
      el("label", {}, [fieldTitle("Bind DN ", infoIcon("authProviderLdapBindDn")), bindDnInput]),
      el("label", {}, [fieldTitle("Bind password ", infoIcon("authProviderLdapBindPassword")), bindPasswordInput]),
      el("label", { class: "span-2" }, [fieldTitle("Search base ", infoIcon("authProviderLdapSearchBase")), searchBaseInput]),
      el("label", { class: "span-2" }, [fieldTitle("Search filter ", infoIcon("authProviderLdapSearchFilter")), searchFilterInput]),
    ]);
    const applyBindModeVisibility = () => {
      const isDirect = bindModeSelect.value === "direct";
      directModeFields.hidden = !isDirect;
      searchModeFields.hidden = isDirect;
    };
    bindModeSelect.addEventListener("change", applyBindModeVisibility);

    const groupSearchBaseInput = el("input", { value: provider.groupSearchBase || "", placeholder: "ou=groups,dc=example,dc=com (optional)" });
    const groupSearchFilterInput = el("input", { value: provider.groupSearchFilter || "", placeholder: "(member={dn}) (required if Group search base is set)" });
    const groupNameAttributeInput = el("input", { value: provider.groupNameAttribute || "", placeholder: 'defaults to "cn"' });
    const attributesInput = el("input", {
      value: (provider.attributes || []).join(", "),
      placeholder: "mail, title, departmentNumber (optional)",
    });
    const isRedactedTokenSecret = provider.tokenSecret === REDACTED;
    const tokenSecretInput = el("input", {
      type: "password",
      value: isRedactedTokenSecret ? "" : provider.tokenSecret || "",
      placeholder: isRedactedTokenSecret ? "(unchanged — leave blank to keep)" : "required",
      ...(EDITING_AUTH_PROVIDER_NAME ? {} : { required: true }),
    });
    const tokenTtlInput = el("input", { type: "number", min: "1", value: provider.tokenTtlSeconds ?? 3600 });

    container.appendChild(
      el("div", { class: "field-grid" }, [
        el("label", { class: "span-2" }, [fieldTitle("URL ", infoIcon("authProviderLdapUrl")), urlInput]),
        el("label", { class: "checkbox-field" }, [tlsRejectCheckbox, "Verify TLS certificate ", infoIcon("authProviderLdapTlsRejectUnauthorized")]),
      ])
    );
    container.appendChild(el("div", { class: "field-grid" }, [el("label", {}, [fieldTitle("Bind mode ", infoIcon("authProviderLdapBindMode")), bindModeSelect])]));
    container.appendChild(directModeFields);
    container.appendChild(searchModeFields);
    applyBindModeVisibility();

    container.appendChild(el("div", { class: "section-header" }, [el("h4", {}, ["Group lookup ", infoIcon("authProviderLdapGroupLookup")])]));
    container.appendChild(
      el("div", { class: "field-grid" }, [
        el("label", { class: "span-2" }, [fieldTitle("Group search base ", infoIcon("authProviderLdapGroupSearchBase")), groupSearchBaseInput]),
        el("label", { class: "span-2" }, [fieldTitle("Group search filter ", infoIcon("authProviderLdapGroupSearchFilter")), groupSearchFilterInput]),
        el("label", {}, [fieldTitle("Group name attribute ", infoIcon("authProviderLdapGroupNameAttribute")), groupNameAttributeInput]),
      ])
    );
    container.appendChild(
      el("div", { class: "field-grid" }, [
        el("label", { class: "span-2" }, [fieldTitle("Extra attributes ", infoIcon("authProviderLdapAttributes"), " (comma-separated)"), attributesInput]),
      ])
    );
    container.appendChild(el("div", { class: "section-header" }, [el("h4", {}, ["Stand-in backend token ", infoIcon("authProviderLdapTokenSecret")])]));
    container.appendChild(
      el("div", { class: "field-grid" }, [
        el("label", {}, [fieldTitle("Token secret ", infoIcon("authProviderLdapTokenSecret")), tokenSecretInput]),
        el("label", {}, [fieldTitle("Token TTL (seconds) ", infoIcon("authProviderLdapTokenTtlSeconds")), tokenTtlInput]),
      ])
    );

    container._read = () => {
      const out = {
        kind: "ldap",
        url: urlInput.value.trim(),
        tlsRejectUnauthorized: tlsRejectCheckbox.checked,
        tokenSecret: tokenSecretInput.value,
        tokenTtlSeconds: tokenTtlInput.value ? Number(tokenTtlInput.value) : 3600,
      };
      if (bindModeSelect.value === "direct") {
        out.userDnTemplate = userDnTemplateInput.value.trim();
      } else {
        out.bindDn = bindDnInput.value.trim();
        out.bindPassword = bindPasswordInput.value;
        out.searchBase = searchBaseInput.value.trim();
        out.searchFilter = searchFilterInput.value.trim();
      }
      if (groupSearchBaseInput.value.trim()) {
        out.groupSearchBase = groupSearchBaseInput.value.trim();
        out.groupSearchFilter = groupSearchFilterInput.value.trim();
        if (groupNameAttributeInput.value.trim()) out.groupNameAttribute = groupNameAttributeInput.value.trim();
      }
      const attributes = attributesInput.value
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      if (attributes.length) out.attributes = attributes;
      return out;
    };
  }
}

/** Clears the test-login credentials/result -- switching provider, kind, or
 * closing/reopening the editor shouldn't carry a stale result (or someone
 * else's typed-in password) forward. */
function resetAuthProviderTestPanel() {
  document.getElementById("auth-provider-test-username").value = "";
  document.getElementById("auth-provider-test-password").value = "";
  const resultEl = document.getElementById("auth-provider-test-result");
  resultEl.hidden = true;
  resultEl.textContent = "";
  resultEl.className = "test-result";
}

function openAuthProviderEditor(name) {
  closeInfoPopup();
  EDITING_AUTH_PROVIDER_NAME = name || null;
  const provider = name ? AUTH_PROVIDERS[name] : null;
  document.getElementById("auth-provider-editor-title").textContent = provider ? `Edit auth provider: ${name}` : "New auth provider";
  const deleteBtn = document.getElementById("auth-provider-delete-btn");
  deleteBtn.hidden = !provider;
  deleteBtn.onclick = () => deleteAuthProvider(EDITING_AUTH_PROVIDER_NAME);
  showError("auth-provider-form-error", "");

  const form = document.getElementById("auth-provider-form");
  form.name.value = name || "";
  form.name.disabled = Boolean(name); // renaming would orphan the old entry; delete+recreate instead

  populateSelect(form.kind, AUTH_PROVIDER_KINDS);
  form.kind.value = provider?.kind || "basicLogin";
  renderAuthProviderKindFields(form.kind.value, provider);
  form.kind.onchange = () => {
    renderAuthProviderKindFields(form.kind.value, {});
    resetAuthProviderTestPanel();
  };
  resetAuthProviderTestPanel();

  showDetailView("authProvider");
  document.getElementById("detail-panel").scrollTop = 0;
}

async function saveAuthProvider(ev) {
  ev.preventDefault();
  showError("auth-provider-form-error", "");
  const form = document.getElementById("auth-provider-form");
  const name = form.name.value.trim();
  try {
    const config = document.getElementById("auth-provider-fields")._read();
    if (EDITING_AUTH_PROVIDER_NAME) {
      await api("PUT", `/admin/api/auth-providers/${encodeURIComponent(EDITING_AUTH_PROVIDER_NAME)}`, { config });
    } else {
      await api("POST", "/admin/api/auth-providers", { name, config });
    }
    toast(`Saved auth provider "${name}"`);
    await loadAll();
    openAuthProviderEditor(name); // stay in the panel, now showing it as a saved provider
  } catch (err) {
    showError("auth-provider-form-error", err.message);
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
  document.getElementById("new-auth-provider-btn").addEventListener("click", () => openAuthProviderEditor(null));
  document.getElementById("endpoint-close-btn").addEventListener("click", closeDetail);
  document.getElementById("gateway-close-btn").addEventListener("click", closeDetail);
  document.getElementById("auth-provider-close-btn").addEventListener("click", closeDetail);
  document.getElementById("session-close-btn").addEventListener("click", closeDetail);
  document.getElementById("refresh-sessions-btn").addEventListener("click", async () => {
    await refreshSessions();
    toast("Sessions refreshed");
  });
  document.getElementById("change-workspace-btn").addEventListener("click", () => openWorkspaceEditor(CURRENT_SETTINGS.configDir));
  document.getElementById("workspace-form").addEventListener("submit", saveWorkspace);
  document.getElementById("download-openapi-btn").addEventListener("click", async () => {
    try {
      await downloadFile("/admin/api/export/openapi.json", "naimix-openapi.json");
      toast("OpenAPI spec downloaded");
    } catch (err) {
      toast(err.message, true);
    }
  });
  document.getElementById("download-mcp-server-btn").addEventListener("click", async () => {
    try {
      await downloadFile("/admin/api/export/mcp-server", "naimix-mcp-server.js");
      toast("MCP server downloaded");
    } catch (err) {
      toast(err.message, true);
    }
  });

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
  document.getElementById("auth-provider-form").addEventListener("submit", saveAuthProvider);
  document.getElementById("auth-provider-test-btn").addEventListener("click", testAuthProviderLogin);
  document.getElementById("fetch-sample-btn").addEventListener("click", fetchSample);
  document.getElementById("apply-mapping-btn").addEventListener("click", applyMappingToSample);

  const savedToken = localStorage.getItem("naimix-admin-token");
  if (savedToken) {
    login(savedToken).catch(() => {
      // Stored token no longer valid -- fall back to the login screen silently.
    });
  }
});
