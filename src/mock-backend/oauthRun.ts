import { startMockOAuthServer } from "./oauthServer";

/**
 * Runs the mock OAuth server on its own, with the admin UI, for trying
 * naimix by hand: `npm run mock-oauth`, then open the printed /admin URL to
 * create issuers, clients and users. Everything is in memory.
 *
 *   MOCK_OAUTH_PORT  port to listen on (default 9100)
 *   MOCK_OAUTH_HOST  interface to bind (default 127.0.0.1)
 */
async function main(): Promise<void> {
  const port = Number(process.env.MOCK_OAUTH_PORT ?? 9100);
  const host = process.env.MOCK_OAUTH_HOST ?? "127.0.0.1";
  const server = await startMockOAuthServer({ port, host, admin: true });
  console.log(`Mock OAuth server listening on ${server.baseUrl}`);
  console.log(`Admin UI: ${server.baseUrl}/admin`);

  const shutdown = () => {
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
