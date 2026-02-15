import { memo } from "react";
import type { QueueItem } from "../lib/types";
import { fmtSeconds, inferChannel } from "./channel-utils";

function MediaPlayer({ filePath, apiBase }: { filePath: string; apiBase: string }) {
  const src = `${apiBase}/dashboard/media-by-path?path=${encodeURIComponent(filePath)}`;
  return <audio controls preload="none" src={src} />;
}

const QueueControls = memo(function QueueControls({ item, onRemove, onPatch }: { item: QueueItem; onRemove: (id: string) => void; onPatch: (id: string, patch: { priority?: number; pinned?: boolean }) => void }) {
  return (
    <div className="queueCtl mono">
      <label>
        Priority {item.priority}
        <input
          type="range"
          min={0}
          max={200}
          value={item.priority}
          onChange={(e) => onPatch(item.id, { priority: Number(e.target.value) })}
        />
      </label>
      <label className="pinRow">
        <input type="checkbox" checked={item.pinned} onChange={(e) => onPatch(item.id, { pinned: e.target.checked })} />
        Pinned
      </label>
      <button onClick={() => onRemove(item.id)}>Remove</button>
    </div>
  );
});

export const QueueSection = memo(function QueueSection({
  queue,
  apiBase,
  onRemove,
  onPatch
}: {
  queue: QueueItem[];
  apiBase: string;
  onRemove: (segmentId: string) => void;
  onPatch: (segmentId: string, patch: { priority?: number; pinned?: boolean }) => void;
}) {
  return (
    <section className="panel">
      <h2>Channel Queue</h2>
      <div className="list mono">
        {queue.map((q) => (
          <div key={q.id} className="queueRow">
            <div>
              <div>{q.type.toUpperCase()} | {fmtSeconds(q.durationSec)} | {q.source} | {(q.channel || inferChannel(q)).toUpperCase()}</div>
              <div className="mono">{q.pinned ? "manual_pinned" : q.source === "manual" ? "manual_priority" : "auto_priority"}</div>
              <div>Start@{typeof q.scheduledStartSec === "number" ? fmtSeconds(q.scheduledStartSec) : "n/a"}</div>
              <div>{q.type === "commentary" ? (q.commentaryText ?? q.notes) : q.notes}</div>
              <MediaPlayer filePath={q.filePath} apiBase={apiBase} />
            </div>
            <QueueControls item={q} onRemove={onRemove} onPatch={onPatch} />
          </div>
        ))}
        {!queue.length ? <p>Queue empty.</p> : null}
      </div>
    </section>
  );
});
