#!/usr/bin/env node
/**
 * Create the first API key (later keys: POST /api-keys).
 *   node scripts/create-key.mjs "my app" [full_access|sending_access] > key.sql
 *   npx wrangler d1 execute DB --remote --file key.sql && rm key.sql
 * The key is printed ONCE to stderr; only its SHA-256 hash goes into the SQL.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

const name = (process.argv[2] ?? "").trim();
const permission =
  process.argv[3] === "sending_access" ? "sending_access" : "full_access";
if (!name) {
  console.error(
    'Usage: node scripts/create-key.mjs "<name>" [full_access|sending_access] > key.sql',
  );
  process.exit(1);
}
const token = `cfm_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(token).digest("hex");
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
process.stdout.write(
  `INSERT INTO api_keys (id, name, key_hash, prefix, permission, created_at) VALUES (${q(randomUUID())}, ${q(name)}, ${q(hash)}, ${q(token.slice(0, 10))}, ${q(permission)}, ${Date.now()});\n`,
);
console.error(
  `\nAPI key (${permission}) for "${name}":\n\n  ${token}\n\nStore it now; it is not shown again.\n`,
);
