/** cfmail dashboard + webmail. Hash routes (#/mail, #/emails, …). */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, type Me } from "./api";
import { MeContext, Toasts } from "./kit";
import type { Permission } from "../src/permissions";
import { Forgot, LinkPage, Login } from "./pages/auth";
import {
  ApiKeys,
  Domains,
  EmailDetail,
  Emails,
  Overview,
  Webhooks,
} from "./pages/admin";
import { Account, Audit, Mailboxes, Roles, Users } from "./pages/team";
import { Mail } from "./pages/mail";

function useHash(): string {
  const [h, setH] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const f = () => setH(location.hash.slice(1) || "/");
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return h;
}

interface NavItem {
  path: string;
  label: string;
  icon: string;
  perm?: Permission;
}
const NAV: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { path: "/mail", label: "Mail", icon: "✉", perm: "mail:use" },
      { path: "/overview", label: "Overview", icon: "◔" },
    ],
  },
  {
    title: "Developers",
    items: [
      { path: "/emails", label: "Emails", icon: "⇅", perm: "emails:view" },
      { path: "/domains", label: "Domains", icon: "◎", perm: "domains:view" },
      {
        path: "/api-keys",
        label: "API keys",
        icon: "⚿",
        perm: "api_keys:manage",
      },
      {
        path: "/webhooks",
        label: "Webhooks",
        icon: "↯",
        perm: "webhooks:manage",
      },
    ],
  },
  {
    title: "Workspace",
    items: [
      {
        path: "/mailboxes",
        label: "Mailboxes",
        icon: "▤",
        perm: "mailboxes:manage",
      },
      { path: "/users", label: "Users", icon: "☺", perm: "users:view" },
      { path: "/roles", label: "Roles", icon: "◈", perm: "roles:manage" },
      { path: "/audit", label: "Audit log", icon: "≡", perm: "audit:view" },
    ],
  },
];

function Shell({ me, path }: { me: Me; path: string }) {
  const perms = me.user.permissions;
  const allowed = (i: NavItem) => !i.perm || perms.includes(i.perm);
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);
  const seg = "/" + (path.split("/")[1] ?? "");
  const home = perms.includes("mail:use") ? "/mail" : "/overview";
  if (path === "/") {
    location.replace(`#${home}`);
    return null;
  }
  const page = (() => {
    const parts = path.split("/").filter(Boolean);
    switch (seg) {
      case "/mail":
        return <Mail path={parts.slice(1)} />;
      case "/overview":
        return <Overview />;
      case "/emails":
        return parts[2] ? (
          <EmailDetail
            kind={parts[1] === "received" ? "received" : "sent"}
            id={parts[2]}
          />
        ) : (
          <Emails kind={parts[1] === "received" ? "received" : "sent"} />
        );
      case "/domains":
        return <Domains />;
      case "/api-keys":
        return <ApiKeys />;
      case "/webhooks":
        return <Webhooks id={parts[1]} />;
      case "/mailboxes":
        return <Mailboxes />;
      case "/users":
        return <Users />;
      case "/roles":
        return <Roles />;
      case "/audit":
        return <Audit />;
      case "/account":
        return <Account />;
      default:
        return (
          <div class="pad">
            Page not found. <a href={`#${home}`}>Go home</a>
          </div>
        );
    }
  })();
  return (
    <MeContext.Provider value={me}>
      <div class={`shell ${menu ? "menu-open" : ""}`}>
        <aside class="side">
          <a class="brand" href={`#${home}`}>
            <span class="logo">✉</span> cfmail
          </a>
          <nav>
            {NAV.map((g, gi) => {
              const items = g.items.filter(allowed);
              if (!items.length) return null;
              return (
                <div key={gi} class="nav-group">
                  {g.title && <div class="nav-title">{g.title}</div>}
                  {items.map((i) => (
                    <a
                      key={i.path}
                      href={`#${i.path}`}
                      class={seg === i.path ? "active" : ""}
                    >
                      <span class="nav-icon" aria-hidden="true">
                        {i.icon}
                      </span>
                      {i.label}
                    </a>
                  ))}
                </div>
              );
            })}
          </nav>
          <a
            class={`me ${seg === "/account" ? "active" : ""}`}
            href="#/account"
          >
            <span class="avatar">
              {(me.user.name || me.user.email)[0]!.toUpperCase()}
            </span>
            <span>
              <strong>{me.user.name}</strong>
              <small>{me.user.role_name}</small>
            </span>
          </a>
        </aside>
        <div class="topbar">
          <button class="icon" onClick={() => setMenu(!menu)} aria-label="Menu">
            ☰
          </button>
          <span>cfmail</span>
        </div>
        <main class={`main ${seg === "/mail" ? "full" : ""}`}>{page}</main>
      </div>
    </MeContext.Provider>
  );
}

function App() {
  const path = useHash();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = () => api<Me>("/me").then(setMe, () => setMe(null));
  useEffect(() => {
    void load();
    const out = () => setMe(null);
    window.addEventListener("cfm:signed-out", out);
    return () => window.removeEventListener("cfm:signed-out", out);
  }, []);

  const [, first, token] = path.split("/");
  if (first === "invite" || first === "reset")
    return <LinkPage purpose={first} token={token ?? ""} onDone={load} />;
  if (first === "forgot") return <Forgot />;
  if (me === undefined) return <div class="boot muted">Loading…</div>;
  if (me === null) return <Login onDone={load} />;
  return <Shell me={me} path={path} />;
}

render(
  <>
    <App />
    <Toasts />
  </>,
  document.getElementById("app")!,
);
