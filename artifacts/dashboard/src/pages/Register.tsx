import { useState } from "react";
import { Link } from "wouter";
import { post } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function Register() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await post<{ ok: boolean; message: string }>("/admin/register", {
        username,
        password,
        displayName: displayName || undefined,
        email: email || undefined,
        reason: reason || undefined,
      });
      setSuccess("Application submitted! An admin will review and approve you shortly.");
      setUsername("");
      setPassword("");
      setConfirm("");
      setDisplayName("");
      setEmail("");
      setReason("");
    } catch (err: any) {
      setError(err.message ?? "Could not submit application");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-foreground">Register as Client</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Apply for access. An admin will review your request.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <Field label="Username">
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className={fieldClass}
                placeholder="yourname"
                required
                minLength={3}
                maxLength={32}
                autoComplete="username"
              />
              <p className="text-xs text-muted-foreground mt-1">3–32 chars: letters, numbers, _ . -</p>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Password">
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={fieldClass}
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirm">
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  className={fieldClass}
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </Field>
            </div>

            <Field label="Display Name (optional)">
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                className={fieldClass}
                placeholder="How admins should refer to you"
                maxLength={100}
              />
            </Field>

            <Field label="Email (optional)">
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className={fieldClass}
                placeholder="you@example.com"
                maxLength={200}
              />
            </Field>

            <Field label="Why do you want access? (optional)">
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                className={cn(fieldClass, "min-h-[80px] resize-none")}
                placeholder="Briefly tell admins what you'll use this for"
                maxLength={500}
              />
            </Field>

            {error && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive">
                {error}
              </div>
            )}
            {success && (
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2.5 text-sm text-emerald-500">
                {success}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className={cn(
                "w-full py-2.5 rounded-lg font-semibold text-sm transition-all",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:opacity-60 disabled:cursor-not-allowed"
              )}
            >
              {loading ? "Submitting..." : "Submit Application"}
            </button>
          </div>
        </form>

        <p className="text-center text-sm text-muted-foreground mt-6">
          Already have an account?{" "}
          <Link href="/login" className="text-primary hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}

const fieldClass =
  "w-full px-3 py-2.5 rounded-lg bg-background border border-input text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">{label}</label>
      {children}
    </div>
  );
}
