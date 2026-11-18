#!/usr/bin/env node
/**
 * Create (or reset) the first dashboard admin.
 *   node scripts/create-admin.mjs you@example.com "Your Name" > admin.sql
 *   npx wrangler d1 execute DB --remote --file admin.sql && rm admin.sql
 * A random password is printed ONCE to stderr; only its PBKDF2 hash goes
 * into the SQL (same format as src/password.ts). Change it after signing in.
 */
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";

const email = (process.argv[2] ?? "").trim().toLowerCase();
const name = (process.argv[3] ?? "").trim() || email.split("@")[0];
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error(
    'Usage: node scripts/create-admin.mjs <email> ["Name"] > admin.sql',
  );
  process.exit(1);
}
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const password = [...randomBytes(18)]
  .map((b) => alphabet[b % alphabet.length])
  .join("");
const iterations = 100000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const stored = `pbkdf2$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
process.stdout.write(
  `INSERT INTO users (id, email, name, role, password_hash, created_at)
VALUES (${q(randomUUID())}, ${q(email)}, ${q(name)}, 'admin', ${q(stored)}, ${Date.now()})
ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = excluded.password_hash, disabled_at = NULL;\n`,
);
console.error(
  `\nAdmin ${email}, temporary password:\n\n  ${password}\n\nSign in at <PUBLIC_ORIGIN>/app/ and change it under Account.\n`,
);
