import { memo } from "react";
import type { DashboardEvent } from "../lib/types";

export const EventFeed = memo(function EventFeed({ events, hlsUrl }: { events: DashboardEvent[]; hlsUrl: string }) {
  return (
    <article className="panel">
      <h2>Event Feed</h2>
      <div className="list mono">
        {events.map((e, idx) => (
          <div key={`${e.ts}-${idx}`} className={`eventRow ${e.event.includes("failed") || e.event.includes("error") ? "danger" : ""}`}>
            <span>{new Date(e.ts).toLocaleTimeString()}</span>
            <span>{e.event}</span>
          </div>
        ))}
      </div>
      <p className="mono"><a href={hlsUrl} target="_blank">Open HLS Stream</a></p>
    </article>
  );
});
