// What a paste into the context popover means: files, web links, or nothing to add. Pure, so it is tested without a DOM.
import {MAX_WEB_LINK_TITLE,normalizeWebUrl} from '@nest/schemas';
import {pastedImageFile} from '../clipboard-files';

const PASTE_LINKS_MAX = 10;
const ADDRESS = /https?:\/\/[^\s<>"'`]+/gi;
/** Punctuation that ends a sentence or closes a bracket rather than the address. */
const TRAILING = /[.,;:!?\]}>]$/;
const count = (text: string, char: string) => text.split(char).length - 1;
/** Drops trailing sentence punctuation; a `)` only when it has no `(` to close, so `…/Foo_(bar)` stays whole. */
function trimAddress(address: string): string {
  let end = address;
  while (end && (TRAILING.test(end) || (end.endsWith(')') && count(end, ')') > count(end, '(')))) end = end.slice(0, -1);
  return end;
}

/** The normalized http(s) addresses in pasted text, in order, without repeats, at most `max`. Nothing is fetched. */
export function extractWebUrls(text: string, max = PASTE_LINKS_MAX): string[] {
  const found = new Set<string>();
  for (const match of text.match(ADDRESS) ?? []) {
    const url = normalizeWebUrl(trimAddress(match));
    if (url) found.add(url);
    if (found.size >= max) break;
  }
  return [...found];
}

const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
const plainText = (html: string) => html.replace(/<[^>]*>/g, '')
  .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  })
  .replace(/\s+/g, ' ').trim();

/** The text of the one anchor in copied HTML that points at `url`, when it says more than the address itself. */
export function htmlLinkTitle(html: string, url: string): string | null {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  if (anchors.length !== 1) return null;
  const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(anchors[0][1]);
  const target = href ? normalizeWebUrl(plainText(href[1] ?? href[2] ?? '')) : null;
  if (!target || target !== normalizeWebUrl(url)) return null;
  const title = plainText(anchors[0][2]);
  if (!title || title === url || normalizeWebUrl(title) === target) return null;
  return title.slice(0, MAX_WEB_LINK_TITLE);
}

/** The http(s) anchors of copied HTML: unique, at most `max`, each titled by its text unless that is the address. */
export function htmlLinkAnchors(html: string, max = PASTE_LINKS_MAX): {url: string; title: string | null}[] {
  const found = new Map<string, string | null>();
  for (const [, attrs, inner] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const url = href ? normalizeWebUrl(plainText(href[1] ?? href[2] ?? '')) : null;
    if (!url || found.has(url)) continue;
    const text = plainText(inner);
    found.set(url, !text || text === url || normalizeWebUrl(text) === url ? null : text.slice(0, MAX_WEB_LINK_TITLE));
    if (found.size >= max) break;
  }
  return [...found].map(([url, title]) => ({url, title}));
}

/** Whether the popover should take a paste: it landed inside the panel, or focus is nowhere (document body or root). */
export function pasteReachesPanel(input: {target: unknown; panel: {contains(node: never): boolean} | null; body: unknown; root: unknown; defaultPrevented: boolean}): boolean {
  if (input.defaultPrevented || !input.target) return false;
  if (input.target === input.body || input.target === input.root) return true;
  return Boolean(input.panel?.contains(input.target as never));
}

/** Clipboard screenshots all arrive as `image.<ext>`; those get a distinct pasted name, like the chat composer gives. */
export const nameClipboardFiles = (files: File[]) => files.map(file => file.type.startsWith('image/') && /^image\.\w+$/i.test(file.name) ? pastedImageFile(file) : file);

export type PasteAction =
  | {kind: 'ignore'}
  | {kind: 'files'; files: File[]}
  | {kind: 'links'; links: {url: string; title: string | null}[]}
  | {kind: 'hint'};

/** Pastes in a field, or from a viewer, are left alone; files win over text; otherwise addresses become links. */
export function pasteAction(input: {editable: boolean; inField: boolean; files: File[]; text: string; html: string}): PasteAction {
  if (input.inField || !input.editable) return {kind: 'ignore'};
  if (input.files.length) return {kind: 'files', files: input.files};
  const urls = extractWebUrls(input.text);
  if (!urls.length) {
    // Copied hyperlinks (docs, chat apps) carry the address only in the HTML.
    const anchors = htmlLinkAnchors(input.html);
    return anchors.length ? {kind: 'links', links: anchors} : {kind: 'hint'};
  }
  return {kind: 'links', links: urls.map(url => ({url, title: urls.length === 1 ? htmlLinkTitle(input.html, url) : null}))};
}
