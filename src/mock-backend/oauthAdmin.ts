import express, { type NextFunction, type Request, type Response } from "express";
import type { MockClient, MockIssuerHandle, MockOAuthServerHandle, MockUser, PkceMode } from "./oauthServer";

/**
 * Admin UI and JSON API for the mock OAuth server, served at `/admin` when
 * the server is started with `{ admin: true }` (see oauthRun.ts). It lets a
 * person create issuers and add clients and users to them while the server
 * runs, instead of calling `addIssuer()` from code.
 *
 * Deliberately small: create and list, plus adding a client or user to an
 * existing issuer. No edit or delete, no persistence (a restart forgets
 * everything), and no scenario / fault controls -- those stay in code.
 * Nothing here is authenticated: the mock is a local test tool and binds to
 * 127.0.0.1 by default.
 */

class BadRequest extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PKCE_MODES: PkceMode[] = ["required", "optional", "ignore"];

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new BadRequest(`${field} is required`);
  return value.trim();
}

function parseClient(raw: unknown): MockClient {
  if (!raw || typeof raw !== "object") throw new BadRequest("client must be an object");
  const c = raw as Record<string, unknown>;
  const clientId = str(c.clientId, "clientId");
  const uris = Array.isArray(c.redirectUris) ? c.redirectUris : [];
  if (uris.length === 0) throw new BadRequest("at least one redirect URI is required");
  const redirectUris = uris.map((u) => {
    const value = str(u, "redirect URI");
    try {
      const parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    } catch {
      throw new BadRequest(`"${value}" is not an absolute http(s) URL`);
    }
    return value;
  });
  const pkce = c.pkce === undefined || c.pkce === "" ? undefined : (c.pkce as PkceMode);
  if (pkce !== undefined && !PKCE_MODES.includes(pkce)) throw new BadRequest(`pkce must be one of ${PKCE_MODES.join(", ")}`);
  const clientSecret = typeof c.clientSecret === "string" && c.clientSecret !== "" ? c.clientSecret : undefined;
  return { clientId, clientSecret, redirectUris, pkce };
}

function parseUser(raw: unknown): MockUser {
  if (!raw || typeof raw !== "object") throw new BadRequest("user must be an object");
  const u = raw as Record<string, unknown>;
  const sub = str(u.sub, "sub");
  const email = typeof u.email === "string" && u.email.trim() !== "" ? u.email.trim() : undefined;
  let claims: Record<string, unknown> | undefined;
  if (u.claims !== undefined && u.claims !== null && u.claims !== "") {
    if (typeof u.claims !== "object" || Array.isArray(u.claims)) throw new BadRequest("claims must be a JSON object");
    claims = u.claims as Record<string, unknown>;
  }
  return { sub, email, claims };
}

const MASKED_KEYS = new Set(["client_secret", "authorization", "cookie"]);

function mask(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) out[key] = MASKED_KEYS.has(key.toLowerCase()) ? "***" : value;
  return out;
}

function describe(handle: MockIssuerHandle) {
  return {
    id: handle.id,
    issuer: handle.issuer,
    authorizationEndpoint: handle.authorizationEndpoint,
    tokenEndpoint: handle.tokenEndpoint,
    jwksUri: handle.jwksUri,
    discoveryUrl: handle.discoveryUrl,
    ...handle.config(),
  };
}

export function createAdminRouter(server: MockOAuthServerHandle): express.Router {
  const router = express.Router();
  router.use(express.json());

  router.get("/", (_req, res) => {
    res.type("html").send(PAGE);
  });

  router.get("/api/issuers", (_req, res) => {
    res.json(server.issuers().map(describe));
  });

  router.post("/api/issuers", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = str(body.id, "id");
    if (!ID_PATTERN.test(id)) throw new BadRequest("id may contain letters, digits, - and _ only (max 64), and must start with a letter or digit");
    if (id === "admin") throw new BadRequest(`"admin" is reserved`);
    if (server.issuers().some((i) => i.id === id)) throw new BadRequest(`Issuer "${id}" already exists`, 409);
    const clients = (Array.isArray(body.clients) ? body.clients : []).map(parseClient);
    if (clients.length === 0) throw new BadRequest("at least one client is required");
    if (new Set(clients.map((c) => c.clientId)).size !== clients.length) throw new BadRequest("duplicate clientId");
    const users = Array.isArray(body.users) ? body.users.map(parseUser) : [];
    if (new Set(users.map((u) => u.sub)).size !== users.length) throw new BadRequest("duplicate user sub");
    const handle = server.addIssuer(id, {
      clients,
      users: users.length > 0 ? users : undefined,
      issParameter: body.issParameter === true,
    });
    res.status(201).json(describe(handle));
  });

  // Newest first. Client secrets and Authorization headers are masked: the
  // panel is for seeing what naimix sent, not for copying credentials.
  router.get("/api/requests", (req, res) => {
    const issuer = typeof req.query.issuer === "string" && req.query.issuer !== "" ? req.query.issuer : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = server.requests
      .filter((r) => !issuer || r.issuerId === issuer)
      .slice(-limit)
      .reverse()
      .map((r) => ({
        at: r.at,
        issuerId: r.issuerId,
        endpoint: r.endpoint,
        method: r.method,
        clientAuth: r.clientAuth,
        query: mask(r.query),
        body: mask(r.body),
        headers: mask(r.headers),
      }));
    res.json({ total: server.requests.length, requests: rows });
  });

  router.delete("/api/requests", (_req, res) => {
    server.clearRequests();
    res.status(204).end();
  });

  const withIssuer = (req: Request): MockIssuerHandle => {
    try {
      return server.issuer(req.params.id);
    } catch {
      throw new BadRequest(`Unknown issuer "${req.params.id}"`, 404);
    }
  };

  router.post("/api/issuers/:id/clients", (req, res) => {
    const handle = withIssuer(req);
    try {
      handle.addClient(parseClient(req.body));
    } catch (err) {
      if (err instanceof BadRequest) throw err;
      throw new BadRequest(err instanceof Error ? err.message : String(err), 409);
    }
    res.status(201).json(describe(handle));
  });

  router.post("/api/issuers/:id/users", (req, res) => {
    const handle = withIssuer(req);
    try {
      handle.addUser(parseUser(req.body));
    } catch (err) {
      if (err instanceof BadRequest) throw err;
      throw new BadRequest(err instanceof Error ? err.message : String(err), 409);
    }
    res.status(201).json(describe(handle));
  });

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequest) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof SyntaxError) {
      res.status(400).json({ error: "request body is not valid JSON" });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

// The page builds all dynamic content with textContent / DOM calls, never
// innerHTML, so values typed into the forms can't inject markup.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock OAuth server</title>
<style>
  :root { --bg:#fff; --fg:#1b1f24; --muted:#5b6670; --line:#d6dbe0; --card:#f6f8fa; --accent:#0b5fff; --err:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14181d; --fg:#e6e9ec; --muted:#9aa5b0; --line:#2c343c; --card:#1c2229; --accent:#6ea0ff; --err:#ff8a80; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 64px; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 8px; }
  h3 { font-size: 14px; margin: 16px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  p.sub { margin: 0 0 16px; color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
  label { display:block; font-size: 13px; color: var(--muted); margin: 10px 0 3px; }
  input[type=text], textarea, select { width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; }
  textarea { min-height: 60px; font-family: ui-monospace, monospace; font-size: 13px; }
  .row { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 560px) { .row { grid-template-columns: 1fr; } }
  button { padding:7px 14px; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:6px; font:inherit; cursor:pointer; margin-top:12px; }
  button.secondary { background:transparent; color:var(--accent); }
  .msg { margin-top:10px; font-size:13px; } .msg.err { color: var(--err); }
  dl { display:grid; grid-template-columns: max-content 1fr; gap: 3px 12px; margin: 6px 0; font-size: 13px; }
  dt { color: var(--muted); } dd { margin:0; font-family: ui-monospace, monospace; word-break: break-all; }
  pre { background: var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; overflow:auto; font-size:12.5px; margin:6px 0; }
  details { margin-top: 10px; } summary { cursor:pointer; color: var(--accent); }
  ul.plain { margin:4px 0; padding-left: 18px; font-size: 13px; }
  .check { display:flex; gap:8px; align-items:center; margin-top:10px; font-size:13px; color:var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Mock OAuth server</h1>
  <p class="sub">Create issuers, clients and users while the server runs. Nothing is saved: a restart clears it.</p>

  <section class="card">
    <h2 style="margin-top:0">New issuer</h2>
    <form id="issuer-form">
      <div class="row">
        <div><label for="i-id">Issuer id (becomes the URL path)</label><input type="text" id="i-id" placeholder="demo" required></div>
        <div class="check"><input type="checkbox" id="i-iss"><label for="i-iss" style="margin:0">Send the RFC 9207 <code>iss</code> parameter on the redirect</label></div>
      </div>
      <h3>First client</h3>
      <div class="row">
        <div><label for="c-id">Client id</label><input type="text" id="c-id" value="naimix" required></div>
        <div><label for="c-secret">Client secret (blank = public client)</label><input type="text" id="c-secret" value="naimix-secret"></div>
      </div>
      <label for="c-uris">Redirect URIs (one per line, exact match)</label>
      <textarea id="c-uris" placeholder="http://localhost:3000/auth/oauth/mockOidc/callback" required></textarea>
      <label for="c-pkce">PKCE</label>
      <select id="c-pkce"><option value="required">required</option><option value="optional">optional</option><option value="ignore">ignore (behaves like a provider without PKCE)</option></select>
      <h3>First user (optional, a default user is created if blank)</h3>
      <div class="row">
        <div><label for="u-sub">sub</label><input type="text" id="u-sub" placeholder="mock-user-1"></div>
        <div><label for="u-email">email</label><input type="text" id="u-email" placeholder="user1@mock.test"></div>
      </div>
      <button type="submit">Create issuer</button>
      <div id="issuer-msg" class="msg"></div>
    </form>
  </section>

  <h2>Issuers</h2>
  <div id="issuers"></div>

  <h2>Requests</h2>
  <p class="sub">What the server received, newest first. Client secrets and Authorization headers are masked. Kept in memory only (last 1000).</p>
  <div class="card">
    <div class="row">
      <div><label for="r-issuer">Issuer</label><select id="r-issuer"><option value="">all</option></select></div>
      <div class="check"><input type="checkbox" id="r-auto" checked><label for="r-auto" style="margin:0">Refresh every 2 s</label></div>
    </div>
    <button type="button" id="r-refresh" class="secondary">Refresh now</button>
    <button type="button" id="r-clear" class="secondary">Clear</button>
    <div id="r-count" class="msg"></div>
    <div id="requests"></div>
  </div>
</main>
<script>
(function () {
  var issuersEl = document.getElementById("issuers");

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === "text") node.textContent = props[k]; else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function api(method, path, body) {
    return fetch("/admin/api" + path, {
      method: method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        return data;
      });
    });
  }

  function say(node, text, isErr) {
    node.textContent = text;
    node.className = "msg" + (isErr ? " err" : "");
  }

  function lines(value) {
    return value.split("\\n").map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function snippet(issuer, client) {
    var name = "mock" + issuer.id.charAt(0).toUpperCase() + issuer.id.slice(1);
    return [
      name + ":",
      "  kind: oauth2",
      "  grantType: authorizationCode",
      "  authorizationUrl: " + issuer.authorizationEndpoint,
      "  tokenUrl: " + issuer.tokenEndpoint,
      "  jwksUri: " + issuer.jwksUri,
      "  issuer: " + issuer.issuer,
      "  clientId: " + client.clientId,
      client.clientSecret ? "  clientSecret: " + client.clientSecret : "  # public client: naimix needs a clientSecret, so give this client one",
      "  scope: \\"openid offline_access\\"",
      "  redirectUri: " + client.redirectUris[0],
      "  pkce: " + (client.pkce === "ignore" ? "off" : "S256"),
      "  clients:",
      "    - id: webapp          # your calling app",
      "      returnTo: [http://localhost:5000/echo]"
    ].join("\\n");
  }

  function dl(pairs) {
    var node = el("dl");
    pairs.forEach(function (p) { node.appendChild(el("dt", { text: p[0] })); node.appendChild(el("dd", { text: p[1] })); });
    return node;
  }

  function addClientForm(issuer) {
    var id = el("input", { type: "text", placeholder: "client id" });
    var secret = el("input", { type: "text", placeholder: "client secret (optional)" });
    var uris = el("textarea", { placeholder: "redirect URIs, one per line" });
    var pkce = el("select");
    ["required", "optional", "ignore"].forEach(function (m) { pkce.appendChild(el("option", { value: m, text: m })); });
    var msg = el("div", { class: "msg" });
    var form = el("form", null, [
      el("div", { class: "row" }, [el("div", null, [el("label", { text: "Client id" }), id]), el("div", null, [el("label", { text: "Secret" }), secret])]),
      el("label", { text: "Redirect URIs" }), uris, el("label", { text: "PKCE" }), pkce,
      el("button", { type: "submit", class: "secondary", text: "Add client" }), msg
    ]);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      api("POST", "/issuers/" + encodeURIComponent(issuer.id) + "/clients", {
        clientId: id.value, clientSecret: secret.value, redirectUris: lines(uris.value), pkce: pkce.value
      }).then(load, function (err) { say(msg, err.message, true); });
    });
    return el("details", null, [el("summary", { text: "Add a client" }), form]);
  }

  function addUserForm(issuer) {
    var sub = el("input", { type: "text", placeholder: "sub" });
    var email = el("input", { type: "text", placeholder: "email (optional)" });
    var claims = el("textarea", { placeholder: '{"name": "Alice"}  (optional extra ID token claims, JSON)' });
    var msg = el("div", { class: "msg" });
    var form = el("form", null, [
      el("div", { class: "row" }, [el("div", null, [el("label", { text: "sub" }), sub]), el("div", null, [el("label", { text: "email" }), email])]),
      el("label", { text: "Extra claims (JSON)" }), claims,
      el("button", { type: "submit", class: "secondary", text: "Add user" }), msg
    ]);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var parsed;
      if (claims.value.trim() !== "") {
        try { parsed = JSON.parse(claims.value); } catch (err) { say(msg, "claims are not valid JSON", true); return; }
      }
      api("POST", "/issuers/" + encodeURIComponent(issuer.id) + "/users", { sub: sub.value, email: email.value, claims: parsed })
        .then(load, function (err) { say(msg, err.message, true); });
    });
    return el("details", null, [el("summary", { text: "Add a user" }), form]);
  }

  function render(list) {
    issuersEl.textContent = "";
    if (list.length === 0) { issuersEl.appendChild(el("p", { class: "sub", text: "No issuers yet." })); return; }
    list.forEach(function (issuer) {
      var card = el("section", { class: "card" }, [
        el("h2", { text: issuer.id, style: "margin-top:0" }),
        dl([["issuer", issuer.issuer], ["authorizationUrl", issuer.authorizationEndpoint], ["tokenUrl", issuer.tokenEndpoint],
            ["jwksUri", issuer.jwksUri], ["discovery", issuer.discoveryUrl], ["iss parameter", issuer.issParameter ? "sent" : "not sent"]]),
        el("h3", { text: "Clients" })
      ]);
      issuer.clients.forEach(function (c) {
        card.appendChild(dl([["clientId", c.clientId], ["secret", c.clientSecret || "(public client)"], ["PKCE", c.pkce || "required"],
                             ["redirect URIs", c.redirectUris.join("  ")]]));
        card.appendChild(el("details", null, [el("summary", { text: "naimix authProviders.yaml entry for " + c.clientId }), el("pre", { text: snippet(issuer, c) })]));
      });
      card.appendChild(addClientForm(issuer));
      card.appendChild(el("h3", { text: "Users (the first is the default login; pick another with login_hint=sub or email)" }));
      var ul = el("ul", { class: "plain" });
      issuer.users.forEach(function (u) {
        ul.appendChild(el("li", { text: u.sub + (u.email ? "  <" + u.email + ">" : "") + (u.claims ? "  " + JSON.stringify(u.claims) : "") }));
      });
      card.appendChild(ul);
      card.appendChild(addUserForm(issuer));
      issuersEl.appendChild(card);
    });
  }

  var issuerSelect = document.getElementById("r-issuer");
  var requestsEl = document.getElementById("requests");

  function syncIssuerFilter(list) {
    var current = issuerSelect.value;
    issuerSelect.textContent = "";
    issuerSelect.appendChild(el("option", { value: "", text: "all" }));
    list.forEach(function (i) { issuerSelect.appendChild(el("option", { value: i.id, text: i.id })); });
    issuerSelect.value = list.some(function (i) { return i.id === current; }) ? current : "";
  }

  function summary(r) {
    var q = r.query || {}, b = r.body || {};
    var bits = [];
    if (r.endpoint === "authorize") {
      if (q.client_id) bits.push("client_id=" + q.client_id);
      if (q.code_challenge) bits.push("PKCE " + (q.code_challenge_method || "plain"));
      if (q.nonce) bits.push("nonce");
      if (q.scope) bits.push("scope=" + q.scope);
    } else if (r.endpoint === "token") {
      if (b.grant_type) bits.push(b.grant_type);
      if (r.clientAuth) bits.push("auth=" + r.clientAuth);
      if (b.code_verifier) bits.push("code_verifier");
    }
    return bits.join("  ");
  }

  function renderRequests(data) {
    requestsEl.textContent = "";
    document.getElementById("r-count").textContent = data.requests.length + " shown, " + data.total + " recorded";
    data.requests.forEach(function (r) {
      var head = new Date(r.at).toLocaleTimeString() + "  " + r.method + " " + r.issuerId + "/" + r.endpoint + "  " + summary(r);
      var detail = JSON.stringify({ query: r.query, body: r.body, headers: r.headers }, null, 2);
      requestsEl.appendChild(el("details", null, [el("summary", { text: head }), el("pre", { text: detail })]));
    });
  }

  function loadRequests() {
    var open = {};
    Array.prototype.forEach.call(requestsEl.children, function (d, i) { if (d.open) open[i] = true; });
    var issuer = issuerSelect.value;
    return api("GET", "/requests" + (issuer ? "?issuer=" + encodeURIComponent(issuer) : "")).then(function (data) {
      renderRequests(data);
      Array.prototype.forEach.call(requestsEl.children, function (d, i) { if (open[i]) d.open = true; });
    }, function (err) { document.getElementById("r-count").textContent = err.message; });
  }

  function load() {
    return api("GET", "/issuers").then(function (list) { render(list); syncIssuerFilter(list); }, function (err) { issuersEl.textContent = err.message; });
  }

  issuerSelect.addEventListener("change", loadRequests);
  document.getElementById("r-refresh").addEventListener("click", loadRequests);
  document.getElementById("r-clear").addEventListener("click", function () {
    api("DELETE", "/requests").then(loadRequests, loadRequests);
  });
  setInterval(function () { if (document.getElementById("r-auto").checked) loadRequests(); }, 2000);
  loadRequests();

  document.getElementById("issuer-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = document.getElementById("issuer-msg");
    var sub = document.getElementById("u-sub").value.trim();
    api("POST", "/issuers", {
      id: document.getElementById("i-id").value,
      issParameter: document.getElementById("i-iss").checked,
      clients: [{
        clientId: document.getElementById("c-id").value,
        clientSecret: document.getElementById("c-secret").value,
        redirectUris: lines(document.getElementById("c-uris").value),
        pkce: document.getElementById("c-pkce").value
      }],
      users: sub ? [{ sub: sub, email: document.getElementById("u-email").value }] : []
    }).then(function (created) {
      say(msg, 'Created "' + created.id + '".', false);
      document.getElementById("issuer-form").reset();
      load();
    }, function (err) { say(msg, err.message, true); });
  });

  load();
})();
</script>
</body>
</html>
`;
