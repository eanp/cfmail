// @ts-expect-error Node types are not installed (Worker types only).
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  looksSpoofed,
  messageIds,
  nextFolder,
  prefixSubject,
  snippetOf,
  textToHtml,
} from "../src/mail";
import { hashPassword, passwordProblem, verifyPassword } from "../src/password";
import {
  ALL_PERMISSIONS,
  effectivePermissions,
  isRoleKey,
  ungrantable,
} from "../src/permissions";
import { getCookie, sessionCookie } from "../src/session";

describe("RBAC", () => {
  it("gives admin every permission and filters unknown ones", () => {
    expect(effectivePermissions("admin", [])).toEqual(ALL_PERMISSIONS);
    expect(
      effectivePermissions("member", ["mail:use", "not:a-permission"]),
    ).toEqual(["mail:use"]);
  });

  it("refuses to grant permissions the actor does not hold", () => {
    expect(
      ungrantable(["mail:use", "users:manage"], ["mail:use", "roles:manage"]),
    ).toEqual(["roles:manage"]);
    expect(ungrantable(ALL_PERMISSIONS, ALL_PERMISSIONS)).toEqual([]);
  });

  it("validates role keys", () => {
    expect(isRoleKey("support")).toBe(true);
    expect(isRoleKey("Support")).toBe(false);
    expect(isRoleKey("a")).toBe(false);
    expect(isRoleKey("x; DROP")).toBe(false);
  });
});

describe("passwords", () => {
  it("hash and verify (PBKDF2, 100k iterations)", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^pbkdf2\$100000\$/);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("accept hashes made by scripts/create-admin.mjs", async () => {
    const out = execFileSync(
      (globalThis as unknown as { process: { execPath: string } }).process
        .execPath,
      [
        new URL(
          "../scripts/create-admin.mjs",
          (import.meta as unknown as { url: string }).url,
        ).pathname,
        "owner@example.com",
        "Owner",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const hash = /'(pbkdf2\$[^']+)'/.exec(out)![1]!;
    expect(hash).toMatch(/^pbkdf2\$100000\$/);
    expect(await verifyPassword("not the password", hash)).toBe(false);
  });

  it("rejects weak passwords", () => {
    expect(passwordProblem("short")).toMatch(/10 characters/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/guess/);
    expect(passwordProblem("budi-secret-2026", "budi@example.com")).toMatch(
      /email name/,
    );
    expect(passwordProblem("a long and fine passphrase")).toBeNull();
  });
});

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Strict, scoped to /app, Secure on https", () => {
    const c = sessionCookie(new Request("https://m.example.com/"), "tok", 1000);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/app");
    expect(c).toContain("Secure");
    expect(
      sessionCookie(new Request("http://localhost:8787/"), "t", 1000),
    ).not.toContain("Secure");
    const req = new Request("https://x/", {
      headers: { cookie: "a=1; cfm_session=abc=; b=2" },
    });
    expect(getCookie(req, "cfm_session")).toBe("abc=");
  });
});

describe("webmail helpers", () => {
  it("extracts Message-IDs", () => {
    expect(messageIds("<a@x> <b@y>")).toEqual(["a@x", "b@y"]);
    expect(messageIds(["<a@x>", "<c@z>"])).toEqual(["a@x", "c@z"]);
    expect(messageIds(undefined)).toEqual([]);
  });

  it("builds snippets from text or html", () => {
    expect(snippetOf("Hello\n\n  world", null)).toBe("Hello world");
    expect(
      snippetOf(null, "<style>p{}</style><p>Hi &amp; <b>bye</b></p>"),
    ).toBe("Hi & bye");
  });

  it("flags spoofed mail", () => {
    expect(looksSpoofed({ dmarc: "fail" })).toBe(true);
    expect(looksSpoofed({ spf: "softfail", dkim: "fail" })).toBe(true);
    expect(looksSpoofed({ spf: "fail", dkim: "pass" })).toBe(false);
    expect(looksSpoofed(null)).toBe(false);
  });

  it("moves messages between folders", () => {
    expect(nextFolder("inbox", "in", "archive", null)).toBe("archive");
    expect(nextFolder("sent", "out", "archive", null)).toBeNull();
    expect(nextFolder("inbox", "in", "trash", null)).toBe("trash");
    expect(nextFolder("trash", "in", "restore", "archive")).toBe("archive");
    expect(nextFolder("trash", "out", "restore", null)).toBe("sent");
    expect(nextFolder("spam", "in", "inbox", null)).toBe("inbox");
  });

  it("escapes plain text when converting to html", () => {
    const h = textToHtml("<script>x</script> see https://example.com/a?b=1");
    expect(h).not.toContain("<script>");
    expect(h).toContain('<a href="https://example.com/a?b=1">');
    expect(prefixSubject("Re", "Re: hi")).toBe("Re: hi");
    expect(prefixSubject("Fwd", "hi")).toBe("Fwd: hi");
  });
});
