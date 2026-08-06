// Version 2 added the phrase grid, version 3 the intro and outro. An older
// grid is rejected on read so it gets recomputed, rather than being planned
// against missing fields and silently falling back forever.
export const BEAT_GRID_VERSION = 3;

export type BeatGrid = {
  version: 3;
  bpm: number;              // raw detected tempo (NOT octave-normalized), 60..200
  firstBeatSec: number;     // seconds, time of first detected beat
  firstDownbeatSec: number; // seconds, time of first downbeat (start of a 4-beat bar)
  phraseBars: number;       // bars per phrase (4/8/16/32), the section period
  firstPhraseSec: number;   // seconds, start of the first full phrase
  phraseConfidence: number; // 0..1; 0 when no phrase grid stood out
  introEndSec: number;      // seconds; where the opening quiet run ends, 0 if none
  outroStartSec: number;    // seconds; where the closing quiet run begins
  hasOutro: boolean;        // false when the track never drops away at the end
  confidence: number;       // 0..1
  analyzedAt: number;       // epoch seconds
};
