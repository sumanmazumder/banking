// Creates the initial Super Admin if none exists. Run: npm run db:seed
import argon2 from 'argon2';
import { v4 as uuid } from 'uuid';
import config from '../config';
import { execute, one, pool } from '../db';

async function main() {
  if (await one("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1")) {
    console.log('A super admin already exists - skipping seed.');
  } else {
    const hash = await argon2.hash(config.SEED_ADMIN_PASSWORD, { type: argon2.argon2id });
    await execute(
      `INSERT INTO users (public_id, email, password_hash, role, status, full_name, email_verified_at)
       VALUES (?, ?, ?, 'super_admin', 'active', 'Super Admin', UTC_TIMESTAMP())`,
      [uuid(), config.SEED_ADMIN_EMAIL.toLowerCase(), hash]
    );
    console.log(`Super admin created: ${config.SEED_ADMIN_EMAIL} (change the password after first login).`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
