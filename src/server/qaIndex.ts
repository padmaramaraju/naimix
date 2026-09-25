import { startDataPlaneServer } from "./dataPlaneServer";

/**
 * QA entry point -- see dataPlaneServer.ts's own comment for why this is a
 * separate file from prodIndex.ts even though both call identical shared
 * logic today. Built/run via package.json's build:qa/start:qa/dev:qa.
 */
startDataPlaneServer("qa");
