import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ScopeContext} from '@nest/schemas';
import {NOTES_SAVE_DELAY_MS,NotesConflict,createNotesAutosave,type NotesSave} from './notes-autosave';

const stored = (notes: string, version: number): ScopeContext => ({notes, version, files: [], links: [], usedBy: []});
/** A save the test answers by hand: each call waits until it is resolved or rejected. */
function manualSave() {
  const calls: {text: string; version: number; resolve(value: ScopeContext): void; reject(error: unknown): void}[] = [];
  const save: NotesSave = (text, version) => new Promise((resolve, reject) => { calls.push({text, version, resolve, reject}); });
  return {save, calls};
}
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('notes autosave', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('saves once, 800 ms after the last keystroke, with the stored version', async () => {
    const {save, calls} = manualSave();
    const notes = createNotesAutosave({save});
    notes.load('Old', 4);
    notes.type('Ne');
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY_MS - 1);
    notes.type('New');
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map(c => [c.text, c.version])).toEqual([['New', 4]]);
    expect(notes.snapshot().status).toBe('saving');
    calls[0].resolve(stored('New', 5));
    await settle();
    expect(notes.snapshot()).toMatchObject({text: 'New', status: 'saved', conflict: null});
    expect(notes.pending()).toBeNull();
  });

  it('flushes straight away when the panel unmounts within the 800 ms window', async () => {
    const {save, calls} = manualSave();
    const onSaved = vi.fn();
    const notes = createNotesAutosave({save, onSaved});
    notes.load('', 0);
    notes.type('Typed and closed');
    await vi.advanceTimersByTimeAsync(300);
    const done = notes.flush();
    expect(calls.map(c => [c.text, c.version])).toEqual([['Typed and closed', 0]]);
    calls[0].resolve(stored('Typed and closed', 1));
    await done;
    // The debounce was cancelled: no second save when the window would have ended.
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY_MS);
    expect(calls).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledWith({wasEmpty: true, next: stored('Typed and closed', 1)});
  });

  it('saves the latest text, with the new version, after a save that was in flight while typing', async () => {
    const {save, calls} = manualSave();
    const notes = createNotesAutosave({save});
    notes.load('', 0);
    notes.type('First');
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY_MS);
    expect(calls).toHaveLength(1);
    notes.type('First and more');
    notes.type('First and more again');
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY_MS);
    // Still one request at a time.
    expect(calls).toHaveLength(1);
    expect(notes.snapshot()).toMatchObject({text: 'First and more again', status: 'saving'});
    calls[0].resolve(stored('First', 1));
    await settle();
    expect(calls.map(c => [c.text, c.version])).toEqual([['First', 0], ['First and more again', 1]]);
    expect(notes.snapshot().status).toBe('saving');
    calls[1].resolve(stored('First and more again', 2));
    await settle();
    expect(notes.snapshot()).toMatchObject({text: 'First and more again', status: 'saved'});
    expect(calls).toHaveLength(2);
  });

  it('keeps the text after a failed save until Try again saves it', async () => {
    const {save, calls} = manualSave();
    const notes = createNotesAutosave({save});
    notes.load('Old', 2);
    notes.type('Unsaved');
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY_MS);
    calls[0].reject(new Error('{"error":"Canvas context is unavailable. Refresh and retry."}'));
    await settle();
    expect(notes.snapshot()).toMatchObject({text: 'Unsaved', status: 'error', conflict: null});
    expect(notes.pending()).toEqual({text: 'Unsaved', version: 2});
    // Nothing retries by itself.
    await vi.advanceTimersByTimeAsync(10 * NOTES_SAVE_DELAY_MS);
    expect(calls).toHaveLength(1);
    const retried = notes.retry();
    expect(calls.map(c => [c.text, c.version])).toEqual([['Unsaved', 2], ['Unsaved', 2]]);
    calls[1].resolve(stored('Unsaved', 3));
    await retried;
    expect(notes.snapshot().status).toBe('saved');
    expect(notes.pending()).toBeNull();
  });

  it('pauses autosave after a 409 until their version is loaded', async () => {
    const {save, calls} = manualSave();
    const notes = createNotesAutosave({save});
    notes.load('Shared', 1);
    notes.type('Mine');
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY_MS);
    calls[0].reject(new NotesConflict(stored('Theirs', 2)));
    await settle();
    expect(notes.snapshot()).toMatchObject({text: 'Mine', status: 'idle', conflict: stored('Theirs', 2)});
    // Typing, waiting, flushing (close) and a leaving page all hold off while the conflict stands.
    notes.type('Mine, still typing');
    await vi.advanceTimersByTimeAsync(10 * NOTES_SAVE_DELAY_MS);
    await notes.flush();
    expect(notes.pending()).toBeNull();
    expect(calls).toHaveLength(1);

    notes.loadTheirs();
    expect(notes.snapshot()).toMatchObject({text: 'Theirs', status: 'idle', conflict: null});
    expect(notes.pending()).toBeNull();
    notes.type('Theirs, edited');
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY_MS);
    expect(calls.map(c => [c.text, c.version])).toEqual([['Mine', 1], ['Theirs, edited', 2]]);
  });

  it('hands unsaved text to a leaving page once, and then drops it', async () => {
    const {save, calls} = manualSave();
    const notes = createNotesAutosave({save});
    notes.load('Old', 7);
    expect(notes.pending()).toBeNull();
    notes.type('Leaving now');
    expect(notes.pending()).toEqual({text: 'Leaving now', version: 7});
    notes.abandon();
    expect(notes.pending()).toBeNull();
    await vi.advanceTimersByTimeAsync(NOTES_SAVE_DELAY_MS);
    await notes.flush();
    expect(calls).toHaveLength(0);
  });
});
