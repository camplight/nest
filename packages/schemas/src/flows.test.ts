import { describe, expect, it } from 'vitest';
import { NewForkSchema, NewLinkSchema, forkTitle, linkLabel } from './flows';

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
  it('names a fork after the first sentence, like the mock', () => {
    expect(forkTitle('Agreed on more data. I will go deep')).toBe('Fork: Agreed on more data');
    expect(forkTitle('Compare: per seat or flat?')).toBe('Fork: Compare');
    expect(forkTitle('x'.repeat(50))).toBe(`Fork: ${'x'.repeat(38)}`);
    expect(forkTitle('  \n ')).toBe('Fork');
  });
  it('refuses a fork into its own chat', () => {
    expect(NewForkSchema.safeParse({ childChannelId: 'a', parentChannelId: 'a', parentEventId: 'e' }).success).toBe(false);
    expect(NewForkSchema.safeParse({ childChannelId: 'a', parentChannelId: 'b', parentEventId: 'e', extra: 1 }).success).toBe(false);
    expect(NewForkSchema.parse({ childChannelId: 'a', parentChannelId: 'b', parentEventId: 'e' })).toEqual({ childChannelId: 'a', parentChannelId: 'b', parentEventId: 'e' });
  });
});
