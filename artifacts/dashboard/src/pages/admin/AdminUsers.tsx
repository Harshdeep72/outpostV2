import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { get, post, del } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

interface AdminUserRow {
  id: number;
  username: string;
  role: "admin" | "client";
  status: "active" | "pending" | "suspended";
  display_name: string | null;
  email: string | null;
  notes: string | null;
  applied_at: string | null;
  approved_at: string | null;
  created_at: string;
  has_password: boolean;
  has_setup_token: boolean;
}

export default function AdminUsers() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [tokenInfo, setTokenInfo] = useState<{ username: string; token: string } | null>(null);
  const isDev = me?.role === "dev";

  // Dev-only "create new admin" form state.
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "client">("admin");
  const [createMsg, setCreateMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => get<{ users: AdminUserRow[] }>("/admin/admin-users"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-users"] });
    qc.invalidateQueries({ queryKey: ["applications"] });
  };

  const suspend = useMutation({
    mutationFn: (id: number) => post(`/admin/admin-users/${id}/suspend`, {}),
    onSuccess: refresh,
  });
  const unsuspend = useMutation({
    mutationFn: (id: number) => post(`/admin/admin-users/${id}/unsuspend`, {}),
    onSuccess: refresh,
  });
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: number; role: "admin" | "client" }) =>
      post(`/admin/admin-users/${id}/role`, { role }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/admin/admin-users/${id}`),
    onSuccess: refresh,
  });
  const resetToken = useMutation({
    mutationFn: (id: number) =>
      post<{ id: number; username: string; setup_token: string }>(`/admin/admin-users/${id}/reset-token`, {}),
    onSuccess: (row) => {
      refresh();
      setTokenInfo({ username: row.username, token: row.setup_token });
    },
  });

  const createAdmin = useMutation({
    mutationFn: (body: { username: string; role: "admin" | "client"; displayName?: string }) =>
      post<{ ok: boolean; user: { id: number; username: string; role: string } }>("/admin/admin-users/create", body),
    onSuccess: (data) => {
      setCreateMsg({
        kind: "success",
        text: `✅ Created ${data.user.role} account "${data.user.username}". Tell them to log in — whatever password they type on their FIRST login becomes their permanent password.`,
      });
      setNewUsername("");
      setNewDisplayName("");
      setNewRole("admin");
      refresh();
    },
    onError: (err: Error) => {
      setCreateMsg({ kind: "error", text: `❌ ${err.message}` });
    },
  });

  const submitCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setCreateMsg(null);
    const u = newUsername.trim();
    if (u.length < 3) { setCreateMsg({ kind: "error", text: "❌ Username too short (min 3 chars)." }); return; }
    createAdmin.mutate({ username: u, role: newRole, displayName: newDisplayName.trim() || undefined });
  };

  const setupLink = (username: string, token: string) => {
    const base = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, "");
    return `${base}/setup-password?username=${encodeURIComponent(username)}&token=${encodeURIComponent(token)}`;
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Dashboard Users</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage admins and clients. Suspend, promote, or issue setup links.
        </p>
      </header>

      {isDev && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded bg-primary/20 text-primary uppercase tracking-wide">Dev only</span>
              Create new account
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Quick-create an admin (or client) account. They'll set their own password on their first login — whatever they type then becomes permanent.
            </p>
          </div>
          <form onSubmit={submitCreate} className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Username *</label>
              <input
                type="text"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="e.g. mod_alex"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                autoComplete="off"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Display name (optional)</label>
              <input
                type="text"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="e.g. Alex (Mod)"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Role</label>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as "admin" | "client")}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="admin">Admin (full dashboard access)</option>
                <option value="client">Client (limited)</option>
              </select>
            </div>
            <div className="md:col-span-2 flex items-center gap-3">
              <button
                type="submit"
                disabled={createAdmin.isPending}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createAdmin.isPending ? "Creating…" : "Create account"}
              </button>
              {createMsg && (
                <span className={cn("text-xs", createMsg.kind === "success" ? "text-emerald-500" : "text-destructive")}>
                  {createMsg.text}
                </span>
              )}
            </div>
          </form>
        </div>
      )}

      {tokenInfo && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 min-w-0 flex-1">
              <p className="text-sm font-semibold">Setup link for {tokenInfo.username}</p>
              <p className="text-xs text-muted-foreground">
                Send this to the user. It works once and expires when they set a password.
              </p>
              <code className="block mt-2 text-xs break-all bg-background border border-border rounded p-2">
                {setupLink(tokenInfo.username, tokenInfo.token)}
              </code>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(setupLink(tokenInfo.username, tokenInfo.token))}
              className="px-3 py-1.5 rounded-lg text-xs bg-secondary hover:bg-secondary/80"
            >
              Copy
            </button>
            <button
              onClick={() => setTokenInfo(null)}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/30 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left">User</th>
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.users.map(u => {
                const isMe = u.id === me?.id;
                return (
                  <tr key={u.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <div className="font-medium">{u.username}{isMe && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}</div>
                      {u.display_name && (
                        <div className="text-xs text-muted-foreground">{u.display_name}</div>
                      )}
                      {u.email && (
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={u.role === "admin" ? "primary" : "muted"}>{u.role}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        tone={
                          u.status === "active" ? "success"
                            : u.status === "pending" ? "warn"
                              : "danger"
                        }
                      >
                        {u.status}
                      </Badge>
                      {!u.has_password && u.has_setup_token && (
                        <div className="text-xs text-amber-500 mt-1">Awaiting password setup</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {u.status === "suspended" ? (
                          <ActionBtn onClick={() => unsuspend.mutate(u.id)} disabled={isMe}>
                            Unsuspend
                          </ActionBtn>
                        ) : (
                          <ActionBtn onClick={() => suspend.mutate(u.id)} disabled={isMe}>
                            Suspend
                          </ActionBtn>
                        )}
                        {u.role === "client" ? (
                          <ActionBtn
                            onClick={() => setRole.mutate({ id: u.id, role: "admin" })}
                            tone="primary"
                          >
                            Promote
                          </ActionBtn>
                        ) : (
                          <ActionBtn
                            onClick={() => setRole.mutate({ id: u.id, role: "client" })}
                            disabled={isMe}
                          >
                            Demote
                          </ActionBtn>
                        )}
                        <ActionBtn onClick={() => resetToken.mutate(u.id)}>Reset password</ActionBtn>
                        <ActionBtn
                          tone="danger"
                          disabled={isMe}
                          onClick={() => {
                            if (confirm(`Permanently delete user ${u.username}? This cannot be undone.`)) {
                              remove.mutate(u.id);
                            }
                          }}
                        >
                          Delete
                        </ActionBtn>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {data && data.users.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "primary" | "muted" | "success" | "warn" | "danger" }) {
  const cls = {
    primary: "bg-primary/15 text-primary border-primary/20",
    muted: "bg-secondary text-secondary-foreground border-border",
    success: "bg-emerald-500/15 text-emerald-500 border-emerald-500/20",
    warn: "bg-amber-500/15 text-amber-500 border-amber-500/20",
    danger: "bg-destructive/15 text-destructive border-destructive/20",
  }[tone];
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border capitalize", cls)}>
      {children}
    </span>
  );
}

function ActionBtn({
  children, onClick, disabled, tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
}) {
  const cls = {
    default: "bg-secondary hover:bg-secondary/70 text-secondary-foreground",
    primary: "bg-primary/15 hover:bg-primary/25 text-primary",
    danger: "bg-destructive/15 hover:bg-destructive/25 text-destructive",
  }[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "px-2.5 py-1 rounded text-xs font-medium transition-colors",
        cls,
        "disabled:opacity-50 disabled:cursor-not-allowed"
      )}
    >
      {children}
    </button>
  );
}
