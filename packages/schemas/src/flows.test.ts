import { describe, expect, it } from 'vitest';
import { NewLinkSchema, linkLabel } from './flows';

const id = '11111111-1111-4111-8111-111111111111';
describe('flow schemas', () => {
  it('labels links like the mock, with a paused suffix', () => {
    expect(linkLabel({ label: 'clips', when: 'approve', on: false, kind: 'link' })).toBe('clips · needs OK · paused');
    expect(linkLabel({ label: 'x', when: 'manual', on: true, kind: 'link' })).toBe('x · manual');
    expect(linkLabel({ label: 'fork · findings flow back', when: 'done', on: true, kind: 'fork' })).toBe('fork · findings flow back');
    expect(linkLabel({ label: 'fork · findings flow back', when: 'approve', on: true, kind: 'fork' })).toBe('fork · findings flow back');
  });
  it('rejects a self link and a long label, and applies defaults', () => {
    expect(NewLinkSchema.safeParse({ id, from: 'a', to: 'a' }).success).toBe(false);
    expect(NewLinkSchema.safeParse({ id, from: 'a', to: 'b', label: 'x'.repeat(61) }).success).toBe(false);
    expect(NewLinkSchema.parse({ id, from: 'a', to: 'b' })).toMatchObject({ what: 'results', when: 'done', label: 'results' });
  });
});
