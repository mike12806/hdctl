export function ago(then: number | string | null, now = Date.now()): string {
  if (then === null) return "never";
  const ms = now - (typeof then === "string" ? Date.parse(then) : then);
  if (Number.isNaN(ms)) return "unknown";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Seconds -> "3d 4h", "5h 12m", "42m". */
export function duration(seconds: number): string {
  if (!seconds) return "–";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function bytes(n: number): string {
  if (!n) return "0";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

export function pct(fraction: number | null, digits = 1): string {
  return fraction === null ? "–" : `${(fraction * 100).toFixed(digits)}%`;
}

export function time(at: number | string): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
