#!/usr/bin/env node
"use strict";

/**
 * Structural proof that a QA or Production build genuinely doesn't contain
 * the DEVELOPER console specifically, not just a comment asserting it --
 * see dataPlaneApp.ts's own comment for the full reasoning. This is
 * narrower than "no admin-shaped code of any kind": the Ops Console
 * (opsAuth.ts/opsApi.ts/opsMetrics.ts, mounted by coreApp.ts) is a
 * second, deliberately-included admin-shaped subsystem with its own
 * token (OPS_TOKEN) -- see OPS_CONSOLE_DESIGN_NOTES.md for why it's meant
 * to be present in every target, unlike the developer console below.
 * Finding Ops Console identifiers in a QA/Production bundle is expected
 * and correct; finding any of the FORBIDDEN developer-console identifiers
 * below is the actual regression this script exists to catch.
 *
 * Run once per target, right after esbuild bundles that target's own
 * entry point: `npm run build:qa` bundles src/server/qaIndex.ts then runs
 * this against dist-qa/server.js, and `npm run build:prod` does the same
 * for src/server/prodIndex.ts / dist-prod/server.js. Either invocation
 * fails the build (non-zero exit) if any of these console-only
 * identifiers turn up in the bundled output, which would only happen if
 * something in dataPlaneApp.ts's module graph started importing
 * consoleApi.ts/consoleAuth.ts again, directly or transitively -- true
 * for both targets alike, since they share that exact same module graph
 * via dataPlaneServer.ts.
 *
 * This is a coarse text search, not a real static-analysis tool -- on
 * purpose. It doesn't need to be clever: these exact identifiers only
 * exist in developer-console-only source files today (verified by
 * grepping the repo when this script was written), so their presence in
 * the bundle is exactly the regression this script exists to catch, and
 * their absence is a real (if simple) guarantee, not a guess.
 */

const fs = require("node:fs");
const path = require("node:path");

const BUNDLE_PATH = process.argv[2] || path.resolve(__dirname, "../dist-qa/server.js");

// One identifier per DEVELOPER-console-only source file/concept it can
// only have come from -- see consoleAuth.ts, consoleApi.ts, and app.ts's
// own console-mounting code for where each of these actually lives. Does
// NOT include Ops Console identifiers (opsAuth.ts/opsApi.ts/etc.) --
// those are supposed to be here; see the module doc comment above.
const FORBIDDEN = [
  "requireConsoleAuth",
  "createConsoleApiRouter",
  "ConsoleDisabled",
  "Missing or invalid console token",
  "CONSOLE_TOKEN",
  "consoleUiDir",
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
      `checkDataPlaneBundle: FAILED -- the data-plane bundle at ${BUNDLE_PATH} contains console-only code.\n` +
        `Found: ${found.join(", ")}\n` +
        "This means something in dataPlaneApp.ts's module graph now imports consoleApi.ts/consoleAuth.ts " +
        "(directly or transitively) -- the developer console must stay structurally absent from this build. " +
        "See src/server/dataPlaneApp.ts and coreApp.ts."
    );
    process.exit(1);
  }

  console.log(`checkDataPlaneBundle: OK -- no console-only code found in ${BUNDLE_PATH}.`);
}

main();
