// Context notes autosave: a plain controller (timers and one save at a time) and the hook that binds it to React.
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {ScopeContext} from '@nest/schemas';

/** Notes save this long after typing stops. */
export const NOTES_SAVE_DELAY_MS = 800;

/** A notes write lost to someone else's: `current` is what is stored now. */
export class NotesConflict extends Error {
  constructor(readonly current: ScopeContext) {
    super('Context changed');
    this.name = 'NotesConflict';
  }
}

export type NotesStatus = 'idle' | 'saving' | 'saved' | 'error';
export type NotesState = {text: string; status: NotesStatus; conflict: ScopeContext | null};
/** After each successful save: whether the notes were empty before, and the stored context. */
export type NotesSaved = {wasEmpty: boolean; next: ScopeContext};
export type NotesSave = (text: string, version: number) => Promise<ScopeContext>;

/**
 * Saves `delayMs` after the last keystroke, one request at a time: text typed while a save is in flight
 * is saved right after it, with the version that save returned. A 409 (NotesConflict) pauses saving until
 * `loadTheirs`; any other failure keeps the text unsaved until `retry`, the next keystroke or a flush.
 */
export function createNotesAutosave({save, delayMs = NOTES_SAVE_DELAY_MS, onSaved}: {save: NotesSave; delayMs?: number; onSaved?(saved: NotesSaved): void}) {
  let state: NotesState = {text: '', status: 'idle', conflict: null};
  let savedText = '';
  let version = 0;
  let dirty = false;
  let saving: Promise<void> | null = null;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<NotesState>) => { state = {...state, ...patch}; for (const listener of listeners) listener(); };
  const stop = () => { clearTimeout(timer); timer = undefined; };

  /** Saves now when anything is unsaved. Resolves once this save, and any queued after it, has finished. */
  function flush(): Promise<void> {
    stop();
    if (!dirty || state.conflict) return saving ?? Promise.resolve();
    if (saving) { queued = true; return saving; }
    dirty = false;
    const sent = state.text, wasEmpty = savedText.length === 0;
    set({status: 'saving'});
    const run = (async () => {
      try {
        const next = await save(sent, version);
        version = next.version;
        savedText = next.notes;
        set({status: dirty ? 'idle' : 'saved'});
        onSaved?.({wasEmpty, next});
      } catch (error) {
        dirty = true;
        if (error instanceof NotesConflict) set({conflict: error.current, status: 'idle'});
        else set({status: 'error'});
      } finally {
        saving = null;
        if (queued) { queued = false; await flush(); }
      }
    })();
    saving = run;
    return run;
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    /** The stored notes, once read. */
    load(notes: string, storedVersion: number) {
      stop();
      dirty = false;
      savedText = notes;
      version = storedVersion;
      set({text: notes, status: 'idle', conflict: null});
    },
    type(text: string) {
      set(state.status === 'saving' || state.conflict ? {text} : {text, status: 'idle'});
      dirty = true;
      if (state.conflict) return;
      stop();
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    retry: () => flush(),
    /** Drops the unsaved text and takes the stored version from the conflict. */
    loadTheirs() {
      const theirs = state.conflict;
      if (!theirs) return;
      stop();
      dirty = false;
      version = theirs.version;
      savedText = theirs.notes;
      set({text: theirs.notes, conflict: null, status: 'idle'});
    },
    /** Unsaved text a leaving page should still send, with the version it is based on. */
    pending: () => (dirty && !state.conflict && !saving ? {text: state.text, version} : null),
    /** The page is going away and has sent `pending` itself. */
    abandon() { stop(); dirty = false; },
  };
}
export type NotesAutosave = ReturnType<typeof createNotesAutosave>;

/**
 * Binds the controller to a panel: unsaved text is saved on unmount (closing the panel within the delay),
 * and on `pagehide` it is sent with `keep` (a keepalive request) so a reload or closed tab keeps it.
 */
export function useNotesAutosave({save, keep, onSaved}: {save: NotesSave; keep(text: string, version: number): void; onSaved?(saved: NotesSaved): void}) {
  const latest = useRef({save, keep, onSaved}); latest.current = {save, keep, onSaved};
  const [notes] = useState(() => createNotesAutosave({save: (text, version) => latest.current.save(text, version), onSaved: saved => latest.current.onSaved?.(saved)}));
  const state = useSyncExternalStore(notes.subscribe, notes.snapshot);
  useEffect(() => {
    const leave = () => {
      const pending = notes.pending();
      if (!pending) return;
      latest.current.keep(pending.text, pending.version);
      notes.abandon();
    };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); void notes.flush(); };
  }, [notes]);
  return {...state, notes};
}
