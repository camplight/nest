import {describe,expect,it} from 'vitest';
import {extractWebUrls,htmlLinkAnchors,pasteAction,pasteReachesPanel,htmlLinkTitle,nameClipboardFiles} from './context-paste';

const file = new File(['x'], 'a.txt');

describe('extractWebUrls', () => {
  it('finds http and https addresses in text', () => {
    expect(extractWebUrls('see https://a.com/x and http://b.org')).toEqual(['https://a.com/x', 'http://b.org/']);
  });
  it('drops other schemes, repeats and trailing punctuation', () => {
    expect(extractWebUrls('javascript:alert(1) (https://a.com/x), https://a.com/x.')).toEqual(['https://a.com/x']);
  });
  it('keeps a closing parenthesis that belongs to the address', () => {
    expect(extractWebUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(extractWebUrls('(see https://a.com/x)')).toEqual(['https://a.com/x']);
    expect(extractWebUrls('(https://a.com/Foo_(bar))')).toEqual(['https://a.com/Foo_(bar)']);
  });
  it('caps the count', () => {
    const text = Array.from({length: 12}, (_, i) => `https://a.com/${i}`).join(' ');
    expect(extractWebUrls(text)).toHaveLength(10);
    expect(extractWebUrls(text, 3)).toHaveLength(3);
  });
});

describe('htmlLinkTitle', () => {
  it('takes the text of a single anchor for the address', () => {
    expect(htmlLinkTitle('<a href="https://a.com/x">Retreat plan</a>', 'https://a.com/x')).toBe('Retreat plan');
  });
  it('is null when the text is the address, there are two anchors or none', () => {
    expect(htmlLinkTitle('<a href="https://a.com/x">https://a.com/x</a>', 'https://a.com/x')).toBeNull();
    expect(htmlLinkTitle('<a href="https://a.com/x">One</a><a href="https://b.org/">Two</a>', 'https://a.com/x')).toBeNull();
    expect(htmlLinkTitle('<p>plain</p>', 'https://a.com/x')).toBeNull();
    expect(htmlLinkTitle('<a href="https://other.com/">Other</a>', 'https://a.com/x')).toBeNull();
  });
  it('limits the length', () => {
    expect(htmlLinkTitle(`<a href="https://a.com/x">${'t'.repeat(300)}</a>`, 'https://a.com/x')).toHaveLength(200);
  });
});

describe('pasteAction', () => {
  const base = {editable: true, inField: false, files: [] as File[], text: '', html: ''};
  it('ignores pastes into fields and from viewers', () => {
    expect(pasteAction({...base, inField: true, text: 'https://a.com'})).toEqual({kind: 'ignore'});
    expect(pasteAction({...base, editable: false, text: 'https://a.com'})).toEqual({kind: 'ignore'});
  });
  it('prefers files, even with text', () => {
    expect(pasteAction({...base, files: [file], text: 'https://a.com'})).toEqual({kind: 'files', files: [file]});
  });
  it('turns text with addresses into links, titled from a single anchor', () => {
    expect(pasteAction({...base, text: 'https://a.com/x', html: '<a href="https://a.com/x">Plan</a>'}))
      .toEqual({kind: 'links', links: [{url: 'https://a.com/x', title: 'Plan'}]});
    expect(pasteAction({...base, text: 'https://a.com/x https://b.org/', html: '<a href="https://a.com/x">Plan</a>'}))
      .toEqual({kind: 'links', links: [{url: 'https://a.com/x', title: null}, {url: 'https://b.org/', title: null}]});
  });
  it('hints when there is nothing to add', () => {
    expect(pasteAction({...base, text: 'just words'})).toEqual({kind: 'hint'});
  });
});

describe('copied hyperlinks', () => {
  const html = '<a href="https://a.com/x">Retreat plan</a> and <a href="https://b.org/">https://b.org/</a> <a href="https://a.com/x">again</a> <a href="mailto:a@b.c">mail</a>';
  it('reads the anchors: http(s) only, unique, titled by their text unless it is the address', () => {
    expect(htmlLinkAnchors(html)).toEqual([{url: 'https://a.com/x', title: 'Retreat plan'}, {url: 'https://b.org/', title: null}]);
    expect(htmlLinkAnchors(`<a href="https://a.com/x">${'t'.repeat(300)}</a>`)[0].title).toHaveLength(200);
    expect(htmlLinkAnchors(Array.from({length: 12}, (_, i) => `<a href="https://a.com/${i}">n${i}</a>`).join(''))).toHaveLength(10);
  });
  it('falls back to the anchors when the plain text has no address', () => {
    expect(pasteAction({editable: true, inField: false, files: [], text: 'Retreat plan', html}))
      .toEqual({kind: 'links', links: [{url: 'https://a.com/x', title: 'Retreat plan'}, {url: 'https://b.org/', title: null}]});
    expect(pasteAction({editable: true, inField: false, files: [], text: 'words', html: '<p>no anchors</p>'})).toEqual({kind: 'hint'});
  });
});

describe('pasteReachesPanel', () => {
  const inside = {}, outside = {}, body = {}, root = {};
  const panel = {contains: (node: unknown) => node === inside};
  const ctx = {panel, body, root};
  it('takes a paste inside the panel', () => {
    expect(pasteReachesPanel({...ctx, target: inside, defaultPrevented: false})).toBe(true);
  });
  it('takes a paste when focus is nowhere (body or root)', () => {
    expect(pasteReachesPanel({...ctx, target: body, defaultPrevented: false})).toBe(true);
    expect(pasteReachesPanel({...ctx, target: root, defaultPrevented: false})).toBe(true);
  });
  it('leaves other targets, such as the chat composer, and handled events alone', () => {
    expect(pasteReachesPanel({...ctx, target: outside, defaultPrevented: false})).toBe(false);
    expect(pasteReachesPanel({...ctx, target: body, defaultPrevented: true})).toBe(false);
    expect(pasteReachesPanel({...ctx, target: null, defaultPrevented: false})).toBe(false);
  });
});

describe('nameClipboardFiles', () => {
  it('renames generic clipboard images and keeps real names', () => {
    const [shot, doc] = nameClipboardFiles([new File(['x'], 'image.png', {type: 'image/png'}), new File(['x'], 'plan.png', {type: 'image/png'})]);
    expect(shot.name).toMatch(/^pasted-\d+-[0-9a-f]+\.png$/);
    expect(doc.name).toBe('plan.png');
  });
});
