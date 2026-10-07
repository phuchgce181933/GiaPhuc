// Pure regression tests must not require production secrets or connect to a DB.
const defaults = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1:27017/giaphuc',
  JWT_SECRET: 'test-access-secret-only-not-for-deployment', JWT_REFRESH_SECRET: 'test-refresh-secret-only-not-for-deployment',
  MAIL_USER: 'test@example.invalid', MAIL_PASS: 'test-not-used' };
for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
