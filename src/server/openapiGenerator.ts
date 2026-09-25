import type { EndpointConfig, GatewayConfig, InputParamDef } from "../types/config";
import { getBackendGatewayName } from "../connectors";
import type { EndpointRegistry } from "./endpointRegistry";
import type { GatewaysRegistry } from "./gatewaysRegistry";
import type { AuthProvidersRegistry } from "./authProvidersRegistry";

export interface OpenApiGeneratorDeps {
  endpointRegistry: EndpointRegistry;
  gatewaysRegistry: GatewaysRegistry;
  authProvidersRegistry: AuthProvidersRegistry;
  /** e.g. `${req.protocol}://${req.get("host")}` -- the base URL callers
   * should use, as seen from the request that asked for this document. */
  baseUrl: string;
}

/** Converts naimix's Express-style path params (":id") to OpenAPI's own
 * ("{id}") syntax -- the only path-param spelling difference between the
 * two, since both otherwise use plain literal path segments. */
function toOpenApiPath(naimixPath: string): string {
  return naimixPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function openApiTypeFor(type: InputParamDef["type"]): "number" | "boolean" | "string" {
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  return "string";
}

/** Finds the auth provider name (if any) a caller must have a session from
 * to call this endpoint, by following backend -> gateway -> requiresAuth --
 * the exact same chain dispatch.ts follows at request time. Returns
 * undefined for an endpoint whose backend has no gateway, or whose gateway
 * doesn't require auth. */
function requiredAuthProvider(endpoint: EndpointConfig, gateways: Record<string, GatewayConfig>): string | undefined {
  const gatewayName = getBackendGatewayName(endpoint.backend);
  if (!gatewayName) return undefined;
  return gateways[gatewayName]?.requiresAuth;
}

function buildOperation(endpoint: EndpointConfig, gateways: Record<string, GatewayConfig>): Record<string, unknown> {
  const parameters: Record<string, unknown>[] = [];
  const bodyProperties: Record<string, unknown> = {};
  const bodyRequired: string[] = [];

  for (const p of endpoint.input ?? []) {
    // "env" params are sourced from this server's own process.env, never
    // from the caller -- they don't belong in a document describing what a
    // caller can/must send.
    if (p.in === "env") continue;

    if (p.in === "body") {
      bodyProperties[p.name] = {
        type: openApiTypeFor(p.type),
        ...(p.description ? { description: p.description } : {}),
        ...(p.default !== undefined ? { default: p.default } : {}),
      };
      if (p.required) bodyRequired.push(p.name);
      continue;
    }

    parameters.push({
      name: p.name,
      in: p.in, // "path" | "query" | "header"
      required: p.in === "path" ? true : Boolean(p.required),
      schema: { type: openApiTypeFor(p.type), ...(p.default !== undefined ? { default: p.default } : {}) },
      ...(p.description ? { description: p.description } : {}),
    });
  }

  const authProvider = requiredAuthProvider(endpoint, gateways);

  const operation: Record<string, unknown> = {
    operationId: endpoint.id,
    summary: endpoint.description || `${endpoint.method} ${endpoint.path}`,
    tags: [authProvider ? `Requires auth: ${authProvider}` : "Public endpoints"],
    ...(parameters.length > 0 ? { parameters } : {}),
    responses: {
      "200": {
        description: "Successful response",
        // OutputFieldDef carries no per-field type info to draw a precise
        // schema from -- see src/types/config.ts -- so the response shape is
        // deliberately left generic rather than guessed at.
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      },
      "400": { description: "Invalid request" },
      ...(authProvider ? { "401": { description: "Missing, invalid, or wrong-provider session token" } } : {}),
      "502": { description: "The backend this endpoint calls failed or was unreachable" },
    },
  };

  if (Object.keys(bodyProperties).length > 0) {
    operation.requestBody = {
      required: bodyRequired.length > 0,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: bodyProperties,
            ...(bodyRequired.length > 0 ? { required: bodyRequired } : {}),
          },
        },
      },
    };
  }

  if (authProvider) {
    operation.security = [{ sessionAuth: [] }];
    operation.description = `Requires a session token from the "${authProvider}" auth provider -- see POST /auth/login/${authProvider}.`;
  }

  return operation;
}

/**
 * Builds a full OpenAPI 3.0.3 document describing every currently-configured
 * endpoint in this workspace, plus the always-on caller-facing routes every
 * naimix instance exposes (/auth/login/{provider}, /auth/logout, /healthz,
 * /__endpoints). Reads live registry state on every call -- there's no
 * caching -- so downloading this again after an endpoint/gateway/auth-
 * provider change picks it up immediately with no separate "regenerate"
 * step. See GET /export/openapi.json in adminApi.ts, the only caller.
 */
export function generateOpenApiDocument({
  endpointRegistry,
  gatewaysRegistry,
  authProvidersRegistry,
  baseUrl,
}: OpenApiGeneratorDeps): Record<string, unknown> {
  const gateways = gatewaysRegistry.getResolved().gateways;
  const authProviders = authProvidersRegistry.getResolved().authProviders;
  const providerNames = Object.keys(authProviders);

  const paths: Record<string, Record<string, unknown>> = {};

  for (const endpoint of endpointRegistry.list()) {
    const openApiPath = toOpenApiPath(endpoint.path);
    paths[openApiPath] = {
      ...paths[openApiPath],
      [endpoint.method.toLowerCase()]: buildOperation(endpoint, gateways),
    };
  }

  if (providerNames.length > 0) {
    paths["/auth/login/{provider}"] = {
      post: {
        operationId: "login",
        summary: "Log in through one of this workspace's configured auth providers",
        description:
          "Every provider kind reads the same credential shape here: username/password for basicLogin, oauth2 (password grant), and ldap. Omit both for an oauth2 client_credentials provider, which authenticates as the middleware itself rather than an end user.",
        tags: ["Auth"],
        parameters: [
          {
            name: "provider",
            in: "path",
            required: true,
            schema: { type: "string", enum: providerNames },
          },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  username: { type: "string" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Login succeeded -- returns an opaque session token",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: {
                      type: "string",
                      description:
                        "Opaque bearer token -- send as \"Authorization: Bearer <token>\" to endpoints requiring this provider. Not a JWT the caller can decode.",
                    },
                    expiresAt: { type: "number", description: "Unix ms timestamp, when the provider reports one." },
                  },
                },
              },
            },
          },
          "400": { description: "Unknown provider or malformed request body" },
          "401": { description: "Invalid credentials" },
        },
      },
    };

    paths["/auth/logout"] = {
      post: {
        operationId: "logout",
        summary: "Revoke the caller's current session",
        tags: ["Auth"],
        security: [{ sessionAuth: [] }],
        responses: {
          "204": { description: "Session revoked (always returned, even if the token was already invalid or absent)" },
        },
      },
    };
  }

  paths["/healthz"] = {
    get: {
      operationId: "healthCheck",
      summary: "Liveness check",
      tags: ["Meta"],
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string" }, endpointCount: { type: "number" } },
              },
            },
          },
        },
      },
    },
  };

  paths["/__endpoints"] = {
    get: {
      operationId: "listEndpoints",
      summary: "Introspection: lists every endpoint configured in this workspace",
      tags: ["Meta"],
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    method: { type: "string" },
                    path: { type: "string" },
                    description: { type: "string" },
                    backendType: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  return {
    openapi: "3.0.3",
    info: {
      title: "Naimix Workspace API",
      description:
        "Auto-generated from this naimix workspace's live endpoint, gateway, and auth-provider configuration. Download it again after any config change to pick up the current shape -- there is no separate regeneration step.",
      version: new Date().toISOString(),
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      securitySchemes: {
        sessionAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Opaque session token returned by POST /auth/login/{provider}. It is not a JWT the caller can decode or verify -- naimix holds the real backend token/credentials server-side and resolves this token to them on each call. See AUTH_DESIGN_NOTES.md.",
        },
      },
    },
  };
}
