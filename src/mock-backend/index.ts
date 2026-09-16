import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import * as soap from "soap";
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
  // tests (and manual "Try it" exploration in the admin UI) can confirm a
  // {paramName} placeholder actually resolved to the value it should have --
  // useful for gateway commonParams and env-sourced input params, which
  // don't change what the fixed demo customer records look like.
  app.get("/echo", (req, res) => {
    res.json({ query: req.query, headers: req.headers });
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
// is exactly what output.root is for (see config/endpoints/xml-customers-list.yaml).
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
