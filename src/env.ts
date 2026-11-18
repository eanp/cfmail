export interface Env {
  DB: D1Database;
  EMAIL?: SendEmail;
  BUCKET?: R2Bucket;
  API_LIMIT?: RateLimit;
  HASH_SECRET?: string;
  /** Only for SEND_MODE=resend (relay outbound mail to Resend). */
  RESEND_API_KEY?: string;
  SEND_DOMAINS?: string;
  INBOUND_DOMAINS?: string;
  SEND_MODE?: string;
  PUBLIC_ORIGIN?: string;
  /** From address for invite / password-reset emails, e.g. "cfmail <noreply@example.com>". */
  SYSTEM_FROM?: string;
  /** Dashboard + webmail static files (public/). */
  ASSETS?: Fetcher;
}

export const VERSION = "0.2.0";

/** Comma-separated env list → lowercased array (empty = no restriction). */
export function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
