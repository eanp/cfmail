/** Small helpers: ids, hashing, base64, address parsing. */

export const now = () => Date.now();
export const iso = (ms: number) => new Date(ms).toISOString();

export function uuid(): string {
  return crypto.randomUUID();
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(s: string): Uint8Array {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  );
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmac(
  keyBytes: Uint8Array,
  data: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export interface Addr {
  email: string;
  name?: string;
}

/** "Name <a@b.c>" or "a@b.c" → { email, name }. Throws on invalid input. */
export function parseAddress(v: unknown): Addr {
  if (typeof v !== "string") throw new Error("Address must be a string.");
  const s = v.trim();
  const m = /^(.*)<([^<>]+)>\s*$/.exec(s);
  const email = (m ? m[2]! : s).trim();
  const name = m
    ? m[1]!
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim()
    : "";
  if (!EMAIL_RE.test(email) || email.length > 254)
    throw new Error(`Invalid email address: ${s.slice(0, 80)}`);
  return name ? { email, name } : { email };
}

/** string | string[] | undefined → Addr[] (validated). */
export function parseAddressList(v: unknown): Addr[] {
  if (v === undefined || v === null || v === "") return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(parseAddress);
}

export function formatAddr(a: Addr): string {
  return a.name ? `${a.name.replace(/[<>"]/g, "")} <${a.email}>` : a.email;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  ics: "text/calendar",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function guessType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}
