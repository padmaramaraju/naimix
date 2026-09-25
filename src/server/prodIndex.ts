import { startDataPlaneServer } from "./dataPlaneServer";

/**
 * Production entry point -- see dataPlaneServer.ts's own comment for why
 * this is a separate file from qaIndex.ts even though both call identical
 * shared logic today. Built/run via package.json's build:prod/start:prod/
 * dev:prod.
 */
startDataPlaneServer("prod");
