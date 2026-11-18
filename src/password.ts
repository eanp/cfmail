/**
 * PBKDF2-SHA256 passwords. 100,000 iterations is the hard limit of the
 * Workers runtime (higher works locally and fails on the edge).
 * Format: `pbkdf2$<iterations>$<salt b64url>$<hash b64url>`.
 * scripts/create-admin.mjs produces the same format.
 */
import { b64url, fromB64, randomBytes } from "./util";

export const ITERATIONS = 100_000;

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      256,
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (
    !Number.isInteger(iterations) ||
    iterations <= 0 ||
    iterations > ITERATIONS
  )
    return false;
  const got = await derive(password, fromB64(parts[2]!), iterations);
  const want = fromB64(parts[3]!);
  if (got.length !== want.length) return false;
  let r = 0;
  for (let i = 0; i < got.length; i++) r |= got[i]! ^ want[i]!;
  return r === 0;
}

/** Checked when the email is unknown, so response time does not reveal it. */
export const DUMMY_HASH =
  "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const COMMON = new Set([
  "password123",
  "1234567890",
  "qwertyuiop",
  "admin12345",
  "passw0rd123",
  "iloveyou123",
  "letmein1234",
]);

/** Problem with a new password, or null when acceptable. */
export function passwordProblem(pw: unknown, email = ""): string | null {
  if (typeof pw !== "string" || pw.length < 10)
    return "Password must be at least 10 characters.";
  if (pw.length > 200) return "Password is too long.";
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(pw))
    return "This password is too easy to guess.";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && lower.includes(local))
    return "Password must not contain your email name.";
  return null;
}
