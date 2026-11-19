import {it,expect,vi} from 'vitest';
import {createFishAudio,spokenText,relaySpeech} from './fish-audio';
import {DEFAULT_SPEECH_SETTINGS} from '@nest/schemas';

it('uses low-latency Fish options and returns before the provider finishes',async()=>{
  const source=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([1,2,3]));}});
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(source));
  const stream=await createFishAudio('test-key','s2.1-pro',fetcher)('Hello',{...DEFAULT_SPEECH_SETTINGS,voiceId:'voice-id',style:'calm',speed:1.25},new AbortController().signal);
  const reader=stream.getReader();expect((await reader.read()).value).toEqual(new Uint8Array([1,2,3]));await reader.cancel();
  const [url,init]=fetcher.mock.calls[0];
  expect(url).toBe('https://api.fish.audio/v1/tts');
  expect(init?.headers).toMatchObject({model:'s2.1-pro',Authorization:'Bearer test-key'});
  expect(JSON.parse(String(init?.body))).toMatchObject({text:'[calm] Hello',reference_id:'voice-id',format:'mp3',latency:'low',chunk_length:100,prosody:{speed:1.25}});
});
it('does not expose provider errors',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive provider error',{status:401}));
  await expect(createFishAudio('test-key',undefined,fetcher)('Hello',DEFAULT_SPEECH_SETTINGS,new AbortController().signal)).rejects.toThrow('Speech provider unavailable');
});
it('bounds streams and releases slots on errors, empty output, abort and completion',async()=>{
  for(const data of [new Uint8Array(),new Uint8Array(10*1024*1024+1)]){
    const abort=new AbortController(),done=vi.fn();
    const stream=relaySpeech(new Response(data).body!,abort,abort.signal,done);
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow('Speech stream interrupted');
    expect(done).toHaveBeenCalledOnce();expect(abort.signal.aborted).toBe(true);
  }
  const abort=new AbortController(),done=vi.fn(),cancel=vi.fn();
  const stream=relaySpeech(new ReadableStream({cancel}),abort,abort.signal,done);
  const reading=stream.getReader().read();abort.abort();
  await expect(reading).rejects.toThrow('Speech stream interrupted');expect(cancel).toHaveBeenCalledOnce();expect(done).toHaveBeenCalledOnce();
  const complete=vi.fn(),controller=new AbortController();
  expect(await new Response(relaySpeech(new Response('audio').body!,controller,controller.signal,complete)).text()).toBe('audio');
  expect(complete).toHaveBeenCalledOnce();
});
it('speaks readable prose without code, links or executable speech tags',()=>{
  expect(spokenText('# Hello **world**\n[Read this](https://example.com) [excited]\n```js\nsecret()\n```')).toBe('Hello world\nRead this excited\n Code block omitted.');
});
