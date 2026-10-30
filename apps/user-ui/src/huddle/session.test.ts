import {EventEmitter} from 'node:events';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {RoomEvent, type Room, type LocalAudioTrack} from 'livekit-client';
import type {apiJson} from '../api';
import {createHuddleSession, emptyHuddle, voiceAgents, type HuddleState} from './session';

const deferred = <T>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {promise, resolve};};
function fixture(options: {microphone?: Promise<LocalAudioTrack>; failEvent?: string} = {}) {
  const track = {stop: vi.fn(), mute: vi.fn(), unmute: vi.fn()};
  const room = Object.assign(new EventEmitter(), {
    canPlaybackAudio: true,
    localParticipant: {identity: 'human:demo:session', name: 'demo', isMicrophoneEnabled: true, isSpeaking: false, audioLevel: .2, publishTrack: vi.fn()},
    remoteParticipants: new Map([['human:teammate:session', {identity: 'human:teammate:session', name: 'teammate', isMicrophoneEnabled: true, isSpeaking: false}]]),
    connect: vi.fn(), disconnect: vi.fn(async () => {}), startAudio: vi.fn(async () => {}),
  });
  const events: {type: string; payload: Record<string, unknown>}[] = [];
  const json = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes('/join')) return {broker: 'livekit', roomName: 'orgops-channel-room', sessionId: 'session', url: 'ws://fixture', token: 'fixture-token'};
    const body = JSON.parse(String(init?.body)); events.push(body);
    if (body.type === options.failEvent) throw Error('Event request failed');
    return {id: 'fixture-event'};
  });
  let state = emptyHuddle(); const changes: HuddleState[] = [];
  const session = createHuddleSession({channelId: 'room', username: 'demo', onChange: next => {state = next; changes.push(next);}},
    {json: json as typeof apiJson, room: () => room as unknown as Room, microphone: async () => options.microphone ?? track as unknown as LocalAudioTrack});
  return {session, room, track, json, events, changes, get state() {return state;}};
}
afterEach(() => vi.restoreAllMocks());

describe('Huddle media lifetime', () => {
  it('joins the authorized channel, starts only selected agents and uses actual room presence', async () => {
    const f = fixture(); await f.session.join(['Puff']);
    expect(f.state.phase).toBe('joined');
    expect(f.state.participants.map(p => p.name)).toEqual(['demo', 'teammate']);
    expect(f.state.participants.some(p => p.name === 'Puff')).toBe(false);
    expect(f.events.map(e => e.type)).toEqual(['voice.session.started', 'voice.room.started']);
    expect(f.events[1].payload).toMatchObject({roomId: 'orgops-channel-room', agentNames: ['Puff']});
    expect(f.json.mock.calls[0][1]?.headers).not.toHaveProperty('x-nest-runner-token');
    await f.session.leave(); expect(f.track.stop).toHaveBeenCalled(); expect(f.room.disconnect).toHaveBeenCalled();
    expect(f.events.map(e => e.type)).not.toContain('voice.room.ended');
  });
  it('allows a human-only huddle without accidentally inviting every agent', async () => {
    const f = fixture(); await f.session.join([]); await f.session.leave();
    expect(f.events.map(e => e.type)).toEqual(['voice.session.started', 'voice.session.ended']);
  });
  it('stops a microphone granted after cancellation and never connects it', async () => {
    const pending = deferred<LocalAudioTrack>(), f = fixture({microphone: pending.promise});
    const join = f.session.join(['Puff']); await vi.waitFor(() => expect(f.json).toHaveBeenCalled());
    await f.session.leave(); pending.resolve(f.track as unknown as LocalAudioTrack); await join;
    expect(f.track.stop).toHaveBeenCalled(); expect(f.room.connect).not.toHaveBeenCalled();
    expect(f.state.phase).toBe('idle'); expect(f.state.error).toBeNull(); expect(f.events).toHaveLength(0);
  });
  it('blocks duplicate joins while a permission prompt is pending', async () => {
    const pending = deferred<LocalAudioTrack>(), f = fixture({microphone: pending.promise});
    const join = f.session.join([]); await f.session.join([]);
    pending.resolve(f.track as unknown as LocalAudioTrack); await join;
    expect(f.room.connect).toHaveBeenCalledTimes(1); await f.session.leave();
  });
  it('does not acquire media if channel authorization fails', async () => {
    const microphone = vi.fn(); let state = emptyHuddle();
    const session = createHuddleSession({channelId: 'private-room', username: 'outsider', onChange: next => {state = next;}}, {
      json: vi.fn(async () => {throw Error('{"error":"Channel not found"}');}) as typeof apiJson, microphone,
    });
    await session.join([]); expect(microphone).not.toHaveBeenCalled(); expect(state.error).toBe('Channel not found');
  });
  it('releases tracks after a failed connection or failed signaling', async () => {
    for (const failure of ['connect', 'voice.room.started']) {
      const f = fixture({failEvent: failure});
      if (failure === 'connect') f.room.connect.mockRejectedValueOnce(Error('Connection failed') as never);
      await f.session.join(['Puff']);
      expect(f.state.phase).toBe('idle'); expect(f.state.error).toBeTruthy();
      expect(f.track.stop).toHaveBeenCalled(); expect(f.room.disconnect).toHaveBeenCalled();
    }
  });
  it('mutes the actual published track and emits the owner’s presence event', async () => {
    const f = fixture(); await f.session.join([]); await f.session.mute(true);
    expect(f.track.mute).toHaveBeenCalled(); expect(f.state.muted).toBe(true);
    expect(f.events.at(-1)).toMatchObject({type: 'voice.participant.muted', payload: {participantId: 'demo', muted: true}});
    await f.session.mute(false); expect(f.track.unmute).toHaveBeenCalled(); await f.session.leave();
  });
  it('keeps reconnecting distinct from connected, and releases media on terminal disconnect', async () => {
    const f = fixture(); await f.session.join([]);
    f.room.emit(RoomEvent.Reconnecting); expect(f.state.phase).toBe('reconnecting');
    f.room.emit(RoomEvent.Reconnected); expect(f.state.phase).toBe('joined');
    f.room.emit(RoomEvent.Disconnected); expect(f.state.phase).toBe('idle');
    expect(f.state.error).toContain('disconnected'); await vi.waitFor(() => expect(f.track.stop).toHaveBeenCalled());
  });
  it('reports denied microphone access without leaving an active call', async () => {
    const pending = deferred<LocalAudioTrack>(), f = fixture({microphone: pending.promise});
    // Reject only after join has installed its handler, avoiding a spurious unhandled rejection.
    const join = f.session.join([]); pending.resolve(Promise.reject(new DOMException('denied', 'NotAllowedError')) as unknown as LocalAudioTrack);
    await join; expect(f.state.error).toContain('Microphone access was denied'); expect(f.state.phase).toBe('idle');
  });
});

it('offers only subscribed, running native realtime agents', () => {
  const names = ['voice', 'text', 'wrapped', 'stopped', 'outsider'];
  const agents = names.map(name => ({name, mode: name === 'wrapped' ? 'WRAPPED' as const : 'CLASSIC' as const, desiredState: name === 'stopped' ? 'STOPPED' : 'RUNNING', modelCapabilities: {realtimeAudioInput: name !== 'text'}}));
  expect(voiceAgents(agents, names.filter(n => n !== 'outsider').map(subscriberId => ({subscriberId, subscriberType: 'AGENT'}))).map(a => a.name)).toEqual(['voice']);
});
