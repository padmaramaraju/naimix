import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import * as soap from "soap";
import crypto from "node:crypto";
import { customers, findCustomer } from "./data";
import { seedDb } from "./seedDb";

// Standalone mock backend server used for local development AND the
// automated tests (see test/middleware.test.ts). It exposes the SAME demo
// dataset through a JSON REST API, an XML API, and a SOAP service, and seeds
// a SQLite DB with it too -- so every connector type in the middleware has
// something real to call.

export interface MockBackendHandle {
  server: http.Server;
  port: number;
  stop: () => Promise<void>;
}

/** Builds and starts the mock backend on `port`, seeding `sqlitePath` first. */
export async function startMockBackend(port: number, sqlitePath: string): Promise<MockBackendHandle> {
  seedDb(sqlitePath);

  const app = express();
  app.use(express.text({ type: ["application/xml", "text/xml"] }));
  app.use(express.json());
  // Needed for the OAuth2 token endpoint below, which -- like every real
  // OAuth2 token endpoint (RFC 6749) -- takes a form-encoded body, not JSON.
  app.use(express.urlencoded({ extended: false }));

  // In-memory authorization codes for the /oauth/authorize + /oauth/token
  // authorizationCode-grant pair below -- single-use, process-lifetime only.
  const pendingAuthCodes = new Map<string, { redirectUri: string; codeChallenge?: string; createdAt: number }>();

  // ---- Generic XML ----
  // Registered before the "/customers/:id" JSON route below: Express matches
  // routes in registration order, and "/customers/xml" would otherwise be
  // swallowed by "/customers/:id" (treating "xml" as an :id).
  app.get("/customers/xml", (_req, res) => {
    res.type("application/xml").send(customersToXml(customers));
  });
  app.get("/customers/:id/xml", (req, res) => {
    const c = findCustomer(req.params.id);
    if (!c) return res.status(404).type("application/xml").send("<error>Customer not found</error>");
    res.type("application/xml").send(customerToXml(c));
  });

  // ---- Echo (test/dev helper) ----
  // Reflects back whatever query params and headers it was called with, so
  // tests (and manual "Try it" exploration in the console UI) can confirm a
  // {paramName} placeholder actually resolved to the value it should have --
  // useful for gateway commonParams and env-sourced input params, which
  // don't change what the fixed demo customer records look like.
  app.get("/echo", (req, res) => {
    res.json({ query: req.query, headers: req.headers });
  });

  // ---- Auth (test/dev helper) ----
  // Exercises the "basicLogin" auth provider: a bespoke login API accepting
  // { username, password } and returning a token payload with its own
  // field names (not the OAuth2 standard ones -- that's the point of this
  // one existing separately from /oauth/token below).
  app.post("/login", (req, res) => {
    const { username, password } = (req.body ?? {}) as Record<string, string>;
    if (username === "demo" && password === "demo123") {
      return res.json({
        accessToken: `mock-backend-token-for-${username}`,
        refreshToken: `mock-basic-refresh-${username}`,
        expiresIn: 3600,
      });
    }
    res.status(401).json({ error: "invalid_credentials" });
  });

  // Exercises the "oauth2" auth provider: a standard RFC 6749 token
  // endpoint (form-encoded request, access_token/refresh_token/expires_in
  // response) supporting the password, client_credentials, refresh_token,
  // and authorization_code grants.
  app.post("/oauth/token", (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    if (body.client_id !== "demo-client" || body.client_secret !== "demo-secret") {
      return res.status(401).json({ error: "invalid_client" });
    }

    if (body.grant_type === "password") {
      if (body.username !== "demo" || body.password !== "demo123") {
        return res.status(400).json({ error: "invalid_grant" });
      }
    } else if (body.grant_type === "refresh_token") {
      if (!body.refresh_token || !body.refresh_token.startsWith("mock-oauth-refresh-")) {
        return res.status(400).json({ error: "invalid_grant" });
      }
    } else if (body.grant_type === "authorization_code") {
      const record = pendingAuthCodes.get(body.code ?? "");
      if (!record) {
        return res.status(400).json({ error: "invalid_grant", error_description: "unknown or already-used code" });
      }
      // Single-use, win or lose -- a replayed code can't be exchanged twice.
      pendingAuthCodes.delete(body.code ?? "");
      if (record.redirectUri !== body.redirect_uri) {
        return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      }
      if (record.codeChallenge) {
        const computed = crypto.createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
        if (computed !== record.codeChallenge) {
          return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        }
      }
    } else if (body.grant_type !== "client_credentials") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    res.json({
      access_token: `mock-oauth-access-${suffix}`,
      // A client_credentials grant authenticates the middleware itself, not
      // an end user -- real providers commonly issue no refresh token for
      // it, so this mirrors that instead of always returning one.
      ...(body.grant_type === "client_credentials" ? {} : { refresh_token: `mock-oauth-refresh-${suffix}` }),
      expires_in: 3600,
      token_type: "Bearer",
    });
  });

  // Exercises the "oauth2" provider's authorizationCode grant end-to-end:
  // a bare-bones stand-in for the real provider's own login page. GETting
  // this without `confirm=1` shows a one-click "log in as demo" page (so a
  // person testing the real redirect flow by hand via a browser sees
  // SOMETHING resembling a provider's login screen, rather than an
  // invisible instant bounce back); following that link re-GETs this same
  // URL with `confirm=1` added, which is what actually mints the code and
  // redirects back to naimix's callback (redirect_uri) with it attached.
  // Codes are single-use and kept only in memory -- fine for a local
  // dev/test double, not meant to resemble a real provider's persistence.
  app.get("/oauth/authorize", (req, res) => {
    const { response_type, client_id, redirect_uri, state, code_challenge, confirm } = req.query as Record<string, string | undefined>;
    if (response_type !== "code" || client_id !== "demo-client" || !redirect_uri) {
      return res.status(400).send("invalid_request: response_type must be \"code\" and client_id/redirect_uri are required");
    }

    if (confirm !== "1") {
      const continueUrl = new URL(req.originalUrl, `http://${req.headers.host}`);
      continueUrl.searchParams.set("confirm", "1");
      res.type("html").send(
        `<!doctype html><html><body style="font-family:sans-serif;max-width:420px;margin:4rem auto">` +
          `<h2>Mock Identity Provider</h2>` +
          `<p>This stands in for a real OAuth provider's own login page.</p>` +
          `<p><a href="${continueUrl.pathname}?${continueUrl.searchParams.toString()}">Continue as demo &rarr;</a></p>` +
          `</body></html>`
      );
      return;
    }

    const code = `mock-code-${crypto.randomBytes(16).toString("hex")}`;
    pendingAuthCodes.set(code, { redirectUri: redirect_uri, codeChallenge: code_challenge, createdAt: Date.now() });

    const dest = new URL(redirect_uri);
    dest.searchParams.set("code", code);
    if (state) dest.searchParams.set("state", state);
    res.redirect(302, dest.href);
  });

  // ---- JSON REST ----
  app.get("/customers", (_req, res) => {
    res.json(customers);
  });
  app.get("/customers/:id", (req, res) => {
    const c = findCustomer(req.params.id);
    if (!c) return res.status(404).json({ error: "Customer not found" });
    res.json(c);
  });

  // ---- SOAP ----
  const soapService = {
    CustomerService: {
      CustomerServicePort: {
        GetCustomer(args: { CustomerId: string }) {
          const c = findCustomer(args.CustomerId);
          if (!c) {
            throw { Fault: { Code: "Client", Reason: "Customer not found" } };
          }
          return { CustomerId: c.id, FirstName: c.firstName, LastName: c.lastName, City: c.city };
        },
      },
    },
  };
  const wsdlXml = fs.readFileSync(path.join(__dirname, "customerService.wsdl"), "utf8");

  const server = http.createServer(app);
  soap.listen(server, "/soap", soapService, wsdlXml);

  await new Promise<void>((resolve) => server.listen(port, resolve));

  return {
    server,
    port,
    stop: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function customerToXml(c: (typeof customers)[number]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<customer>
  <id>${c.id}</id>
  <firstName>${c.firstName}</firstName>
  <lastName>${c.lastName}</lastName>
  <address>
    <city>${c.city}</city>
    <country>${c.country}</country>
  </address>
  <status>${c.status}</status>
</customer>`;
}

// A collection response: repeated <customer> siblings under one <customers>
// wrapper -- fast-xml-parser turns repeated sibling tags into an array, which
// is exactly what a top-level array output.field's `root` is for (see
// config/endpoints/xml-customers-list.yaml).
function customersToXml(list: typeof customers): string {
  const items = list
    .map(
      (c) => `  <customer>
    <id>${c.id}</id>
    <firstName>${c.firstName}</firstName>
    <lastName>${c.lastName}</lastName>
    <status>${c.status}</status>
  </customer>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<customers>\n${items}\n</customers>`;
}

if (require.main === module) {
  const PORT = Number(process.env.MOCK_PORT ?? 5000);
  const sqlitePath = process.env.DEMO_SQLITE_PATH ?? "./data/demo.sqlite";
  startMockBackend(PORT, sqlitePath).then(() => {
    // eslint-disable-next-line no-console
    console.log(`Mock backend listening on http://localhost:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`  JSON: GET /customers, GET /customers/:id`);
    // eslint-disable-next-line no-console
    console.log(`  XML:  GET /customers/:id/xml, GET /customers/xml`);
    // eslint-disable-next-line no-console
    console.log(`  SOAP: /soap?wsdl (operation GetCustomer)`);
  });
}
