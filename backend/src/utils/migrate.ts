// Minimal migration runner: applies migrations/*.sql in filename order, once each. Run: npm run db:migrate
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import config, { ROOT } from '../config';

async function main() {
  const conn = await mysql.createConnection({
    host: config.DB_HOST, port: config.DB_PORT, user: config.DB_USER, password: config.DB_PASSWORD,
    database: config.DB_NAME, multipleStatements: true,
  });
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);

  const [rows] = await conn.query('SELECT name FROM schema_migrations');
  const done = new Set((rows as { name: string }[]).map((r) => r.name));
  const dir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`Applying ${f} ...`);
    await conn.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
  }
  console.log('Migrations up to date.');
  await conn.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
