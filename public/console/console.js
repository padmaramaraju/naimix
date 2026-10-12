"use strict";

/* ---------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------- */
const REDACTED = "••••••••";
const SENSITIVE_KEY = /pass|secret|token|apikey|api_key|credential/i;
const THEME_KEY = "naimix-console-theme";

let TOKEN = null;
let META = { methods: [], backendTypes: [], transforms: [], sqlClients: [], paramLocations: [], paramTypes: [], devMode: false };
let INTEGRATIONS = [];
let APPS = [];
let GATEWAYS = {};
let AUTH_PROVIDERS = {};
let SESSIONS = [];
let ACTIVE_DETAIL = null; // null | "integration" | "app" | "gateway" | "authProvider" | "session" -- which panel is showing on the right
let EDITING_INTEGRATION_ID = null; // null = creating a new integration
let EDITING_APP_ID = null; // null = creating a new app
let EDITING_GATEWAY_NAME = null; // null = creating a new gateway
let EDITING_AUTH_PROVIDER_NAME = null; // null = creating a new auth provider
let SELECTED_SESSION_ID = null;
let LAST_RAW_SAMPLE;
let HAS_RAW_SAMPLE = false;
let CURRENT_SETTINGS = { configDir: null };
// The App currently open in the detail panel's own full routes array, kept
// in memory so saving just id/name edits (via #app-form) can resend the
// whole App -- see appRegistry.upsert()'s "whole file" persistence model --
// without the detail panel needing to re-render the Routes table from a
// fresh fetch on every keystroke.
let CURRENT_APP_ROUTES = [];
// Which App + (if any) existing route the route-editor drawer is currently
// working on -- null routeId means "adding a new route to this app".
let ROUTE_EDITOR_STATE = { appId: null, routeId: null, integrationId: null };
// Drives the breadcrumb and which sidebar nav row shows active -- see
// renderBreadcrumb()/renderSharedNav()/renderAppsNav(). `type` is
// null | "shared" | "app" | "session"; `key` is the shared category
// ("authProviders"|"gateways"|"integrations") or App id; `item` (shared
// only) is the individual item's id when its own editor is open on top
// of that category's catalog table, or null when just the table shows.
let CURRENT_VIEW = { type: null, key: null, item: null };

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
 * Downloads a file from an authenticated /console/api/* route. A plain
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
  sharedCollection: "Centrally-maintained Auth providers, Gateways, and Integrations -- every App's Routes point into these by name, so one change here (a backend URL, a secret, an output mapping) is visible to every App that uses it. See WORKSPACE_APPS_DESIGN_NOTES.md.",
  integrationsSection: "An Integration is the backend-calling/output-mapping half of what used to be one flat Endpoint -- it has no method/path of its own. A Route (inside an App, below) points at one of these by name to expose it at a real URL.",
  appsSection: "A team-owned flat list of Routes. Each Route is a pure method+path pointer at one Integration in the Shared Collection above. An App gets exposed on a real server only once deployment.yaml's `mounts` list names it (with a basePath) -- that file is hand-edited, not managed from here.",
  integrationId: "A unique identifier for this integration (letters, digits, _ and - only). Used in the config filename and log messages, and as what a Route's `integration` field names -- renaming it is safe, the app moves the file for you and you just repoint any Route that used the old name.",
  integrationDescription: "An optional human-readable note shown in the integrations list -- purely for your own reference, it has no effect on requests.",
  appId: "A unique identifier for this App (letters, digits, _ and - only). Used in the config filename and as what deployment.yaml's `mounts` list names to mount it.",
  appName: "A display name for this App, shown in the console UI -- independent of its Id, so renaming it doesn't affect deployment.yaml's `mounts` list or any file path.",
  appRoutes: "This App's own public surface -- each Route is a method + path a caller can hit, pointing at one Integration in the Shared Collection by name. Two Routes in the SAME App can never collide on method + path (checked on save); the same Integration can be pointed at by Routes in different Apps, or more than once in the same App under different paths.",
  routeId: "A unique identifier for this Route within its App (letters, digits, _ and - only) -- independent of its method/path, so editing the path in place doesn't need a new id.",
  routeMethod: "The HTTP method this Route listens for on Path.",
  routePath: "The URL path callers hit, relative to this App's basePath (set in deployment.yaml's `mounts` list, hand-edited, not here) -- not the backend's URL. Must start with / and can include path params, e.g. /:id.",
  routeDescription: "An optional human-readable note shown in the routes list -- purely for your own reference, it has no effect on requests.",
  routeTryIt: "Calls this Route's Integration for real (through its backend, mapped through its output) using the sample values below -- the same test a saved Integration's own Test tab runs, reached here by name instead.",
  backendGateway: "Which named gateway (from the Gateways list) supplies the base URL, WSDL, or DB connection for this call. Leave as (none) to call an absolute URL directly.",
  backendType: "Which kind of backend this is -- json, xml, soap, or sql. Set automatically from the selected Gateway's kind, since the two can never disagree; only editable when no gateway is selected.",
  backendUrl: "The backend URL to call, relative to the gateway's Base URL (or absolute if there's no gateway). Supports {param} placeholders filled in from this integration's input parameters.",
  backendMethod: "The HTTP method used to call the backend.",
  backendHeaders: "Extra HTTP headers sent with the backend request, layered on top of the gateway's own headers. Values support {param} placeholders.",
  backendQuery: "Query-string parameters appended to the backend request URL. Values support {param} placeholders.",
  backendBody: "The request body sent to the backend. For a JSON backend this is parsed as JSON; for XML it's sent through as a literal string template.",
  soapWsdl: "Overrides the WSDL URL for this one operation. Leave blank to use the gateway's own WSDL.",
  soapEndpoint: "Overrides the actual SOAP endpoint the operation is called against. Leave blank to use the WSDL URL with its query string stripped.",
  soapOperation: "The name of the SOAP operation to call, exactly as declared in the WSDL.",
  soapArgs: "Arguments passed to the SOAP operation, by name. Values support {param} placeholders from this integration's input parameters.",
  sqlQuery: "A parameterized SQL query using named :param bindings (e.g. :id) that map to this integration's input parameters.",
  paramName: "The parameter's name -- this becomes the {name} placeholder you can use in the backend config on the previous tab.",
  paramIn: "Where the caller supplies this value: a URL path segment, a query-string parameter, an HTTP header, the JSON request body, or (env) this server's own environment variable.",
  paramEnvVar: "The environment variable name to read from. Defaults to the parameter's own name if left blank.",
  paramType: "The value is coerced to this type (string, number, or boolean) before it's used.",
  paramRequired: "If on, a call missing this parameter is rejected with a 400 error before the backend is ever called.",
  paramDefault: "The value used when the caller doesn't supply one and it isn't required.",
  outputTarget: "The field name in this integration's JSON response -- can be nested, e.g. name.first.",
  outputSource: "A JSONPath into the backend's raw response, e.g. $.firstName.",
  outputTransform: "An optional conversion applied to the extracted value before it's placed in the response.",
  outputDefault: "The value used when Source doesn't match anything in the backend's response.",
  outputArrayRoot: "A JSONPath selecting a collection, evaluated relative to this field's own parent item -- the real backend response itself at the top level, or one level deeper for a nested array inside another array. Each match is mapped through this array's own nested fields below, e.g. $.orders[*].",
  outputPostProcess: "An optional named custom function run once on the entire mapped output above (not just one field) -- use it to add or remove top-level fields, or to walk and rewrite an array, after every field above has already been extracted. The same functions available here can also be picked as a single field's Transform.",
  gatewayName: "A unique identifier for this gateway (letters, digits, _ and - only). Integrations reference it by this exact name in their Gateway field.",
  gatewayKind: "The type of backend this gateway connects to -- json, xml, soap, or sql. Determines which fields below apply and which connector handles requests through it.",
  gatewayBaseUrl: "The base URL every integration using this gateway calls relative to, e.g. https://api.example.com.",
  gatewayWsdl: "The WSDL URL describing this SOAP service's available operations.",
  gatewayClient: "Which database driver (knex client) to use -- must match the actual database you're connecting to.",
  gatewayConnection: "The database driver's own connection fields (e.g. host, port, user, password, database, or filename for SQLite) -- passed straight through to the driver.",
  gatewayUseNullAsDefault: "Required by SQLite (better-sqlite3/sqlite3) -- tells the query builder to use NULL for columns you didn't specify, instead of erroring.",
  gatewayCommonParams: "Default parameter values shared by every integration that uses this gateway, available as {name}. An integration's own input parameter of the same name takes precedence.",
  gatewayRequiresAuth: "Names an entry in the Auth providers list. When set, every route whose Integration calls through this gateway requires a caller session obtained by logging in against that provider (POST /auth/login/<name>) -- the real backend token it holds is available to this gateway's config as {__authToken}.",
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
  authProviderClaims: "Optional extra fields pulled out of the login response using the same JSONPath mapping as an Integration's Output fields, e.g. exposing a display name or role from the login response.",
  activeSessions: "Every caller session currently held in memory across all auth providers. This is a live view of the session store, showing enough to identify a session (provider, subject, claims, timestamps) and revoke it if needed. Outside production (NODE_ENV != \"production\"), opening a session also shows its real session/backend/refresh tokens for local debugging; a real deployment run with NODE_ENV=production always withholds them.",
  exportSection: "Download a standard OpenAPI (Swagger) description of every route currently MOUNTED on this server (every App named in deployment.yaml's `mounts`, basePath-prefixed) plus this workspace's auth routes, or a ready-to-run MCP server that talks to this same live instance -- both always reflect the current config, so re-download after making changes rather than reusing an older copy.",
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
  testRawQuery: "For an auto-generated \"list\" integration: the query-string filters/sort/paging a real caller would send, as a JSON object, e.g. {\"status\": \"active\", \"limit\": \"20\"}. Ignored for the other table operations.",
  testRawBody: "For an auto-generated bulk-create/bulk-update/bulk-delete integration: the exact JSON body a real caller would send. Ignored for \"list\", which reads Query params instead.",
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

// A <label> is flex-direction: column (see console.css), so each of its direct
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
 * params) without leaving the integration editor to go look it up.
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
  const form = document.getElementById("integration-form");
  const name = form.backendGateway.value;
  if (!name) return;
  showPopup(btn, buildGatewayPreview(name), "gateway-preview");
}

function refreshViewGatewayBtn() {
  const form = document.getElementById("integration-form");
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
    await api("GET", "/console/api/integrations");
  } catch (err) {
    TOKEN = prevToken;
    throw err;
  }
  localStorage.setItem("naimix-console-token", token);
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app").hidden = false;
  await loadAll();
}

function logout() {
  TOKEN = null;
  localStorage.removeItem("naimix-console-token");
  document.getElementById("app").hidden = true;
  document.getElementById("login-screen").hidden = false;
}

/* ---------------------------------------------------------------------
 * Load + render
 * ------------------------------------------------------------------- */
async function loadAll() {
  const [meta, integrations, apps, gateways, authProviders, sessions, settings] = await Promise.all([
    api("GET", "/console/api/meta"),
    api("GET", "/console/api/integrations"),
    api("GET", "/console/api/apps"),
    api("GET", "/console/api/gateways"),
    api("GET", "/console/api/auth-providers"),
    api("GET", "/console/api/sessions"),
    api("GET", "/console/api/settings"),
  ]);
  META = meta;
  INTEGRATIONS = integrations;
  APPS = apps;
  GATEWAYS = gateways;
  AUTH_PROVIDERS = authProviders;
  SESSIONS = sessions;
  renderSharedNav();
  renderAppsNav();
  renderSessionsList();
  renderWorkspaceBar(settings);
  // If a Shared Collection catalog table is currently showing, refresh its
  // rows too -- loadAll() runs after every save/delete/reload, and the
  // catalog table has its own copy of the list baked into its DOM.
  if (CURRENT_VIEW.type === "shared" && !CURRENT_VIEW.item) renderSharedCatalogTable(CURRENT_VIEW.key);
}

/** Re-fetches just the session list -- used by the sidebar's "Refresh"
 * button and after a revoke, without re-loading every other section. */
async function refreshSessions() {
  SESSIONS = await api("GET", "/console/api/sessions");
  renderSessionsList();
}

/* ---------------------------------------------------------------------
 * Workspace -- the folder (integrations/ + apps/ + gateways.yaml) this
 * instance is currently pointed at. Still persisted/transmitted under the
 * field name `configDir` (see deploymentConfig.ts / the
 * /console/api/settings API) -- that's a stable data contract, not the
 * user-facing name. `mountErrors` (an unknown app in deployment.yaml's
 * `mounts`, or a route referencing an unknown integration) is surfaced as
 * a small warning button rather than silently ignored.
 * ------------------------------------------------------------------- */
function renderWorkspaceBar(settings) {
  CURRENT_SETTINGS = settings;
  const chipEl = document.getElementById("workspace-chip");
  const name = settings.configDir || `${settings.integrationsDir} + ${settings.appsDir}`;
  chipEl.textContent = `Workspace: ${name}`;
  chipEl.title =
    `${name}\n${settings.integrationCount} integration(s), ${settings.appCount} app(s), ` +
    `${settings.routeCount} route(s) mounted, ${settings.gatewayCount} gateway(s)`;

  const mountErrors = settings.mountErrors || [];
  const warnBtn = document.getElementById("workspace-mount-warning");
  warnBtn.hidden = mountErrors.length === 0;
  warnBtn.textContent = `⚠ ${mountErrors.length} mount issue(s)`;
  warnBtn.onclick = () => alert(mountErrors.join("\n"));
}

function openWorkspaceEditor(currentConfigDir) {
  showError("workspace-form-error", "");
  const form = document.getElementById("workspace-form");
  form.configDir.value = currentConfigDir || "";
  document.getElementById("workspace-editor").hidden = false;
  form.configDir.focus();
}

async function browseWorkspace() {
  const button = document.getElementById("browse-workspace-btn");
  const form = document.getElementById("workspace-form");
  showError("workspace-form-error", "");
  button.disabled = true;
  button.textContent = "Choosing folder…";
  try {
    const startDir = form.configDir.value.trim();
    const result = await api("POST", "/console/api/settings/select-folder", startDir ? { startDir } : undefined);
    if (result.configDir !== null) {
      form.configDir.value = result.configDir;
      form.configDir.focus();
    }
  } catch (err) {
    showError("workspace-form-error", err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Browse…";
  }
}

async function saveWorkspace(ev) {
  ev.preventDefault();
  showError("workspace-form-error", "");
  const configDir = ev.target.configDir.value.trim();
  try {
    const result = await api("PUT", "/console/api/settings", { configDir });
    closeDrawer("workspace-editor");
    const errorCount = (result.integrationErrors?.length || 0) + (result.appErrors?.length || 0);
    toast(
      `Switched to ${configDir} — ${result.integrationCount} integration(s), ${result.appCount} app(s)` +
        `${errorCount ? `, ${errorCount} error(s)` : ""}, ${result.gatewayCount} gateway(s)` +
        `${result.mountErrors?.length ? ` — ${result.mountErrors.length} mount issue(s)` : ""}`,
      errorCount > 0 || Boolean(result.mountErrors?.length)
    );
    closeDetail();
    await loadAll();
  } catch (err) {
    showError("workspace-form-error", err.message);
  }
}

/* ---------------------------------------------------------------------
 * Detail panel (right side) -- shows a placeholder until an item is
 * selected from the sidebar, then its inline view (edit/test/save for
 * integration/app/gateway/authProvider; read-only for a session). Only
 * one of the five ever shows at a time.
 * ------------------------------------------------------------------- */
function showDetailView(kind) {
  ACTIVE_DETAIL = kind;
  document.getElementById("detail-empty").hidden = kind !== null;
  document.getElementById("shared-catalog-view").hidden = kind !== "sharedCatalog";
  document.getElementById("integration-detail").hidden = kind !== "integration";
  document.getElementById("app-detail").hidden = kind !== "app";
  document.getElementById("gateway-detail").hidden = kind !== "gateway";
  document.getElementById("auth-provider-detail").hidden = kind !== "authProvider";
  document.getElementById("session-detail").hidden = kind !== "session";
  renderSharedNav();
  renderAppsNav();
  renderSessionsList();
}

/** Closes whatever's open and returns to the blank "nothing selected"
 * state -- used for the two kinds with no catalog/list to fall back to
 * (App, Session). An Integration/Gateway/Auth provider editor's own Close
 * button goes back to its Shared Collection catalog table instead (see
 * backToSharedCatalog()), not here. */
function closeDetail() {
  EDITING_INTEGRATION_ID = null;
  EDITING_APP_ID = null;
  EDITING_GATEWAY_NAME = null;
  EDITING_AUTH_PROVIDER_NAME = null;
  SELECTED_SESSION_ID = null;
  CURRENT_VIEW = { type: null, key: null, item: null };
  showDetailView(null);
  renderBreadcrumb();
  closeInfoPopup();
}

/** Returns to the Shared Collection catalog table for `kind` -- what an
 * Integration/Gateway/Auth provider editor's Close button does, and what
 * a save/delete from inside one of those editors falls back to, now that
 * each of the three is reached by drilling into a table rather than
 * picked directly off the sidebar. */
function backToSharedCatalog(kind) {
  EDITING_INTEGRATION_ID = null;
  EDITING_GATEWAY_NAME = null;
  EDITING_AUTH_PROVIDER_NAME = null;
  showSharedCatalog(kind);
}

/* ---------------------------------------------------------------------
 * Breadcrumb (top bar) -- reflects CURRENT_VIEW: "Shared Collection ›
 * Gateways" (catalog table) or "... › Gateways › my-gateway" (its editor
 * open on top of that), "Apps › My App", or "Active sessions".
 * ------------------------------------------------------------------- */
const SHARED_CATEGORY_LABELS = { authProviders: "Auth Providers", gateways: "Gateways", integrations: "Integrations" };

function renderBreadcrumb() {
  const container = document.getElementById("breadcrumb");
  container.innerHTML = "";
  const sep = () => el("span", { class: "breadcrumb-sep" }, ["›"]);
  if (CURRENT_VIEW.type === "shared") {
    container.append(el("span", {}, ["Shared Collection"]), sep(), el("b", {}, [SHARED_CATEGORY_LABELS[CURRENT_VIEW.key]]));
    if (CURRENT_VIEW.item) container.append(sep(), el("b", {}, [CURRENT_VIEW.item]));
  } else if (CURRENT_VIEW.type === "app") {
    container.append(el("span", {}, ["Apps"]), sep(), el("b", {}, [CURRENT_VIEW.key]));
  } else if (CURRENT_VIEW.type === "session") {
    container.append(el("span", {}, ["Active sessions"]));
  }
}

/* ---------------------------------------------------------------------
 * Shared Collection sidebar nav -- just 3 category links now (Auth
 * Providers / Gateways / Integrations), each with a count, instead of a
 * full row per individual item. Clicking one opens a read-only catalog
 * table of every item of that kind (see showSharedCatalog() below); the
 * individual item's own full editor is reached by clicking a row in that
 * table, or its "+ Add" button for a new one.
 * ------------------------------------------------------------------- */
function renderSharedNav() {
  const listEl = document.getElementById("shared-nav-list");
  listEl.innerHTML = "";
  const counts = {
    authProviders: Object.keys(AUTH_PROVIDERS).length,
    gateways: Object.keys(GATEWAYS).length,
    integrations: INTEGRATIONS.length,
  };
  for (const key of ["authProviders", "gateways", "integrations"]) {
    const active = CURRENT_VIEW.type === "shared" && CURRENT_VIEW.key === key;
    listEl.appendChild(
      el("li", { class: "nav-item" + (active ? " shared-active" : ""), onclick: () => showSharedCatalog(key) }, [
        el("span", {}, [SHARED_CATEGORY_LABELS[key]]),
        el("span", { class: "nav-item-count" }, [String(counts[key])]),
      ])
    );
  }
}

/* ---------------------------------------------------------------------
 * Apps sidebar nav -- flat list of Apps, each showing its route count.
 * Clicking one opens that App's own editor (Settings/Routes/Export tabs).
 * ------------------------------------------------------------------- */
function renderAppsNav() {
  const listEl = document.getElementById("apps-nav-list");
  const emptyEl = document.getElementById("apps-empty");
  listEl.innerHTML = "";
  emptyEl.hidden = APPS.length > 0;
  for (const app of [...APPS].sort((a, b) => a.name.localeCompare(b.name))) {
    const active = CURRENT_VIEW.type === "app" && CURRENT_VIEW.key === app.id;
    listEl.appendChild(
      el("li", { class: "nav-item" + (active ? " apps-active" : ""), onclick: () => openAppEditor(app.id) }, [
        el("span", {}, [app.name]),
        el("span", { class: "nav-item-count" }, [String((app.routes || []).length)]),
      ])
    );
  }
}

/** Turns a typed App name into a safe candidate id (lowercase,
 * non-alphanumerics collapsed to "-"), for the inline "+ New App" quick
 * create below -- a real App needs an id matching appConfigSchema's
 * `[A-Za-z0-9_-]+`, but the mockup's inline flow only ever asked for a
 * display name, so this bridges the two without a second field. */
function slugifyAppId(name) {
  const slug = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}
function uniqueAppId(base) {
  const existing = new Set(APPS.map((a) => a.id));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** "+ New App" -- a quick inline create right in the sidebar (type a
 * name, Enter to create), matching the mockup, rather than opening the
 * full App editor just to fill in two fields. The id is slugified from
 * the typed name and uniquified against existing Apps; Escape cancels. */
function wireNewAppInline() {
  const btn = document.getElementById("new-app-btn");
  const wrap = document.getElementById("new-app-input-wrap");
  const input = document.getElementById("new-app-input");

  function open() {
    wrap.hidden = false;
    btn.hidden = true;
    input.value = "";
    input.focus();
  }
  function cancel() {
    wrap.hidden = true;
    btn.hidden = false;
  }

  btn.addEventListener("click", open);
  input.addEventListener("keydown", async (ev) => {
    if (ev.key === "Escape") {
      cancel();
      return;
    }
    if (ev.key !== "Enter") return;
    const name = input.value.trim();
    if (!name) return;
    const id = uniqueAppId(slugifyAppId(name));
    try {
      await api("POST", "/console/api/apps", { id, name, routes: [] });
      cancel();
      await loadAll();
      toast(`Created "${name}". Add its first route below.`);
      openAppEditor(id);
      switchAppTab("routes");
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/** A gateway/auth-provider has no `description` field of its own (unlike
 * an Integration) -- this is the same one-line "what does this actually
 * point at" summary the old sidebar rows used to show, now shown in the
 * catalog table's Description column instead. */
function gatewaySummary(gw) {
  if (gw.kind === "sql") return `${gw.client} · ${Object.keys(gw.connection || {}).join(", ")}`;
  return gw.baseUrl || gw.wsdl || "";
}
function authProviderSummary(provider) {
  return provider.kind === "oauth2" ? provider.tokenUrl || "" : provider.loginUrl || "";
}

const SHARED_CATALOG_META = {
  authProviders: { title: "Auth Providers", addLabel: "Auth Provider", open: (id) => openAuthProviderEditor(id) },
  gateways: { title: "Gateways", addLabel: "Gateway", open: (id) => openGatewayEditor(id) },
  integrations: { title: "Integrations", addLabel: "Integration", open: (id) => openIntegrationEditor(id) },
};

/** Opens the read-only catalog table for one Shared Collection category.
 * `highlightId`, when given, briefly pulses that one row -- used by
 * cross-navigation from an Integration pill/card elsewhere in the app. */
function showSharedCatalog(kind, highlightId) {
  closeInfoPopup();
  CURRENT_VIEW = { type: "shared", key: kind, item: null };
  const meta = SHARED_CATALOG_META[kind];
  document.getElementById("shared-catalog-title").textContent = meta.title;
  const addBtn = document.getElementById("shared-catalog-add-btn");
  addBtn.textContent = `+ Add ${meta.addLabel}`;
  addBtn.onclick = () => meta.open(null);
  renderSharedCatalogTable(kind, highlightId);
  showDetailView("sharedCatalog");
  renderBreadcrumb();
  document.getElementById("detail-panel").scrollTop = 0;
}

/** Builds the actual table for `showSharedCatalog()` -- also called by
 * loadAll()/saves to refresh an already-open catalog table in place. */
function renderSharedCatalogTable(kind, highlightId) {
  const container = document.getElementById("shared-catalog-table");
  const emptyEl = document.getElementById("shared-catalog-empty");
  container.innerHTML = "";
  const meta = SHARED_CATALOG_META[kind];

  let rows; // [{ id, kindChip, authChip, desc }]
  let header;
  if (kind === "authProviders") {
    header = ["Name", "Type", "Description"];
    rows = Object.keys(AUTH_PROVIDERS)
      .sort()
      .map((name) => ({ id: name, kindChip: AUTH_PROVIDERS[name].kind, desc: authProviderSummary(AUTH_PROVIDERS[name]) }));
  } else if (kind === "gateways") {
    header = ["Name", "Type", "Requires Auth", "Description"];
    rows = Object.keys(GATEWAYS)
      .sort()
      .map((name) => ({
        id: name,
        kindChip: GATEWAYS[name].kind,
        authChip: GATEWAYS[name].requiresAuth || null,
        desc: gatewaySummary(GATEWAYS[name]),
      }));
  } else {
    header = ["Name", "Gateway", "Description"];
    rows = [...INTEGRATIONS]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((integration) => ({
        id: integration.id,
        kindChip: integration.backend?.gateway || null,
        desc: integration.description || "",
      }));
  }

  emptyEl.hidden = rows.length > 0;
  emptyEl.textContent = `No ${meta.title.toLowerCase()} yet. Click "+ Add ${meta.addLabel}" to create one.`;

  const headCells = header.map((h, i) =>
    el("span", { class: i === 0 ? "catalog-cell-name" : i === header.length - 1 ? "catalog-cell-desc" : kind === "gateways" && i === 2 ? "catalog-cell-auth" : "catalog-cell-kind" }, [h])
  );
  container.appendChild(el("div", { class: "catalog-head" }, headCells));

  for (const row of rows) {
    const cells = [el("span", { class: "catalog-cell-name" }, [row.id])];
    cells.push(el("span", { class: "catalog-cell-kind" }, [row.kindChip ? el("span", { class: "chip" }, [row.kindChip]) : el("span", { class: "chip none" }, ["none"])]));
    if (kind === "gateways") {
      cells.push(
        el("span", { class: "catalog-cell-auth" }, [
          row.authChip ? el("span", { class: "chip auth" }, [row.authChip]) : el("span", { class: "chip none" }, ["none"]),
        ])
      );
    }
    cells.push(el("span", { class: "catalog-cell-desc" }, [row.desc || ""]));
    container.appendChild(
      el("div", { id: `catalog-row-${kind}-${row.id}`, class: "catalog-row", onclick: () => meta.open(row.id) }, cells)
    );
  }

  if (highlightId) {
    const target = document.getElementById(`catalog-row-${kind}-${highlightId}`);
    if (target) {
      target.classList.remove("highlight");
      void target.offsetWidth; // re-trigger the animation even if it just ran
      target.classList.add("highlight");
      target.scrollIntoView({ block: "center" });
    }
  }
}

/** Opens an Integration from anywhere else in the app (a Route's
 * Integration pill, or the "View in Shared Collection" link on a route
 * picker card) by landing on the Integrations catalog table with that
 * row pulsing -- not by opening its editor directly, since the catalog
 * table is now the Shared Collection's own home view. */
function openIntegrationFromPill(integrationId) {
  showSharedCatalog("integrations", integrationId);
}

/* ---------------------------------------------------------------------
 * Active sessions (sidebar + read-only detail) -- what's actually held in
 * the server's in-memory session store right now (see
 * AuthService.listSessions()): every logged-in caller across every
 * provider, for whoever runs this instance to see without a debugger.
 * Never shows a session's real bearer token or the backend/refresh token
 * it wraps -- the console API itself never sends those out either.
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
  CURRENT_VIEW = { type: "session", key: id };

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
  renderBreadcrumb();
  document.getElementById("detail-panel").scrollTop = 0;
}

async function revokeSession(id) {
  const session = SESSIONS.find((s) => s.id === id);
  const label = session ? `${session.providerName} / ${session.subject || "(no subject)"}` : "this session";
  if (!confirm(`Revoke ${label}? That caller's current session token will stop working immediately.`)) return;
  try {
    await api("DELETE", `/console/api/sessions/${encodeURIComponent(id)}`);
    toast("Session revoked");
    closeDetail();
    await refreshSessions();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteIntegration(id) {
  if (!confirm(`Delete integration "${id}"? This removes its config file too.`)) return;
  try {
    await api("DELETE", `/console/api/integrations/${encodeURIComponent(id)}`);
    toast(`Deleted integration "${id}"`);
    await loadAll();
    backToSharedCatalog("integrations");
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteApp(id) {
  if (!confirm(`Delete app "${id}"? This removes its config file (and every Route in it) too. If deployment.yaml's \`mounts\` still names it, that's left for you to fix by hand.`)) return;
  try {
    await api("DELETE", `/console/api/apps/${encodeURIComponent(id)}`);
    toast(`Deleted app "${id}"`);
    closeDetail();
    await loadAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteGateway(name) {
  if (!confirm(`Delete gateway "${name}"?`)) return;
  try {
    await api("DELETE", `/console/api/gateways/${encodeURIComponent(name)}`);
    toast(`Deleted gateway "${name}"`);
    await loadAll();
    backToSharedCatalog("gateways");
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteAuthProvider(name) {
  if (!confirm(`Delete auth provider "${name}"?`)) return;
  try {
    await api("DELETE", `/console/api/auth-providers/${encodeURIComponent(name)}`);
    toast(`Deleted auth provider "${name}"`);
    await loadAll();
    backToSharedCatalog("authProviders");
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

  // opts.maskable: whether this field is masked is an explicit per-entry
  // setting rather than inferred from a key's own name -- used for a
  // gateway's commonParams (see commonParamsMasked in schema.ts/config.ts
  // and secretRedaction.ts's redactSelected). A commonParams entry named
  // "apiKey" is NOT auto-masked under this mode. The single eye toggle
  // IS that setting here: whatever it's showing (hidden/shown) when the
  // form is saved is what gets persisted as masked or not -- there's no
  // separate on/off control.
  // opts.maskedKeys: which entries start out hidden, when maskable.
  const maskable = !!opts.maskable;
  const initiallyMaskedKeys = new Set(opts.maskedKeys || []);

  function isInitiallyMasked(key) {
    return maskable ? initiallyMaskedKeys.has(key) : SENSITIVE_KEY.test(key || "");
  }

  function addRow(k, v) {
    const isRedacted = v === REDACTED;
    const keyInput = el("input", { placeholder: "key", value: k || "" });
    const valueInput = el("input", {
      placeholder: isRedacted ? "(unchanged — leave blank to keep)" : "value",
      type: isInitiallyMasked(k) ? "password" : "text",
      value: isRedacted ? "" : v == null ? "" : String(v),
    });

    // The one control for hiding/showing a value, anchored to the field
    // itself (right edge, like a typical password-reveal input) rather
    // than living as a separate checkbox alongside it.
    const revealBtn = el(
      "button",
      {
        type: "button",
        class: "icon-btn field-reveal-btn",
        title: "Show/hide value",
        "aria-label": "Show/hide value",
        onclick: () => {
          valueInput.type = valueInput.type === "password" ? "text" : "password";
        },
      },
      ["👁"]
    );
    if (!maskable) {
      keyInput.addEventListener("input", () => {
        valueInput.type = SENSITIVE_KEY.test(keyInput.value) ? "password" : "text";
      });
    }

    const valueWrap = el("div", { class: "field-with-reveal" }, [valueInput, revealBtn]);
    const removeBtn = el("button", { type: "button", class: "btn-secondary btn-sm", onclick: () => row.remove() }, ["✕"]);
    const row = el("div", { class: "repeatable-row" }, [
      el("label", {}, [opts.keyLabel || "Key", keyInput]),
      el("label", {}, [opts.valueLabel || "Value", valueWrap]),
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

/** Like readKeyValueEditor(), but also returns which rows are currently
 * showing their value hidden (password-style) -- only meaningful for an
 * editor rendered with opts.maskable (see renderKeyValueEditor), where
 * the eye toggle's current state IS the masked setting being saved. */
function readKeyValueEditorMaskable(container) {
  const values = {};
  const maskedKeys = [];
  for (const row of container.children) {
    const k = row._keyInput.value.trim();
    if (!k) continue;
    values[k] = row._valueInput.value;
    if (row._valueInput.type === "password") maskedKeys.push(k);
  }
  return { values, maskedKeys };
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
 * Integration editor
 * ------------------------------------------------------------------- */
function populateSelect(select, values, { includeBlank, blankLabel } = {}) {
  select.innerHTML = "";
  if (includeBlank) select.appendChild(el("option", { value: "" }, [blankLabel || "(none)"]));
  for (const v of values) select.appendChild(el("option", { value: v }, [v]));
}

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
  const form = document.getElementById("integration-form");
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

const CUSTOM_FUNCTION_OPTION = "__function__";
const NEW_FUNCTION_OPTION = "__new__";

/**
 * Shared "custom function" sub-editor, used both by a value field's
 * Transform select (when set to "Custom function...") and by the
 * integration-level Post-process section below -- both store/read the
 * exact same { kind: "function", name } shape (see FunctionTransformRef/
 * OutputConfig.postProcess in src/types/config.ts), so one control
 * suffices for both. Renders a <select> of every function already saved
 * on this server (re-fetched fresh each time one of these is built, so a
 * function saved a moment ago in a different row shows up here too) plus
 * "+ New function...", and an inline editor (code + a hand-typed sample
 * value + Test/Save) for creating a new one or editing whichever is
 * currently selected. See TRANSFORM_FUNCTIONS_DESIGN_NOTES.md.
 */
function buildFunctionPicker(initialName) {
  const nameSelect = el("select", {}, []);
  const editBtn = el("button", { type: "button", class: "btn-secondary btn-sm" }, ["✎ Edit"]);
  const panel = el("div", { class: "function-editor-panel" }, []);
  panel.hidden = true;
  const wrapper = el("div", { class: "function-picker" }, [
    el("div", { class: "function-picker-row" }, [nameSelect, editBtn]),
    panel,
  ]);

  function updateEditBtn() {
    editBtn.hidden = !nameSelect.value || nameSelect.value === NEW_FUNCTION_OPTION;
  }

  async function loadNames(selectValue) {
    let names = [];
    try {
      names = (await api("GET", "/console/api/functions")).names;
    } catch {
      // Non-fatal -- the picker still works for whatever's already selected.
    }
    const want = selectValue !== undefined ? selectValue : nameSelect.value;
    nameSelect.innerHTML = "";
    nameSelect.appendChild(el("option", { value: "" }, ["(choose a function)"]));
    for (const n of names) nameSelect.appendChild(el("option", { value: n }, [n]));
    nameSelect.appendChild(el("option", { value: NEW_FUNCTION_OPTION }, ["+ New function…"]));
    if (want && [...nameSelect.options].some((o) => o.value === want)) nameSelect.value = want;
    updateEditBtn();
  }
  loadNames(initialName);

  function openPanel(name, code) {
    panel.innerHTML = "";
    panel.hidden = false;
    const isNew = !name;
    const nameInput = el("input", { placeholder: "e.g. normalizePrice", value: name || "" });
    nameInput.disabled = !isNew;
    const codeArea = el(
      "textarea",
      { rows: 10 },
      []
    );
    codeArea.value =
      code ||
      'function transform(data, ctx) {\n  // data: this field\'s value, or (for a post-process\n  // function) the whole mapped output.\n  // ctx: { item, raw, params }\n  return data;\n}\n';
    const sampleArea = el("textarea", { rows: 3 }, []);
    sampleArea.value = "null";
    const resultBox = el("pre", { class: "code-block" }, ["—"]);
    const errorBox = el("p", { class: "error-text" }, []);
    const testBtn = el("button", { type: "button", class: "btn-secondary btn-sm" }, ["Test"]);
    const saveBtn = el("button", { type: "button", class: "btn-primary btn-sm" }, ["Save"]);
    const cancelBtn = el("button", { type: "button", class: "btn-secondary btn-sm" }, ["Cancel"]);

    testBtn.onclick = async () => {
      resultBox.textContent = "Running…";
      try {
        const value = looseParse(sampleArea.value);
        const res = await api("POST", "/console/api/functions/test", { code: codeArea.value, value, ctx: {} });
        resultBox.textContent = JSON.stringify(res, null, 2);
      } catch (err) {
        resultBox.textContent = "Error: " + err.message;
      }
    };

    saveBtn.onclick = async () => {
      const finalName = isNew ? nameInput.value.trim() : name;
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(finalName)) {
        errorBox.textContent = 'Function name must start with a letter, then only letters, digits, "_" or "-".';
        return;
      }
      errorBox.textContent = "";
      try {
        await api("PUT", `/console/api/functions/${encodeURIComponent(finalName)}`, { code: codeArea.value });
        await loadNames(finalName);
        panel.hidden = true;
      } catch (err) {
        errorBox.textContent = err.message;
      }
    };

    cancelBtn.onclick = () => {
      panel.hidden = true;
      if (isNew) loadNames("");
    };

    panel.append(
      el("label", {}, ["Function name", nameInput]),
      el("label", {}, ["Code", codeArea]),
      el("label", {}, ["Sample value to test with (JSON)", sampleArea]),
      el("div", { class: "function-editor-actions" }, [testBtn, saveBtn, cancelBtn]),
      el("p", { class: "muted" }, ["Result:"]),
      resultBox,
      errorBox
    );
  }

  nameSelect.addEventListener("change", async () => {
    if (nameSelect.value === NEW_FUNCTION_OPTION) {
      openPanel(null, null);
      return;
    }
    panel.hidden = true;
    updateEditBtn();
  });

  editBtn.onclick = async () => {
    const name = nameSelect.value;
    if (!name) return;
    try {
      const { code } = await api("GET", `/console/api/functions/${encodeURIComponent(name)}`);
      openPanel(name, code);
    } catch (err) {
      alert("Could not load function: " + err.message);
    }
  };

  // Re-fetches the dropdown's options from the server without disturbing
  // whatever's currently selected -- used after a top-level "Reload" (see
  // the reload-btn handler below), since that reloads the server-side
  // FunctionRegistry but has no other way to reach a picker that was
  // already mounted (and fetched its options) before the reload ran.
  wrapper._refresh = () => loadNames();

  return {
    wrapper,
    getName: () => (nameSelect.value && nameSelect.value !== NEW_FUNCTION_OPTION ? nameSelect.value : ""),
    refreshNames: () => loadNames(),
  };
}

/**
 * An output field row is either a value extraction (the original shape --
 * Target/Source/Transform/Default) or, when `field.kind === "array"`, a
 * nested collection: Target/Root plus its own nested, recursively-rendered
 * fields list (which can itself contain more array rows, to any depth).
 * See OutputArrayFieldDef's doc comment in src/types/config.ts.
 *
 * `transform` can be one of the built-in enum values OR a custom function
 * reference ({ kind: "function", name } -- see FunctionTransformRef in
 * src/types/config.ts); picking "Custom function..." in the Transform
 * select reveals buildFunctionPicker()'s inline editor in place of (not
 * in addition to) the plain enum choice.
 */
function outputFieldRow(field) {
  field = field || { target: "", source: "", default: "", transform: "" };

  if (field.kind === "array") return outputArrayFieldRow(field);

  const isFunctionTransform = !!(field.transform && typeof field.transform === "object" && field.transform.kind === "function");

  const targetInput = el("input", { placeholder: "e.g. name.first", value: field.target });
  const sourceInput = el("input", { placeholder: "e.g. $.firstName", value: field.source || "" });
  const transformSelect = el("select", {}, []);
  populateSelect(transformSelect, META.transforms, { includeBlank: true });
  transformSelect.appendChild(el("option", { value: CUSTOM_FUNCTION_OPTION }, ["Custom function…"]));
  transformSelect.value = isFunctionTransform ? CUSTOM_FUNCTION_OPTION : field.transform || "";
  const defaultInput = el("input", { placeholder: "default (optional)", value: field.default ?? "" });

  const functionPicker = buildFunctionPicker(isFunctionTransform ? field.transform.name : "");
  functionPicker.wrapper.hidden = !isFunctionTransform;
  transformSelect.addEventListener("change", () => {
    functionPicker.wrapper.hidden = transformSelect.value !== CUSTOM_FUNCTION_OPTION;
  });

  const removeBtn = el(
    "button",
    {
      type: "button",
      class: "btn-secondary btn-sm remove-btn",
      onclick: () => {
        row.remove();
        refreshSectionCounts();
      },
    },
    ["✕"]
  );

  const row = el("div", { class: "repeatable-row" }, [
    el("label", {}, [fieldTitle("Target ", infoIcon("outputTarget")), targetInput]),
    el("label", {}, [fieldTitle("Source ", infoIcon("outputSource"), " (JSONPath)"), sourceInput]),
    el("label", {}, [fieldTitle("Transform ", infoIcon("outputTransform")), transformSelect]),
    el("label", {}, [fieldTitle("Default ", infoIcon("outputDefault")), defaultInput]),
    removeBtn,
    functionPicker.wrapper,
  ]);
  row._read = () => ({
    target: targetInput.value.trim(),
    source: sourceInput.value.trim(),
    ...(transformSelect.value === CUSTOM_FUNCTION_OPTION
      ? functionPicker.getName()
        ? { transform: { kind: "function", name: functionPicker.getName() } }
        : {}
      : transformSelect.value
        ? { transform: transformSelect.value }
        : {}),
    ...(defaultInput.value !== "" ? { default: looseParse(defaultInput.value) } : {}),
  });
  return row;
}

/** A nested-array output field row -- see outputFieldRow()'s own doc
 * comment. Rendered with its own nested repeatable-list of child rows
 * (value rows and/or further array rows), with "+ Add field"/"+ Add array"
 * controls scoped to that nested list for filling it in by hand. */
function outputArrayFieldRow(field) {
  const targetInput = el("input", { placeholder: "e.g. orders", value: field.target || "" });
  const rootInput = el("input", { placeholder: "e.g. $.orders[*]", value: field.root || "" });

  const nestedList = el("div", { class: "repeatable-list nested-fields-list" }, []);
  for (const f of field.fields || []) nestedList.appendChild(outputFieldRow(f));

  const addFieldBtn = el(
    "button",
    {
      type: "button",
      class: "btn-secondary btn-sm",
      onclick: () => {
        nestedList.appendChild(outputFieldRow());
        refreshSectionCounts();
      },
    },
    ["+ Add field"]
  );
  const addArrayBtn = el(
    "button",
    {
      type: "button",
      class: "btn-secondary btn-sm",
      onclick: () => {
        nestedList.appendChild(outputFieldRow({ kind: "array", target: "", root: "", fields: [] }));
        refreshSectionCounts();
      },
    },
    ["+ Add array"]
  );
  const removeBtn = el(
    "button",
    {
      type: "button",
      class: "btn-secondary btn-sm remove-btn",
      onclick: () => {
        row.remove();
        refreshSectionCounts();
      },
    },
    ["✕ Remove array"]
  );

  const row = el("div", { class: "repeatable-row array-field-row" }, [
    el("div", { class: "array-field-header" }, [
      el("label", {}, [fieldTitle("Target ", infoIcon("outputTarget")), targetInput]),
      el("label", {}, [fieldTitle("Root ", infoIcon("outputArrayRoot"), " (JSONPath, relative to the parent item)"), rootInput]),
      el("div", { class: "array-field-header-actions" }, [removeBtn]),
    ]),
    nestedList,
    el("div", { class: "array-field-footer" }, [addFieldBtn, addArrayBtn]),
  ]);
  // Lets addToOutputFromTree() (see below) find this array's current Root
  // and its nested-fields container without re-deriving either -- used to
  // target a tree-picker "+" click at the right array scope instead of
  // always the top level, at any nesting depth.
  row._arrayMeta = { rootInput, nestedList };
  row._read = () => ({
    kind: "array",
    target: targetInput.value.trim(),
    root: rootInput.value.trim(),
    fields: [...nestedList.children].map((r) => r._read()).filter(isValidOutputFieldRead),
  });

  return row;
}

/** A row read back as invalid (no target, or a value row with no source /
 * an array row with no root) is dropped rather than saved/tested -- same
 * "incomplete row is silently ignored, not an error" behavior the flat
 * `.filter((f) => f.target && f.source)` had before array fields existed,
 * just kind-aware now that `source` isn't the only field shape. */
function isValidOutputFieldRead(f) {
  if (!f || !f.target) return false;
  return f.kind === "array" ? !!f.root : !!f.source;
}

function jsonPathSegmentFor(key, isArrayIndex) {
  if (isArrayIndex) return `[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(key)) ? `.${key}` : `['${String(key).replace(/'/g, "\\'")}']`;
}

function jsonTreeAddButton(path, kind, keyLabel) {
  return el(
    "button",
    {
      type: "button",
      class: "json-tree-add-btn",
      title: "Add to Output",
      "aria-label": "Add to Output",
      onclick: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        addToOutputFromTree(path, kind, keyLabel);
      },
    },
    ["+"]
  );
}

/** Right-click is the primary "Add to Output" gesture (the task this UI
 * exists for); the "+" button next to every node is the same action for
 * trackpad/discoverability, since a context menu is easy to miss. */
function wireJsonTreeNodeActions(rowEl, path, kind, keyLabel) {
  rowEl.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    addToOutputFromTree(path, kind, keyLabel);
  });
}

/** Recursively renders one node of the fetched (and, once armed past the
 * top level, re-scoped) sample response as a collapsible tree. Only
 * leaves and arrays get an "Add to Output" affordance -- a plain object
 * node isn't independently addable (nest it via a dotted Target instead,
 * same as the manual-entry form already supports). */
function renderJsonTreeNode(value, pathSegments, keyLabel, depth) {
  const path = "$" + pathSegments.join("");
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === "object" && !isArray;

  if (!isArray && !isObject) {
    const valueText = value === undefined ? "undefined" : JSON.stringify(value);
    const row = el("div", { class: "json-tree-row json-tree-leaf", "data-path": path }, [
      el("span", { class: "json-tree-key" }, [keyLabel]),
      el("span", { class: "json-tree-value" }, [valueText]),
      jsonTreeAddButton(path, "value", keyLabel),
    ]);
    wireJsonTreeNodeActions(row, path, "value", keyLabel);
    return row;
  }

  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
  const summaryText = isArray ? `Array(${entries.length})` : `Object{${entries.length}}`;
  const summaryRow = el("summary", { class: "json-tree-row" }, [
    el("span", { class: "json-tree-key" }, [keyLabel]),
    el("span", { class: "json-tree-summary" }, [summaryText]),
    isArray ? jsonTreeAddButton(path, "array", keyLabel) : null,
  ]);
  if (isArray) wireJsonTreeNodeActions(summaryRow, path, "array", keyLabel);

  const childrenWrap = el("div", { class: "json-tree-children" }, []);
  for (const [k, v] of entries) {
    childrenWrap.appendChild(renderJsonTreeNode(v, [...pathSegments, jsonPathSegmentFor(k, isArray)], String(k), depth + 1));
  }

  const details = el("details", { class: "json-tree-node" }, [summaryRow, childrenWrap]);
  if (depth < 1) details.open = true;
  return details;
}

/** Turns a raw key/label into a safe default Target: dots/brackets in a
 * backend field name would otherwise be read back as nested-path
 * separators by setDeep() (see mapper.ts), silently producing the wrong
 * output shape. */
function sanitizeTargetName(name) {
  const s = String(name ?? "").trim().replace(/[.[\]]/g, "_");
  return s || "field";
}

function uniqueTargetName(base, existingTargets) {
  if (!existingTargets.has(base)) return base;
  let n = 2;
  while (existingTargets.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Turns a Root pattern (as typed in an array field's Root input, e.g.
 * "$.orders[*]") into a RegExp source matching any CONCRETE sample path
 * it could be instantiated to -- "[*]" (a wildcard index) becomes
 * "\[\d+\]" (the Test tab's tree always shows one concrete, indexed
 * sample item, e.g. "$.orders[0]", never the wildcard itself), and
 * everything else is escaped as a literal. */
function jsonPathPatternToRegexSource(pattern) {
  return pattern
    .split(/(\[\*\])/)
    .map((part) => (part === "[*]" ? "\\[\\d+\\]" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
}

/** Walks every array field currently defined in the Output tab (at any
 * nesting depth, since an array can contain another array) and finds the
 * deepest one whose Root the given CONCRETE sample path (from the Test
 * tab's tree) falls inside. `prefixPattern` is the regex source already
 * matched by an enclosing array, if any -- a nested array's own Root is
 * written relative to its parent item (same rule as everywhere else in
 * this output-mapping engine -- see OutputArrayFieldDef's doc comment in
 * src/types/config.ts), so its absolute pattern is the parent's matched
 * prefix plus its own Root with the leading "$" (which stands for "this
 * point") stripped.
 *
 * Returns `{ listEl, relativePath }` -- `listEl` is that array's own
 * nested-fields container to add into, and `relativePath` is `path`
 * rewritten to be relative to one item of that array, the same way a
 * nested array field's own source/root already has to be written -- or
 * `null` if `path` isn't inside any array defined yet, which keeps the
 * original top-level-only behavior for anything outside one (including
 * the very first "+" click on an array node, before it exists as a row
 * here at all). */
function findEnclosingArrayScope(path, containerEl = document.getElementById("output-fields-list"), prefixPattern = "\\$") {
  for (const row of containerEl.children) {
    const meta = row._arrayMeta;
    if (!meta) continue;
    const rootValue = meta.rootInput.value.trim();
    if (!rootValue) continue;
    const pattern = prefixPattern + jsonPathPatternToRegexSource(rootValue.replace(/^\$/, ""));
    const m = path.match(new RegExp("^" + pattern));
    if (!m) continue;
    const candidate = { listEl: meta.nestedList, relativePath: "$" + path.slice(m[0].length) };
    return findEnclosingArrayScope(path, meta.nestedList, pattern) || candidate;
  }
  return null;
}

/** The actual "Add to Output" action, fired by a tree node's right-click
 * or its "+" button. If the clicked node falls inside an array that's
 * already been added (at any depth), the new field is added INTO that
 * array's own fields, with its source/root rewritten relative to that
 * array's item -- otherwise it's added at the top level, same as before
 * (which is always true for the very first "+" on an array node itself,
 * since the array doesn't exist as a scope to be "inside" until this
 * call creates it). A leaf becomes a value field, an array becomes a new
 * (initially empty) nested array field whose own fields are then filled
 * in the same way -- by clicking "+" on ITS children in the tree, now
 * landing in the right place instead of back at the top. */
function addToOutputFromTree(path, kind, keyLabel) {
  const scope = findEnclosingArrayScope(path);
  const listEl = scope ? scope.listEl : document.getElementById("output-fields-list");
  const effectivePath = scope ? scope.relativePath : path;
  const existingTargets = new Set([...listEl.children].map((r) => r._read().target));
  const target = uniqueTargetName(sanitizeTargetName(keyLabel), existingTargets);

  if (kind === "array") {
    const root = /(\[\*\]|\[\d+\])$/.test(effectivePath) ? effectivePath : `${effectivePath}[*]`;
    const row = outputFieldRow({ kind: "array", target, root, fields: [] });
    listEl.appendChild(row);
    refreshSectionCounts();
    toast(`Added array field "${target}" -- fill in its fields below.`);
  } else {
    const row = outputFieldRow({ target, source: effectivePath });
    listEl.appendChild(row);
    refreshSectionCounts();
    toast(scope ? `Added "${target}" inside the array above, from ${effectivePath}` : `Added "${target}" from ${path}`);
  }
  applyMappingToSample();
}

/** Re-renders the Test tab's sample tree from the raw sample response,
 * unscoped -- there's no separate top-level root to pre-scope it anymore
 * (see mapper.ts's mapResponse()): output.fields are always relative to
 * this same real response, exactly what this tree shows. A field that
 * needs a narrower scope (an array field's own Root) is filled in by hand
 * below, using this tree purely to find the right JSONPath to type. */
async function refreshJsonTree() {
  const treeEl = document.getElementById("test-raw-tree");
  const hintEl = document.getElementById("json-tree-hint");
  if (!treeEl || !hintEl) return;

  if (!HAS_RAW_SAMPLE) {
    treeEl.innerHTML = "";
    hintEl.hidden = false;
    hintEl.textContent = "Fetch a sample response above to enable picking fields below.";
    return;
  }

  hintEl.hidden = true;
  hintEl.textContent = "";
  treeEl.innerHTML = "";
  treeEl.appendChild(renderJsonTreeNode(LAST_RAW_SAMPLE, [], "(root)", 0));
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
 * Integration editor tabs (Basic / Backend / Parameters / Output / Test).
 * Only one tab's panel is shown at a time -- switching just toggles
 * [hidden] and the active tab button's styling, no re-rendering.
 * ------------------------------------------------------------------- */
function switchIntegrationTab(tab) {
  for (const btn of document.querySelectorAll("#integration-form .editor-tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  for (const panel of document.querySelectorAll("#integration-form .editor-tab-panel")) {
    panel.hidden = panel.dataset.tabPanel !== tab;
  }
  closeInfoPopup();
}

function initIntegrationTabs() {
  for (const btn of document.querySelectorAll("#integration-form .editor-tab-btn")) {
    btn.addEventListener("click", () => switchIntegrationTab(btn.dataset.tab));
  }
  // A required field can be on a tab that isn't showing when Save is
  // clicked -- the browser's own validation only "sees" visible fields, so
  // jump to whichever tab holds the first invalid one before it reports it.
  document.getElementById("integration-form").addEventListener(
    "invalid",
    (ev) => {
      const panel = ev.target.closest(".editor-tab-panel");
      if (panel) switchIntegrationTab(panel.dataset.tabPanel);
    },
    true
  );
}

function refreshSectionCounts() {
  const form = document.getElementById("integration-form");
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
    // An integration created by "Generate CRUD + procedure endpoints"
    // (gateway editor) -- its backend is table/operation/procedure fields,
    // not a raw query, and isn't meant to be hand-edited here. Show a
    // read-only summary and preserve the backend exactly as-is on save,
    // rather than falling through to the raw-query editor below and
    // silently discarding it.
    const summary = backend.table
      ? `Auto-generated table integration — table "${backend.table}", operation "${backend.operation}"` +
        (backend.primaryKey?.length ? `, primary key [${backend.primaryKey.join(", ")}]` : ", no primary key")
      : `Auto-generated stored-procedure integration — calls "${backend.procedure}"` +
        (backend.procedureParams?.length ? ` with params: ${backend.procedureParams.join(", ")}` : " (no params)");
    container.appendChild(
      el("p", { class: "muted" }, [
        summary +
          ". Created by \"Generate CRUD + procedure endpoints\" on the gateway — not editable as raw SQL here. " +
          "Delete this integration and generate again if the table/procedure shape changed.",
      ])
    );
    container._read = () => backend;
  } else if (type === "sql") {
    const queryInput = el("textarea", { required: true, placeholder: "SELECT * FROM customers WHERE id = :id" }, [backend.query || ""]);
    container.appendChild(el("label", { class: "block" }, [fieldTitle("SQL ", infoIcon("sqlQuery"), " (named :param bindings)"), queryInput]));
    container._read = () => ({ type: "sql", query: queryInput.value.trim() });
  }
}

function openIntegrationEditor(integrationId) {
  closeInfoPopup();
  EDITING_INTEGRATION_ID = integrationId || null;
  CURRENT_VIEW = { type: "shared", key: "integrations", item: integrationId || null };
  const integration = integrationId ? INTEGRATIONS.find((r) => r.id === integrationId) : null;

  document.getElementById("integration-editor-title").textContent = integration ? `Edit integration: ${integration.id}` : "New integration";
  const deleteBtn = document.getElementById("integration-delete-btn");
  deleteBtn.hidden = !integration;
  deleteBtn.onclick = () => deleteIntegration(EDITING_INTEGRATION_ID);
  showError("integration-form-error", "");
  document.getElementById("test-raw-output").textContent = "—";
  document.getElementById("test-mapped-output").textContent = "—";
  document.getElementById("test-raw-query").value = "";
  document.getElementById("test-raw-body").value = "";
  document.getElementById("apply-mapping-btn").disabled = true;
  HAS_RAW_SAMPLE = false;
  refreshJsonTree();

  const form = document.getElementById("integration-form");
  form.id.value = integration?.id || "";
  form.id.disabled = false; // renaming is allowed; the registry moves the file
  form.description.value = integration?.description || "";

  populateSelect(form.backendGateway, Object.keys(GATEWAYS), { includeBlank: true, blankLabel: "(none) -- call a URL directly" });
  form.backendGateway.value = integration?.backend?.gateway || "";

  populateSelect(form.backendType, META.backendTypes);
  form.backendType.value = integration?.backend?.type || "json";
  renderBackendFields(form.backendType.value, integration?.backend);
  form.backendType.onchange = () => {
    renderBackendFields(form.backendType.value, {});
    refreshSectionCounts();
  };
  applyGatewayInferredType(); // locks Type to the gateway's kind when one's already selected, above

  const inputList = document.getElementById("input-params-list");
  inputList.innerHTML = "";
  for (const p of integration?.input || []) inputList.appendChild(inputParamRow(p));

  const outputList = document.getElementById("output-fields-list");
  outputList.innerHTML = "";
  for (const f of integration?.output?.fields || []) outputList.appendChild(outputFieldRow(f));

  const postProcessContainer = document.getElementById("output-postprocess-container");
  postProcessContainer.innerHTML = "";
  const postProcessPicker = buildFunctionPicker(integration?.output?.postProcess?.name || "");
  postProcessContainer._picker = postProcessPicker;
  postProcessContainer.appendChild(postProcessPicker.wrapper);

  // Which Routes (across every App) point at this Integration -- surfaced
  // read-only here since deleting or renaming it affects every one of them.
  const usedByEl = document.getElementById("integration-used-by");
  if (integration) {
    const usages = APPS.flatMap((a) =>
      (a.routes || []).filter((r) => r.integration === integration.id).map((r) => `${a.id}: ${r.method} ${r.path}`)
    );
    usedByEl.textContent = usages.length
      ? `Used by ${usages.length} route${usages.length === 1 ? "" : "s"}: ${usages.join(", ")}`
      : "Not used by any route yet.";
  } else {
    usedByEl.textContent = "";
  }

  switchIntegrationTab("basic"); // always open on the same tab, regardless of what was showing last time

  syncTestParams(); // also calls refreshSectionCounts()

  // Generated table-CRUD integrations (list/bulkCreate/bulkUpdate/bulkDelete)
  // read straight from the raw query string / JSON body rather than
  // declared `input` params -- the Try it panel has no fields for the
  // latter by default, so swap in a raw query-params or request-body
  // textarea (whichever this operation actually reads) instead of leaving
  // it looking broken. A generated stored-procedure integration isn't
  // affected: its params ARE declared `input` (in: "body"), so it works
  // fine with the normal per-parameter fields above.
  const isBulkTableEndpoint = Boolean(integration?.backend?.type === "sql" && integration?.backend?.table);
  document.getElementById("tryit-bulk-note").hidden = !isBulkTableEndpoint;
  const rawQueryRow = document.getElementById("test-raw-query-row");
  const rawBodyRow = document.getElementById("test-raw-body-row");
  if (isBulkTableEndpoint) {
    const op = integration.backend.operation;
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

  showDetailView("integration");
  renderBreadcrumb();
  document.getElementById("detail-panel").scrollTop = 0;
}

function readIntegrationForm() {
  const form = document.getElementById("integration-form");
  const input = [...document.getElementById("input-params-list").children].map((r) => r._read()).filter((p) => p.name);
  const fields = [...document.getElementById("output-fields-list").children].map((r) => r._read()).filter(isValidOutputFieldRead);

  const backend = document.getElementById("backend-fields")._read();
  const gw = form.backendGateway.value;
  if (gw) backend.gateway = gw;

  const output = { fields };
  const postProcessName = document.getElementById("output-postprocess-container")._picker?.getName();
  if (postProcessName) output.postProcess = { name: postProcessName };

  return {
    id: form.id.value.trim(),
    description: form.description.value.trim() || undefined,
    input,
    backend,
    output,
  };
}

async function saveIntegration(ev) {
  ev.preventDefault();
  showError("integration-form-error", "");
  let integration;
  try {
    integration = readIntegrationForm();
  } catch (err) {
    showError("integration-form-error", "Couldn't read the form: " + err.message);
    return;
  }
  try {
    if (EDITING_INTEGRATION_ID) {
      await api("PUT", `/console/api/integrations/${encodeURIComponent(EDITING_INTEGRATION_ID)}`, integration);
    } else {
      await api("POST", "/console/api/integrations", integration);
    }
    toast(`Saved integration "${integration.id}" — it's live now.`);
    await loadAll();
    openIntegrationEditor(integration.id); // stay in the panel, now showing it as a saved integration
  } catch (err) {
    showError("integration-form-error", err.message);
  }
}

async function fetchSample() {
  showError("integration-form-error", "");
  try {
    const backend = document.getElementById("backend-fields")._read();
    const form = document.getElementById("integration-form");
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

    const { raw } = await api("POST", "/console/api/test-backend", { input, backend, params, rawQuery, rawBody });
    LAST_RAW_SAMPLE = raw;
    HAS_RAW_SAMPLE = true;
    document.getElementById("test-raw-output").textContent = JSON.stringify(raw, null, 2);
    document.getElementById("apply-mapping-btn").disabled = false;
    await refreshJsonTree();
    await applyMappingToSample();
  } catch (err) {
    document.getElementById("test-raw-output").textContent = "Error: " + err.message;
    showError("integration-form-error", err.message);
  }
}

async function applyMappingToSample() {
  if (!HAS_RAW_SAMPLE) return;
  try {
    const fields = [...document.getElementById("output-fields-list").children].map((r) => r._read()).filter(isValidOutputFieldRead);
    const output = { fields };
    const postProcessName = document.getElementById("output-postprocess-container")._picker?.getName();
    if (postProcessName) output.postProcess = { name: postProcessName };
    const { mapped } = await api("POST", "/console/api/test-mapping", { raw: LAST_RAW_SAMPLE, output });
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
      const appSelect = el("select", { id: "gateway-crud-app-select" }, []);
      populateSelect(appSelect, APPS.map((a) => a.id));
      if (APPS.length > 0) appSelect.value = APPS[0].id;
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
            "Creates one Integration + Route (list / bulk-create / bulk-update / bulk-delete) for every table " +
              "(a table with no primary key only gets list/create), plus one Integration + Route per stored " +
              "procedure where this database supports them. Never overwrites an existing Integration or Route -- " +
              "a conflicting id is skipped and reported, so this is safe to run again later " +
              "(e.g. after adding a table). Uses the currently SAVED version of this gateway, so " +
              "save any pending edits above first.",
          ]),
          APPS.length > 0
            ? el("label", { class: "block" }, [fieldTitle("Add routes to App "), appSelect])
            : el("p", { class: "error-text" }, ["Create an App first — the generated routes need somewhere to live."]),
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
  const appSelect = document.getElementById("gateway-crud-app-select");
  const appId = appSelect ? appSelect.value : "";
  if (!appId) {
    resultEl.hidden = false;
    resultEl.className = "test-result test-result-error";
    resultEl.textContent = "✕ Create an App first — the generated routes need somewhere to live.";
    return;
  }
  resultEl.hidden = false;
  resultEl.className = "test-result";
  resultEl.textContent = "Introspecting and generating…";
  try {
    const summary = await api(
      "POST",
      `/console/api/gateways/${encodeURIComponent(EDITING_GATEWAY_NAME)}/generate-crud`,
      { appId }
    );
    const lines = [
      `${summary.tablesFound} table(s) found -- ${summary.created.length} integration(s)+route(s) created in app "${summary.app}", ${summary.skipped.length} skipped.`,
      summary.proceduresSupported
        ? `${summary.proceduresFound} stored procedure(s) found.`
        : "This database client doesn't support stored procedures.",
    ];
    if (summary.created.length > 0) {
      lines.push("Created: " + summary.created.map((r) => `${r.method} ${r.path} (${r.id})`).join(", "));
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
      toast(`Generated ${summary.created.length} integration(s)+route(s) for "${EDITING_GATEWAY_NAME}" in app "${summary.app}".`);
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
    const result = await api("POST", "/console/api/gateways/test-connection", body);
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
 * (the console API doesn't return one) -- just enough to confirm the config
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
    const result = await api("POST", "/console/api/auth-providers/test-login", body);
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
  CURRENT_VIEW = { type: "shared", key: "gateways", item: name || null };
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
  renderKeyValueEditor(commonParamsList, gw?.commonParams, { maskable: true, maskedKeys: gw?.commonParamsMasked || [] });

  showDetailView("gateway");
  renderBreadcrumb();
  document.getElementById("detail-panel").scrollTop = 0;
}

async function saveGateway(ev) {
  ev.preventDefault();
  showError("gateway-form-error", "");
  const form = document.getElementById("gateway-form");
  const name = form.name.value.trim();
  try {
    const config = document.getElementById("gateway-fields")._read();
    const { values: commonParams, maskedKeys: commonParamsMasked } = readKeyValueEditorMaskable(
      document.getElementById("gateway-common-params-list")
    );
    if (Object.keys(commonParams).length > 0) {
      config.commonParams = commonParams;
      // Always send the current checkbox state, even when empty -- the
      // server merges a saved config's commonParamsMasked in wholesale
      // (see GatewaysRegistry.upsert()), so omitting it here on a save
      // that unchecked every box would leave stale masked entries behind.
      config.commonParamsMasked = commonParamsMasked;
    }
    if (form.requiresAuth.value) config.requiresAuth = form.requiresAuth.value;
    if (EDITING_GATEWAY_NAME) {
      await api("PUT", `/console/api/gateways/${encodeURIComponent(EDITING_GATEWAY_NAME)}`, { config });
    } else {
      await api("POST", "/console/api/gateways", { name, config });
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
  CURRENT_VIEW = { type: "shared", key: "authProviders", item: name || null };
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
  renderBreadcrumb();
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
      await api("PUT", `/console/api/auth-providers/${encodeURIComponent(EDITING_AUTH_PROVIDER_NAME)}`, { config });
    } else {
      await api("POST", "/console/api/auth-providers", { name, config });
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

/* ---------------------------------------------------------------------
 * App editor + its embedded Routes table
 * ------------------------------------------------------------------- */
function renderAppRoutesTable(routes) {
  const listEl = document.getElementById("app-routes-list");
  const emptyEl = document.getElementById("app-routes-empty");
  listEl.innerHTML = "";
  emptyEl.hidden = routes.length > 0;
  for (const route of routes) {
    const integration = INTEGRATIONS.find((i) => i.id === route.integration);
    const pill = el(
      "button",
      {
        type: "button",
        class: "integration-pill" + (integration ? "" : " broken"),
        title: integration ? `Open "${route.integration}" in Shared Collection` : `Integration "${route.integration}" not found`,
        onclick: () => openIntegrationFromPill(route.integration),
      },
      [route.integration + (integration ? "" : " ⚠")]
    );
    const editBtn = el(
      "button",
      { type: "button", class: "icon-btn", title: "Edit route", "aria-label": "Edit route", onclick: () => openRouteEditor(EDITING_APP_ID, route) },
      ["✎"]
    );
    const deleteBtn = el(
      "button",
      { type: "button", class: "icon-btn", title: "Delete route", "aria-label": "Delete route", onclick: () => deleteRoute(EDITING_APP_ID, route.id) },
      ["✕"]
    );
    // Column order matches the validated mockup: Method, Path, Description,
    // Integration pill last -- then this app's own Edit/Delete actions,
    // which the mockup (a read-only demo) never needed to show.
    const row = el("div", { class: "route-row" }, [
      el("span", { class: "route-row-method " + route.method }, [route.method]),
      el("span", { class: "route-row-path" }, [route.path]),
      el("span", { class: "route-row-desc" }, [route.description || ""]),
      pill,
      el("div", { class: "route-row-actions" }, [editBtn, deleteBtn]),
    ]);
    listEl.appendChild(row);
  }
}

/** Switches the App editor's Settings/Routes/Export tabs -- same
 * show/hide-only mechanics as switchIntegrationTab(), just without the
 * "jump to the tab with the first invalid field" wiring (the only
 * required fields live on Settings, which is always reachable). */
function switchAppTab(tab) {
  for (const btn of document.querySelectorAll("#app-tabs .editor-tab-btn")) {
    btn.classList.toggle("active", btn.dataset.appTab === tab);
  }
  for (const panel of document.querySelectorAll(".app-tab-panel")) {
    panel.hidden = panel.dataset.appTabPanel !== tab;
  }
}

function initAppTabs() {
  for (const btn of document.querySelectorAll("#app-tabs .editor-tab-btn")) {
    btn.addEventListener("click", () => {
      if (!btn.disabled) switchAppTab(btn.dataset.appTab);
    });
  }
}

function openAppEditor(id) {
  closeInfoPopup();
  EDITING_APP_ID = id || null;
  CURRENT_VIEW = { type: "app", key: id || null };
  const app = id ? APPS.find((a) => a.id === id) : null;
  CURRENT_APP_ROUTES = app ? [...(app.routes || [])] : [];

  document.getElementById("app-editor-title").textContent = app ? `Edit app: ${app.id}` : "New app";
  const deleteBtn = document.getElementById("app-delete-btn");
  deleteBtn.hidden = !app;
  deleteBtn.onclick = () => deleteApp(EDITING_APP_ID);
  showError("app-form-error", "");

  const form = document.getElementById("app-form");
  form.id.value = app?.id || "";
  form.id.disabled = Boolean(app); // renaming would orphan this app's file AND any deployment.yaml mount referencing its old id -- delete+recreate instead
  form.name.value = app?.name || "";

  // Routes/Export only make sense once the App exists (Routes needs an
  // appId to POST into; Export needs real routes to describe) -- a
  // brand-new, unsaved App only ever shows Settings.
  const routesTabBtn = document.getElementById("app-tab-routes-btn");
  const exportTabBtn = document.getElementById("app-tab-export-btn");
  routesTabBtn.disabled = !app;
  exportTabBtn.disabled = !app;
  document.getElementById("count-app-routes").textContent = app ? `(${CURRENT_APP_ROUTES.length})` : "";
  if (app) {
    renderAppRoutesTable(CURRENT_APP_ROUTES);
    document.getElementById("app-mount-note").textContent =
      "To expose these routes, make sure this App's id appears under `mounts` in deployment.yaml (hand-edited on this machine, not shown here).";
    document.getElementById("app-export-openapi-desc").textContent =
      `Covers only this app's own ${CURRENT_APP_ROUTES.length} route${CURRENT_APP_ROUTES.length === 1 ? "" : "s"} (whether or not it's currently mounted).`;
    document.getElementById("download-openapi-btn").onclick = async () => {
      try {
        await downloadFile(`/console/api/apps/${encodeURIComponent(app.id)}/export/openapi.json`, `naimix-${app.id}-openapi.json`);
        toast(`OpenAPI spec for "${app.id}" downloaded`);
      } catch (err) {
        toast(err.message, true);
      }
    };
    document.getElementById("download-mcp-server-btn").onclick = async () => {
      try {
        await downloadFile("/console/api/export/mcp-server", "naimix-mcp-server.js");
        toast("MCP server downloaded");
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
  switchAppTab("settings"); // always open on Settings, regardless of what was showing last time

  showDetailView("app");
  renderBreadcrumb();
  document.getElementById("detail-panel").scrollTop = 0;
}

function readAppForm() {
  const form = document.getElementById("app-form");
  return {
    id: form.id.value.trim(),
    name: form.name.value.trim(),
    // PUT /apps/:id replaces the whole App, so its routes have to be
    // resent along with id/name even though this form has no field for
    // them directly -- CURRENT_APP_ROUTES is kept in sync by
    // openRouteEditor/saveRoute/deleteRoute as the source of truth while
    // this editor is open.
    routes: CURRENT_APP_ROUTES,
  };
}

async function saveApp(ev) {
  ev.preventDefault();
  showError("app-form-error", "");
  let app;
  try {
    app = readAppForm();
  } catch (err) {
    showError("app-form-error", "Couldn't read the form: " + err.message);
    return;
  }
  const wasNew = !EDITING_APP_ID;
  try {
    if (EDITING_APP_ID) {
      await api("PUT", `/console/api/apps/${encodeURIComponent(EDITING_APP_ID)}`, app);
    } else {
      await api("POST", "/console/api/apps", app);
    }
    toast(`Saved app "${app.id}"`);
    await loadAll();
    openAppEditor(app.id); // stay in the panel, now showing it as a saved app (and its Routes/Export tabs, now enabled)
    // A brand-new App has nothing to configure on Settings beyond what was
    // just entered -- land straight on Routes so adding the first one is
    // the obvious next step, matching the mockup's "Created X. Add its
    // first route below." flow.
    if (wasNew) switchAppTab("routes");
  } catch (err) {
    showError("app-form-error", err.message);
  }
}

/* ---------------------------------------------------------------------
 * Route editor drawer -- the 2-step add/edit flow: pick an Integration
 * (step 1), then fill in method/path/description (step 2), plus a
 * Route-level "Try it" tester once the route is actually saved (it needs
 * a real appId+routeId to call POST /apps/:appId/routes/:routeId/test).
 * ------------------------------------------------------------------- */
function renderChosenIntegrationCard(integrationId) {
  const card = document.getElementById("route-chosen-integration-card");
  const integration = INTEGRATIONS.find((i) => i.id === integrationId);
  card.innerHTML = "";
  card.appendChild(el("div", { class: "integration-card-id" }, [integration ? integrationId : `${integrationId} ⚠ (not found)`]));
  if (integration?.description) card.appendChild(el("div", { class: "integration-card-desc" }, [integration.description]));
}

function showRouteStepDetails(integrationId) {
  ROUTE_EDITOR_STATE.integrationId = integrationId;
  renderChosenIntegrationCard(integrationId);
  document.getElementById("route-step-pick-integration").hidden = true;
  document.getElementById("route-step-details").hidden = false;
}

function renderIntegrationCards(searchTerm) {
  const container = document.getElementById("route-integration-cards");
  const emptyEl = document.getElementById("route-integration-cards-empty");
  const term = (searchTerm || "").trim().toLowerCase();
  const matches = INTEGRATIONS.filter(
    (i) => !term || i.id.toLowerCase().includes(term) || (i.description || "").toLowerCase().includes(term)
  ).sort((a, b) => a.id.localeCompare(b.id));
  container.innerHTML = "";
  emptyEl.hidden = matches.length > 0;
  emptyEl.textContent = term
    ? `No integrations match "${searchTerm}".`
    : "No integrations yet -- create one in the Shared Collection first.";
  for (const integration of matches) {
    // "View in Shared Collection" jumps there (closing this modal) without
    // picking the integration -- matches the mockup's picker cards, which
    // let you double-check an Integration's definition before committing
    // to it for this Route. stopPropagation keeps that click from also
    // firing the card's own onclick (choose this integration).
    const viewLink = el(
      "a",
      {
        href: "javascript:void(0)",
        class: "viewlink",
        onclick: (ev) => {
          ev.stopPropagation();
          closeDrawer("route-editor");
          showSharedCatalog("integrations", integration.id);
        },
      },
      ["View in Shared Collection ↗"]
    );
    const card = el(
      "div",
      { class: "integration-card", onclick: () => chooseIntegrationForRoute(integration.id) },
      [
        el("div", { class: "integration-card-row1" }, [el("span", { class: "integration-card-id" }, [integration.id]), viewLink]),
        integration.description ? el("div", { class: "integration-card-desc" }, [integration.description]) : null,
      ]
    );
    container.appendChild(card);
  }
}

function chooseIntegrationForRoute(integrationId) {
  showRouteStepDetails(integrationId);
  const form = document.getElementById("route-form");
  // Only pre-fill id/method/path when adding a brand-new route (no routeId
  // yet) -- swapping the Integration on an already-saved route leaves its
  // own id/method/path exactly as they were.
  if (!ROUTE_EDITOR_STATE.routeId) {
    form.id.value = integrationId;
    form.path.value = "";
    form.description.value = "";
  }
  document.getElementById("route-tryit-section").hidden = true;
}

/** Only meaningful for an already-saved route (needs a real appId+routeId
 * to call the test endpoint) -- builds one plain value input per the
 * chosen Integration's declared input parameters. */
function setupRouteTryIt(route) {
  const section = document.getElementById("route-tryit-section");
  const integration = INTEGRATIONS.find((i) => i.id === route.integration);
  const paramsList = document.getElementById("route-test-params-list");
  paramsList.innerHTML = "";
  for (const p of integration?.input || []) {
    const valueInput = el("input", { placeholder: `value for ${p.name}` });
    const row = el("div", { class: "repeatable-row" }, [el("label", {}, [p.name, valueInput])]);
    row._paramName = p.name;
    row._valueInput = valueInput;
    paramsList.appendChild(row);
  }
  document.getElementById("route-test-raw-output").textContent = "—";
  document.getElementById("route-test-mapped-output").textContent = "—";
  section.hidden = false;
}

function openRouteEditor(appId, route) {
  closeInfoPopup();
  ROUTE_EDITOR_STATE = { appId, routeId: route?.id || null, integrationId: route?.integration || null };
  document.getElementById("route-editor-title").textContent = route ? `Edit route: ${route.id}` : "Add route";
  showError("route-form-error", "");

  const form = document.getElementById("route-form");
  populateSelect(form.method, META.methods);

  if (route) {
    showRouteStepDetails(route.integration);
    form.id.value = route.id;
    form.id.disabled = false; // renaming is allowed; the registry just rewrites the App's own file
    form.method.value = route.method;
    form.path.value = route.path;
    form.description.value = route.description || "";
    setupRouteTryIt(route);
  } else {
    document.getElementById("route-step-pick-integration").hidden = false;
    document.getElementById("route-step-details").hidden = true;
    document.getElementById("route-tryit-section").hidden = true;
    form.id.value = "";
    form.id.disabled = false;
    form.method.value = "GET";
    form.path.value = "";
    form.description.value = "";
  }
  document.getElementById("route-integration-search").value = "";
  renderIntegrationCards("");

  document.getElementById("route-editor").hidden = false;
}

async function saveRoute(ev) {
  ev.preventDefault();
  showError("route-form-error", "");
  const { appId, routeId, integrationId } = ROUTE_EDITOR_STATE;
  if (!integrationId) {
    showError("route-form-error", "Pick an Integration first.");
    return;
  }
  const form = document.getElementById("route-form");
  const route = {
    id: form.id.value.trim(),
    method: form.method.value,
    path: form.path.value.trim(),
    description: form.description.value.trim() || undefined,
    integration: integrationId,
  };
  try {
    if (routeId) {
      await api("PUT", `/console/api/apps/${encodeURIComponent(appId)}/routes/${encodeURIComponent(routeId)}`, route);
    } else {
      await api("POST", `/console/api/apps/${encodeURIComponent(appId)}/routes`, route);
    }
    toast(`Saved route "${route.id}"`);
    closeDrawer("route-editor");
    await loadAll();
    openAppEditor(appId); // stay on the app, now showing the saved route in its table
    switchAppTab("routes");
  } catch (err) {
    showError("route-form-error", err.message);
  }
}

async function deleteRoute(appId, routeId) {
  if (!confirm(`Delete route "${routeId}" from app "${appId}"? This does not delete its Integration.`)) return;
  try {
    await api("DELETE", `/console/api/apps/${encodeURIComponent(appId)}/routes/${encodeURIComponent(routeId)}`);
    toast(`Deleted route "${routeId}"`);
    await loadAll();
    openAppEditor(appId); // stay on the app, refreshed
    switchAppTab("routes");
  } catch (err) {
    toast(err.message, true);
  }
}

async function fetchRouteSample() {
  const { appId, routeId } = ROUTE_EDITOR_STATE;
  showError("route-form-error", "");
  if (!appId || !routeId) {
    showError("route-form-error", "Save this route first — Try it needs a saved route to call.");
    return;
  }
  try {
    const params = {};
    for (const row of document.getElementById("route-test-params-list").children) {
      if (row._valueInput.value !== "") params[row._paramName] = row._valueInput.value;
    }
    const { raw, mapped } = await api(
      "POST",
      `/console/api/apps/${encodeURIComponent(appId)}/routes/${encodeURIComponent(routeId)}/test`,
      { params }
    );
    document.getElementById("route-test-raw-output").textContent = JSON.stringify(raw, null, 2);
    document.getElementById("route-test-mapped-output").textContent = JSON.stringify(mapped, null, 2);
  } catch (err) {
    document.getElementById("route-test-raw-output").textContent = "Error: " + err.message;
    showError("route-form-error", err.message);
  }
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
      const result = await api("POST", "/console/api/reload");
      const integrationErrors = result.integrationErrors || [];
      const appErrors = result.appErrors || [];
      const functionErrors = result.functionErrors || [];
      const mountErrors = result.mountErrors || [];
      const parts = [`${result.integrationCount} integration(s)`, `${result.appCount} app(s)`, `${result.routeCount} route(s)`];
      if (integrationErrors.length) parts.push(`${integrationErrors.length} integration error(s)`);
      if (appErrors.length) parts.push(`${appErrors.length} app error(s)`);
      if (functionErrors.length) parts.push(`${functionErrors.length} function error(s)`);
      if (mountErrors.length) parts.push(`${mountErrors.length} mount error(s)`);
      const hasError = integrationErrors.length > 0 || appErrors.length > 0 || functionErrors.length > 0 || mountErrors.length > 0;
      toast(`Reloaded — ${parts.join(", ")}`, hasError);
      await loadAll();
      // loadAll() only re-renders the sidebar lists -- an already-open
      // integration editor's function picker(s) fetched their dropdown
      // options once, when that editor/row was mounted, and won't see
      // what Reload just (re)loaded on their own.
      document.querySelectorAll(".function-picker").forEach((w) => {
        if (typeof w._refresh === "function") w._refresh();
      });
    } catch (err) {
      toast(err.message, true);
    }
  });

  // "+ New" for an individual Auth Provider/Gateway/Integration is now
  // the catalog table's own "+ Add" button (wired per-category inside
  // showSharedCatalog()), not a static sidebar listener -- there's no
  // single #new-integration-btn/#new-gateway-btn/#new-auth-provider-btn
  // anymore. Apps keep a quick inline create right in the sidebar instead.
  wireNewAppInline();
  document.getElementById("integration-close-btn").addEventListener("click", () => backToSharedCatalog("integrations"));
  document.getElementById("gateway-close-btn").addEventListener("click", () => backToSharedCatalog("gateways"));
  document.getElementById("auth-provider-close-btn").addEventListener("click", () => backToSharedCatalog("authProviders"));
  document.getElementById("app-close-btn").addEventListener("click", closeDetail);
  document.getElementById("session-close-btn").addEventListener("click", closeDetail);
  document.getElementById("refresh-sessions-btn").addEventListener("click", async () => {
    await refreshSessions();
    toast("Sessions refreshed");
  });
  document.getElementById("change-workspace-btn").addEventListener("click", () => openWorkspaceEditor(CURRENT_SETTINGS.configDir));
  document.getElementById("workspace-form").addEventListener("submit", saveWorkspace);
  document.getElementById("browse-workspace-btn").addEventListener("click", browseWorkspace);
  // download-openapi-btn/download-mcp-server-btn now live inside each
  // App's own Export tab -- openAppEditor() assigns their .onclick fresh
  // every time it opens (scoped to that app's id), so there's no global
  // listener for them here anymore.

  for (const closer of document.querySelectorAll("[data-close]")) {
    closer.addEventListener("click", () => closeDrawer(closer.dataset.close));
  }

  // Integrations no longer have a method/path of their own (that's a
  // Route's job now -- see the Apps section), so there's no more
  // auto-path wiring here: just Gateway -> inferred backend Type.
  const integrationForm = document.getElementById("integration-form");
  integrationForm.backendGateway.addEventListener("change", () => {
    applyGatewayInferredType();
    refreshSectionCounts();
  });
  initIntegrationTabs();
  initAppTabs();
  initInfoIcons();
  document.getElementById("view-gateway-btn").addEventListener("click", (ev) => openGatewayPreview(ev.currentTarget));

  document.getElementById("add-input-btn").addEventListener("click", () => {
    document.getElementById("input-params-list").appendChild(inputParamRow());
    syncTestParams();
  });
  document.getElementById("add-output-btn").addEventListener("click", () => {
    document.getElementById("output-fields-list").appendChild(outputFieldRow());
    refreshSectionCounts();
  });
  document.getElementById("add-output-array-btn")?.addEventListener("click", () => {
    document.getElementById("output-fields-list").appendChild(outputFieldRow({ kind: "array", target: "", root: "", fields: [] }));
    refreshSectionCounts();
  });
  document.getElementById("add-common-param-btn").addEventListener("click", () => {
    document.getElementById("gateway-common-params-list")._addRow("", "");
  });

  document.getElementById("integration-form").addEventListener("submit", saveIntegration);
  document.getElementById("app-form").addEventListener("submit", saveApp);
  document.getElementById("gateway-form").addEventListener("submit", saveGateway);
  document.getElementById("auth-provider-form").addEventListener("submit", saveAuthProvider);
  document.getElementById("auth-provider-test-btn").addEventListener("click", testAuthProviderLogin);
  document.getElementById("fetch-sample-btn").addEventListener("click", fetchSample);
  document.getElementById("apply-mapping-btn").addEventListener("click", applyMappingToSample);

  // App's embedded Routes table + the Route editor drawer.
  document.getElementById("add-route-btn").addEventListener("click", () => openRouteEditor(EDITING_APP_ID, null));
  document.getElementById("route-form").addEventListener("submit", saveRoute);
  document.getElementById("route-fetch-sample-btn").addEventListener("click", fetchRouteSample);
  document.getElementById("route-integration-search").addEventListener("input", (ev) => renderIntegrationCards(ev.target.value));
  document.getElementById("route-change-integration-btn").addEventListener("click", () => {
    document.getElementById("route-step-pick-integration").hidden = false;
    document.getElementById("route-step-details").hidden = true;
    document.getElementById("route-integration-search").value = "";
    renderIntegrationCards("");
  });

  const savedToken = localStorage.getItem("naimix-console-token");
  if (savedToken) {
    login(savedToken).catch(() => {
      // Stored token no longer valid -- fall back to the login screen silently.
    });
  }
});
