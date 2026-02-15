"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { applyEvent, initialUiState, type UiState } from "../lib/state";
import type { AudioChannel, DashboardEvent, DashboardSnapshot, TimelineSnapshot } from "../lib/types";
import { EventFeed } from "../components/event-feed";
import { fmtSeconds, inferChannel, stripLabel } from "../components/channel-utils";
import { MixerSection, type ChannelView } from "../components/mixer-section";
import { QueueSection } from "../components/queue-section";

const API_BASE = process.env.NEXT_PUBLIC_RJ_API_BASE || "http://127.0.0.1:3000";
const MONITOR_HLS_URL = process.env.NEXT_PUBLIC_MONITOR_HLS_URL || "http://127.0.0.1:8888/live/radio/index.m3u8";

type ConnectionState = "connecting" | "connected" | "disconnected";
type WsPayload =
  | { type: "snapshot"; revision: number; snapshot: DashboardSnapshot }
  | { type: "event"; revision: number; event: DashboardEvent };

const CHANNEL_ORDER: Array<{ id: AudioChannel; label: string }> = [
  { id: "music", label: "Music" },
  { id: "voice", label: "Voice" },
  { id: "jingle", label: "Jingle" },
  { id: "ads", label: "Ads" }
];

function toWsBase(apiBase: string): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

function MediaPlayer({ filePath }: { filePath: string }) {
  const src = `${API_BASE}/dashboard/media-by-path?path=${encodeURIComponent(filePath)}`;
  return <audio controls preload="none" src={src} />;
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

  const lastMessageAt = useRef<number>(Date.now());
  const lastRevision = useRef<number>(0);
  const pendingSnapshot = useRef<DashboardSnapshot | null>(null);
  const pendingEvents = useRef<DashboardEvent[]>([]);
  const flushTimer = useRef<number | null>(null);
  const lastTimelineFetchMs = useRef<number>(0);

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
    loadSnapshot().catch(() => setConnection("disconnected"));
    loadTimeline().catch(() => undefined);
  }, []);

  useEffect(() => {
    const poll = setInterval(() => {
      fetch(`${API_BASE}/dashboard/snapshot`)
        .then((r) => r.json())
        .then((snapshot: DashboardSnapshot) => setUi((prev) => ({ ...prev, snapshot })))
        .catch(() => undefined);

      if (connection !== "connected") {
        fetch(`${API_BASE}/timeline/snapshot`)
          .then((r) => r.json())
          .then((t: TimelineSnapshot) => setTimeline(t))
          .catch(() => undefined);
      }
    }, connection === "connected" ? 900 : 1500);

    return () => clearInterval(poll);
  }, [connection]);

  useEffect(() => {
    let stopped = false;
    let retryMs = 1000;
    let ws: WebSocket | null = null;

    const flushPending = () => {
      flushTimer.current = null;
      const nextSnapshot = pendingSnapshot.current;
      const eventsBatch = pendingEvents.current.splice(0, pendingEvents.current.length);
      pendingSnapshot.current = null;
      setUi((prev) => {
        let out: UiState = nextSnapshot ? { ...prev, snapshot: nextSnapshot } : prev;
        for (const e of eventsBatch) {
          out = applyEvent(out, e);
        }
        return out;
      });
    };

    const scheduleFlush = () => {
      if (flushTimer.current !== null) return;
      flushTimer.current = window.setTimeout(flushPending, 90);
    };

    const connect = () => {
      if (stopped) return;
      setConnection("connecting");
      const wsUrl = `${toWsBase(API_BASE)}?lastRevision=${encodeURIComponent(String(lastRevision.current))}`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        retryMs = 1000;
        setConnection("connected");
        lastMessageAt.current = Date.now();
      };

      ws.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(String(evt.data)) as WsPayload;
          lastMessageAt.current = Date.now();

          if (parsed.type === "snapshot") {
            lastRevision.current = parsed.revision;
            pendingSnapshot.current = parsed.snapshot;
            scheduleFlush();
            return;
          }

          lastRevision.current = parsed.revision;
          pendingEvents.current.push(parsed.event);
          scheduleFlush();

          if (
            parsed.event.event === "timeline.updated" ||
            parsed.event.event === "queue.arbitrated" ||
            parsed.event.event === "segment.enqueued" ||
            parsed.event.event === "segment.started" ||
            parsed.event.event === "segment.finished"
          ) {
            const now = Date.now();
            if (now - lastTimelineFetchMs.current > 500) {
              lastTimelineFetchMs.current = now;
              fetch(`${API_BASE}/timeline/snapshot`)
                .then((r) => r.json())
                .then((t: TimelineSnapshot) => setTimeline(t))
                .catch(() => undefined);
            }
          }
        } catch {
          // ignore malformed event
        }
      };

      ws.onerror = () => {
        setConnection("disconnected");
        ws?.close();
      };

      ws.onclose = () => {
        setConnection("disconnected");
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
      if (flushTimer.current !== null) {
        window.clearTimeout(flushTimer.current);
      }
      ws?.close();
    };
  }, []);

  const snapshot = ui.snapshot;
  const queue = useMemo(() => snapshot?.queue.slice(0, 20) ?? [], [snapshot?.queue]);
  const recentSegments = useMemo(() => snapshot?.recentSegments.slice(0, 20) ?? [], [snapshot?.recentSegments]);
  const events = useMemo(() => ui.liveEvents.slice(0, 40), [ui.liveEvents]);
  const deferredEvents = useDeferredValue(events);

  const hlsUrl = useMemo(() => MONITOR_HLS_URL, []);
  const streamUptimeSec = snapshot?.streamStartedAt ? Math.max(0, Math.floor((Date.now() - new Date(snapshot.streamStartedAt).getTime()) / 1000)) : 0;
  const playheadElapsedSec = snapshot?.nowPlaying ? Math.max(0, Math.floor((Date.now() - new Date(snapshot.nowPlaying.startedAt).getTime()) / 1000)) : 0;
  const playheadDurationSec = snapshot?.nowPlaying?.durationSec ?? 0;
  const playheadRemainingSec = Math.max(0, Math.floor(playheadDurationSec - playheadElapsedSec));
  const playheadPct = playheadDurationSec > 0 ? Math.max(0, Math.min(100, (playheadElapsedSec / playheadDurationSec) * 100)) : 0;
  const mainMeter = Math.round(Math.max(0, Math.min(1, snapshot?.meters.master ?? 0)) * 100);

  const channelViews = useMemo<ChannelView[]>(() => {
    const byChannel = new Map<AudioChannel, typeof queue>();
    for (const c of CHANNEL_ORDER) byChannel.set(c.id, []);
    for (const q of queue) {
      const ch = inferChannel(q);
      const list = byChannel.get(ch);
      if (list) list.push(q);
    }

    const now = snapshot?.nowPlaying;

    return CHANNEL_ORDER.map((c) => {
      const queued = byChannel.get(c.id) ?? [];
      const active = now && inferChannel(now) === c.id ? now : null;
      const head = active ?? queued[0] ?? null;
      const meterPct = Math.round(Math.max(0, Math.min(1, snapshot?.meters[c.id] ?? 0)) * 100);
      return {
        channel: c.id,
        label: c.label,
        active: head,
        queued,
        meterPct
      };
    });
  }, [queue, snapshot?.nowPlaying, snapshot?.meters]);

  const runControl = useCallback(async (action: "start" | "stop") => {
    if (!window.confirm(`Confirm ${action} stream?`)) return;
    setActionBusy(true);
    try {
      await fetch(`${API_BASE}/control/${action}`, { method: "POST" });
    } finally {
      setActionBusy(false);
    }
  }, []);

  const skipNow = useCallback(async () => {
    await fetch(`${API_BASE}/dashboard/transport/skip`, { method: "POST" });
  }, []);

  const addCommentary = useCallback(async () => {
    const text = commentaryText.trim();
    if (!text) return;
    await fetch(`${API_BASE}/dashboard/queue/commentary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    setCommentaryText("");
  }, [commentaryText]);

  const addTrack = useCallback(async () => {
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
  }, [trackTitle, trackArtist, trackUrl]);

  const removeQueued = useCallback(async (segmentId: string) => {
    await fetch(`${API_BASE}/dashboard/queue/${segmentId}`, { method: "DELETE" });
  }, []);

  const patchQueued = useCallback(async (segmentId: string, patch: { priority?: number; pinned?: boolean }) => {
    await fetch(`${API_BASE}/dashboard/queue/${segmentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
  }, []);

  return (
    <main className="djShell mixerShell">
      <header className="djHeader">
        <div>
          <h1>PULSE AI BROADCAST CONSOLE</h1>
          <p>Channel mixer view for scheduled playout</p>
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

      <MixerSection
        snapshot={snapshot}
        streamUptimeSec={streamUptimeSec}
        channelViews={channelViews}
        mainMeter={mainMeter}
        playheadElapsedSec={playheadElapsedSec}
        playheadRemainingSec={playheadRemainingSec}
        playheadDurationSec={playheadDurationSec}
      />

      <section className="panel">
        <h2>Now Playing</h2>
        {snapshot?.nowPlaying ? (
          <>
            <p className="mono">{snapshot.nowPlaying.type.toUpperCase()} | {snapshot.nowPlaying.id} | {(snapshot.nowPlaying.channel || inferChannel(snapshot.nowPlaying)).toUpperCase()}</p>
            <p>{stripLabel(snapshot.nowPlaying)}</p>
            <div className="timeRow mono">
              <span>{fmtSeconds(playheadElapsedSec)}</span>
              <span>{fmtSeconds(playheadRemainingSec)}</span>
              <span>{fmtSeconds(playheadDurationSec)}</span>
            </div>
            <div className="progressTrack"><div className="progressFill" style={{ width: `${playheadPct}%` }} /></div>
            <MediaPlayer filePath={snapshot.nowPlaying.filePath} />
          </>
        ) : <p>No active segment.</p>}
      </section>

      <QueueSection queue={queue} apiBase={API_BASE} onRemove={removeQueued} onPatch={patchQueued} />

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

        <EventFeed events={deferredEvents} hlsUrl={hlsUrl} />
      </section>

      <section className="panel">
        <h2>Recent Played</h2>
        <div className="list mono">
          {recentSegments.map((s) => (
            <div key={`${s.id}-${s.startedAt}`} className="eventRow">
              <span>{s.type}</span>
              <span>{(s.channel || inferChannel(s)).toUpperCase()} | {s.type === "commentary" ? (s.commentaryText ?? s.notes) : s.notes}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Timeline Monitor</h2>
        <p className="mono">Transitions: {timeline?.nextTransitions.length ?? 0} | Deck Clips: {timeline?.activeDeckClips.length ?? 0} | VO Overlays: {timeline?.voiceoverOverlays.length ?? 0}</p>
      </section>
    </main>
  );
}
