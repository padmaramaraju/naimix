# Local LDAP test directory

A free, self-hosted [OpenLDAP](https://www.openldap.org/) server, seeded with a
small set of test users and groups -- for developing and testing the LDAP/AD
auth provider described in `AUTH_DESIGN_NOTES.md` (step 2 of the "Suggested
phased build order"). **Nothing here is a naimix feature yet** -- this is a
test fixture to build that feature *against*, the same role
`src/mock-backend` plays for the JSON/XML/SOAP/SQL connectors and the
`basicLogin`/`oauth2` auth providers.

Uses the [`osixia/openldap`](https://github.com/osixia/docker-openldap) image
-- free, widely used, no account or license needed. Requires Docker.

## Start it

```
docker compose -f docker/openldap/docker-compose.yml up
```

Add `-d` to run in the background. First start takes a few seconds longer
while it seeds from `bootstrap/10-naimix-seed.ldif`; that only happens once
-- the seed is skipped on later starts as long as the container's own data
volume still exists.

To wipe it back to a clean, freshly-seeded state (drop anything you changed
while testing):

```
docker compose -f docker/openldap/docker-compose.yml down -v
```

## Connection details

| | |
|---|---|
| Host / port | `localhost:3389` (mapped from the container's standard `389`) |
| Base DN | `dc=naimix,dc=test` |
| Admin bind DN | `cn=admin,dc=naimix,dc=test` |
| Admin password | `adminpw123` |

**Test users** (all under `ou=people,dc=naimix,dc=test`, all with password
`password123`):

| uid | Bind DN | Name | Department | Groups |
|---|---|---|---|---|
| `jdoe` | `uid=jdoe,ou=people,dc=naimix,dc=test` | Jane Doe | Engineering | `employees`, `engineers` |
| `asmith` | `uid=asmith,ou=people,dc=naimix,dc=test` | Alice Smith | IT | `employees`, `admins` |
| `bwayne` | `uid=bwayne,ou=people,dc=naimix,dc=test` | Bruce Wayne | Sales | `employees` |

Groups live under `ou=groups,dc=naimix,dc=test` as `groupOfNames` entries
(`cn=employees`, `cn=engineers`, `cn=admins`), each listing its members via
`member: <bind DN>` -- useful for testing a "bind, then look up group
membership" claims flow, not just a bare bind.

**This is a test fixture, not a secret.** These credentials are intentionally
simple and public in this repo -- never reuse them for anything real, and
never expose port `3389` outside your own machine.

## Quick smoke test

With the container running:

```
# A correct bind should succeed and echo the DN back:
ldapwhoami -x -H ldap://localhost:3389 -D "uid=jdoe,ou=people,dc=naimix,dc=test" -w password123

# A wrong password should fail with "Invalid credentials (49)":
ldapwhoami -x -H ldap://localhost:3389 -D "uid=jdoe,ou=people,dc=naimix,dc=test" -w wrongpassword

# Search jdoe's own attributes (as the admin):
ldapsearch -x -H ldap://localhost:3389 -D "cn=admin,dc=naimix,dc=test" -w adminpw123 \
  -b "ou=people,dc=naimix,dc=test" "(uid=jdoe)" cn mail title departmentNumber

# Find which groups asmith belongs to:
ldapsearch -x -H ldap://localhost:3389 -D "cn=admin,dc=naimix,dc=test" -w adminpw123 \
  -b "ou=groups,dc=naimix,dc=test" "(member=uid=asmith,ou=people,dc=naimix,dc=test)" cn
```

(`ldapwhoami`/`ldapsearch` come from the `ldap-utils` package on
Debian/Ubuntu, `openldap-clients` on RHEL/Fedora, or `openldap` via Homebrew
on macOS.)

These exact commands, and this exact bootstrap file, were verified against a
real standalone `slapd` instance before being committed -- both users' binds
succeeding, a wrong password correctly failing with error 49, and both
searches returning the expected entries.

## Why this instead of a public test server

`ldap.forumsys.com` and the FreeIPA public demo are fine for a one-off sanity
check, but neither is a good fit for active development: `forumsys.com` is
read-only, and the FreeIPA demo is wiped daily and shared with everyone else
using it. This container is yours -- free, private, and you can freely add
users/groups or point the future `ldap`/`ad` auth provider's TLS settings at
it without depending on infrastructure outside your control.
