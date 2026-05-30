import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(val: string | number | null | undefined) {
  const n = parseFloat(String(val ?? "0"));
  return `$${n.toFixed(2)}`;
}

export function timeAgo(date: string | Date | null | undefined) {
  if (!date) return "—";
  const d = new Date(date);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function statusColor(status: string) {
  switch (status) {
    case "approved": return "text-green-400 bg-green-400/10 border-green-400/20";
    case "pending": return "text-yellow-400 bg-yellow-400/10 border-yellow-400/20";
    case "rejected": return "text-red-400 bg-red-400/10 border-red-400/20";
    case "open": return "text-blue-400 bg-blue-400/10 border-blue-400/20";
    case "closed": return "text-gray-400 bg-gray-400/10 border-gray-400/20";
    case "active": return "text-green-400 bg-green-400/10 border-green-400/20";
    default: return "text-gray-400 bg-gray-400/10 border-gray-400/20";
  }
}
