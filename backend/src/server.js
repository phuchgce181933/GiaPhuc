'use strict';

const app = require('./app');
const env = require('./config');
const { connectDB, disconnectDB } = require('./config/db');
const { ensureSystemRoles } = require('./modules/role/role.seed');

async function bootstrap() {
  await connectDB();
  await ensureSystemRoles();

  const server = app.listen(env.PORT, () => {
    console.log(`[server] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] received ${signal}, shutting down...`);
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});