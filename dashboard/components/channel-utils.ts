import type { AudioChannel, DashboardSnapshot, QueueItem } from "../lib/types";

export function fmtSeconds(sec: number): string {
  if (!Number.isFinite(sec)) return "0:00";
  const s = Math.max(0, Math.floor(sec));
  const min = Math.floor(s / 60);
  const rem = s % 60;
  return `${min}:${String(rem).padStart(2, "0")}`;
}

export function inferChannel(item: QueueItem | DashboardSnapshot["nowPlaying"]): AudioChannel {
  if (!item) return "music";
  if (item.channel) return item.channel;
  if (item.type === "commentary") return "voice";
  if (item.type === "liner") return "jingle";
  return "music";
}

export function stripLabel(item: QueueItem | DashboardSnapshot["nowPlaying"] | null): string {
  if (!item) return "-";
  return item.type === "commentary" ? (item.commentaryText ?? item.notes) : item.notes;
}
