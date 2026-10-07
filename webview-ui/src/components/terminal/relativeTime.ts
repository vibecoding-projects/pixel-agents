const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Coarse "closed N ago" label for the Closed list. */
export function relativeTime(fromMs: number, nowMs: number): string {
  const d = Math.max(0, nowMs - fromMs);
  if (d < MINUTE_MS) return 'just now';
  if (d < HOUR_MS) return `${Math.floor(d / MINUTE_MS)} min ago`;
  if (d < DAY_MS) return `${Math.floor(d / HOUR_MS)} h ago`;
  return `${Math.floor(d / DAY_MS)} d ago`;
}
