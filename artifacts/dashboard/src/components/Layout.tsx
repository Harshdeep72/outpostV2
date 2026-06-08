import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

function discordOAuthUrl(): string {
  const raw = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
  const base = raw ? `${raw}/api` : "/api";
  return `${base}/admin/discord/oauth/start`;
}

type NavItem = {
  label: string;
  path: string;
  adminOnly?: boolean;
  icon: React.ReactNode;
};

const Icon = ({ d }: { d: string }) => (
  <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
  </svg>
);

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Overview",
    items: [
      { label: "Dashboard", path: "/admin", icon: <Icon d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /> },
    ],
  },
  {
    title: "Members",
    items: [
      { label: "Users", path: "/admin/users", icon: <Icon d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /> },
      { label: "Verified Users", path: "/admin/verified", icon: <Icon d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /> },
      { label: "Payment Methods", path: "/admin/payments", icon: <Icon d="M3 10h18M7 15h2m3 0h2M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" /> },
    ],
  },
  {
    title: "Tasks",
    items: [
      { label: "All Tasks", path: "/admin/tasks", icon: <Icon d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /> },
      { label: "Create Task", path: "/admin/tasks/new", icon: <Icon d="M12 4v16m8-8H4" /> },
      { label: "Bulk Create", path: "/admin/tasks/bulk", icon: <Icon d="M4 6h16M4 12h16M4 18h7" /> },
      { label: "Submissions", path: "/admin/submissions", icon: <Icon d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /> },
      { label: "Tasks by Creator", path: "/admin/tasks-by-creator", icon: <Icon d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /> },
      { label: "Creator Earnings", path: "/admin/creator-earnings", icon: <Icon d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /> },
      { label: "Fraud Signals", path: "/admin/fraud-signals", icon: <Icon d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /> },
      { label: "Cooldowns", path: "/admin/cooldowns", icon: <Icon d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /> },
      { label: "Exports (CSV)", path: "/admin/exports", icon: <Icon d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /> },
      { label: "Campaigns", path: "/admin/campaigns", icon: <Icon d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" /> },
    ],
  },
  {
    title: "Admin",
    items: [
      { label: "Applications", path: "/admin/applications", adminOnly: true, icon: <Icon d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5l5 5v11a2 2 0 01-2 2z" /> },
      { label: "Dashboard Users", path: "/admin/admin-users", adminOnly: true, icon: <Icon d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /> },
    ],
  },
  {
    title: "Tools",
    items: [
      { label: "Reddit Test", path: "/admin/reddit-test", icon: <Icon d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /> },
      { label: "Reddit Bulk Check", path: "/admin/reddit-bulk-check", icon: <Icon d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /> },
      { label: "Reddit Inspector", path: "/admin/reddit-inspector", icon: <Icon d="M10 21h4M12 17v4M12 3a7 7 0 00-7 7c0 2.5 1.5 4.5 3 6v2a2 2 0 002 2h4a2 2 0 002-2v-2c1.5-1.5 3-3.5 3-6a7 7 0 00-7-7z" /> },
      { label: "Console", path: "/admin/console", icon: <Icon d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /> },
      { label: "Settings", path: "/admin/settings", adminOnly: true, icon: <Icon d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z" /> },
    ],
  },
];

function pageTitle(location: string): string {
  const items = NAV_GROUPS.flatMap(g => g.items);
  // Prefer the longest path match so /admin/tasks/bulk wins over /admin/tasks.
  let best: { label: string; len: number } | null = null;
  for (const item of items) {
    if (item.path === location) return item.label;
    if (item.path !== "/admin" && location.startsWith(item.path + "/")) {
      if (!best || item.path.length > best.len) {
        best = { label: item.label, len: item.path.length };
      }
    }
  }
  return best?.label ?? "Outpost Bot";
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout, refresh } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // After Discord OAuth callback redirects back here with ?discord=linked,
  // refresh the user so the linked Discord identity shows up immediately.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("discord") === "linked") {
      refresh();
      params.delete("discord");
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState({}, "", newUrl);
    }
  }, [refresh]);
  // 'dev' is a higher-privileged role that ALSO sees admin-only items.
  const isAdmin = user?.role === "admin" || user?.role === "dev";
  const isDev = user?.role === "dev";

  const roleBadge = isDev
    ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
    : isAdmin
    ? "bg-zinc-100 text-zinc-900 border border-zinc-300/20"
    : "bg-zinc-800 text-zinc-300 border border-zinc-700";
  const roleLabel = isDev ? "DEV" : (user?.role ?? "").toUpperCase();

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 w-60 flex flex-col",
          "bg-zinc-950 border-r border-zinc-800",
          "transition-transform duration-150 ease-out",
          "lg:static lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-zinc-800">
          <div className="w-8 h-8 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 2 L4 7 v6 c0 4.5 3.4 8.4 8 9 4.6-.6 8-4.5 8-9 V7 L12 2 z M9 12 l2 2 4-4" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-zinc-100 tracking-tight truncate">Outpost Bot</p>
            <p className="text-[10px] text-zinc-500">Reddit operations</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
          {NAV_GROUPS.map(group => {
            const visible = group.items.filter(i => !i.adminOnly || isAdmin);
            if (visible.length === 0) return null;
            return (
              <div key={group.title} className="space-y-0.5">
                <p className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-600">
                  {group.title}
                </p>
                {visible.map(item => {
                  const active = location === item.path
                    || (item.path !== "/admin" && location.startsWith(item.path + "/")
                        && pageTitle(location) === item.label);
                  return (
                    <Link
                      key={item.path}
                      href={item.path}
                      onClick={() => setSidebarOpen(false)}
                      className={cn(
                        "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px]",
                        active
                          ? "bg-zinc-900 text-zinc-100 border border-zinc-800"
                          : "text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-100 border border-transparent"
                      )}
                    >
                      <span className={active ? "text-zinc-300" : "text-zinc-500"}>{item.icon}</span>
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="p-2.5 border-t border-zinc-800">
          <div className="flex items-center gap-2.5 px-2 py-2 mb-1.5 rounded-md bg-zinc-900 border border-zinc-800">
            {user?.discordAvatar ? (
              <img
                src={user.discordAvatar}
                alt=""
                className="w-8 h-8 rounded-md object-cover border border-zinc-700 shrink-0"
              />
            ) : (
              <div className="w-8 h-8 rounded-md bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[13px] font-semibold text-zinc-200 uppercase shrink-0">
                {user?.username?.[0]}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-zinc-100 truncate">{user?.username}</p>
              <span className={cn("inline-block mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-wider", roleBadge)}>
                {roleLabel}
              </span>
              {user?.discordUsername && (
                <p className="text-[10px] text-indigo-300 mt-0.5 truncate" title="Linked Discord account">
                  @{user.discordUsername}
                </p>
              )}
            </div>
          </div>
          {user?.discordId ? (
            <a
              href={discordOAuthUrl()}
              className="w-full mb-1.5 flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-[11px] font-medium text-indigo-300 hover:text-indigo-200 hover:bg-indigo-500/10 border border-indigo-500/30"
              title="Re-link your Discord account"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              Discord linked — Re-link
            </a>
          ) : (
            <a
              href={discordOAuthUrl()}
              className="w-full mb-1.5 flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-semibold text-white bg-indigo-600 hover:bg-indigo-500"
              title="Link your Discord account so created tasks/reviews show your name & avatar"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              Connect Discord
            </a>
          )}
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 border border-transparent hover:border-zinc-800"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="flex items-center gap-3 px-5 sm:px-7 py-3.5 border-b border-zinc-800 bg-zinc-950">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 rounded-md hover:bg-zinc-900 text-zinc-400 lg:hidden"
            aria-label="Open menu"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.12em] text-zinc-500">Dashboard</p>
            <h1 className="text-[15px] sm:text-base font-semibold text-zinc-100 truncate">{pageTitle(location)}</h1>
          </div>
          <div className="ml-auto hidden sm:flex items-center gap-2.5">
            <span className={cn("px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider", roleBadge)}>
              {roleLabel}
            </span>
            <div className="w-7 h-7 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center text-[11px] font-semibold text-zinc-200 uppercase">
              {user?.username?.[0]}
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto bg-zinc-950">
          {children}
        </main>
      </div>
    </div>
  );
}
