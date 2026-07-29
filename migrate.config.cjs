/** @type {import('node-pg-migrate').RunnerOption} */
module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  dir: 'migrations',
  direction: 'up',
  migrationsTable: 'pgmigrations',
  verbose: true,
  'migration-file-language': 'sql',
};
