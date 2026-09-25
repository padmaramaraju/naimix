#!/usr/bin/env node
"use strict";

/**
 * Structural proof that a QA or Production build genuinely doesn't contain
 * the admin console, not just a comment asserting it -- see
 * dataPlaneApp.ts's own comment for the full reasoning. Run once per
 * target, right after esbuild bundles that target's own entry point:
 * `npm run build:qa` bundles src/server/qaIndex.ts then runs this against
 * dist-qa/server.js, and `npm run build:prod` does the same for
 * src/server/prodIndex.ts / dist-prod/server.js. Either invocation fails
 * the build (non-zero exit) if any of these admin-only identifiers turn up
 * in the bundled output, which would only happen if something in
 * dataPlaneApp.ts's module graph started importing adminApi.ts/adminAuth.ts
 * again, directly or transitively -- true for both targets alike, since
 * they share that exact same module graph via dataPlaneServer.ts.
 *
 * This is a coarse text search, not a real static-analysis tool -- on
 * purpose. It doesn't need to be clever: these exact identifiers only
 * exist in admin-only source files today (verified by grepping the repo
 * when this script was written), so their presence in the bundle is
 * exactly the regression this script exists to catch, and their absence is
 * a real (if simple) guarantee, not a guess.
 */

const fs = require("node:fs");
const path = require("node:path");

const BUNDLE_PATH = process.argv[2] || path.resolve(__dirname, "../dist-qa/server.js");

// One identifier per admin-only source file/concept it can only have come
// from -- see adminAuth.ts, adminApi.ts, and app.ts's own admin-mounting
// code for where each of these actually lives.
const FORBIDDEN = [
  "requireAdminAuth",
  "createAdminApiRouter",
  "AdminDisabled",
  "Missing or invalid admin token",
  "ADMIN_TOKEN",
  "adminUiDir",
  "generateCrudEndpointsForGateway",
  "generateOpenApiDocument",
];

function main() {
  if (!fs.existsSync(BUNDLE_PATH)) {
    console.error(`checkDataPlaneBundle: no bundle at ${BUNDLE_PATH} -- run the esbuild step first.`);
    process.exit(1);
  }

  const contents = fs.readFileSync(BUNDLE_PATH, "utf8");
  const found = FORBIDDEN.filter((needle) => contents.includes(needle));

  if (found.length > 0) {
    console.error(
      `checkDataPlaneBundle: FAILED -- the data-plane bundle at ${BUNDLE_PATH} contains admin-only code.\n` +
        `Found: ${found.join(", ")}\n` +
        "This means something in dataPlaneApp.ts's module graph now imports adminApi.ts/adminAuth.ts " +
        "(directly or transitively) -- the admin console must stay structurally absent from this build. " +
        "See src/server/dataPlaneApp.ts and coreApp.ts."
    );
    process.exit(1);
  }

  console.log(`checkDataPlaneBundle: OK -- no admin-only code found in ${BUNDLE_PATH}.`);
}

main();
