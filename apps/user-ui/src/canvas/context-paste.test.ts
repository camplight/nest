import {describe,expect,it} from 'vitest';
import {extractWebUrls,htmlLinkTitle,pasteAction} from './context-paste';

const file = new File(['x'], 'a.txt');

describe('extractWebUrls', () => {
  it('finds http and https addresses in text', () => {
    expect(extractWebUrls('see https://a.com/x and http://b.org')).toEqual(['https://a.com/x', 'http://b.org/']);
  });
  it('drops other schemes, repeats and trailing punctuation', () => {
    expect(extractWebUrls('javascript:alert(1) (https://a.com/x), https://a.com/x.')).toEqual(['https://a.com/x']);
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
