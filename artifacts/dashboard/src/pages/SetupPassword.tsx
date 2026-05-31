import { useState } from "react";
import { useLocation } from "wouter";
import { post } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function SetupPassword() {
  const search = new URLSearchParams(window.location.search);
  const username = search.get("username") ?? "";
  const token = search.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [, navigate] = useLocation();

  const invalid = !username || !token;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      await post("/admin/set-password", { username, token, newPassword: password });
      setDone(true);
    } catch (err: any) {
      setError(err.message ?? "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <svg className="w-4 h-4 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 2 L4 7 v6 c0 4.5 3.4 8.4 8 9 4.6-.6 8-4.5 8-9 V7 L12 2 z M9 12 l2 2 4-4" />
            </svg>
          </div>
          <div className="leading-tight">
            <p className="text-[15px] font-semibold text-zinc-100">Outpost Bot</p>
            <p className="text-[11px] text-zinc-500">Reddit operations console</p>
          </div>
        </div>

        <div className="rounded-lg bg-zinc-900/60 border border-zinc-800 p-6 space-y-5">
          {invalid ? (
            <div className="space-y-2">
              <h1 className="text-lg font-semibold text-zinc-100">Invalid link</h1>
              <p className="text-[13px] text-zinc-400">
                This setup link is missing required information. Ask your admin to send you a new one.
              </p>
            </div>
          ) : done ? (
            <div className="space-y-4">
              <h1 className="text-lg font-semibold text-zinc-100">Password set!</h1>
              <p className="text-[13px] text-zinc-400">
                Your account is ready. You can now sign in with your new password.
              </p>
              <button
                onClick={() => navigate("/login")}
                className={cn(
                  "w-full py-2 rounded-md font-medium text-[13px]",
                  "bg-zinc-100 text-zinc-900 hover:bg-white",
                  "border border-zinc-300/10"
                )}
              >
                Go to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <h1 className="text-lg font-semibold text-zinc-100">Set your password</h1>
                <p className="text-[13px] text-zinc-500 mt-1">
                  Welcome, <span className="text-zinc-300">{username}</span>. Choose a password to activate your account.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[12px] font-medium text-zinc-400">New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600 text-sm"
                  placeholder="Min. 8 characters"
                  required
                  autoFocus
                  autoComplete="new-password"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-[12px] font-medium text-zinc-400">Confirm password</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600 text-sm"
                  placeholder="Repeat password"
                  required
                  autoComplete="new-password"
                />
              </div>

              {error && (
                <div className="rounded-md bg-red-950/40 border border-red-900/60 px-3 py-2 text-[13px] text-red-300">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className={cn(
                  "w-full py-2 rounded-md font-medium text-[13px]",
                  "bg-zinc-100 text-zinc-900 hover:bg-white",
                  "border border-zinc-300/10",
                  "disabled:opacity-60 disabled:cursor-not-allowed"
                )}
              >
                {loading ? "Setting password…" : "Set password"}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-[11px] text-zinc-600 mt-10">
          Outpost Bot · v2 Flash Edition
        </p>
      </div>
    </div>
  );
}
