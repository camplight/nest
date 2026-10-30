import {Room, RoomEvent, Track, createLocalAudioTrack, type LocalAudioTrack, type Participant} from 'livekit-client';
import {apiJson, getApiHeaders} from '../api';
import type {Agent, ChannelParticipant} from '../types';

export type VoiceConfig = {
  transcription: {enabled: boolean; modelId: string | null};
  realtime?: {enabled: boolean; rooms?: {enabled: boolean; broker: string}};
};
export type HuddleParticipant = {identity: string; name: string; agent: boolean; muted: boolean; speaking: boolean};
export type HuddleState = {
  phase: 'idle' | 'joining' | 'joined' | 'reconnecting';
  participants: HuddleParticipant[]; muted: boolean; audioBlocked: boolean;
  startedAt: number | null; error: string | null;
};
export const emptyHuddle = (): HuddleState => ({phase: 'idle', participants: [], muted: false, audioBlocked: false, startedAt: null, error: null});

export function voiceAgents(agents: Agent[], participants: ChannelParticipant[]) {
  const names = new Set(participants.filter(p => p.subscriberType.toUpperCase() === 'AGENT').map(p => p.subscriberId));
  return agents.filter(a => names.has(a.name) && a.mode !== 'WRAPPED' && a.desiredState === 'RUNNING' && a.modelCapabilities?.realtimeAudioInput);
}

export function voiceError(error: unknown): string {
  if (error instanceof Error && error.name === 'NotAllowedError') return 'Microphone access was denied. Allow the microphone in your browser settings, then try again.';
  if (error instanceof Error && error.name === 'NotFoundError') return 'No microphone was found. Connect one, then try again.';
  if (error instanceof Error && error.name === 'NotReadableError') return 'Your microphone is busy. Close the other app using it, then try again.';
  if (error instanceof Error) {
    try {const value = JSON.parse(error.message); if (typeof value.error === 'string') return value.error;} catch { /* Plain SDK error. */ }
    return error.message || 'We couldn’t connect. Please try again.';
  }
  return 'We couldn’t connect. Please try again.';
}

type Join = {broker: string; url: string; token: string; roomName: string; sessionId: string};
type Attempt = {sessionId: string; room?: Room; microphone?: LocalAudioTrack; abort: AbortController; closed: boolean; announced: boolean; ended: boolean; audio: Set<HTMLMediaElement>; timer?: ReturnType<typeof setInterval>};
type Dependencies = {json: typeof apiJson; room: () => Room; microphone: () => Promise<LocalAudioTrack>};

// Nest owns presentation and media lifetime. OrgOps authenticates the human,
// authorizes channel access and starts the agents through its existing events.
export function createHuddleSession(input: {
  channelId: string; username: string; onChange(state: HuddleState): void; onLevel?(level: number): void;
}, overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {json: apiJson, room: () => new Room(), microphone: () => createLocalAudioTrack({echoCancellation: true, noiseSuppression: true, autoGainControl: true}), ...overrides};
  let active: Attempt | undefined, state = emptyHuddle();
  const update = (patch: Partial<HuddleState>) => {state = {...state, ...patch}; input.onChange(state);};
  const emit = (attempt: Attempt, type: string, payload: Record<string, unknown>) => deps.json('/api/events', {
    method: 'POST', headers: getApiHeaders(), body: JSON.stringify({type, channelId: input.channelId, source: `human:${input.username}`, payload: {sessionId: attempt.sessionId, ...payload}}),
    keepalive: type === 'voice.session.ended',
    // Ending a session must still work after its media request is cancelled.
    signal: AbortSignal.timeout(10_000),
  });
  const current = (attempt: Attempt) => active === attempt && !attempt.closed;
  const detach = (attempt: Attempt) => {
    for (const element of attempt.audio) {element.pause(); element.srcObject = null; element.remove();}
    attempt.audio.clear();
  };
  async function dispose(attempt: Attempt, reason: string) {
    attempt.closed = true; attempt.abort.abort(); clearInterval(attempt.timer);
    attempt.microphone?.stop(); detach(attempt);
    attempt.room?.removeAllListeners();
    await attempt.room?.disconnect().catch(() => undefined);
    if (attempt.announced && !attempt.ended) {attempt.ended = true; await emit(attempt, 'voice.session.ended', {endedAt: Date.now(), reason}).catch(() => undefined);}
    // Do not end the whole room when one human leaves. Upstream's runner hangs
    // up its media legs when the last human disconnects, including tab crashes.
  }
  function participants(attempt: Attempt) {
    const room = attempt.room!;
    const list: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    return list.filter(p => p.identity).map(p => ({identity: p.identity, name: p.name || p.identity,
      agent: p.identity.startsWith('agent:'), muted: !p.isMicrophoneEnabled, speaking: p.isSpeaking}));
  }
  function observe(attempt: Attempt) {
    if (current(attempt)) update({participants: participants(attempt), audioBlocked: !attempt.room!.canPlaybackAudio});
  }
  async function leave(reason = 'left') {
    const attempt = active; active = undefined;
    state = emptyHuddle(); input.onChange(state); input.onLevel?.(0);
    if (attempt) await dispose(attempt, reason);
  }
  async function join(agentNames: string[]) {
    if (active) return;
    const attempt: Attempt = {sessionId: crypto.randomUUID(), abort: new AbortController(), closed: false, announced: false, ended: false, audio: new Set()};
    active = attempt; update({...emptyHuddle(), phase: 'joining'});
    const assertCurrent = () => {if (!current(attempt)) throw new DOMException('Cancelled', 'AbortError');};
    try {
      const response = await deps.json<Join>('/api/voice/rooms/join', {method: 'POST', headers: getApiHeaders(), body: JSON.stringify({channelId: input.channelId, sessionId: attempt.sessionId}), signal: AbortSignal.any([attempt.abort.signal, AbortSignal.timeout(20_000)])});
      assertCurrent();
      if (response.broker !== 'livekit') throw Error('Huddles need the LiveKit room service. Ask your administrator to enable it.');
      const room = deps.room(); attempt.room = room;
      const changed = () => observe(attempt);
      for (const event of [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.ActiveSpeakersChanged, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.AudioPlaybackStatusChanged]) room.on(event, changed);
      room.on(RoomEvent.TrackSubscribed, track => {
        if (!current(attempt) || track.kind !== Track.Kind.Audio) return;
        const element = track.attach(); element.autoplay = true; element.hidden = true;
        document.body.appendChild(element); attempt.audio.add(element);
        void element.play().catch(() => {if (current(attempt)) update({audioBlocked: true});});
      });
      room.on(RoomEvent.TrackUnsubscribed, track => {
        for (const element of track.detach()) {element.pause(); element.srcObject = null; element.remove(); attempt.audio.delete(element);}
      });
      room.on(RoomEvent.Reconnecting, () => {if (current(attempt)) update({phase: 'reconnecting'});});
      room.on(RoomEvent.Reconnected, () => {if (current(attempt)) {update({phase: 'joined'}); observe(attempt);}});
      room.on(RoomEvent.Disconnected, () => {
        if (!current(attempt)) return;
        void leave('disconnected'); update({error: 'You were disconnected from the huddle. Join again to reconnect.'});
      });
      // Capture only after channel permission is checked. Own the track so a
      // late permission response can be stopped even if the dialog has closed.
      attempt.microphone = await deps.microphone(); assertCurrent();
      await room.connect(response.url, response.token); assertCurrent();
      await room.localParticipant.publishTrack(attempt.microphone, {source: Track.Source.Microphone}); assertCurrent();
      await room.startAudio().catch(() => undefined); assertCurrent();
      attempt.announced = true;
      await emit(attempt, 'voice.session.started', {startedAt: Date.now()}); assertCurrent();
      if (agentNames.length) {
        // LiveKit already has one stable room per channel. A stable roomId makes
        // repeated human joins idempotent in OrgOps's active-call registry.
        await emit(attempt, 'voice.room.started', {roomId: response.roomName, broker: 'livekit', brokerRoomName: response.roomName, agentNames, startedAt: Date.now()}); assertCurrent();
      }
      update({phase: 'joined', startedAt: Date.now()}); observe(attempt);
      attempt.timer = setInterval(() => {if (current(attempt)) input.onLevel?.(state.muted ? 0 : room.localParticipant.audioLevel);}, 100);
    } catch (error) {
      const wasCurrent = current(attempt);
      if (wasCurrent) active = undefined;
      await dispose(attempt, 'join_failed');
      if (wasCurrent) update({...emptyHuddle(), error: voiceError(error)});
    }
  }
  async function mute(muted: boolean) {
    const attempt = active;
    if (!attempt?.microphone || state.phase !== 'joined') return;
    try {
      await (muted ? attempt.microphone.mute() : attempt.microphone.unmute());
      if (!current(attempt)) return;
      update({muted, error: null}); observe(attempt);
      await emit(attempt, 'voice.participant.muted', {participantId: input.username, participantKind: 'HUMAN', muted});
    } catch (error) {if (current(attempt)) update({error: voiceError(error)});}
  }
  async function enableAudio() {
    const attempt = active;
    try {await attempt?.room?.startAudio(); if (attempt && current(attempt)) observe(attempt);}
    catch {update({error: 'Tap Enable sound again, or check your browser’s audio settings.'});}
  }
  return {join, leave, mute, enableAudio};
}
