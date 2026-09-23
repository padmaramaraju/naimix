import { Client, DN, Filter, InvalidCredentialsError, ResultCodeError, type Entry } from "ldapts";
import jwt from "jsonwebtoken";
import type { LdapProviderConfig } from "../../types/config";
import { AuthError } from "../../server/errors";
import type { AuthProvider, AuthResult } from "../types";

/**
 * LDAP/AD plain simple-bind provider -- step 2 of AUTH_DESIGN_NOTES.md's
 * phased build order. See LdapProviderConfig (src/types/config.ts) for the
 * two supported bind modes.
 *
 * LDAP/AD has no native "backend token" to relay to a downstream backend,
 * so on a successful bind this provider mints its own signed JWT (the
 * "stand-in signed backend token" decision in AUTH_DESIGN_NOTES.md) --
 * any backend that separately trusts this middleware (i.e. holds the same
 * `tokenSecret`) can verify it via the standard `sub`/`username`/`groups`
 * claims.
 *
 * No `refresh`: LDAP has no refresh concept (there's no token to renew,
 * just a bind that either still would or wouldn't succeed), so an expired
 * session here means a clean re-login -- same as basicLogin.
 */
export function createLdapProvider(name: string, config: LdapProviderConfig): AuthProvider {
  return {
    name,
    kind: "ldap",

    async login(credentials: Record<string, unknown>): Promise<AuthResult> {
      const username = credentials.username;
      const password = credentials.password;
      if (typeof username !== "string" || username.length === 0 || typeof password !== "string" || password.length === 0) {
        throw new AuthError("username and password are required");
      }

      const client = new Client({
        url: config.url,
        tlsOptions: config.tlsRejectUnauthorized === false ? { rejectUnauthorized: false } : undefined,
      });

      try {
        const userDn = config.userDnTemplate
          ? fillTemplate(config.userDnTemplate, { username: escapeDnValue(username) })
          : await resolveUserDn(client, config, username);

        await bindAs(client, userDn, password);

        // Group/attribute lookups need read access to more of the directory
        // than the end user necessarily has -- a real concern for AD and
        // most enterprise directories, where a regular account often can't
        // browse OUs like ou=groups itself, even anonymously-undisclosed
        // (many directories return the same noSuchObject an absent entry
        // would, rather than revealing that something exists but access is
        // denied). In search-then-bind mode there's already a service
        // account on hand -- its credentials just worked in resolveUserDn
        // above -- so rebind as it for these lookups instead of staying
        // bound as the caller. Direct-bind mode has no separate service
        // account configured, so those lookups still run as the caller
        // there, same as before.
        if (config.bindDn && config.bindPassword) {
          await bindAs(client, config.bindDn, config.bindPassword);
        }

        const attributes =
          config.attributes && config.attributes.length > 0
            ? await fetchAttributes(client, userDn, config.attributes)
            : undefined;

        const groups =
          config.groupSearchBase && config.groupSearchFilter
            ? await fetchGroups(client, config, userDn, username)
            : undefined;

        const claims: Record<string, unknown> = {};
        if (groups) claims.groups = groups;
        if (attributes) claims.attributes = attributes;

        const tokenTtlSeconds = config.tokenTtlSeconds ?? 3600;
        const backendToken = jwt.sign(
          { sub: userDn, username, ...(groups ? { groups } : {}) },
          config.tokenSecret,
          { algorithm: "HS256", expiresIn: tokenTtlSeconds },
        );

        return {
          backendToken,
          expiresAt: Date.now() + tokenTtlSeconds * 1000,
          subject: userDn,
          claims: Object.keys(claims).length > 0 ? claims : undefined,
        };
      } finally {
        // Best-effort: a failed bind may leave the connection unbound
        // already, and either way we're done with it after one login.
        await client.unbind().catch(() => {});
      }
    },
  };
}

/** Search-then-bind mode: binds as the configured service account, searches
 * for the real user DN, and returns it (not yet bound as that user --
 * `login()` does that next with the caller's own password). The realistic
 * pattern for Active Directory and most enterprise directories, where
 * usernames don't map predictably to a DN. */
async function resolveUserDn(client: Client, config: LdapProviderConfig, username: string): Promise<string> {
  if (!config.bindDn || !config.bindPassword || !config.searchBase || !config.searchFilter) {
    // Guarded by schema.ts's superRefine at config-load time; this is a
    // defensive backstop in case a config was constructed programmatically.
    throw new Error(`ldap provider is missing search-then-bind fields (bindDn/bindPassword/searchBase/searchFilter)`);
  }

  await bindAs(client, config.bindDn, config.bindPassword);

  const filter = fillTemplate(config.searchFilter, { username: Filter.escape(username) });
  const searchEntries = await runSearch(client, config.searchBase, {
    scope: "sub",
    filter,
    attributes: ["dn"],
    sizeLimit: 2,
  });

  if (searchEntries.length === 0) {
    throw new AuthError("Invalid username or password");
  }
  if (searchEntries.length > 1) {
    throw new AuthError(`Directory search for "${username}" matched more than one entry`);
  }
  return searchEntries[0].dn;
}

/** Binds the given (already-connected) client as `dn`/`password`, mapping
 * an LDAP-level rejection (wrong password, no such DN, etc.) to the same
 * caller-facing AuthError regardless of which of those it was -- callers
 * shouldn't be able to distinguish "no such user" from "wrong password". */
async function bindAs(client: Client, dn: string, password: string): Promise<void> {
  try {
    await client.bind(dn, password);
  } catch (err) {
    if (err instanceof InvalidCredentialsError || err instanceof ResultCodeError) {
      throw new AuthError("Invalid username or password");
    }
    throw err;
  }
}

/** Runs an ldapts search, converting any failure -- a missing/wrong base
 * DN, a malformed filter, an ACL denial, a network hiccup, ... -- into a
 * clear AuthError naming the base DN, instead of letting ldapts's own raw
 * error reach the caller/admin verbatim. Worth doing specifically because
 * ldapts's ResultCodeError builds its message as `${message} Code:
 * 0x${code}`, and falls back to a default message only when the server's
 * own diagnostic text is `undefined` -- an OpenLDAP server that replies
 * with resultCode 32 (noSuchObject) and an EMPTY diagnostic string (common
 * for e.g. a missing search base) produces the unhelpful bare " Code:
 * 0x20" otherwise (`??` doesn't treat "" as missing). */
async function runSearch(client: Client, baseDn: string, options: Parameters<Client["search"]>[1]): Promise<Entry[]> {
  try {
    const { searchEntries } = await client.search(baseDn, options);
    return searchEntries;
  } catch (err) {
    throw new AuthError(`Directory search under "${baseDn}" failed: ${describeLdapError(err)}`);
  }
}

function describeLdapError(err: unknown): string {
  if (err instanceof ResultCodeError) {
    return `${err.name.replace(/Error$/, "")} (LDAP result code ${err.code})`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Reads extra attributes off the resolved user entry, using whichever
 * identity `login()` left the connection bound as (the caller themselves
 * in direct-bind mode, or the service account in search-then-bind mode --
 * see the rebind in `login()` above). */
async function fetchAttributes(client: Client, userDn: string, attributeNames: string[]): Promise<Record<string, unknown> | undefined> {
  const searchEntries = await runSearch(client, userDn, {
    scope: "base",
    filter: "(objectClass=*)",
    attributes: attributeNames,
  });
  const entry = searchEntries[0];
  if (!entry) return undefined;

  const out: Record<string, unknown> = {};
  for (const attributeName of attributeNames) {
    const value = firstString(entry[attributeName]);
    if (value !== undefined) out[attributeName] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Optional group-membership lookup, run after a successful bind (see
 * LdapProviderConfig.groupSearchBase/groupSearchFilter). Both `{dn}` and
 * `{username}` are LDAP-filter-escaped before substitution -- the DN came
 * out of a directory search rather than directly off the wire, but it can
 * still contain characters that are meaningful in a filter, so it gets the
 * same treatment as any other value interpolated into one. */
async function fetchGroups(client: Client, config: LdapProviderConfig, userDn: string, username: string): Promise<string[] | undefined> {
  const groupNameAttribute = config.groupNameAttribute ?? "cn";
  const filter = fillTemplate(config.groupSearchFilter!, {
    dn: Filter.escape(userDn),
    username: Filter.escape(username),
  });
  const searchEntries = await runSearch(client, config.groupSearchBase!, {
    scope: "sub",
    filter,
    attributes: [groupNameAttribute],
  });

  const groups = searchEntries.map((entry) => firstString(entry[groupNameAttribute])).filter((v): v is string => v !== undefined);
  return groups.length > 0 ? groups : undefined;
}

/** Substitutes `{placeholder}` tokens in a config-authored template string
 * with pre-escaped values. Unknown placeholders are left as-is. */
function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key] : match));
}

/** RFC 4514 DN-value escaping for an untrusted value being interpolated
 * into a `userDnTemplate` (see LdapProviderConfig). ldapts doesn't expose
 * its RDN-value escaping as a standalone function -- only via the `DN`/`RDN`
 * builder classes -- so this builds a throwaway single-attribute RDN and
 * strips its "x=" prefix to get the exact same escaping ldapts would apply
 * if the value were a real RDN, without reimplementing RFC 4514 by hand. */
function escapeDnValue(value: string): string {
  return new DN().addPairRDN("x", value).toString().slice(2);
}

/** Normalizes one Entry attribute value (string | string[] | Buffer |
 * Buffer[] | undefined) down to a single display string. */
function firstString(value: Entry[string] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) return undefined;
  return Buffer.isBuffer(first) ? first.toString("utf8") : first;
}
