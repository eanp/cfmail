/** Small UI kit: data loading, buttons, modals, toasts, formatting. */
import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Me } from "./api";
import type { Permission } from "../src/permissions";

export const MeContext = createContext<Me | null>(null);
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("not signed in");
  return me;
}
export function useCan(p: Permission): boolean {
  return useMe().user.permissions.includes(p);
}

/** Load data; `reload()` refetches. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: Error) => {
        if (!live) return;
        setError(e.message);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload, setData };
}

// ── toasts ─────────────────────────────────────────────────────────────────
type Toast = { id: number; text: string; kind: "ok" | "err" };
let pushToast: (t: Omit<Toast, "id">) => void = () => {};
export const toast = {
  ok: (text: string) => pushToast({ text, kind: "ok" }),
  err: (text: string) => pushToast({ text, kind: "err" }),
};
export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let id = 0;
    pushToast = (t) => {
      const item = { ...t, id: ++id };
      setItems((xs) => [...xs, item]);
      setTimeout(
        () => setItems((xs) => xs.filter((x) => x.id !== item.id)),
        t.kind === "err" ? 6000 : 3000,
      );
    };
  }, []);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Run an async action with a busy flag and an error toast. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (ok) toast.ok(ok);
        return r;
      } catch (e) {
        toast.err((e as Error).message);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  return { busy, run };
}

// ── layout pieces ──────────────────────────────────────────────────────────
export function Page(props: {
  title: string;
  sub?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="page">
      <header class="page-head">
        <div>
          <h1>{props.title}</h1>
          {props.sub && <p class="muted">{props.sub}</p>}
        </div>
        <div class="row">{props.actions}</div>
      </header>
      {props.children}
    </section>
  );
}

export function Loading({ error }: { error?: string | null }) {
  if (error) return <div class="notice err">{error}</div>;
  return <div class="muted pad">Loading…</div>;
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="empty">{children}</div>;
}

export function Badge(props: {
  kind?: "ok" | "warn" | "err" | "muted" | "info";
  children: ComponentChildren;
}) {
  return <span class={`badge ${props.kind ?? "muted"}`}>{props.children}</span>;
}

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [props.onClose]);
  return (
    <div class="modal-bg" onClick={props.onClose}>
      <div
        class={`modal ${props.wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{props.title}</h2>
          <button class="icon" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function Field(props: {
  label: string;
  hint?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <label class="field">
      <span>{props.label}</span>
      {props.children}
      {props.hint && <small class="muted">{props.hint}</small>}
    </label>
  );
}

/** A secret shown once, with a copy button. */
export function Secret({ value, note }: { value: string; note?: string }) {
  return (
    <div class="secret">
      <code>{value}</code>
      <button
        class="btn sm"
        onClick={() =>
          navigator.clipboard.writeText(value).then(() => toast.ok("Copied"))
        }
      >
        Copy
      </button>
      {note && <p class="muted">{note}</p>}
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre class="json">{JSON.stringify(value, null, 2)}</pre>;
}

// ── formatting ─────────────────────────────────────────────────────────────
export function fmtDate(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const d = new Date(v);
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function ago(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "never";
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(v).toLocaleDateString();
}

/** Short list-friendly time: today → 14:05, this year → 3 Nov, else date. */
export function shortTime(ms: number): string {
  const d = new Date(ms);
  const n = new Date();
  if (d.toDateString() === n.toDateString())
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  if (d.getFullYear() === n.getFullYear())
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return d.toLocaleDateString();
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "Name <a@b>" → "Name"; "a@b" → "a@b". */
export function displayName(addr: string): string {
  const m = /^(.*?)\s*<([^>]+)>$/.exec(addr);
  return m ? m[1]!.replace(/^"|"$/g, "") || m[2]! : addr;
}

export const onInput =
  (set: (v: string) => void) =>
  (
    e: JSX.TargetedEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
  ) =>
    set(e.currentTarget.value);

export function navigate(path: string) {
  location.hash = `#${path}`;
}
