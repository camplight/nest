// Shared by every file drop target: what a drag carries, which elements take their own drops, and the files in a drop.

/**
 * The canvas elements that take their own file drops: cards, areas and the context popover. Window-wide drop zones
 * (the bottom box, an open chat) leave these alone.
 */
export const FILE_DROP_TARGETS = '.canvas-card, .canvas-area, .canvas-context';
export const outsideFileDropTargets = (target: EventTarget | null) => !(target instanceof Element && target.closest(FILE_DROP_TARGETS));
/** Inside the chat open beside or over the canvas: a split chat takes only the drops on itself. */
export const insideCanvasChat = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('.canvas-chat'));
/** Inside the active canvas chat (split, or the active window): a passive window takes its own drops for its own chat. */
export const insideActiveCanvasChat = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('.canvas-chat:not(.is-passive)'));
/** The canvas's bottom box: every drop that no card, area, popover or open chat takes ("anywhere else"). */
export const outsideCanvasChat = (target: EventTarget | null) => outsideFileDropTargets(target) && !insideCanvasChat(target);
export const FOLDER_NOTICE = 'Folders can’t be attached directly. Drop individual files or a ZIP archive.';

export function dragCarriesFiles(data: DataTransfer | null): boolean {
  return !!data && (Array.from(data.types).includes('Files') || Array.from(data.items).some(item => item.kind === 'file'));
}

/** The files in a drop, and whether any folder was left out. Read synchronously: the browser empties the data after the event. */
export function droppedFiles(data: DataTransfer): {files: File[]; folders: boolean} {
  const entries = Array.from(data.items).filter(item => item.kind === 'file');
  if (!entries.length) return {files: Array.from(data.files), folders: false};
  let folders = false;
  const files = entries.flatMap(item => {
    if (item.webkitGetAsEntry?.()?.isDirectory) { folders = true; return []; }
    const file = item.getAsFile();
    return file ? [file] : [];
  });
  return {files, folders};
}
