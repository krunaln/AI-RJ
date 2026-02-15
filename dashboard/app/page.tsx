"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyEvent, initialUiState, type UiState } from "../lib/state";
import type { DashboardEvent, DashboardSnapshot, QueueItem, TimelineSnapshot } from "../lib/types";

const API_BASE = process.env.NEXT_PUBLIC_RJ_API_BASE || "http://127.0.0.1:3000";

type ConnectionState = "connecting" | "connected" | "disconnected";

function fmtSeconds(sec: number): string {
  if (!Number.isFinite(sec)) return "0:00";
  const s = Math.max(0, Math.floor(sec));
  const min = Math.floor(s / 60);
  const rem = s % 60;
  return `${min}:${String(rem).padStart(2, "0")}`;
}

function MediaPlayer({ filePath }: { filePath: string }) {
  const src = `${API_BASE}/dashboard/media-by-path?path=${encodeURIComponent(filePath)}`;
  return <audio controls preload="none" src={src} />;
}

function QueueControls({ item, onRemove, onPatch }: { item: QueueItem; onRemove: (id: string) => void; onPatch: (id: string, patch: { priority?: number; pinned?: boolean }) => void }) {
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
}

export default function Page() {
  const [ui, setUi] = useState<UiState>(initialUiState);
  const [timeline, setTimeline] = useState<TimelineSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [disconnectedLong, setDisconnectedLong] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [commentaryText, setCommentaryText] = useState("");
  const [trackTitle, setTrackTitle] = useState("");
  const [trackArtist, setTrackArtist] = useState("");
  const [trackUrl, setTrackUrl] = useState("");
  const [tick, setTick] = useState(0);
  const lastMessageAt = useRef<number>(Date.now());

  useEffect(() => {
    const loadSnapshot = async () => {
      const res = await fetch(`${API_BASE}/dashboard/snapshot`);
      const snapshot = (await res.json()) as DashboardSnapshot;
      setUi((prev) => ({ ...prev, snapshot }));
    };
    const loadTimeline = async () => {
      const res = await fetch(`${API_BASE}/timeline/snapshot`);
      const t = (await res.json()) as TimelineSnapshot;
      setTimeline(t);
    };
    loadSnapshot().catch(() => {
      setConnection("disconnected");
    });
    loadTimeline().catch(() => {
      // ignore
    });
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let stopped = false;
    let retryMs = 1000;
    let es: EventSource | null = null;

    const connect = () => {
      if (stopped) return;
      setConnection("connecting");
      es = new EventSource(`${API_BASE}/dashboard/events`);

      es.onopen = () => {
        retryMs = 1000;
        setConnection("connected");
        lastMessageAt.current = Date.now();
      };

      es.addEventListener("message", (m) => {
        const evt = m as MessageEvent;
        try {
          const parsed = JSON.parse(evt.data) as DashboardEvent;
          lastMessageAt.current = Date.now();
          setUi((prev) => applyEvent(prev, parsed));
          if (
            parsed.event === "timeline.updated" ||
            parsed.event === "queue.arbitrated" ||
            parsed.event === "segment.enqueued" ||
            parsed.event === "segment.started" ||
            parsed.event === "segment.finished"
          ) {
            fetch(`${API_BASE}/timeline/snapshot`)
              .then((r) => r.json())
              .then((t: TimelineSnapshot) => setTimeline(t))
              .catch(() => {
                // ignore
              });
          }
        } catch {
          // ignore malformed event
        }
      });

      es.addEventListener("heartbeat", () => {
        lastMessageAt.current = Date.now();
      });

      es.onerror = () => {
        setConnection("disconnected");
        es?.close();
        if (stopped) return;
        setTimeout(connect, retryMs);
        retryMs = Math.min(10000, retryMs * 2);
      };
    };

    connect();

    const watcher = setInterval(() => {
      setDisconnectedLong(Date.now() - lastMessageAt.current > 15000);
    }, 1000);

    return () => {
      stopped = true;
      clearInterval(watcher);
      es?.close();
    };
  }, []);

  const snapshot = ui.snapshot;
  const queue = snapshot?.queue.slice(0, 20) ?? [];
  const recentSegments = snapshot?.recentSegments.slice(0, 20) ?? [];
  const events = ui.liveEvents.slice(0, 40);
  const deckBPlanned = timeline?.activeDeckClips.find((c) => c.deck === "B") || null;
  const voiceoverPlanned = timeline?.voiceoverOverlays[0] || null;

  const hlsUrl = useMemo(() => "http://127.0.0.1:8888/live/radio/index.m3u8", []);
  const streamUptimeSec = snapshot?.streamStartedAt ? Math.max(0, Math.floor((Date.now() - new Date(snapshot.streamStartedAt).getTime()) / 1000)) : 0;
  const playheadElapsedSec = snapshot?.nowPlaying ? Math.max(0, Math.floor((Date.now() - new Date(snapshot.nowPlaying.startedAt).getTime()) / 1000)) : 0;
  const playheadDurationSec = snapshot?.nowPlaying?.durationSec ?? 0;
  const playheadRemainingSec = Math.max(0, Math.floor(playheadDurationSec - playheadElapsedSec));
  const playheadPct = playheadDurationSec > 0 ? Math.max(0, Math.min(100, (playheadElapsedSec / playheadDurationSec) * 100)) : 0;
  const vu = Math.min(100, Math.round((snapshot?.bufferedSec ?? 0) / 6));

  const runControl = async (action: "start" | "stop") => {
    if (!window.confirm(`Confirm ${action} stream?`)) return;
    setActionBusy(true);
    try {
      await fetch(`${API_BASE}/control/${action}`, { method: "POST" });
    } finally {
      setActionBusy(false);
    }
  };

  const skipNow = async () => {
    await fetch(`${API_BASE}/dashboard/transport/skip`, { method: "POST" });
  };

  const addCommentary = async () => {
    const text = commentaryText.trim();
    if (!text) return;
    await fetch(`${API_BASE}/dashboard/queue/commentary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    setCommentaryText("");
  };

  const addTrack = async () => {
    const title = trackTitle.trim();
    const youtube_url = trackUrl.trim();
    if (!title || !youtube_url) return;
    await fetch(`${API_BASE}/dashboard/queue/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, artist: trackArtist.trim(), youtube_url })
    });
    setTrackTitle("");
    setTrackArtist("");
    setTrackUrl("");
  };

  const removeQueued = async (segmentId: string) => {
    await fetch(`${API_BASE}/dashboard/queue/${segmentId}`, { method: "DELETE" });
  };

  const patchQueued = async (segmentId: string, patch: { priority?: number; pinned?: boolean }) => {
    await fetch(`${API_BASE}/dashboard/queue/${segmentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
  };

  return (
    <main className="djShell">
      <header className="djHeader">
        <div>
          <h1>PULSEAI LIVE</h1>
          <p>Live autonomous DJ control room</p>
        </div>
        <div className="statusWrap">
          <span className={`pill ${snapshot?.running ? "ok" : "bad"}`}>{snapshot?.running ? "ON AIR" : "OFF AIR"}</span>
          <span className={`pill ${connection === "connected" ? "ok" : "warn"}`}>LINK {connection.toUpperCase()}</span>
          <button disabled={actionBusy} onClick={() => runControl("start")}>Start</button>
          <button disabled={actionBusy} onClick={() => runControl("stop")}>Stop</button>
          <button disabled={actionBusy} onClick={skipNow}>Skip</button>
        </div>
      </header>

      {disconnectedLong ? <div className="banner">SSE disconnected for more than 15 seconds.</div> : null}

      <section className="deckGrid">
        <article className="panel deckA">
          <h2>Deck A / Now Playing</h2>
          {snapshot?.nowPlaying ? (
            <>
              <p className="mono">{snapshot.nowPlaying.type.toUpperCase()} | {snapshot.nowPlaying.id}</p>
              <p>{snapshot.nowPlaying.type === "commentary" ? (snapshot.nowPlaying.commentaryText ?? snapshot.nowPlaying.notes) : snapshot.nowPlaying.notes}</p>
              <div className="timeRow mono">
                <span>{fmtSeconds(playheadElapsedSec)}</span>
                <span>{fmtSeconds(playheadRemainingSec)}</span>
                <span>{fmtSeconds(playheadDurationSec)}</span>
              </div>
              <div className="progressTrack"><div className="progressFill" style={{ width: `${playheadPct}%` }} /></div>
              <MediaPlayer filePath={snapshot.nowPlaying.filePath} />
            </>
          ) : <p>No active segment.</p>}
        </article>

        <article className="panel mixer">
          <h2>Mixer</h2>
          <div className="mono">Uptime: {fmtSeconds(streamUptimeSec)}</div>
          <div className="mono">Buffered: {fmtSeconds(snapshot?.bufferedSec ?? 0)}</div>
          <div className="mono">Lookahead: {fmtSeconds(snapshot?.lookaheadSecCovered ?? 0)}</div>
          <div className="mono">Phase: {snapshot?.phase ?? "-"}</div>
          <div className="mono">Tracks: {snapshot?.tracksLoaded ?? 0}</div>
          <div className="mono">Crossfader: {snapshot?.crossfader.active ? `${snapshot.crossfader.fromDeck} -> ${snapshot.crossfader.toDeck} (${snapshot.crossfader.curve})` : "idle"}</div>
          <div className="mono">Ducking: {snapshot?.ducking.active ? `ON (-${snapshot.ducking.reductionDb}dB)` : "OFF"}</div>
          <div className="vuTrack"><div className="vuFill" style={{ width: `${vu}%` }} /></div>
          <p className="mono">Errors: {snapshot?.lastError ?? "none"}</p>
        </article>
      </section>

      <section className="deckGrid">
        <article className="panel">
          <h2>Deck B</h2>
          <p className="mono">Active: {snapshot?.deckB.activeSegmentId ?? "none"}</p>
          <p className="mono">Planned: {deckBPlanned?.segmentId ?? "none"}</p>
          <p className="mono">Type: {deckBPlanned?.type ?? snapshot?.deckB.activeType ?? "-"}</p>
          <p className="mono">Start@T+{fmtSeconds(deckBPlanned?.startSec ?? 0)} | Dur: {fmtSeconds(deckBPlanned?.durationSec ?? 0)}</p>
        </article>
        <article className="panel">
          <h2>Voiceover Lane</h2>
          <p className="mono">Active: {snapshot?.voiceoverLane.active ? "yes" : "no"}</p>
          <p className="mono">Planned: {voiceoverPlanned?.segmentId ?? "none"}</p>
          <p className="mono">Type: {voiceoverPlanned?.type ?? "-"}</p>
          <p className="mono">Start@T+{fmtSeconds(voiceoverPlanned?.startSec ?? 0)} | Dur: {fmtSeconds(voiceoverPlanned?.durationSec ?? 0)}</p>
          <p className="mono">Master Timeline: {fmtSeconds(snapshot?.masterPlayhead.timelineOffsetSec ?? 0)}</p>
        </article>
      </section>

      <section className="panel">
        <h2>DJ Queue (priority + pin)</h2>
        <div className="list mono">
          {queue.map((q) => (
            <div key={q.id} className="queueRow">
              <div>
                <div>{q.type.toUpperCase()} | {fmtSeconds(q.durationSec)} | {q.source}</div>
                <div className="mono">{q.pinned ? "manual_pinned" : q.source === "manual" ? "manual_priority" : "auto_priority"}</div>
                <div>{q.type === "commentary" ? (q.commentaryText ?? q.notes) : q.notes}</div>
                <MediaPlayer filePath={q.filePath} />
              </div>
              <QueueControls item={q} onRemove={removeQueued} onPatch={patchQueued} />
            </div>
          ))}
          {!queue.length ? <p>Queue empty.</p> : null}
        </div>
      </section>

      <section className="deckGrid">
        <article className="panel">
          <h2>Add Segment</h2>
          <div className="formWrap mono">
            <label>Commentary text</label>
            <textarea value={commentaryText} onChange={(e) => setCommentaryText(e.target.value)} rows={4} />
            <button onClick={addCommentary}>Cue Commentary</button>
            <hr />
            <label>Track title</label>
            <input value={trackTitle} onChange={(e) => setTrackTitle(e.target.value)} />
            <label>Artist</label>
            <input value={trackArtist} onChange={(e) => setTrackArtist(e.target.value)} />
            <label>YouTube URL</label>
            <input value={trackUrl} onChange={(e) => setTrackUrl(e.target.value)} />
            <button onClick={addTrack}>Cue Track</button>
          </div>
        </article>

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
      </section>

      <section className="panel">
        <h2>Recent Played</h2>
        <div className="list mono">
          {recentSegments.map((s) => (
            <div key={`${s.id}-${s.startedAt}`} className="eventRow">
              <span>{s.type}</span>
              <span>{s.type === "commentary" ? (s.commentaryText ?? s.notes) : s.notes}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
