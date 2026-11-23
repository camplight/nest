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

export const voiceCapError = (max: number) => `You can attach up to ${max} files. 1 file was not added.`;

export type VoiceDeps = {
  getUserMedia(): Promise<Stream>;
  Recorder: RecorderClass;
  /** POST /api/files; resolves the stored file's id. */
  upload(file: File): Promise<string>;
  /** GET /api/voice/config */
  transcriptionEnabled(): Promise<boolean>;
  /** POST /api/voice/transcribe */
  transcribe(fileId: string): Promise<string>;
  /** Room for one more attachment; when there is none the note is not uploaded and the cap error shows. */
  attachRoom(): {ok: true} | {ok: false; error: string};
  onAudio(audio: VoiceAudio): void;
  /** Cancel (or leaving) while the note is still being processed: take its audio back off the attachment list. */
  onDiscard(fileId: string): void;
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
  // The audio this run attached, until the run ends: only then can Cancel take it back.
  let owned: string | null = null, stopping = false;
  let stream: Stream | null = null, recorder: RecorderLike | null = null, ticker: ReturnType<typeof setInterval> | undefined;

  function release() {
    stopping = false;
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
    stopping = false;
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
    const room = deps.attachRoom();
    if (!room.ok) { fail(id, room.error); return; }
    set({state: 'uploading'});
    let fileId: string;
    try { fileId = await deps.upload(new File([blob], name, {type: mime})); } catch { fail(id, VOICE_UPLOAD_FAILED); return; }
    if (id !== run) return;
    owned = fileId;
    deps.onAudio({fileId, name, mime, size: blob.size});
    set({state: 'transcribing'});
    try {
      if (!await deps.transcriptionEnabled().catch(() => true)) { if (id === run) owned = null; fail(id, VOICE_TRANSCRIPTION_OFF); return; }
      const text = (await deps.transcribe(fileId)).trim();
      if (id !== run) return;
      if (text) deps.onTranscript(text);
      owned = null;
      set({state: 'idle', error: null});
    } catch { if (id === run) owned = null; fail(id, VOICE_TRANSCRIBE_FAILED); }
  }

  /** Ends the recording; the note is then uploaded and transcribed. */
  function stop() {
    // A second stop (a double click, or the time limit racing a click) waits for the first: a recorder that has
    // been stopped throws on stop().
    if (snapshot.state !== 'recording' || !recorder || stopping) return;
    stopping = true;
    stopEvery(ticker); ticker = undefined;
    try { recorder.stop(); } catch { const id = run; release(); fail(id, 'Recording failed.'); }
  }
  /** Throws everything away: the recording, a running upload's result and any transcript. */
  function discard() {
    const fileId = owned; owned = null;
    if (fileId) deps.onDiscard(fileId);
  }
  function cancel() {
    run++;
    release();
    discard();
    set({state: 'idle', seconds: 0, error: null});
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => snapshot,
    start, stop, cancel,
    /** The page or composer is going away: the microphone is released and nothing more is delivered. */
    destroy() { run++; release(); discard(); },
  };
}
export type VoiceNote = ReturnType<typeof createVoiceNote>;
