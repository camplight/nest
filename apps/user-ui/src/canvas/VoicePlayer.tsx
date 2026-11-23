// The Nest voice player: a lime play button, the recording's own waveform (it fills as it plays, and a press or the
// arrow keys seek), the clock and a speed toggle. Used by the file viewer and by voice notes in chat messages.
// It reads only the audio it is given; nothing about the file leaves the page.
import {useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref} from 'react';
import {VOICE_BARS, fallbackPeaks, formatClock, nextRate, peaksOf, playedBars, seekByKey, seekFromPointer} from './voice-player';
import './voice-player.css';

type AudioContextClass = typeof AudioContext;
/** Decodes the recording for its waveform and true length (MediaRecorder WebM often reports an infinite duration). */
async function decode(src: string): Promise<{peaks: number[]; duration: number} | null> {
  const Context: AudioContextClass | undefined = typeof window === 'undefined' ? undefined
    : window.AudioContext ?? (window as unknown as {webkitAudioContext?: AudioContextClass}).webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  try {
    const buffer = await context.decodeAudioData(await (await fetch(src)).arrayBuffer());
    return {peaks: peaksOf(buffer.getChannelData(0), VOICE_BARS), duration: buffer.duration};
  } catch {
    return null;
  } finally {
    void context.close().catch(() => {});
  }
}

const PlayIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>;
const PauseIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>;

export type VoicePlayerProps = {
  /** A typed object URL (the viewer's allowlist). */
  src: string;
  name: string;
  autoPlay?: boolean;
  /** The browser cannot play it. */
  onFailed?(): void;
  /** Receives the play button, so a caller can move keyboard focus to the player. */
  buttonRef?: Ref<HTMLButtonElement>;
  /** `compact` for chat messages; the viewer uses the roomier default. */
  size?: 'compact' | 'roomy';
};

export function VoicePlayer({src, name, autoPlay = false, onFailed, buttonRef, size = 'roomy'}: VoicePlayerProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [peaks, setPeaks] = useState(() => fallbackPeaks(name));
  const scrubbing = useRef(false);

  useEffect(() => {
    let live = true;
    void decode(src).then(result => {
      if (!live || !result) return;
      setPeaks(result.peaks);
      setDuration(known => Number.isFinite(known) && known > 0 ? known : result.duration);
    });
    return () => { live = false; };
  }, [src]);

  useEffect(() => {
    if (autoPlay) void audio.current?.play().catch(() => {});
  }, [autoPlay, src]);

  // Smooth progress while playing; timeupdate alone moves the bars in visible steps.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => { if (audio.current && !scrubbing.current) setCurrent(audio.current.currentTime); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const seek = (time: number) => {
    const element = audio.current;
    if (!element) return;
    element.currentTime = time;
    setCurrent(time);
  };
  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => {}); else element.pause();
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const to = seekByKey(event.key, current, duration);
    if (to === null) return;
    event.preventDefault();
    seek(to);
  };
  const pointerSeek = (event: PointerEvent<HTMLDivElement>) => seek(seekFromPointer(event.clientX, event.currentTarget.getBoundingClientRect(), duration));
  const played = playedBars(current, duration, peaks.length);
  const known = duration > 0 && Number.isFinite(duration);

  return <div className="voice-player" data-size={size} data-playing={playing || undefined}>
    <audio ref={audio} src={src} preload="metadata"
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onEnded={() => { setPlaying(false); setCurrent(audio.current?.duration && Number.isFinite(audio.current.duration) ? audio.current.duration : duration); }}
      onTimeUpdate={event => { if (!scrubbing.current) setCurrent(event.currentTarget.currentTime); }}
      onLoadedMetadata={event => { const d = event.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDuration(d); }}
      onDurationChange={event => { const d = event.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDuration(d); }}
      onError={onFailed}/>
    <button ref={buttonRef} type="button" className="voice-player-play" onClick={toggle}
      aria-label={`${playing ? 'Pause' : 'Play'} ${name}`}>
      {playing ? <PauseIcon/> : <PlayIcon/>}
    </button>
    <div className="voice-player-wave" role="slider" tabIndex={0} aria-label={`Position in ${name}`}
      aria-valuemin={0} aria-valuemax={Math.round(known ? duration : 0)} aria-valuenow={Math.round(current)}
      aria-valuetext={`${formatClock(current)} of ${formatClock(duration)}`} aria-disabled={!known || undefined}
      onKeyDown={onKey}
      onPointerDown={event => { if (!known || event.button !== 0) return; scrubbing.current = true; try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* an untracked pointer still seeks */ } pointerSeek(event); }}
      onPointerMove={event => { if (scrubbing.current) pointerSeek(event); }}
      onPointerUp={event => { scrubbing.current = false; event.currentTarget.releasePointerCapture?.(event.pointerId); }}
      onPointerCancel={() => { scrubbing.current = false; }}>
      {peaks.map((peak, i) => <i key={i} className={i < played ? 'is-played' : undefined} style={{height: `${Math.round(peak * 100)}%`}}/>)}
    </div>
    <span className="voice-player-clock" aria-hidden="true">{formatClock(current)}<span> / {formatClock(duration)}</span></span>
    <button type="button" className="voice-player-rate" onClick={() => {
      const next = nextRate(rate);
      setRate(next);
      if (audio.current) audio.current.playbackRate = next;
    }} aria-label={`Playback speed ${rate}×`}>{rate}×</button>
  </div>;
}
