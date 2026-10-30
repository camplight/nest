import {expect, it} from 'vitest';
import {voiceJoinBody} from './voice-request';

it('retains the source of a streamed voice join for an HTTP auth challenge', async () => {
  const body = JSON.stringify({channelId: 'fixture-room', sessionId: 'fixture-session'});
  const source = new Response(body).body!;
  const bytes = await voiceJoinBody(source);
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(body);
});
it('rejects and cancels an oversized join before buffering an unbounded request', async () => {
  let cancelled = false;
  const source = new ReadableStream({pull(controller) {controller.enqueue(new Uint8Array(8193));}, cancel() {cancelled = true;}});
  const response = await voiceJoinBody(source);
  expect(response).toBeInstanceOf(Response); expect((response as Response).status).toBe(413); expect(cancelled).toBe(true);
});
it('preserves ordinary body sources without touching file upload handling', async () => {
  const json = '{"channelId":"fixture"}'; expect(await voiceJoinBody(json)).toBe(json);
});
