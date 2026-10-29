// Two ephemeral clients, synthetic audio, no product messages or model calls.
import assert from 'node:assert/strict';
import {createHmac, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';

const require = createRequire(new URL('../../vendor/orgops/apps/agent-runner/package.json', import.meta.url));
const rtc = require('@livekit/rtc-node');
const {LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret} = process.env;
assert(url && key && secret, 'Managed LiveKit credentials are required');
const roomName = `nest-smoke-${randomUUID()}`;
function token(identity, admin = false) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({alg: 'HS256', typ: 'JWT'})}.${encode({
    iss: key, sub: identity, nbf: now - 5, exp: now + 60,
    video: {room: roomName, ...(admin ? {roomAdmin: true} : {roomJoin: true, canPublish: true, canSubscribe: true})},
  })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}
const watchdog = setTimeout(() => {
  console.error('FAIL: LiveKit media smoke exceeded 30 seconds');
  process.exit(1);
}, 30_000);
const listener = new rtc.Room(), speaker = new rtc.Room();
let source, track, reader;
try {
  const subscribed = new Promise(resolve => {
    listener.on(rtc.RoomEvent.TrackSubscribed, (remote, _publication, participant) => {
      if (remote.kind !== rtc.TrackKind.KIND_AUDIO || participant.identity !== 'synthetic-speaker') return;
      reader = new rtc.AudioStream(remote, {sampleRate: 48_000, numChannels: 1}).getReader();
      resolve(reader);
    });
  });
  await listener.connect(url, token('synthetic-listener'), {autoSubscribe: true});
  await speaker.connect(url, token('synthetic-speaker'), {autoSubscribe: true});
  source = new rtc.AudioSource(48_000, 1);
  track = rtc.LocalAudioTrack.createAudioTrack('synthetic-tone', source);
  const options = new rtc.TrackPublishOptions();
  options.source = rtc.TrackSource.SOURCE_MICROPHONE;
  await speaker.localParticipant.publishTrack(track, options);
  await subscribed;
  const received = reader.read();
  for (let frame = 0; frame < 50; frame++) {
    const samples = Int16Array.from({length: 960}, (_, i) => Math.round(2000 * Math.sin(2 * Math.PI * 440 * (frame * 960 + i) / 48_000)));
    await source.captureFrame(new rtc.AudioFrame(samples, 48_000, 1, samples.length));
  }
  const audio = await received;
  assert(!audio.done && audio.value.samplesPerChannel > 0, 'No audio received');
  console.log('PASS: two authenticated LiveKit clients joined and received synthetic audio');
} finally {
  await reader?.cancel();
  await Promise.allSettled([listener.disconnect(), speaker.disconnect()]);
  await track?.close();
  await source?.close();
  await rtc.dispose();
  const endpoint = new URL('/twirp/livekit.RoomService/DeleteRoom', url.replace(/^ws/, 'http'));
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(3000),
    headers: {'content-type': 'application/json', authorization: `Bearer ${token('synthetic-cleanup', true)}`},
    body: JSON.stringify({room: roomName}),
  });
  assert(response.ok || response.status === 404, 'Temporary LiveKit room cleanup failed');
  clearTimeout(watchdog);
}
