// The Nest voice player's arithmetic: waveform peaks, the clock, seeking and playback speed. No DOM, so it is tested
// in node; VoicePlayer.tsx draws and drives the <audio> element.

/** Bars in the waveform. */
export const VOICE_BARS = 48;
/** Quiet bars keep this height, so silence still reads as a waveform. */
const FLOOR = 0.08;
/** Arrow keys move this many seconds. */
export const SEEK_STEP = 5;
export const RATES = [1, 1.5, 2] as const;

const round = (value: number) => Math.round(value * 1000) / 1000;

/** One peak per bar (0..1, the loudest bar at 1) from decoded samples; flat bars for silence or no samples. */
export function peaksOf(samples: Float32Array, bars = VOICE_BARS): number[] {
  const n = samples.length;
  if (!n) return Array.from({length: bars}, () => FLOOR);
  const raw = Array.from({length: bars}, (_, i) => {
    const start = Math.floor(i * n / bars), end = Math.max(start + 1, Math.floor((i + 1) * n / bars));
    let peak = 0;
    for (let j = start; j < end && j < n; j++) peak = Math.max(peak, Math.abs(samples[j]!));
    return peak;
  });
  const max = Math.max(...raw);
  return raw.map(peak => max > 0 ? round(Math.max(FLOOR, peak / max)) : FLOOR);
}

/** A stable stand-in waveform for a file the browser cannot decode, so the player never shows an empty strip. */
export function fallbackPeaks(seed: string, bars = VOICE_BARS): number[] {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return Array.from({length: bars}, (_, i) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const wobble = 0.55 + 0.35 * Math.sin(i / 2.6);
    return round(Math.min(1, Math.max(0.2, wobble * (0.6 + 0.4 * (state / 0xffffffff)))));
  });
}

/** `0:03`, `1:15`, `1:02:05`; unknown or infinite durations read `0:00`. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** How many bars sit behind the playhead. */
export function playedBars(current: number, duration: number, bars = VOICE_BARS): number {
  if (!(duration > 0) || !Number.isFinite(duration)) return 0;
  return Math.round(Math.min(1, Math.max(0, current / duration)) * bars);
}

/** The time a key moves the playhead to (arrows by SEEK_STEP, Home and End to the ends), or null for other keys. */
export function seekByKey(key: string, current: number, duration: number): number | null {
  if (!(duration > 0) || !Number.isFinite(duration)) return null;
  const clamp = (t: number) => Math.min(duration, Math.max(0, t));
  switch (key) {
    case 'ArrowRight': case 'ArrowUp': return clamp(current + SEEK_STEP);
    case 'ArrowLeft': case 'ArrowDown': return clamp(current - SEEK_STEP);
    case 'Home': return 0;
    case 'End': return duration;
    default: return null;
  }
}

/** The time under a pointer at `clientX` across the waveform's box. */
export function seekFromPointer(clientX: number, box: {left: number; width: number}, duration: number): number {
  if (!(box.width > 0) || !(duration > 0) || !Number.isFinite(duration)) return 0;
  return Math.min(duration, Math.max(0, (clientX - box.left) / box.width * duration));
}

/** 1× → 1.5× → 2× → 1×; any other speed goes back to 1×. */
export function nextRate(rate: number): number {
  const index = RATES.indexOf(rate as (typeof RATES)[number]);
  return index < 0 ? 1 : RATES[(index + 1) % RATES.length]!;
}
