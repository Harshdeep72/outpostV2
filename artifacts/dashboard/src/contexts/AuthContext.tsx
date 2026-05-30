import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { get, post } from "@/lib/api";

interface AdminUser {
  id: number;
  username: string;
  role: string;
  discordId?: string | null;
  discordUsername?: string | null;
  discordAvatar?: string | null;
}

interface AuthContextType {
  user: AdminUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    get<AdminUser>("/admin/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string) => {
    const u = await post<AdminUser>("/admin/login", { username, password });
    setUser(u);
  };

  const logout = async () => {
    await post("/admin/logout", {});
    setUser(null);
  };

  const refresh = async () => {
    try {
      const u = await get<AdminUser>("/admin/me");
      setUser(u);
    } catch {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
