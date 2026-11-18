import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { authResults, flatten, headerRecord } from "../src/inbound";
import { LIMITS, mapSendError, prepare, toBuilder } from "../src/send";
import { fromB64, parseAddress } from "../src/util";
import { newSecret, sign } from "../src/webhooks";
import { SAMPLE_EML } from "./fixtures";

/** Svix verification exactly as a Resend webhook receiver does it. */
async function verifySvix(
  secret: string,
  id: string,
  ts: string,
  body: string,
  header: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64(secret.slice(6)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${ts}.${body}`),
    ),
  );
  const expected = btoa(String.fromCharCode(...mac));
  return header.split(" ").some((p) => p === `v1,${expected}`);
}

describe("webhook signatures", () => {
  it("are Svix-compatible", async () => {
    const secret = newSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]+$/);
    const body = JSON.stringify({
      type: "email.received",
      data: { email_id: "x" },
    });
    const sig = await sign(secret, "msg_1", 1794700000, body);
    expect(await verifySvix(secret, "msg_1", "1794700000", body, sig)).toBe(
      true,
    );
    expect(await verifySvix(secret, "msg_1", "1794700001", body, sig)).toBe(
      false,
    );
  });
});

describe("addresses", () => {
  it("parses display names", () => {
    expect(parseAddress('"Example Inc" <noreply@example.com>')).toEqual({
      name: "Example Inc",
      email: "noreply@example.com",
    });
    expect(parseAddress("a@b.co")).toEqual({ email: "a@b.co" });
    expect(() => parseAddress("not an email")).toThrow();
  });
});

describe("prepare (Resend body → validated message)", () => {
  const base = {
    from: "Example Inc <noreply@example.com>",
    to: ["a@x.com"],
    subject: "Hello",
    html: "<p>hi</p>",
  };

  it("maps a Resend body to the send binding builder", () => {
    const p = prepare(
      {
        ...base,
        cc: "b@x.com",
        reply_to: ["sales@example.com"],
        headers: { "List-Unsubscribe": "<https://u>" },
        attachments: [{ filename: "a.pdf", content: "JVBERg==" }],
      },
      ["example.com"],
    );
    const b = toBuilder(p) as unknown as Record<string, unknown>;
    expect(b.from).toEqual({
      email: "noreply@example.com",
      name: "Example Inc",
    });
    expect(b.to).toEqual(["a@x.com"]);
    expect(b.cc).toEqual(["b@x.com"]);
    expect(b.replyTo).toBe("sales@example.com");
    expect(b.headers).toEqual({ "List-Unsubscribe": "<https://u>" });
    const att = (
      b.attachments as {
        type: string;
        disposition: string;
        content: Uint8Array;
      }[]
    )[0]!;
    expect(att.type).toBe("application/pdf");
    expect(att.disposition).toBe("attachment");
    expect(att.content.byteLength).toBe(4);
  });

  it("rejects bad input with clear messages", () => {
    expect(() =>
      prepare({ ...base, from: "x@other.com" }, ["example.com"]),
    ).toThrow(/not allowed/);
    expect(() => prepare({ ...base, to: undefined }, [])).toThrow(
      /Missing `to`/,
    );
    expect(() => prepare({ ...base, html: undefined }, [])).toThrow(/html/);
    expect(() => prepare({ ...base, scheduled_at: "in 1 hour" }, [])).toThrow(
      /scheduled_at/,
    );
    const many = Array.from(
      { length: LIMITS.recipients + 1 },
      (_, i) => `u${i}@x.com`,
    );
    expect(() => prepare({ ...base, to: many }, [])).toThrow(
      /Too many recipients/,
    );
  });

  it("maps binding error codes to HTTP statuses", () => {
    const e = (code: string) => Object.assign(new Error("x"), { code });
    expect(mapSendError(e("E_DAILY_LIMIT_EXCEEDED")).status).toBe(429);
    expect(mapSendError(e("E_SENDER_DOMAIN_NOT_AVAILABLE")).status).toBe(403);
    expect(mapSendError(e("E_RECIPIENT_SUPPRESSED")).status).toBe(422);
    expect(mapSendError(e("E_INTERNAL_SERVER_ERROR")).status).toBe(503);
    expect(mapSendError(e("E_EMAIL_SENDING_NOT_READY")).status).toBe(503);
    expect(mapSendError(e("E_SOMETHING_ELSE")).status).toBe(500);
  });
});

describe("inbound parsing", () => {
  it("extracts addresses, headers, auth results and attachments", async () => {
    const email = await PostalMime.parse(SAMPLE_EML, {
      attachmentEncoding: "arraybuffer",
    });
    expect(email.subject).toBe("Request for quotation: excavator");
    expect(flatten(email.to)).toEqual([
      "Sales <sales@example.com>",
      "admin@example.com",
    ]);
    expect(authResults(email.headers)).toEqual({
      dkim: "pass",
      dmarc: "pass",
      spf: "pass",
    });
    const h = headerRecord(email.headers);
    expect(Array.isArray(h["authentication-results"])).toBe(true);
    expect(email.html).toContain("cid:logo@vendor");
    expect(
      email.attachments.map((a) => [a.filename, a.disposition, a.contentId]),
    ).toEqual([
      ["logo.png", "inline", "<logo@vendor>"],
      ["rfq.pdf", "attachment", undefined],
    ]);
  });
});

describe("relay mode (SEND_MODE=resend)", () => {
  it("falls back to log when the needed binding or secret is missing", async () => {
    const { sendMode } = await import("../src/send");
    const env = { DB: {} as D1Database };
    expect(sendMode({ ...env, SEND_MODE: "resend" })).toBe("log");
    expect(
      sendMode({ ...env, SEND_MODE: "resend", RESEND_API_KEY: "re_x" }),
    ).toBe("resend");
    expect(sendMode({ ...env, SEND_MODE: "cloudflare" })).toBe("log");
    expect(
      sendMode({ ...env, SEND_MODE: "cloudflare", EMAIL: {} as SendEmail }),
    ).toBe("cloudflare");
  });

  it("forwards a Resend-shaped body and maps errors", async () => {
    const { viaResend } = await import("../src/send");
    const p = prepare(
      {
        from: "Example Inc <noreply@example.com>",
        to: "a@x.com",
        subject: "S",
        text: "T",
        attachments: [{ filename: "a.txt", content: "aXNp" }],
      },
      [],
    );
    const calls: { url: string; init: RequestInit }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1
        ? new Response(JSON.stringify({ id: "re_123" }), { status: 200 })
        : new Response(
            JSON.stringify({ name: "validation_error", message: "bad from" }),
            { status: 422 },
          );
    }) as typeof fetch;
    try {
      const env = { DB: {} as D1Database, RESEND_API_KEY: "re_key" };
      expect(await viaResend(env, p, "idem-1")).toBe("re_123");
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(calls[0]!.url).toBe("https://api.resend.com/emails");
      expect(body).toMatchObject({
        from: "Example Inc <noreply@example.com>",
        to: ["a@x.com"],
        subject: "S",
        text: "T",
      });
      expect(body.attachments[0]).toMatchObject({
        filename: "a.txt",
        content: "aXNp",
        content_type: "text/plain",
      });
      await expect(viaResend(env, p, "idem-2")).rejects.toMatchObject({
        status: 422,
        name: "validation_error",
      });
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("Message-ID handling for Email Sending", () => {
  it("splits a custom Message-ID off the headers", async () => {
    const { splitMessageId } = await import("../src/send");
    expect(
      splitMessageId({ "Message-ID": "<abc@app.id>", "X-Tag": "1" }),
    ).toEqual({ headers: { "X-Tag": "1" }, messageId: "abc@app.id" });
    expect(splitMessageId({ "message-id": "<a@b>" })).toEqual({
      messageId: "a@b",
    });
    expect(splitMessageId(undefined)).toEqual({ messageId: null });
  });

  it("rewrites In-Reply-To / References to the app's ids", async () => {
    const { restoreThreadIds } = await import("../src/inbound");
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [{ p: "cf1@example.com", r: "app1@example.com" }],
          }),
        }),
      }),
    } as unknown as D1Database;
    const out = await restoreThreadIds(
      { DB: db },
      {
        "in-reply-to": "<cf1@example.com>",
        references: "<x@y> <cf1@example.com>",
        subject: "s",
      },
    );
    expect(out["in-reply-to"]).toBe("<app1@example.com>");
    expect(out.references).toBe("<x@y> <app1@example.com>");
    expect(out.subject).toBe("s");
  });
});
