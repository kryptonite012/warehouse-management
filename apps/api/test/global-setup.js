// Applies migrations to a dedicated test database before the suite runs.
const { execSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/quickstore_test?schema=public';
  const root = path.resolve(__dirname, '../../..');
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate --schema database/prisma/schema.prisma', {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
};
