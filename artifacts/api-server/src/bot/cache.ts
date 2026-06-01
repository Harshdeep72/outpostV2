import type { User } from "@workspace/db";

type Entry<V> = { value: V; expires: number };

export class TTLCache<K, V> {
  private map = new Map<K, Entry<V>>();
  private hits = 0;
  private misses = 0;

  constructor(private ttlMs: number, private maxSize: number = 2000) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expires < Date.now()) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, { value, expires: Date.now() + (ttlMs ?? this.ttlMs) });
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  stats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 100),
    };
  }

  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this.map.entries()) {
      if (v.expires < now) {
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }
}

const _allCaches: TTLCache<any, any>[] = [];
function register<T extends TTLCache<any, any>>(c: T): T {
  _allCaches.push(c);
  return c;
}

let _sweepStarted = false;
export function startCacheSweeper(): void {
  if (_sweepStarted) return;
  _sweepStarted = true;
  setInterval(() => {
    for (const c of _allCaches) c.sweep();
  }, 60_000).unref();
}

export const userCache = register(new TTLCache<string, User>(30_000));
export const userByIdCache = register(new TTLCache<number, User>(30_000));
export const userByReferralCodeCache = register(new TTLCache<string, User>(60_000));

export const taskCache = register(new TTLCache<number, any>(60_000));
export const claimCache = register(new TTLCache<number, any>(60_000));

export const serverConfigCache = register(new TTLCache<string, any>(5 * 60_000));

export const walletStatsCache = register(new TTLCache<
  string,
  { weekTotal: string; weekCount: number; lifeCount: number }
>(30_000));

export const referralStatsCache = register(new TTLCache<
  string,
  { count: number; completed: number; pending: number }
>(30_000));

export const leaderboardSnapshotCache = register(new TTLCache<
  string,
  {
    embedData: any;
    refreshedAt: number;
    cardData?: {
      weekRangeLabel: string;
      rows: Array<{
        rank: number;
        username: string;
        amount: string;
        discordId: string;
        isZero: boolean;
        acceptRate?: string;
        tier?: "Gold" | "Silver" | "Bronze" | "Verified" | "Earner";
      }>;
      lastWinnerLabel: string | null;
      totalEarners: number;
      totalPaid: string;
    };
  }
>(60_000));

export const userExistsCache = register(new TTLCache<string, string>(5 * 60_000));

export function invalidateUser(discordId: string, id?: number): void {
  userCache.delete(discordId);
  if (id !== undefined) userByIdCache.delete(id);
  walletStatsCache.delete(discordId);
  referralStatsCache.delete(discordId);
}

export function invalidateTask(taskId: number): void {
  taskCache.delete(taskId);
}

export function invalidateClaim(claimId: number): void {
  claimCache.delete(claimId);
}

export function invalidateServerConfig(guildId: string): void {
  serverConfigCache.delete(guildId);
}

export function invalidateLeaderboard(guildId: string): void {
  leaderboardSnapshotCache.delete(guildId);
}

export function getAllCacheStats(): Record<string, ReturnType<TTLCache<any, any>["stats"]>> {
  return {
    user: userCache.stats(),
    userById: userByIdCache.stats(),
    userByReferralCode: userByReferralCodeCache.stats(),
    task: taskCache.stats(),
    claim: claimCache.stats(),
    serverConfig: serverConfigCache.stats(),
    walletStats: walletStatsCache.stats(),
    referralStats: referralStatsCache.stats(),
    leaderboardSnapshot: leaderboardSnapshotCache.stats(),
    userExists: userExistsCache.stats(),
    commentValidation: commentValidationCache.stats(),
  };
}
