import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username.trim(), password);
    } catch (err: any) {
      setError(err.message ?? "Invalid credentials");
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

        <form onSubmit={handleSubmit}>
          <div className="rounded-lg bg-zinc-900/60 border border-zinc-800 p-6 space-y-5">
            <div>
              <h1 className="text-lg font-semibold text-zinc-100">Sign in</h1>
              <p className="text-[13px] text-zinc-500 mt-1">Use your dashboard credentials.</p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-zinc-400">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600 text-sm"
                placeholder="smurf_xz"
                required
                autoComplete="username"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-zinc-400">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-zinc-950 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600 text-sm"
                placeholder="Your password"
                required
                autoComplete="current-password"
              />
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                First time logging in? Type the password you want — it locks in for next time.
              </p>
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
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>

        <p className="mt-5 text-center text-[13px] text-zinc-500">
          New here?{" "}
          <Link href="/register" className="text-zinc-300 hover:text-zinc-100 underline underline-offset-4 decoration-zinc-700">
            Apply for access
          </Link>
        </p>

        <p className="text-center text-[11px] text-zinc-600 mt-10">
          Outpost Bot · v2 Flash Edition
        </p>
      </div>
    </div>
  );
}
