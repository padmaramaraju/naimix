#!/usr/bin/env node
'use strict';

/**
 * naimix MCP server -- a thin proxy client.
 * ==========================================
 *
 * This is a single, dependency-free file. It does not describe one
 * particular workspace: every time it STARTS, it asks a live naimix
 * instance what endpoints, gateways, and auth providers it currently has
 * configured, and builds MCP tools from that on the fly. There is nothing
 * to regenerate after a config change -- just restart your MCP client (or
 * this process) and it re-discovers the current shape.
 *
 * IMPORTANT: this only works against a naimix `dev` build. QA and
 * Production builds do not expose /admin/api/* at all (by design -- see
 * DEPLOYMENT_ARCHITECTURE_NOTES.md in the naimix repo), so there is nothing
 * for this script to discover from there. Point NAIMIX_BASE_URL at a `dev`
 * instance.
 *
 * Requirements: Node.js 18 or later (for the built-in `fetch`). No
 * `npm install` needed -- this file has zero external dependencies.
 *
 * Configuration (environment variables):
 *   NAIMIX_BASE_URL     Required. e.g. http://localhost:3000
 *   NAIMIX_ADMIN_TOKEN  Required. The same value as this naimix instance's
 *                        own ADMIN_TOKEN env var (i.e. what you'd type into
 *                        the admin UI's login screen). Used ONLY to
 *                        discover the workspace's endpoints/gateways/auth
 *                        providers at startup (GET /admin/api/*) -- every
 *                        actual tool call this server makes on your behalf
 *                        goes to the normal caller-facing routes
 *                        (/auth/login/*, /auth/logout, and each endpoint's
 *                        real path), never back through the admin API.
 *
 * Security note: NAIMIX_ADMIN_TOKEN grants full admin access to whatever
 * naimix instance NAIMIX_BASE_URL points at (the same access the admin UI
 * has). Treat this file plus that token together as a credential -- don't
 * share them, and don't point this at a naimix instance whose admin token
 * you wouldn't otherwise hand out.
 *
 * Using this with Claude Desktop or Claude Code: add an entry like this to
 * your MCP server config (claude_desktop_config.json, or `claude mcp add`):
 *
 *   {
 *     "mcpServers": {
 *       "naimix": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/naimix-mcp-server.js"],
 *         "env": {
 *           "NAIMIX_BASE_URL": "http://localhost:3000",
 *           "NAIMIX_ADMIN_TOKEN": "paste-your-admin-token-here"
 *         }
 *       }
 *     }
 *   }
 *
 * What you get: one `login_<provider>` tool per configured auth provider, a
 * `logout` tool, a `list_endpoints` tool, and one `endpoint_<id>` tool per
 * configured endpoint. Call the right `login_*` tool first for any endpoint
 * whose gateway requires auth -- the tool descriptions say which provider.
 */

const readline = require('node:readline');

const BASE_URL = (process.env.NAIMIX_BASE_URL || '').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.NAIMIX_ADMIN_TOKEN || '';

if (!BASE_URL) {
  process.stderr.write('[naimix-mcp] NAIMIX_BASE_URL is required (e.g. http://localhost:3000)\n');
  process.exit(1);
}
if (!ADMIN_TOKEN) {
  process.stderr.write('[naimix-mcp] NAIMIX_ADMIN_TOKEN is required (your naimix instance\'s ADMIN_TOKEN value)\n');
  process.exit(1);
}

/* -----------------------------------------------------------------------
 * Workspace discovery (admin API -- read-only, only called at startup)
 * --------------------------------------------------------------------- */

async function adminFetch(path) {
  const res = await fetch(`${BASE_URL}/admin/api${path}`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET /admin/api${path} -> ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

async function loadWorkspace() {
  const [endpoints, gateways, authProviders] = await Promise.all([
    adminFetch('/endpoints'),
    adminFetch('/gateways'),
    adminFetch('/auth-providers'),
  ]);
  return { endpoints, gateways, authProviders };
}

/** The gateway name a backend config references, if any -- mirrors
 * naimix's own getBackendGatewayName() in src/connectors/index.ts. */
function backendGatewayName(backend) {
  return backend && typeof backend === 'object' && 'gateway' in backend ? backend.gateway : undefined;
}

/** The auth provider name (if any) an endpoint's gateway requires a caller
 * session from -- mirrors dispatch.ts's own lookup at request time. */
function gatewayRequiresAuth(endpoint, gateways) {
  const gwName = backendGatewayName(endpoint.backend);
  if (!gwName) return undefined;
  const gw = gateways[gwName];
  return gw && gw.requiresAuth;
}

/* -----------------------------------------------------------------------
 * Tool naming / schema helpers
 * --------------------------------------------------------------------- */

function sanitizeToolName(id) {
  return String(id)
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '') || 'unnamed';
}

function jsonSchemaTypeFor(type) {
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  return 'string';
}

function jsonSchemaForParam(p) {
  return {
    type: jsonSchemaTypeFor(p.type),
    description: [p.description, `(${p.in} parameter)`].filter(Boolean).join(' '),
    ...(p.default !== undefined ? { default: p.default } : {}),
  };
}

/** Builds the MCP tool definition + a closure that executes it for one
 * configured endpoint. All credential handling for auth is out of band --
 * see doLogin/session store below -- this only attaches whichever session
 * token that provider already has, if the endpoint needs one. */
function buildEndpointTool(endpoint, requiresAuth) {
  const name = `endpoint_${sanitizeToolName(endpoint.id)}`;
  const properties = {};
  const required = [];
  for (const p of endpoint.input || []) {
    if (p.in === 'env') continue; // sourced from the SERVER's own environment, never the caller
    properties[p.name] = jsonSchemaForParam(p);
    if (p.required) required.push(p.name);
  }

  const description = [
    endpoint.description || `${endpoint.method} ${endpoint.path}`,
    requiresAuth ? `Requires a session from the "${requiresAuth}" auth provider -- call login_${sanitizeToolName(requiresAuth)} first.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    definition: {
      name,
      description,
      inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    },
    requiresAuth,
    async call(args) {
      return callEndpoint(endpoint, args || {}, requiresAuth);
    },
  };
}

/** Builds the login_<name> tool for one auth provider. Every provider kind
 * (basicLogin/oauth2/ldap) reads only username/password from credentials --
 * confirmed against each provider's login() implementation -- except an
 * oauth2 client_credentials provider, which reads neither (it authenticates
 * as naimix itself, not an end user), so its tool takes no input at all. */
function buildLoginTool(providerName, config) {
  const name = `login_${sanitizeToolName(providerName)}`;
  const isClientCredentials = config.kind === 'oauth2' && config.grantType === 'client_credentials';

  const properties = isClientCredentials
    ? {}
    : {
        username: { type: 'string', description: 'Username to authenticate with.' },
        password: { type: 'string', description: 'Password to authenticate with.' },
      };
  const required = isClientCredentials ? [] : ['username', 'password'];

  const description = isClientCredentials
    ? `Log in to the "${providerName}" auth provider (${config.kind}, client_credentials -- no user credentials needed; this authenticates as the middleware itself).`
    : `Log in to the "${providerName}" auth provider (${config.kind}) with a username and password. Stores the returned session in memory for this MCP server process; subsequent tool calls to endpoints requiring this provider use it automatically.`;

  return {
    definition: {
      name,
      description,
      inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    },
    async call(args) {
      return doLogin(providerName, args || {});
    },
  };
}

/* -----------------------------------------------------------------------
 * In-memory session store -- one session per auth provider name, held only
 * for the lifetime of this process (an MCP client's one conversation, in
 * the common case). Nothing here is persisted to disk.
 * --------------------------------------------------------------------- */

const sessions = new Map(); // providerName -> { token, expiresAt }

async function doLogin(providerName, credentials) {
  const res = await fetch(`${BASE_URL}/auth/login/${encodeURIComponent(providerName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    return { isError: true, text: `Login to "${providerName}" failed (${res.status}): ${data.message || text || res.statusText}` };
  }
  sessions.set(providerName, { token: data.token, expiresAt: data.expiresAt });
  return {
    isError: false,
    text: `Logged in to "${providerName}".${data.expiresAt ? ` Session expires at ${new Date(data.expiresAt).toISOString()}.` : ''}`,
  };
}

async function doLogout(args) {
  const providerName = args && args.provider;
  const targets = providerName ? [providerName] : [...sessions.keys()];
  if (targets.length === 0) {
    return { isError: false, text: 'No active sessions to log out of.' };
  }
  const results = [];
  for (const name of targets) {
    const session = sessions.get(name);
    if (!session) {
      results.push(`"${name}": no active session.`);
      continue;
    }
    await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
    }).catch(() => {}); // logout is always treated as best-effort locally too
    sessions.delete(name);
    results.push(`"${name}": logged out.`);
  }
  return { isError: false, text: results.join(' ') };
}

async function doListEndpoints(endpoints, gateways) {
  const summary = endpoints.map((e) => ({
    id: e.id,
    method: e.method,
    path: e.path,
    description: e.description,
    requiresAuth: gatewayRequiresAuth(e, gateways) || null,
  }));
  return { isError: false, text: JSON.stringify(summary, null, 2) };
}

/** Substitutes {name} placeholders naimix uses in a path... actually naimix
 * paths use Express-style ":name" segments. Longer names are substituted
 * first so ":id" doesn't accidentally eat the front of ":idempotencyKey". */
function substitutePathParams(pathTemplate, params) {
  const names = Object.keys(params).sort((a, b) => b.length - a.length);
  let result = pathTemplate;
  for (const name of names) {
    const re = new RegExp(`:${name}(?![A-Za-z0-9_])`, 'g');
    result = result.replace(re, encodeURIComponent(String(params[name])));
  }
  return result;
}

async function callEndpoint(endpoint, args, requiresAuth) {
  let session;
  if (requiresAuth) {
    session = sessions.get(requiresAuth);
    if (!session) {
      return {
        isError: true,
        text: `This endpoint requires a session from the "${requiresAuth}" auth provider. Call login_${sanitizeToolName(requiresAuth)} first.`,
      };
    }
  }

  const pathParams = {};
  const query = new URLSearchParams();
  const headers = {};
  const bodyObj = {};
  let hasBody = false;

  for (const p of endpoint.input || []) {
    if (p.in === 'env') continue;
    const value = args[p.name];
    if (value === undefined) continue;
    if (p.in === 'path') pathParams[p.name] = value;
    else if (p.in === 'query') query.set(p.name, String(value));
    else if (p.in === 'header') headers[p.name] = String(value);
    else if (p.in === 'body') {
      bodyObj[p.name] = value;
      hasBody = true;
    }
  }

  const resolvedPath = substitutePathParams(endpoint.path, pathParams);
  const qs = query.toString();
  const url = `${BASE_URL}${resolvedPath}${qs ? `?${qs}` : ''}`;

  if (requiresAuth && session) {
    headers.Authorization = `Bearer ${session.token}`;
  }
  if (hasBody) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: endpoint.method,
    headers,
    body: hasBody ? JSON.stringify(bodyObj) : undefined,
  });
  const text = await res.text();

  return {
    isError: !res.ok,
    text: text || (res.ok ? '(empty response)' : `Request failed with status ${res.status}`),
  };
}

/* -----------------------------------------------------------------------
 * MCP stdio JSON-RPC server -- hand-rolled, newline-delimited JSON-RPC 2.0
 * over stdin/stdout. No SDK dependency; this is the entire protocol surface
 * an MCP client needs to list and call tools.
 * --------------------------------------------------------------------- */

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function main() {
  process.stderr.write(`[naimix-mcp] Discovering workspace at ${BASE_URL} ...\n`);
  const { endpoints, gateways, authProviders } = await loadWorkspace();
  process.stderr.write(
    `[naimix-mcp] Discovered ${endpoints.length} endpoint(s), ${Object.keys(gateways).length} gateway(s), ${Object.keys(authProviders).length} auth provider(s).\n`
  );

  const tools = new Map();

  tools.set('list_endpoints', {
    definition: {
      name: 'list_endpoints',
      description: 'Lists every endpoint configured in this naimix workspace, including which (if any) auth provider each one requires.',
      inputSchema: { type: 'object', properties: {} },
    },
    call: async () => doListEndpoints(endpoints, gateways),
  });

  tools.set('logout', {
    definition: {
      name: 'logout',
      description:
        'Logs out of one auth provider session held by this MCP server (pass "provider"), or every held session (omit it).',
      inputSchema: {
        type: 'object',
        properties: { provider: { type: 'string', description: 'Auth provider name to log out of. Omit to log out of all.' } },
      },
    },
    call: async (args) => doLogout(args || {}),
  });

  for (const [providerName, config] of Object.entries(authProviders)) {
    const tool = buildLoginTool(providerName, config);
    tools.set(tool.definition.name, tool);
  }

  for (const endpoint of endpoints) {
    const requiresAuth = gatewayRequiresAuth(endpoint, gateways);
    const tool = buildEndpointTool(endpoint, requiresAuth);
    tools.set(tool.definition.name, tool);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // not valid JSON-RPC -- silently ignore rather than crash the transport
    }

    const { id, method, params } = msg;

    (async () => {
      switch (method) {
        case 'initialize':
          respond(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'naimix-mcp-server', version: '1.0.0' },
          });
          break;

        case 'notifications/initialized':
          // No response expected for notifications.
          break;

        case 'ping':
          respond(id, {});
          break;

        case 'tools/list':
          respond(id, { tools: [...tools.values()].map((t) => t.definition) });
          break;

        case 'tools/call': {
          const toolName = params && params.name;
          const tool = tools.get(toolName);
          if (!tool) {
            respondError(id, -32602, `Unknown tool "${toolName}"`);
            break;
          }
          try {
            const result = await tool.call((params && params.arguments) || {});
            respond(id, {
              content: [{ type: 'text', text: result.text }],
              isError: Boolean(result.isError),
            });
          } catch (err) {
            respond(id, {
              content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            });
          }
          break;
        }

        // Declared but empty -- this server exposes tools only, not
        // resources or prompts. Answering these defensively (rather than
        // an error) keeps MCP clients that probe for them happy.
        case 'resources/list':
          respond(id, { resources: [] });
          break;

        case 'prompts/list':
          respond(id, { prompts: [] });
          break;

        default:
          if (id !== undefined) {
            respondError(id, -32601, `Method not found: ${method}`);
          }
      }
    })().catch((err) => {
      if (id !== undefined) {
        respondError(id, -32603, err instanceof Error ? err.message : String(err));
      }
    });
  });

  process.stderr.write('[naimix-mcp] Ready.\n');
}

main().catch((err) => {
  process.stderr.write(`[naimix-mcp] Fatal error during startup: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
