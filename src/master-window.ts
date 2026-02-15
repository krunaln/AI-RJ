import { makeOutFile, trimAudioRange } from "./audio";
import { renderTimeline, type TimelineClip as MixClip } from "./timeline";
import type { RenderedSegment } from "./types";

export type PendingSegment = {
  segment: RenderedSegment;
  consumedSec: number;
};

function overlapFor(anchorType: RenderedSegment["type"], nextType: RenderedSegment["type"]): number {
  if (anchorType === "songs" && nextType === "commentary") return 6;
  if (anchorType === "commentary" && nextType === "songs") return 4;
  if (anchorType === "songs" && nextType === "songs") return 3.2;
  return 2.2;
}

export async function renderMasterWindowForAnchor(
  workDir: string,
  anchor: PendingSegment,
  upcoming: PendingSegment[],
  targetWindowSec: number
): Promise<RenderedSegment> {
  const anchorRemaining = Math.max(0.3, anchor.segment.durationSec - anchor.consumedSec);
  const anchorDur = Math.max(0.3, anchorRemaining);

  const extracted: string[] = [];
  const mixClips: MixClip[] = [];

  const anchorFile = makeOutFile(workDir, "mw-anchor");
  await trimAudioRange(anchor.segment.filePath, anchorFile, anchor.consumedSec, anchorDur);
  extracted.push(anchorFile);
  mixClips.push({
    filePath: anchorFile,
    startSec: 0,
    durationSec: anchorDur,
    gain: anchor.segment.type === "commentary" ? 1.9 : 1,
    fadeInSec: 0.2,
    fadeOutSec: 0.6
  });

  let cursor = anchorDur;
  for (const next of upcoming.slice(0, 3)) {
    const ov = overlapFor(anchor.segment.type, next.segment.type);
    const start = Math.max(0, cursor - ov);
    const dur = Math.min(next.segment.durationSec, ov + 6);
    const nextFile = makeOutFile(workDir, "mw-next");
    await trimAudioRange(next.segment.filePath, nextFile, next.consumedSec, dur);
    extracted.push(nextFile);
    mixClips.push({
      filePath: nextFile,
      startSec: start,
      durationSec: dur,
      gain: next.segment.type === "commentary" ? 1.9 : 1,
      fadeInSec: 0.2,
      fadeOutSec: 0.6
    });
    cursor = start + dur;
  }

  const out = makeOutFile(workDir, "master-window");
  await renderTimeline(mixClips, out, { master: true });

  return {
    id: anchor.segment.id,
    type: anchor.segment.type,
    filePath: out,
    durationSec: anchorDur,
    notes: `master-window:${anchor.segment.notes}`,
    commentaryText: anchor.segment.commentaryText,
    source: anchor.segment.source,
    priority: anchor.segment.priority,
    pinned: anchor.segment.pinned
  };
}
