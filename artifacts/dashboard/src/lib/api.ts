// In dev / same-origin deploy → "/api" (proxied to the API server).
// When the dashboard is hosted separately (e.g. Vercel) and points at a
// remote API (e.g. Render), set VITE_API_BASE_URL=https://api.example.com
// at build time and we'll talk to that origin directly with credentials.
const RAW_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const BASE = RAW_BASE ? `${RAW_BASE}/api` : "/api";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let body: any = null;
    try {
      body = await res.json();
      msg = body?.error ?? msg;
    } catch {}
    // Attach full JSON body so callers can read auxiliary fields like `hint`.
    const err = new Error(msg) as Error & { body?: any; status?: number };
    err.body = body;
    err.status = res.status;
    throw err;
  }
  return res.json() as T;
}

export function get<T>(path: string) {
  return request<T>(path);
}
export function post<T>(path: string, body: unknown) {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}
export function patch<T>(path: string, body: unknown) {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}
export function put<T>(path: string, body: unknown) {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}
export function del<T>(path: string) {
  return request<T>(path, { method: "DELETE" });
}

/** Fetch a server-generated file (CSV/TXT) and trigger a browser download.
 * Sends the auth cookie (`credentials: "include"`) so it works whether the
 * dashboard is served same-origin (dev) or cross-origin (Pages → Render). */
export async function downloadFile(path: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json())?.error ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  // Honor Content-Disposition filename if the server set one.
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = match?.[1] ?? fallbackFilename;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
