import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "./config";
import type { RenderedSegment, Track } from "./types";
import { loadCatalog } from "./catalog";
import { YouTubeAudioService } from "./youtube";
import { CommentaryService } from "./llm";
import { TTSClient } from "./tts";
import { RtmpPublisher } from "./publisher";
import { applyEdgeFades, enhanceCommentaryVoice, getDurationSec, makeOutFile, mixCommentaryWithTrackBed, prependStationId, silenceFile, trimAudioStart } from "./audio";
import { log, logError } from "./log";
import { RuntimeState } from "./runtime-state";
import { buildTimelineSnapshot } from "./timeline-engine";
import type { TimelineSnapshot } from "./types";
import { renderMasterWindowForAnchor, type PendingSegment } from "./master-window";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Orchestrator {
  private tracks: Track[] = [];
  private running = false;
  private shuffledTrackOrder: number[] = [];
  private shuffledPtr = 0;
  private phase: "songs" | "commentary" = "songs";
  private lastPlayed: Track[] = [];
  private lastError = "";
  private songsSinceCommentary = 0;
  private carryOverTrackId: string | null = null;
  private carryOverOffsetSec = 0;
  private forcedNextTrackId: string | null = null;
  private readonly runtime = new RuntimeState();
  private pendingMasterSegments: PendingSegment[] = [];
  private stationIdAvailable = false;

  private readonly yt = new YouTubeAudioService(appConfig.workDir);
  private readonly commentary = new CommentaryService(appConfig.groqApiKey, appConfig.groqModel, appConfig.persona);
  private readonly tts = new TTSClient(appConfig.ttsBaseUrl);
  private readonly publisher = new RtmpPublisher(appConfig.workDir, appConfig.rtmpUrl, {
    onStarted: (rtmpUrl) => this.runtime.publisherStarted(rtmpUrl),
    onStopped: () => this.runtime.publisherStopped(),
    onError: (message, code) => this.runtime.publisherError(message, code),
    onFfmpegLine: (line) => this.runtime.publisherLine(line),
    onSegmentStarted: (segmentId) => this.runtime.segmentStarted(segmentId),
    onSegmentFinished: (segmentId, bufferedSec) => this.runtime.segmentFinished(segmentId, bufferedSec)
  });

  getRuntimeState(): RuntimeState {
    return this.runtime;
  }

  async enqueueManualCommentary(text: string): Promise<RenderedSegment> {
    await this.yt.init();
    const raw = makeOutFile(appConfig.workDir, "manual-talk-raw");
    const voiced = makeOutFile(appConfig.workDir, "manual-talk");
    const next = this.peekNextTrack();

    await this.tts.synthToFile(text, raw);
    const voiceDuration = await getDurationSec(raw);

    if (next) {
      try {
        const bed = await this.yt.fetchTrackWav(next);
        await mixCommentaryWithTrackBed(raw, bed, voiced, voiceDuration);
      } catch {
        await enhanceCommentaryVoice(raw, voiced);
      }
    } else {
      await enhanceCommentaryVoice(raw, voiced);
    }

    let finalCommentary = voiced;
    if (this.stationIdAvailable) {
      const withId = makeOutFile(appConfig.workDir, "manual-talk-id");
      await prependStationId(appConfig.stationIdPath, voiced, withId);
      finalCommentary = withId;
    }

    const durationSec = await getDurationSec(finalCommentary);
    const seg: RenderedSegment = {
      id: `manual-talk-${Date.now()}`,
      type: "commentary",
      filePath: finalCommentary,
      durationSec,
      notes: text,
      commentaryText: text,
      source: "manual",
      priority: 120,
      pinned: true
    };
    this.publisher.enqueue(seg);
    this.runtime.enqueueSegment(seg, this.publisher.getBufferedSec());
    return seg;
  }

  async enqueueManualTrack(input: { title: string; artist?: string; youtube_url: string }): Promise<RenderedSegment> {
    await this.yt.init();
    const track: Track = {
      id: `manual-track-${Date.now()}`,
      title: input.title,
      artist: input.artist || "Unknown Artist",
      youtube_url: input.youtube_url,
      duration_sec: 180,
      tags: ["manual"],
      energy: 0.5,
      mood: "custom",
      language: "en"
    };
    const filePath = await this.yt.fetchTrackWav(track);
    const durationSec = await getDurationSec(filePath);
    const seg: RenderedSegment = {
      id: `manual-song-${Date.now()}`,
      type: "songs",
      filePath,
      durationSec,
      notes: `${track.title} - ${track.artist}`,
      source: "manual",
      priority: 110,
      pinned: true
    };
    this.publisher.enqueue(seg);
    this.runtime.enqueueSegment(seg, this.publisher.getBufferedSec());
    return seg;
  }

  removeQueuedSegment(segmentId: string): boolean {
    const removed = this.publisher.removeQueuedSegment(segmentId);
    if (!removed) {
      return false;
    }
    this.runtime.removeQueuedSegment(segmentId, this.publisher.getBufferedSec());
    return true;
  }

  updateQueuedSegment(segmentId: string, patch: { priority?: number; pinned?: boolean }): boolean {
    const updated = this.publisher.updateQueuedSegment(segmentId, patch);
    if (!updated) {
      return false;
    }
    this.runtime.updateQueuedSegment(segmentId, patch, this.publisher.getBufferedSec());
    return true;
  }

  getTimelineSnapshot(): TimelineSnapshot {
    const s = this.runtime.snapshot();
    return buildTimelineSnapshot(s);
  }

  rebuildTimeline(reason = "manual"): TimelineSnapshot {
    this.runtime.markSchedulerRebuild("started", reason);
    try {
      const snap = this.getTimelineSnapshot();
      this.runtime.markSchedulerRebuild("done", reason);
      return snap;
    } catch (error) {
      this.runtime.markSchedulerRebuild("failed", reason);
      throw error;
    }
  }

  skipCurrentSegment(): boolean {
    this.runtime.markSkipRequested();
    const ok = this.publisher.skipCurrentSegment();
    if (ok) {
      this.runtime.markSkipCompleted();
    }
    return ok;
  }

  getMediaPath(segmentId: string): string | null {
    return this.runtime.getMediaPath(segmentId);
  }

  async start(): Promise<void> {
    if (this.running) return;
    await mkdir(appConfig.workDir, { recursive: true });
    this.tracks = await loadCatalog(appConfig.catalogPath);
    this.resetShuffleOrder();
    this.stationIdAvailable = await this.checkStationId();
    await this.yt.init();
    await this.publisher.start();

    this.running = true;
    this.songsSinceCommentary = 0;
    this.pendingMasterSegments = [];
    this.runtime.setCore({
      running: true,
      phase: this.phase,
      tracksLoaded: this.tracks.length,
      bufferedSec: this.publisher.getBufferedSec(),
      lastError: null
    });
    this.loop().catch((err) => {
      this.lastError = String(err instanceof Error ? err.message : err);
      logError("orchestrator.loop.crash", err);
      this.running = false;
      this.runtime.markBuildFailed(this.lastError);
      this.runtime.setCore({ running: false, lastError: this.lastError });
    });
    log("orchestrator.started", { tracks: this.tracks.length });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.publisher.stop();
    this.runtime.setCore({ running: false, bufferedSec: this.publisher.getBufferedSec() });
    log("orchestrator.stopped");
  }

  status(): Record<string, unknown> {
    const s = this.runtime.snapshot();
    return { running: s.running, tracksLoaded: s.tracksLoaded, phase: s.phase, bufferedSec: s.bufferedSec, lastPlayed: this.lastPlayed.map((t) => `${t.title} - ${t.artist}`), lastError: s.lastError };
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const bufferedSec = this.publisher.getBufferedSec();
      this.runtime.setCore({ bufferedSec, phase: this.phase });
      if (bufferedSec < appConfig.targetBufferSec) {
        try {
          this.runtime.markBuildStarted(this.phase);
          const seg = await this.buildNextSegment();
          if (appConfig.timelineEngineV2) {
            this.pendingMasterSegments.push({ segment: seg, consumedSec: 0 });
            this.runtime.enqueueSegment(seg, this.publisher.getBufferedSec());
            await this.flushMasterWindows();
          } else {
            this.publisher.enqueue(seg);
            this.runtime.enqueueSegment(seg, this.publisher.getBufferedSec());
          }
          log("segment.enqueued", {
            segmentId: seg.id,
            type: seg.type,
            durationSec: seg.durationSec,
            bufferedSec: this.publisher.getBufferedSec(),
            notes: seg.notes
          });
        } catch (error) {
          this.lastError = String(error instanceof Error ? error.message : error);
          logError("segment.build.error", error);
          this.runtime.markBuildFailed(this.lastError);
          this.runtime.setCore({ lastError: this.lastError });
          await this.enqueueEmergencySilence();
        }
      }
      await wait(250);
    }
  }

  private nextTrack(): Track {
    if (!this.tracks.length) {
      throw new Error("No tracks available");
    }
    if (!this.shuffledTrackOrder.length || this.shuffledPtr >= this.shuffledTrackOrder.length) {
      this.resetShuffleOrder();
    }
    const idx = this.shuffledTrackOrder[this.shuffledPtr];
    this.shuffledPtr += 1;
    return this.tracks[idx] as Track;
  }

  private resetShuffleOrder(): void {
    const n = this.tracks.length;
    this.shuffledTrackOrder = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = this.shuffledTrackOrder[i];
      const b = this.shuffledTrackOrder[j];
      this.shuffledTrackOrder[i] = b;
      this.shuffledTrackOrder[j] = a;
    }

    // Avoid same track repeating at boundary between shuffle cycles.
    if (n > 1 && this.lastPlayed[0]) {
      const lastId = this.lastPlayed[0].id;
      const firstIdx = this.shuffledTrackOrder[0];
      const firstTrack = this.tracks[firstIdx];
      if (firstTrack?.id === lastId) {
        const swapIdx = 1 + Math.floor(Math.random() * (n - 1));
        const tmp = this.shuffledTrackOrder[0];
        this.shuffledTrackOrder[0] = this.shuffledTrackOrder[swapIdx];
        this.shuffledTrackOrder[swapIdx] = tmp;
      }
    }
    this.shuffledPtr = 0;
  }

  private async buildNextSegment(): Promise<RenderedSegment> {
    if (this.phase === "songs") {
      const track = this.consumeNextSongTrack();
      let rawSong: string;
      try {
        rawSong = await this.yt.fetchTrackWav(track);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.runtime.markYoutubeError(msg);
        throw error;
      }
      if (this.carryOverTrackId === track.id && this.carryOverOffsetSec > 0) {
        const trimmed = makeOutFile(appConfig.workDir, "song-carry-trim");
        await trimAudioStart(rawSong, trimmed, this.carryOverOffsetSec);
        rawSong = trimmed;
        this.carryOverTrackId = null;
        this.carryOverOffsetSec = 0;
        this.forcedNextTrackId = null;
      }
      const out = makeOutFile(appConfig.workDir, "song-faded");
      await applyEdgeFades(rawSong, out, 0.4, 0.9);

      const durationSec = await getDurationSec(out);
      this.lastPlayed = [track];
      this.songsSinceCommentary += 1;
      const cadence = Math.max(1, appConfig.commentaryEveryNSongs);
      this.phase = this.songsSinceCommentary >= cadence ? "commentary" : "songs";
      this.runtime.setCore({ phase: this.phase });

      return {
        id: `songs-${Date.now()}`,
        type: "songs",
        filePath: out,
        durationSec,
        notes: `${track.title} - ${track.artist}`,
        source: "auto",
        priority: 50,
        pinned: false
      };
    }

    const next = this.peekNextTrack();
    let out = makeOutFile(appConfig.workDir, "talk");
    let type: RenderedSegment["type"] = "commentary";
    let notes = "generated commentary";
    let commentaryText: string | undefined;

    try {
      const text = await this.commentary.generateCommentary(this.lastPlayed, next);
      commentaryText = text;
      notes = text;
      this.runtime.markCommentaryGenerated(text.length);
      try {
        const raw = makeOutFile(appConfig.workDir, "talk-raw");
        out = await this.tts.synthToFile(text, raw);
        const voiced = makeOutFile(appConfig.workDir, "talk-mix");
        const voiceDuration = await getDurationSec(out);
        if (next) {
          try {
            const bed = await this.yt.fetchTrackWav(next);
            await mixCommentaryWithTrackBed(out, bed, voiced, voiceDuration);
            // Next song continues from where commentary already previewed its bed.
            this.carryOverTrackId = next.id;
            const bedStartSec = Math.max(0, voiceDuration * 0.5);
            const bedTailSec = 0.9;
            const previewedBedSec = Math.max(0, voiceDuration - bedStartSec + bedTailSec);
            this.carryOverOffsetSec = Math.max(0, Math.min(previewedBedSec, 25));
            this.forcedNextTrackId = next.id;
          } catch {
            await enhanceCommentaryVoice(out, voiced);
            this.carryOverTrackId = null;
            this.carryOverOffsetSec = 0;
            this.forcedNextTrackId = null;
          }
        } else {
          await enhanceCommentaryVoice(out, voiced);
          this.carryOverTrackId = null;
          this.carryOverOffsetSec = 0;
          this.forcedNextTrackId = null;
        }
        let withStationId = voiced;
        if (this.stationIdAvailable) {
          const pre = makeOutFile(appConfig.workDir, "talk-with-id");
          await prependStationId(appConfig.stationIdPath, voiced, pre);
          withStationId = pre;
        }
        const finalOut = makeOutFile(appConfig.workDir, "talk-faded");
        await applyEdgeFades(withStationId, finalOut, 0.25, 0);
        out = finalOut;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.runtime.markTtsError(message);
        throw error;
      }
    } catch (error) {
      logError("commentary.failed", error);
      const message = error instanceof Error ? error.message : String(error);
      this.runtime.markCommentaryFallback(message);
      const liner = await this.pickEmergencyLiner();
      if (liner) {
        out = liner;
        type = "liner";
        notes = "emergency liner fallback";
      } else {
        await silenceFile(out, 3);
        type = "liner";
        notes = "silence fallback";
      }
    }

    const durationSec = await getDurationSec(out);
    this.phase = "songs";
    this.songsSinceCommentary = 0;
    this.runtime.setCore({ phase: this.phase });

    return {
      id: `talk-${Date.now()}`,
      type,
      filePath: out,
      durationSec,
      notes,
      commentaryText,
      source: "auto",
      priority: 50,
      pinned: false
    };
  }

  private async pickEmergencyLiner(): Promise<string | null> {
    try {
      const entries = await readdir(appConfig.emergencyDir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".wav"))
        .map((e) => path.join(appConfig.emergencyDir, e.name));
      if (!files.length) return null;
      return files[Math.floor(Math.random() * files.length)];
    } catch {
      return null;
    }
  }

  private peekNextTrack(): Track | null {
    if (!this.tracks.length) return null;
    if (!this.shuffledTrackOrder.length || this.shuffledPtr >= this.shuffledTrackOrder.length) {
      this.resetShuffleOrder();
    }
    const idx = this.shuffledTrackOrder[this.shuffledPtr];
    return this.tracks[idx] || null;
  }

  private consumeNextSongTrack(): Track {
    if (this.forcedNextTrackId) {
      const forced = this.tracks.find((t) => t.id === this.forcedNextTrackId);
      if (forced) {
        this.consumeFromShuffle(forced.id);
        return forced;
      }
      this.forcedNextTrackId = null;
    }
    return this.nextTrack();
  }

  private consumeFromShuffle(trackId: string): void {
    if (!this.shuffledTrackOrder.length || this.shuffledPtr >= this.shuffledTrackOrder.length) {
      return;
    }
    const peekIdx = this.shuffledTrackOrder[this.shuffledPtr];
    const peekTrack = this.tracks[peekIdx];
    if (peekTrack?.id === trackId) {
      this.shuffledPtr += 1;
      return;
    }
    // Remove any future occurrence from the remaining order so forced track doesn't repeat soon.
    for (let i = this.shuffledPtr; i < this.shuffledTrackOrder.length; i += 1) {
      const idx = this.shuffledTrackOrder[i];
      if (this.tracks[idx]?.id === trackId) {
        this.shuffledTrackOrder.splice(i, 1);
        return;
      }
    }
  }

  private async checkStationId(): Promise<boolean> {
    try {
      await access(appConfig.stationIdPath);
      return true;
    } catch {
      return false;
    }
  }

  private async enqueueEmergencySilence(): Promise<void> {
    const out = makeOutFile(appConfig.workDir, "recover");
    await silenceFile(out, 2);
    const durationSec = await getDurationSec(out);
    const seg: RenderedSegment = {
      id: `recover-${Date.now()}`,
      type: "liner",
      filePath: out,
      durationSec,
      notes: "recovery silence",
      source: "auto",
      priority: 200,
      pinned: true
    };
    if (appConfig.timelineEngineV2) {
      this.pendingMasterSegments.push({ segment: seg, consumedSec: 0 });
      this.runtime.enqueueSegment(seg, this.publisher.getBufferedSec());
      await this.flushMasterWindows();
    } else {
      this.publisher.enqueue(seg);
      this.runtime.enqueueSegment(seg, this.publisher.getBufferedSec());
    }
  }

  private async flushMasterWindows(): Promise<void> {
    this.runtime.markSchedulerRebuild("started", "master_window_flush");
    while (this.publisher.getBufferedSec() < appConfig.targetBufferSec && this.pendingMasterSegments.length > 0) {
      const anchor = this.pendingMasterSegments[0];
      const upcoming = this.pendingMasterSegments.slice(1);
      const windowSeg = await renderMasterWindowForAnchor(
        appConfig.workDir,
        anchor,
        upcoming,
        appConfig.masterWindowSec
      );
      this.publisher.enqueue(windowSeg);
      this.pendingMasterSegments.shift();
    }
    this.runtime.markSchedulerRebuild("done", "master_window_flush");
  }
}
