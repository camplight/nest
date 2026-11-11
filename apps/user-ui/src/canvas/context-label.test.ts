import {describe,expect,it} from 'vitest';
import type {BoardCard,ContextLink} from '@nest/schemas';
import {chatSees,contextLabel,fileKind,fileTypeLabel,joinNames,linkDetail,linkElsewhere,usedByList} from './context-label';

const link = (over: Partial<ContextLink> = {}): ContextLink => ({sourceAreaId: 's1', title: 'Brand kit', canvasId: 'c1', canvasName: 'Atlas', available: true, counts: {notes: true, fileCount: 1}, ...over});
const card = (home: Extract<BoardCard, {access: 'open'}>['home']): Extract<BoardCard, {access: 'open'}> => ({
  access: 'open', channelId: 'ch', x: 0, y: 0, w: 264, version: 0, title: 'Chat', projectId: null, participants: [], archived: false, canManage: true, home,
} as unknown as Extract<BoardCard, {access: 'open'}>);

describe('context labels', () => {
  it('reads like the mock: notes, files, or an invitation', () => {
    expect(contextLabel({notes: true, fileCount: 1})).toBe('Notes · 1 file');
    expect(contextLabel({notes: true, fileCount: 0})).toBe('Notes');
    expect(contextLabel({notes: false, fileCount: 3})).toBe('3 files');
    expect(contextLabel({notes: false, fileCount: 0})).toBe('Add context');
    expect(contextLabel({notes: false, fileCount: 0}, 'No context')).toBe('No context');
  });

  it('joins names with "and", and counts areas the viewer cannot open without naming them', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(usedByList([])).toBe('');
    expect(usedByList([{areaId: '1', title: 'Launch content'}, {areaId: '2', title: 'Teams plan pricing'}])).toBe('Launch content and Teams plan pricing');
    expect(usedByList([{areaId: '1', title: 'Launch'}, {areaId: '2', title: null}])).toBe("Launch and 1 area you can't open");
    expect(usedByList([{areaId: '1', title: null}, {areaId: '2', title: null}])).toBe("2 areas you can't open");
    expect(usedByList([{areaId: '1', title: ''}])).toBe('Untitled area');
  });

  it('describes a link by its canvas (only when it is another one) and its counts', () => {
    expect(linkDetail(link(), 'c1')).toBe('Notes · 1 file');
    expect(linkDetail(link({canvasId: 'c2', canvasName: 'Support ops'}), 'c1')).toBe('on Support ops · Notes · 1 file');
    expect(linkDetail(link({counts: {notes: false, fileCount: 0}}), 'c1')).toBe('Nothing yet');
    expect(linkDetail(link({available: false, counts: null}), 'c1')).toBe('unavailable');
    expect(linkDetail(link({title: 'Unavailable area', canvasId: null, canvasName: null, counts: null}), 'c1')).toBe('');
    expect(linkElsewhere(link(), 'c1')).toBe(false);
    expect(linkElsewhere(link({canvasId: 'c2'}), 'c1')).toBe(true);
    expect(linkElsewhere(link({canvasId: null}), 'c1')).toBe(false);
  });

  it('picks a tile glyph from the extension first, then the type', () => {
    expect(fileKind('image/png', 'a.png')).toBe('image');
    expect(fileKind('audio/webm', 'a.webm')).toBe('audio');
    expect(fileKind('video/webm', 'a.webm')).toBe('video');
    expect(fileKind('video/mp4', 'a.mp4')).toBe('video');
    expect(fileKind('text/csv', 'a.csv')).toBe('sheet');
    expect(fileKind('text/plain', 'brief.txt')).toBe('doc');
    // The agent upload tool sends a generic type for Office files: the extension decides.
    for (const mime of ['application/octet-stream', '', undefined]) {
      expect(fileKind(mime, 'Q3 revenue model.xlsx')).toBe('sheet');
      expect(fileKind(mime, 'Proposal.DOCX')).toBe('doc');
      expect(fileKind(mime, 'Pitch.pptx')).toBe('slides');
      expect(fileKind(mime, 'Q3 revenue report.pdf')).toBe('doc');
      expect(fileKind(mime, 'usage.csv')).toBe('sheet');
      expect(fileKind(mime, 'chart.png')).toBe('image');
    }
    expect(fileKind('application/octet-stream', 'deck.key')).toBe('slides');
    expect(fileKind('application/octet-stream', 'data.tsv')).toBe('sheet');
    expect(fileKind('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck')).toBe('slides');
    expect(fileKind('application/vnd.ms-excel', 'export')).toBe('sheet');
    expect(fileKind('image/jpeg', 'photo')).toBe('image');
    expect(fileKind('application/zip', 'bundle.zip')).toBe('doc');
  });

  it('names a file type the way a person would, never as a raw MIME type', () => {
    const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    expect(fileTypeLabel(xlsx, 'Q3 revenue model.xlsx')).toBe('Excel spreadsheet');
    expect(fileTypeLabel('application/octet-stream', 'Q3 revenue model.xlsx')).toBe('Excel spreadsheet');
    expect(fileTypeLabel(xlsx, 'model')).toBe('Excel spreadsheet');
    expect(fileTypeLabel('application/pdf', 'Q3 revenue report.pdf')).toBe('PDF');
    expect(fileTypeLabel('application/pdf', 'report')).toBe('PDF');
    expect(fileTypeLabel(undefined, 'Proposal.docx')).toBe('Word document');
    expect(fileTypeLabel('application/msword', 'old')).toBe('Word document');
    expect(fileTypeLabel(undefined, 'Pitch.pptx')).toBe('PowerPoint slides');
    expect(fileTypeLabel('text/csv', 'usage.csv')).toBe('CSV');
    expect(fileTypeLabel('text/plain', 'brief.txt')).toBe('Text');
    expect(fileTypeLabel('application/octet-stream', 'chart.png')).toBe('Image');
    expect(fileTypeLabel('image/svg+xml', 'diagram')).toBe('Image');
    expect(fileTypeLabel('audio/webm', 'Voice note.webm')).toBe('Audio');
    expect(fileTypeLabel('video/mp4', 'clip.mp4')).toBe('Video');
    expect(fileTypeLabel('application/zip', 'bundle.zip')).toBe('ZIP');
    expect(fileTypeLabel('application/octet-stream', 'README')).toBe('File');
    expect(fileTypeLabel(undefined, '')).toBe('File');
  });
});

describe('what an open chat sees (home semantics)', () => {
  const area = {id: 'a1', title: 'Launch'};
  it('counts the canvas, the home area and its available links when this card is home', () => {
    expect(chatSees(card({isHere: true, label: 'Launch'}), 'Atlas', area, [link(), link({sourceAreaId: 's2', title: 'Gone', available: false, counts: null})]))
      .toEqual({kind: 'sees', areaId: 'a1', names: ['Atlas', 'Launch', 'Brand kit']});
    expect(chatSees(card({isHere: true, label: 'Atlas'}), 'Atlas', null, [])).toEqual({kind: 'sees', areaId: null, names: ['Atlas']});
  });
  it('names the home elsewhere, says when it is unavailable, and has nothing without a home', () => {
    expect(chatSees(card({isHere: false, label: 'Briefing'}), 'Atlas', area, [link()])).toEqual({kind: 'from', label: 'Briefing'});
    expect(chatSees(card({isHere: false, label: null, available: false}), 'Atlas', area, [])).toEqual({kind: 'unavailable'});
    expect(chatSees(card(null), 'Atlas', area, [])).toEqual({kind: 'none'});
    expect(chatSees(card(undefined), 'Atlas', area, [])).toEqual({kind: 'none'});
  });
});
