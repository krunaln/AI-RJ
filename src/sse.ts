import type { DashboardEvent } from "./types";

let sequence = 0;

export function formatSseEvent(event: DashboardEvent): string {
  sequence += 1;
  return `id: ${sequence}\nretry: 2000\nevent: message\ndata: ${JSON.stringify(event)}\n\n`;
}

export function heartbeatSseEvent(): string {
  sequence += 1;
  return `id: ${sequence}\nretry: 2000\nevent: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`;
}
