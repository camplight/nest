import { describe, expect, it } from 'vitest';
import { accessExtras, channelAccess, viewerTeams } from './access';

const ana = { id: 'h-ana', username: 'ana' };
const chat = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'Chat', visibility: 'PRIVATE', ownerHumanId: 'h-owner', archivedAt: null,
  participants: [{ subscriberType: 'AGENT', subscriberId: 'Pip' }], ...over,
});

describe('channelAccess', () => {
  it.each([
    ['a PUBLIC chat', chat({ visibility: 'PUBLIC' }), { read: true, post: true, member: false }],
    ['a chat with an unknown visibility (the engine treats it as public)', chat({ visibility: undefined }), { read: true, post: true, member: false }],
    ['a chat the human owns', chat({ ownerHumanId: 'h-ana' }), { read: true, post: true, member: true }],
    ['a chat the human is a HUMAN participant of', chat({ participants: [{ subscriberType: 'HUMAN', subscriberId: 'ana' }] }), { read: true, post: true, member: true }],
    ['an archived chat the human owns', chat({ ownerHumanId: 'h-ana', archivedAt: 5 }), { read: true, post: false, member: true }],
    ['an archived PUBLIC chat', chat({ visibility: 'PUBLIC', archivedAt: 5 }), { read: true, post: false, member: false }],
    ['a private chat reached only through a team the human is not in', chat({ participants: [{ subscriberType: 'TEAM', subscriberId: 't-crew' }] }), { read: false, post: false, member: false }],
    ['a private chat with a TEAM participant named like the human', chat({ participants: [{ subscriberType: 'TEAM', subscriberId: 'ana' }] }), { read: false, post: false, member: false }],
    ['a private chat shared with someone else', chat({ shares: [{ viewerType: 'HUMAN', viewerId: 'bo' }] }), { read: false, post: false, member: false }],
    ['a private chat with an AGENT of the same name', chat({ participants: [{ subscriberType: 'AGENT', subscriberId: 'ana' }] }), { read: false, post: false, member: false }],
    ['a private chat of someone else', chat(), { read: false, post: false, member: false }],
    ['a missing chat', undefined, { read: false, post: false, member: false }],
  ])('%s', (_name, channel, expected) => {
    expect(channelAccess(channel, ana)).toEqual(expected);
  });

  // The engine's canViewChannel and canPostToChannel (OrgOps routes/access.ts): a team subscription counts like a
  // human one; a viewer share only lets the human read.
  const extra = (teamIds: string[] = [], viewerShare = false) => ({ teamIds: new Set(teamIds), viewerShare });
  it.each([
    ['a private chat reached through a team the human is in', chat({ participants: [{ subscriberType: 'TEAM', subscriberId: 't-crew' }] }), extra(['t-crew']), { read: true, post: true, member: false }],
    ['an archived chat reached through a team', chat({ archivedAt: 5, participants: [{ subscriberType: 'TEAM', subscriberId: 't-crew' }] }), extra(['t-crew']), { read: true, post: false, member: false }],
    ['a private chat of another team', chat({ participants: [{ subscriberType: 'TEAM', subscriberId: 't-other' }] }), extra(['t-crew']), { read: false, post: false, member: false }],
    ['a private chat shared with the human to view', chat(), extra([], true), { read: true, post: false, member: false }],
    ['a team id that is only an AGENT participant name', chat({ participants: [{ subscriberType: 'AGENT', subscriberId: 't-crew' }] }), extra(['t-crew']), { read: false, post: false, member: false }],
  ])('%s', (_name, channel, more, expected) => {
    expect(channelAccess(channel, ana, more)).toEqual(expected);
  });

  it('never matches a chat without an owner to a human by an empty id', () => {
    expect(channelAccess(chat({ ownerHumanId: null }), { id: '', username: 'ana' }).member).toBe(false);
  });
});

describe('accessExtras', () => {
  const crew = chat({ participants: [{ subscriberType: 'TEAM', subscriberId: 't-crew' }], shares: [{ viewerType: 'HUMAN', viewerId: 'ana' }, { viewerType: 'AGENT', viewerId: 'h-ana' }] });

  it('reads the viewer share from the chat record and the teams of the human it checks', async () => {
    const asked: string[] = [];
    const extras = accessExtras(async username => { asked.push(username); return new Set(['t-crew']); });
    expect(await extras(crew, ana)).toEqual({ teamIds: new Set(['t-crew']), viewerShare: true });
    expect(await extras(chat({ shares: [{ viewerType: 'AGENT', viewerId: 'ana' }] }), ana)).toEqual({ teamIds: new Set(), viewerShare: false });
    expect(asked).toEqual(['ana']);
  });

  it('reads no teams where a team cannot change the answer', async () => {
    const asked: string[] = [];
    const extras = accessExtras(async username => { asked.push(username); return new Set(['t-crew']); });
    await extras(chat(), ana);
    await extras(chat({ visibility: 'PUBLIC', participants: [{ subscriberType: 'TEAM', subscriberId: 't-crew' }] }), ana);
    await extras(chat({ ownerHumanId: 'h-ana', participants: [{ subscriberType: 'TEAM', subscriberId: 't-crew' }] }), ana);
    await extras(undefined, ana);
    expect(asked).toEqual([]);
  });

  it('takes the viewer\'s own teams for the viewer only, read once', async () => {
    let reads = 0;
    const teams = viewerTeams(async () => { reads++; return [{ id: 't-crew' }]; }, 'ana');
    expect(await teams('ana')).toEqual(new Set(['t-crew']));
    expect(await teams('bo')).toEqual(new Set());
    expect(await teams('ana')).toEqual(new Set(['t-crew']));
    expect(reads).toBe(1);
  });
});
