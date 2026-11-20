import {describe, expect, it} from 'vitest';
import {VOICE_BARS, fallbackPeaks, formatClock, nextRate, peaksOf, playedBars, seekByKey, seekFromPointer} from './voice-player';

describe('peaksOf', () => {
  it('turns samples into one normalised peak per bar, loudest bar at 1', () => {
    const samples = new Float32Array([0, 0.1, -0.2, 0.05, 0.5, -0.5, 0.25, 0]);
    expect(peaksOf(samples, 4)).toEqual([0.2, 0.4, 1, 0.5]);
  });
  it('keeps quiet bars visible with a floor', () => {
    const samples = new Float32Array([0, 0, 1, 1]);
    expect(peaksOf(samples, 2)[0]).toBeGreaterThan(0);
  });
  it('gives flat bars for silence or no samples', () => {
    expect(new Set(peaksOf(new Float32Array(8), 4)).size).toBe(1);
    expect(peaksOf(new Float32Array(0), 4)).toHaveLength(4);
  });
});

describe('fallbackPeaks', () => {
  it('is stable for a name and has the bar count', () => {
    expect(fallbackPeaks('Voice note.webm')).toEqual(fallbackPeaks('Voice note.webm'));
    expect(fallbackPeaks('Voice note.webm')).toHaveLength(VOICE_BARS);
    expect(fallbackPeaks('a.mp3')).not.toEqual(fallbackPeaks('b.mp3'));
    for (const peak of fallbackPeaks('x')) { expect(peak).toBeGreaterThan(0); expect(peak).toBeLessThanOrEqual(1); }
  });
});

describe('formatClock', () => {
  it('shows minutes and seconds, hours when long, and 0:00 for unknown', () => {
    expect(formatClock(3.4)).toBe('0:03');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('playedBars', () => {
  it('counts the bars behind the playhead', () => {
    expect(playedBars(0, 10, 40)).toBe(0);
    expect(playedBars(5, 10, 40)).toBe(20);
    expect(playedBars(10, 10, 40)).toBe(40);
    expect(playedBars(3, 0, 40)).toBe(0);
  });
});

describe('seekByKey', () => {
  it('moves 5 s with the arrows and jumps to the ends, clamped', () => {
    expect(seekByKey('ArrowRight', 3, 12)).toBe(8);
    expect(seekByKey('ArrowUp', 10, 12)).toBe(12);
    expect(seekByKey('ArrowLeft', 3, 12)).toBe(0);
    expect(seekByKey('ArrowDown', 9, 12)).toBe(4);
    expect(seekByKey('Home', 9, 12)).toBe(0);
    expect(seekByKey('End', 1, 12)).toBe(12);
    expect(seekByKey('a', 1, 12)).toBeNull();
    expect(seekByKey('ArrowRight', 1, 0)).toBeNull();
  });
});

describe('seekFromPointer', () => {
  it('maps a press across the waveform to a time, clamped', () => {
    expect(seekFromPointer(150, {left: 100, width: 200}, 20)).toBe(5);
    expect(seekFromPointer(50, {left: 100, width: 200}, 20)).toBe(0);
    expect(seekFromPointer(400, {left: 100, width: 200}, 20)).toBe(20);
    expect(seekFromPointer(150, {left: 100, width: 0}, 20)).toBe(0);
  });
});

describe('nextRate', () => {
  it('cycles 1×, 1.5×, 2× and back', () => {
    expect(nextRate(1)).toBe(1.5);
    expect(nextRate(1.5)).toBe(2);
    expect(nextRate(2)).toBe(1);
    expect(nextRate(1.25)).toBe(1);
  });
});
