import { match } from "path-to-regexp";
import type { AppRegistry } from "./appRegistry";
import type { IntegrationRegistry } from "./integrationRegistry";
import type { DeploymentMount, HttpMethod, InputParamDef, BackendConfig, OutputConfig } from "../types/config";

export interface MountedRoute {
  /** "<appId>:<routeId>" -- unique across every mounted App, even when two
   * Apps happen to reuse the same route id internally. */
  id: string;
  description?: string;
  method: HttpMethod;
  path: string;
  input: InputParamDef[];
  backend: BackendConfig;
  output: OutputConfig;
}

export interface MountedRouteMatch {
  endpoint: MountedRoute;
  params: Record<string, string>;
}

function joinBasePath(basePath: string, routePath: string): string {
  const trimmed = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return `${trimmed}${routePath}`;
}

/**
 * New -- see WORKSPACE_APPS_DESIGN_NOTES.md. This is what dispatch.ts
 * actually matches incoming requests against now, in place of the old
 * EndpointRegistry: for each {app, basePath} in deployment.yaml's
 * `mounts`, for each Route in that App, resolve its `integration` name
 * against IntegrationRegistry and synthesize one MountedRoute combining
 * the Route's public method+path (prefixed with the App's basePath) with
 * the Integration's backend-calling/output-mapping config. The resulting
 * shape is deliberately the same as the old EndpointConfigParsed -- it's
 * what lets dispatch.ts/coreApp.ts stay completely unchanged, just reading
 * from this instead of a raw EndpointRegistry.
 *
 * Deliberately uncached: every call reads straight from the live
 * AppRegistry/IntegrationRegistry and the (effectively static, hand-edited)
 * deployment mounts list, the same "reads the registry fresh per request"
 * philosophy coreApp.ts already documents for the old EndpointRegistry --
 * so an Integration or App edited through the console API is reflected on
 * the very next request, with no separate rebuild/invalidation step for
 * callers to remember. Recompiling each route's path-to-regexp matcher on
 * every call costs a little more than EndpointRegistry's old "compile once
 * at load time" -- an acceptable trade for a config-driven tool, not a
 * high-QPS gateway; worth revisiting only if it ever actually shows up as
 * a bottleneck.
 */
export class MountedRouteRegistry {
  constructor(
    private mounts: DeploymentMount[],
    private appRegistry: AppRegistry,
    private integrationRegistry: IntegrationRegistry
  ) {}

  /** Builds the full synthesized list fresh. `errors` surfaces an
   * unmounted-app or unknown-integration reference loudly (see
   * WORKSPACE_APPS_DESIGN_NOTES.md's "a bad reference is a load error, not
   * a silent no-op" convention) instead of silently skipping it. */
  private build(): { routes: MountedRoute[]; errors: string[] } {
    const routes: MountedRoute[] = [];
    const errors: string[] = [];

    for (const mount of this.mounts) {
      const app = this.appRegistry.get(mount.app);
      if (!app) {
        errors.push(`deployment.yaml mounts references unknown app "${mount.app}"`);
        continue;
      }
      for (const route of app.routes) {
        const integration = this.integrationRegistry.get(route.integration);
        if (!integration) {
          errors.push(
            `App "${app.id}" route "${route.id}" references unknown integration "${route.integration}"`
          );
          continue;
        }
        routes.push({
          id: `${app.id}:${route.id}`,
          description: route.description,
          method: route.method,
          path: joinBasePath(mount.basePath, route.path),
          input: integration.input ?? [],
          backend: integration.backend,
          output: integration.output,
        });
      }
    }

    return { routes, errors };
  }

  /** Boot-time/health-check visibility into anything currently unresolved
   * -- an unknown mounted app or an unknown integration reference. Empty
   * when everything mounted resolves cleanly. */
  errors(): string[] {
    return this.build().errors;
  }

  list(): MountedRoute[] {
    return this.build().routes;
  }

  /** Finds the mounted route (if any) whose method+path matches this
   * request -- same matching approach EndpointRegistry.match() used
   * (path-to-regexp's `match()`, first match wins). */
  match(method: string, pathname: string): MountedRouteMatch | undefined {
    for (const route of this.build().routes) {
      if (route.method !== method) continue;
      const matcher = match(route.path);
      const result = matcher(pathname);
      if (result) {
        return { endpoint: route, params: result.params as Record<string, string> };
      }
    }
    return undefined;
  }
}

/** The read-only surface `generateOpenApiDocument()` actually needs from
 * a route source -- narrower than the full `MountedRouteRegistry` class,
 * so a one-off, non-mount-dependent route list (see `resolveAppRoutes()`
 * below) can satisfy it too without faking the rest of that class's
 * (private) internals. */
export interface RouteSource {
  list(): MountedRoute[];
}

/**
 * Resolves one App's Routes into `MountedRoute[]` directly against
 * `IntegrationRegistry`, independent of whether that App actually appears
 * in deployment.yaml's `mounts` -- used by the Console's per-App OpenAPI
 * export (`GET /apps/:appId/export/openapi.json`), which describes just
 * one App's own routes rather than everything currently mounted. Mirrors
 * `MountedRouteRegistry.build()`'s own per-route resolution (and its "a
 * bad reference is a load error, not a silent no-op" convention via the
 * returned `errors`), just scoped to a single App instead of every mount.
 * `basePath` defaults to "/" since an App that isn't (yet) mounted has no
 * real basePath of its own to prefix with -- callers that know this App
 * IS currently mounted may pass its actual basePath instead.
 */
export function resolveAppRoutes(
  app: { id: string; routes: { id: string; description?: string; method: HttpMethod; path: string; integration: string }[] },
  integrationRegistry: IntegrationRegistry,
  basePath = "/"
): { routes: MountedRoute[]; errors: string[] } {
  const routes: MountedRoute[] = [];
  const errors: string[] = [];

  for (const route of app.routes) {
    const integration = integrationRegistry.get(route.integration);
    if (!integration) {
      errors.push(`App "${app.id}" route "${route.id}" references unknown integration "${route.integration}"`);
      continue;
    }
    routes.push({
      id: `${app.id}:${route.id}`,
      description: route.description,
      method: route.method,
      path: joinBasePath(basePath, route.path),
      input: integration.input ?? [],
      backend: integration.backend,
      output: integration.output,
    });
  }

  return { routes, errors };
}
