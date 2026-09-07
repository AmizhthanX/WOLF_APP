/**
 * Formatting helpers.
 *
 * The single rule these enforce: a value WOLF could not read renders as an explicit
 * "unavailable", never as 0 or "—" that could be mistaken for a real reading.
 */

export const UNAVAILABLE = 'unavailable';

export function bytes(value: number | null | undefined, fractionDigits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNAVAILABLE;

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }

  return `${size.toFixed(unit === 0 ? 0 : fractionDigits)} ${units[unit]}`;
}

export function bytesPerSecond(value: number | null | undefined): string {
  const formatted = bytes(value, 1);
  return formatted === UNAVAILABLE ? UNAVAILABLE : `${formatted}/s`;
}

export function percent(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNAVAILABLE;
  return `${value.toFixed(fractionDigits)}%`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNAVAILABLE;

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';

  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return UNAVAILABLE;

  const deltaSeconds = Math.round((Date.now() - then) / 1000);
  if (deltaSeconds < 5) return 'just now';
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}

export function timestamp(iso: string | null | undefined): string {
  if (!iso) return UNAVAILABLE;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return UNAVAILABLE;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Threshold colouring shared by every usage bar and metric. */
export function severityFor(usagePercent: number | null | undefined): 'ok' | 'warn' | 'danger' {
  if (usagePercent === null || usagePercent === undefined) return 'ok';
  if (usagePercent >= 90) return 'danger';
  if (usagePercent >= 75) return 'warn';
  return 'ok';
}
