import * as ldap from "ldapjs";

/**
 * In-process fake LDAP server for the automated test suite -- the LDAP
 * counterpart to startMockBackend() (mock-backend/index.ts), which fakes
 * the JSON/XML/SOAP/SQL backends the same way. Not a real directory server:
 * just enough bind/search behavior to exercise the `ldap` AuthProvider
 * (both bind modes, group lookup, attribute capture) without depending on
 * Docker, which isn't reliably available in every environment this test
 * suite runs in.
 *
 * Deliberately mirrors docker/openldap's seed data exactly (see
 * docker/openldap/bootstrap/10-naimix-seed.ldif and its README) -- same
 * base DN, same three users, same three groups, same passwords -- so both
 * represent "the same naimix test directory": this one for CI/automated
 * tests, the real Docker container for manual/dev testing against an
 * actual `slapd`.
 */

export const BASE_DN = "dc=naimix,dc=test";
export const ADMIN_DN = `cn=admin,${BASE_DN}`;
export const ADMIN_PASSWORD = "adminpw123";
export const USER_PASSWORD = "password123";

interface FakeLdapEntry {
  dn: string;
  attributes: Record<string, string | string[]>;
  /** Plaintext, since this is a test-only in-memory fixture -- no need to
   * replicate real directories' password hashing here. */
  password?: string;
}

const PEOPLE_BASE = `ou=people,${BASE_DN}`;
const GROUPS_BASE = `ou=groups,${BASE_DN}`;

const ENTRIES: FakeLdapEntry[] = [
  { dn: PEOPLE_BASE, attributes: { objectClass: "organizationalUnit", ou: "people" } },
  { dn: GROUPS_BASE, attributes: { objectClass: "organizationalUnit", ou: "groups" } },
  {
    dn: `uid=jdoe,${PEOPLE_BASE}`,
    password: USER_PASSWORD,
    attributes: {
      objectClass: "inetOrgPerson",
      uid: "jdoe",
      cn: "Jane Doe",
      sn: "Doe",
      mail: "jdoe@naimix.test",
      title: "Software Engineer",
      departmentNumber: "Engineering",
    },
  },
  {
    dn: `uid=asmith,${PEOPLE_BASE}`,
    password: USER_PASSWORD,
    attributes: {
      objectClass: "inetOrgPerson",
      uid: "asmith",
      cn: "Alice Smith",
      sn: "Smith",
      mail: "asmith@naimix.test",
      title: "IT Administrator",
      departmentNumber: "IT",
    },
  },
  {
    dn: `uid=bwayne,${PEOPLE_BASE}`,
    password: USER_PASSWORD,
    attributes: {
      objectClass: "inetOrgPerson",
      uid: "bwayne",
      cn: "Bruce Wayne",
      sn: "Wayne",
      mail: "bwayne@naimix.test",
      title: "Account Executive",
      departmentNumber: "Sales",
    },
  },
  {
    dn: `cn=employees,${GROUPS_BASE}`,
    attributes: {
      objectClass: "groupOfNames",
      cn: "employees",
      member: [`uid=jdoe,${PEOPLE_BASE}`, `uid=asmith,${PEOPLE_BASE}`, `uid=bwayne,${PEOPLE_BASE}`],
    },
  },
  {
    dn: `cn=engineers,${GROUPS_BASE}`,
    attributes: { objectClass: "groupOfNames", cn: "engineers", member: `uid=jdoe,${PEOPLE_BASE}` },
  },
  {
    dn: `cn=admins,${GROUPS_BASE}`,
    attributes: { objectClass: "groupOfNames", cn: "admins", member: `uid=asmith,${PEOPLE_BASE}` },
  },
];

export interface FakeLdapServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

/** Starts the fake server on an ephemeral loopback port by default (pass an
 * explicit port for the CLI entrypoint below). */
export function startFakeLdapServer(port = 0): Promise<FakeLdapServerHandle> {
  const server = ldap.createServer();

  // Mounting at the base DN routes every bind/search under the whole tree
  // to these single handlers -- simpler than mounting one route per entry,
  // and this fixture is small enough that a linear scan per request is fine.
  //
  // req.dn comes back as a real ldap.DN instance for search requests, but
  // (in the installed ldapjs version, despite what its own docs say) as a
  // plain string for bind requests -- normalize with ldap.parseDN() so both
  // handlers can use the same DN.equals()/parentOf() API either way.
  server.bind(BASE_DN, (req: any, res: any, next: any) => {
    const dn: ldap.DN = typeof req.dn === "string" ? ldap.parseDN(req.dn) : req.dn;
    if (dn.equals(ADMIN_DN)) {
      if (req.credentials !== ADMIN_PASSWORD) return next(new ldap.InvalidCredentialsError());
      res.end();
      return next();
    }
    const entry = ENTRIES.find((e) => dn.equals(e.dn));
    if (!entry || entry.password === undefined) return next(new ldap.NoSuchObjectError(dn.toString()));
    if (req.credentials !== entry.password) return next(new ldap.InvalidCredentialsError());
    res.end();
    return next();
  });

  server.search(BASE_DN, (req: any, res: any, next: any) => {
    const dn: ldap.DN = typeof req.dn === "string" ? ldap.parseDN(req.dn) : req.dn;
    // Disables ldapjs's own requested-attributes filtering (its
    // SearchResponse.send() drops any entry attribute whose lowercased name
    // isn't found via a case-*sensitive* indexOf against the client's
    // requested attribute list -- so a mixed-case schema attribute name
    // like "departmentNumber", requested with that same casing, is
    // incorrectly treated as "not requested" and silently dropped; passing
    // `true` as send()'s second arg does NOT bypass this particular branch,
    // only the separate "_"-prefixed/notAttributes filtering). We already
    // return exactly the attributes each entry has, and the ldap
    // AuthProvider only reads the specific names it asked for back off the
    // entry, so ldapjs's redundant filtering isn't needed and is disabled
    // by clearing the request's own remembered attribute list.
    res.attributes = [];
    const candidates = ENTRIES.filter((entry) => {
      switch (req.scope) {
        case "base":
          return dn.equals(entry.dn);
        case "one": {
          if (dn.equals(entry.dn)) return false;
          const parent = ldap.parseDN(entry.dn).parent();
          return parent ? parent.equals(dn) : false;
        }
        case "sub":
        default:
          return dn.equals(entry.dn) || dn.parentOf(entry.dn);
      }
    });

    for (const entry of candidates) {
      if (req.filter.matches(entry.attributes)) {
        res.send({ dn: entry.dn, attributes: entry.attributes });
      }
    }
    res.end();
    return next();
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = (server as any).server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actualPort,
        url: `ldap://127.0.0.1:${actualPort}`,
        stop: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// Allow running this fixture standalone, e.g. `tsx src/mock-backend/ldapServer.ts`,
// mirroring mock-backend/index.ts's own CLI entrypoint -- handy for manually
// pointing an `ldap` auth provider config at it without the full test suite.
if (require.main === module) {
  const port = process.env.MOCK_LDAP_PORT ? Number(process.env.MOCK_LDAP_PORT) : 3389;
  startFakeLdapServer(port).then((handle) => {
    console.log(`Fake LDAP server listening at ${handle.url}`);
    console.log(`Base DN: ${BASE_DN}`);
    console.log(`Admin bind: ${ADMIN_DN} / ${ADMIN_PASSWORD}`);
    console.log(`Test users (password "${USER_PASSWORD}"): jdoe, asmith, bwayne`);
  });
}
