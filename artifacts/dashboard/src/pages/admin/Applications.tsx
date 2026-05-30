import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Application {
  id: number;
  username: string;
  display_name: string | null;
  email: string | null;
  notes: string | null;
  applied_at: string;
}

export default function Applications() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["applications"],
    queryFn: () => get<{ applications: Application[] }>("/admin/applications"),
  });

  const approve = useMutation({
    mutationFn: (id: number) => post(`/admin/applications/${id}/approve`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["applications"] });
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  const reject = useMutation({
    mutationFn: (id: number) => post(`/admin/applications/${id}/reject`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["applications"] }),
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Applications</h1>
        <p className="text-sm text-muted-foreground mt-1">
          People who applied to be clients. Approve or reject them here.
        </p>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {data && data.applications.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
          <p className="text-sm text-muted-foreground">No pending applications. You are all caught up.</p>
        </div>
      )}

      <div className="space-y-3">
        {data?.applications.map(app => (
          <div key={app.id} className="rounded-xl border border-border bg-card p-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="space-y-1.5 flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <h3 className="font-semibold text-base">{app.username}</h3>
                  {app.display_name && (
                    <span className="text-sm text-muted-foreground">— {app.display_name}</span>
                  )}
                </div>
                {app.email && (
                  <p className="text-xs text-muted-foreground break-all">{app.email}</p>
                )}
                {app.notes && (
                  <p className="text-sm text-foreground/90 mt-2 whitespace-pre-wrap break-words">
                    {app.notes}
                  </p>
                )}
                <p className="text-xs text-muted-foreground pt-1">
                  Applied {new Date(app.applied_at).toLocaleString()}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => approve.mutate(app.id)}
                  disabled={approve.isPending}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-sm font-medium",
                    "bg-emerald-500 text-white hover:bg-emerald-600",
                    "disabled:opacity-60 disabled:cursor-not-allowed"
                  )}
                >
                  Approve
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Reject application from ${app.username}? This deletes the record.`)) {
                      reject.mutate(app.id);
                    }
                  }}
                  disabled={reject.isPending}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-sm font-medium",
                    "bg-secondary text-secondary-foreground hover:bg-secondary/80",
                    "disabled:opacity-60 disabled:cursor-not-allowed"
                  )}
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
