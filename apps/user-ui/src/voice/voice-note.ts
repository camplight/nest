// A voice note: record, upload as a normal file, then transcribe it. A plain controller with every browser API injected,
// and the React hook (useVoiceNote.ts) that binds it to a composer.

/** At most this long per recording; recording stops by itself. */
export const MAX_VOICE_SECONDS = 300;
export const VOICE_BLOCKED = 'Microphone access was blocked.';
export const VOICE_TRANSCRIPTION_OFF = 'Transcription is off on this server.';
export const VOICE_TRANSCRIBE_FAILED = 'The recording is attached, but it could not be transcribed.';
export const VOICE_UPLOAD_FAILED = 'The recording could not be uploaded.';

export type VoiceState = 'idle' | 'recording' | 'uploading' | 'transcribing' | 'error';
export type VoiceSnapshot = {state: VoiceState; seconds: number; error: string | null};
export type VoiceAudio = {fileId: string; name: string; mime: string; size: number};

type Track = {stop(): void};
type Stream = {getTracks(): Track[]};
export type RecorderLike = {
  mimeType: string;
  ondataavailable: ((event: {data: Blob}) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};
export type RecorderClass = {new (stream: Stream, options?: {mimeType?: string}): RecorderLike; isTypeSupported(type: string): boolean};

export type VoiceDeps = {
  getUserMedia(): Promise<Stream>;
  Recorder: RecorderClass;
  /** POST /api/files; resolves the stored file's id. */
  upload(file: File): Promise<string>;
  /** GET /api/voice/config */
  transcriptionEnabled(): Promise<boolean>;
  /** POST /api/voice/transcribe */
  transcribe(fileId: string): Promise<string>;
  onAudio(audio: VoiceAudio): void;
  onTranscript(text: string): void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

/** `audio/webm`, or `audio/mp4` where webm cannot be recorded (Safari). */
export function pickMime(Recorder: Pick<RecorderClass, 'isTypeSupported'>): string | undefined {
  return ['audio/webm', 'audio/mp4'].find(type => Recorder.isTypeSupported(type));
}
const baseMime = (mime: string) => mime.split(';')[0].trim().toLowerCase();
/** The file name follows the recorded type. */
export const voiceFileName = (mime: string) => (baseMime(mime) === 'audio/mp4' ? 'Voice note.m4a' : 'Voice note.webm');

export function createVoiceNote(deps: VoiceDeps) {
  const every = deps.setInterval ?? setInterval, stopEvery = deps.clearInterval ?? clearInterval;
  let snapshot: VoiceSnapshot = {state: 'idle', seconds: 0, error: null};
  const listeners = new Set<() => void>();
  const set = (patch: Partial<VoiceSnapshot>) => { snapshot = {...snapshot, ...patch}; for (const listener of listeners) listener(); };
  // Bumped by cancel and unmount: whatever an older run finishes later is dropped.
  let run = 0;
  let stream: Stream | null = null, recorder: RecorderLike | null = null, ticker: ReturnType<typeof setInterval> | undefined;

  function release() {
    stopEvery(ticker); ticker = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    if (recorder) {
      const old = recorder;
      old.ondataavailable = old.onstop = old.onerror = null; recorder = null;
      try { old.stop(); } catch { /* already stopped */ }
    }
  }
  const fail = (id: number, error: string) => { if (id === run) set({state: 'error', error}); };

  async function start() {
    if (snapshot.state === 'recording' || snapshot.state === 'uploading' || snapshot.state === 'transcribing') return;
    const id = ++run;
    set({state: 'idle', seconds: 0, error: null});
    let media: Stream;
    try { media = await deps.getUserMedia(); } catch { fail(id, VOICE_BLOCKED); return; }
    if (id !== run) { for (const track of media.getTracks()) track.stop(); return; }
    stream = media;
    const chosen = pickMime(deps.Recorder);
    const chunks: Blob[] = [];
    let live: RecorderLike;
    try { live = new deps.Recorder(media, chosen ? {mimeType: chosen} : undefined); } catch { release(); fail(id, VOICE_BLOCKED); return; }
    recorder = live;
    live.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };
    live.onerror = () => { release(); fail(id, 'Recording failed.'); };
    live.onstop = () => { release(); void finish(id, chunks, live.mimeType || chosen || 'audio/webm'); };
    live.start();
    set({state: 'recording', seconds: 0, error: null});
    ticker = every(() => {
      if (id !== run || snapshot.state !== 'recording') return;
      set({seconds: snapshot.seconds + 1});
      if (snapshot.seconds >= MAX_VOICE_SECONDS) stop();
    }, 1000);
  }

  async function finish(id: number, chunks: Blob[], recorded: string) {
    if (id !== run) return;
    const mime = baseMime(recorded) || 'audio/webm';
    const blob = new Blob(chunks, {type: mime});
    if (blob.size === 0) { fail(id, 'Nothing was recorded.'); return; }
    const name = voiceFileName(mime);
    set({state: 'uploading'});
    let fileId: string;
    try { fileId = await deps.upload(new File([blob], name, {type: mime})); } catch { fail(id, VOICE_UPLOAD_FAILED); return; }
    if (id !== run) return;
    deps.onAudio({fileId, name, mime, size: blob.size});
    set({state: 'transcribing'});
    try {
      if (!await deps.transcriptionEnabled().catch(() => true)) { fail(id, VOICE_TRANSCRIPTION_OFF); return; }
      const text = (await deps.transcribe(fileId)).trim();
      if (id !== run) return;
      if (text) deps.onTranscript(text);
      set({state: 'idle', error: null});
    } catch { fail(id, VOICE_TRANSCRIBE_FAILED); }
  }

  /** Ends the recording; the note is then uploaded and transcribed. */
  function stop() {
    if (snapshot.state !== 'recording' || !recorder) return;
    stopEvery(ticker); ticker = undefined;
    try { recorder.stop(); } catch { const id = run; release(); fail(id, 'Recording failed.'); }
  }
  /** Throws everything away: the recording, a running upload's result and any transcript. */
  function cancel() {
    run++;
    release();
    set({state: 'idle', seconds: 0, error: null});
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => snapshot,
    start, stop, cancel,
    /** The page or composer is going away: the microphone is released and nothing more is delivered. */
    destroy() { run++; release(); },
  };
}
export type VoiceNote = ReturnType<typeof createVoiceNote>;
