import type { Direction } from "./types";
export const zone = "Europe/London";
export function londonDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
export function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function weekday(date: string): boolean {
  if (!isDate(date)) return false;
  const d = new Date(date + "T12:00:00Z").getUTCDay();
  return d !== 0 && d !== 6;
}
export function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function recentWeekdays(date: string, count: number): string[] {
  const result: string[] = [];
  for (let d = date; result.length < count; d = shiftDate(d, -1)) if (weekday(d)) result.push(d);
  return result;
}
export function timeLabel(value: string | Date | null): string {
  return value ? new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)) : "Not recorded";
}
export function minutesBetween(actual: string | null, scheduled: string | null): number | null {
  if (!actual || !scheduled) return null;
  const value = (Date.parse(actual) - Date.parse(scheduled)) / 60000;
  return Number.isFinite(value) ? value : null;
}
export const windows = {
  MORNING: { origin: "MKC", destination: "EUS", from: "06:00", to: "08:00", collectFrom: "05:00", collectTo: "12:00" },
  EVENING: { origin: "EUS", destination: "MKC", from: "16:30", to: "18:00", collectFrom: "15:30", collectTo: "22:00" },
} as const;
export function monitoredDeparture(value: string | null, direction: Direction): boolean {
  if (!value || !weekday(londonDate(new Date(value)))) return false;
  const w = windows[direction], t = timeLabel(value);
  return t >= w.from && t <= w.to;
}
