import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`API listening on port ${env.PORT} (${env.NODE_ENV})`);
});

server.on('error', (err) => {
  console.error('HTTP server failed to start:', err.message);
  process.exit(1);
});

// Graceful shutdown: stop accepting new connections, let in-flight requests
// finish, then close database connections. A timer forces exit if that hangs.
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    console.error(`Shutdown did not finish within ${env.SHUTDOWN_TIMEOUT_MS} ms, forcing exit.`);
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close((serverErr) => {
    closePool()
      .then(() => {
        console.log('Shutdown complete.');
        process.exit(serverErr ? 1 : 0);
      })
      .catch((poolErr: unknown) => {
        console.error('Error while closing the database pool:', poolErr);
        process.exit(1);
      });
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
