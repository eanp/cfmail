/** Sign in, accept invite / reset password, forgot password. */
import { useState } from "preact/hooks";
import { api } from "../api";
import { Field, onInput, useAction, useLoad } from "../kit";

function AuthCard(props: {
  title: string;
  children: preact.ComponentChildren;
}) {
  return (
    <div class="auth">
      <form class="auth-card" onSubmit={(e) => e.preventDefault()}>
        <div class="brand big">
          <span class="logo">✉</span> cfmail
        </div>
        <h1>{props.title}</h1>
        {props.children}
      </form>
    </div>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const submit = () =>
    run(async () => {
      setError(null);
      try {
        await api("/auth/login", { body: { email, password } });
        location.hash = "#/";
        onDone();
      } catch (e) {
        setError((e as Error).message);
      }
    });
  return (
    <AuthCard title="Sign in">
      {error && <div class="notice err">{error}</div>}
      <Field label="Email">
        <input
          type="email"
          autocomplete="username"
          required
          value={email}
          onInput={onInput(setEmail)}
        />
      </Field>
      <Field label="Password">
        <input
          type="password"
          autocomplete="current-password"
          required
          value={password}
          onInput={onInput(setPassword)}
        />
      </Field>
      <button class="btn primary block" disabled={busy} onClick={submit}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <a class="small-link" href="#/forgot">
        Forgot password?
      </a>
    </AuthCard>
  );
}

export function LinkPage(props: {
  purpose: "invite" | "reset";
  token: string;
  onDone: () => void;
}) {
  const info = useLoad(
    () =>
      api<{ email: string; name: string; purpose: string }>(
        `/auth/link/${encodeURIComponent(props.token)}`,
      ),
    [props.token],
  );
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const title =
    props.purpose === "invite"
      ? "Welcome — set your password"
      : "Set a new password";
  if (info.loading) return <AuthCard title={title}>Checking link…</AuthCard>;
  if (info.error || !info.data)
    return (
      <AuthCard title="Link not valid">
        <p class="muted">{info.error}</p>
        <p class="muted">Ask an admin for a new link.</p>
        <a class="btn block" href="#/">
          Go to sign in
        </a>
      </AuthCard>
    );
  const submit = () =>
    run(async () => {
      setError(null);
      if (pw !== pw2) return setError("The passwords do not match.");
      try {
        await api(`/auth/link/${encodeURIComponent(props.token)}`, {
          body: { password: pw },
        });
        location.hash = "#/";
        props.onDone();
      } catch (e) {
        setError((e as Error).message);
      }
    });
  return (
    <AuthCard title={title}>
      <p class="muted">{info.data.email}</p>
      {error && <div class="notice err">{error}</div>}
      <input
        type="email"
        hidden
        autocomplete="username"
        value={info.data.email}
      />
      <Field label="New password" hint="At least 10 characters.">
        <input
          type="password"
          autocomplete="new-password"
          value={pw}
          onInput={onInput(setPw)}
        />
      </Field>
      <Field label="Repeat password">
        <input
          type="password"
          autocomplete="new-password"
          value={pw2}
          onInput={onInput(setPw2)}
        />
      </Field>
      <button class="btn primary block" disabled={busy} onClick={submit}>
        Save and sign in
      </button>
    </AuthCard>
  );
}

export function Forgot() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState<null | boolean>(null);
  const { busy, run } = useAction();
  const submit = () =>
    run(async () => {
      const r = await api<{ email_enabled: boolean }>("/auth/forgot", {
        body: { email },
      });
      setDone(r.email_enabled);
    });
  return (
    <AuthCard title="Reset password">
      {done === null ? (
        <>
          <Field label="Email">
            <input type="email" value={email} onInput={onInput(setEmail)} />
          </Field>
          <button class="btn primary block" disabled={busy} onClick={submit}>
            Send reset link
          </button>
        </>
      ) : done ? (
        <p>If an account exists for {email}, a reset link is on its way.</p>
      ) : (
        <p>
          This server does not send system emails. Ask an admin to create a
          reset link for you (Users → Reset password).
        </p>
      )}
      <a class="small-link" href="#/">
        Back to sign in
      </a>
    </AuthCard>
  );
}
