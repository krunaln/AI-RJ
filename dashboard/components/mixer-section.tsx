import { memo } from "react";
import type { AudioChannel, DashboardSnapshot, QueueItem } from "../lib/types";
import { fmtSeconds, inferChannel, stripLabel } from "./channel-utils";

export type ChannelView = {
  channel: AudioChannel;
  label: string;
  active: QueueItem | DashboardSnapshot["nowPlaying"] | null;
  queued: QueueItem[];
  meterPct: number;
};

export const MixerSection = memo(function MixerSection({
  snapshot,
  streamUptimeSec,
  channelViews,
  mainMeter,
  playheadElapsedSec,
  playheadRemainingSec,
  playheadDurationSec
}: {
  snapshot: DashboardSnapshot | null;
  streamUptimeSec: number;
  channelViews: ChannelView[];
  mainMeter: number;
  playheadElapsedSec: number;
  playheadRemainingSec: number;
  playheadDurationSec: number;
}) {
  return (
    <section className="panel mixerPanel">
      <div className="mixerHead mono">
        <span>Uptime {fmtSeconds(streamUptimeSec)}</span>
        <span>Buffered {fmtSeconds(snapshot?.bufferedSec ?? 0)}</span>
        <span>Lookahead {fmtSeconds(snapshot?.lookaheadSecCovered ?? 0)}</span>
        <span>Phase {snapshot?.phase ?? "-"}</span>
        <span>Error {snapshot?.lastError ?? "none"}</span>
      </div>

      <div className="mixerBoard">
        {channelViews.map((strip) => {
          const isLive = Boolean(snapshot?.nowPlaying && inferChannel(snapshot.nowPlaying) === strip.channel);
          return (
            <article key={strip.channel} className={`channelStrip strip-${strip.channel} ${isLive ? "live" : ""}`}>
              <header>
                <h3>{strip.label}</h3>
                <span className="mono">{strip.channel.toUpperCase()}</span>
              </header>
              <div className="stripScreen mono">
                <div>{isLive ? "LIVE" : "READY"}</div>
                <div>{strip.active?.id ?? "none"}</div>
                <div>{stripLabel(strip.active)}</div>
              </div>
              <div className="meterStack">
                <div className="meterTrack vertical"><div className="meterFill" style={{ height: `${strip.meterPct}%` }} /></div>
                <div className="faderTrack"><div className="faderKnob" style={{ bottom: `${Math.max(8, strip.meterPct - 6)}%` }} /></div>
              </div>
              <div className="queueMini mono">
                <div>Vol {strip.meterPct}%</div>
                <div>Q {strip.queued.length}</div>
                <div>Next {strip.queued[0]?.id ?? "-"}</div>
                <div>At +{fmtSeconds((strip.queued[0]?.scheduledStartSec ?? 0) - (snapshot?.masterPlayhead.timelineOffsetSec ?? 0))}</div>
              </div>
            </article>
          );
        })}

        <article className="channelStrip masterStrip">
          <header>
            <h3>Main</h3>
            <span className="mono">MASTER</span>
          </header>
          <div className="stripScreen mono">
            <div>PLAYHEAD {fmtSeconds(snapshot?.masterPlayhead.timelineOffsetSec ?? 0)}</div>
            <div>ACTIVE {snapshot?.nowPlaying?.id ?? "none"}</div>
            <div>{snapshot?.nowPlaying ? stripLabel(snapshot.nowPlaying) : "no active segment"}</div>
          </div>
          <div className="meterStack">
            <div className="meterTrack vertical main"><div className="meterFill main" style={{ height: `${mainMeter}%` }} /></div>
            <div className="faderTrack main"><div className="faderKnob main" style={{ bottom: `${Math.max(8, mainMeter - 5)}%` }} /></div>
          </div>
          <div className="queueMini mono">
            <div>Vol {mainMeter}%</div>
            <div>Elapsed {fmtSeconds(playheadElapsedSec)}</div>
            <div>Remain {fmtSeconds(playheadRemainingSec)}</div>
            <div>Dur {fmtSeconds(playheadDurationSec)}</div>
          </div>
        </article>
      </div>
    </section>
  );
});
