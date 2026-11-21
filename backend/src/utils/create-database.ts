// One-time helper: creates the database and a least-privilege app user using the MySQL admin account.
// Run: npm run db:create
import mysql from 'mysql2/promise';
import config from '../config';

const ident = (s: string) => '`' + s.replace(/`/g, '``') + '`';

async function main() {
  if (/^CHANGE_ME/.test(config.DB_PASSWORD) || /^CHANGE_ME/.test(config.DB_ADMIN_PASSWORD)) {
    console.error(`Set DB_PASSWORD and DB_ADMIN_PASSWORD in .env.${config.APP_ENV} first.`);
    process.exit(1);
  }
  // DDL can't bind identifiers, so validate the user name strictly.
  if (!/^[A-Za-z0-9_]+$/.test(config.DB_USER)) throw new Error('DB_USER may only contain letters, digits, underscore');

  const conn = await mysql.createConnection({
    host: config.DB_HOST, port: config.DB_PORT, user: config.DB_ADMIN_USER, password: config.DB_ADMIN_PASSWORD,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS ${ident(config.DB_NAME)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`CREATE USER IF NOT EXISTS '${config.DB_USER}'@'localhost' IDENTIFIED BY ?`, [config.DB_PASSWORD]);
  await conn.query(`ALTER USER '${config.DB_USER}'@'localhost' IDENTIFIED BY ?`, [config.DB_PASSWORD]);
  await conn.query(`GRANT ALL PRIVILEGES ON ${ident(config.DB_NAME)}.* TO '${config.DB_USER}'@'localhost'`);
  await conn.query('FLUSH PRIVILEGES');
  await conn.end();
  console.log(`Database "${config.DB_NAME}" and user "${config.DB_USER}"@localhost are ready.`);
}

main().catch((err) => {
  console.error('db:create failed:', err.message);
  process.exit(1);
});
