import { describe, expect, it } from 'vitest';
import { channelAccess } from './access';

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
    ['a private chat reached only through a team', chat({ participants: [{ subscriberType: 'TEAM', subscriberId: 'ana' }] }), { read: false, post: false, member: false }],
    ['a private chat with an AGENT of the same name', chat({ participants: [{ subscriberType: 'AGENT', subscriberId: 'ana' }] }), { read: false, post: false, member: false }],
    ['a private chat of someone else', chat(), { read: false, post: false, member: false }],
    ['a missing chat', undefined, { read: false, post: false, member: false }],
  ])('%s', (_name, channel, expected) => {
    expect(channelAccess(channel, ana)).toEqual(expected);
  });

  it('never matches a chat without an owner to a human by an empty id', () => {
    expect(channelAccess(chat({ ownerHumanId: null }), { id: '', username: 'ana' }).member).toBe(false);
  });
});
