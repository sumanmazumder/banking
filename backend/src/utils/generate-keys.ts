// Generates the RS256 key pair used to sign/verify JWT access tokens (SRS section 10).
// Usage: npm run keys:generate   (refuses to overwrite existing keys unless --force)
import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import path from 'path';

const dir = path.resolve(__dirname, '..', '..', 'keys');
const priv = path.join(dir, 'jwt_private.pem');
const pub = path.join(dir, 'jwt_public.pem');

if (fs.existsSync(priv) && !process.argv.includes('--force')) {
  console.log('Keys already exist in keys/. Use --force to regenerate (this logs everyone out).');
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
fs.writeFileSync(priv, privateKey, { mode: 0o600 });
fs.writeFileSync(pub, publicKey);
console.log('Generated RS256 keys in keys/');
