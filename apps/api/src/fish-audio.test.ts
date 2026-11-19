import {it,expect,vi} from 'vitest';
import {createFishAudio,spokenText} from './fish-audio';
import {DEFAULT_SPEECH_SETTINGS} from '@nest/schemas';

it('uses the documented Fish contract and caps returned audio',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1,2,3])));
  const provider=createFishAudio('test-key','s2.1-pro',fetcher);
  expect(await provider('Hello',{...DEFAULT_SPEECH_SETTINGS,voiceId:'voice-id',style:'calm',speed:1.25},new AbortController().signal)).toEqual(new Uint8Array([1,2,3]));
  const [url,init]=fetcher.mock.calls[0];
  expect(url).toBe('https://api.fish.audio/v1/tts');
  expect(init?.headers).toMatchObject({model:'s2.1-pro',Authorization:'Bearer test-key'});
  expect(JSON.parse(String(init?.body))).toMatchObject({text:'[calm] Hello',reference_id:'voice-id',format:'mp3',prosody:{speed:1.25}});
  fetcher.mockResolvedValue(new Response(new Uint8Array(10*1024*1024+1)));
  await expect(provider('Hello',DEFAULT_SPEECH_SETTINGS,new AbortController().signal)).rejects.toThrow('too large');
});
it('does not expose provider errors and rejects empty output',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive provider error',{status:401}));
  const provider=createFishAudio('test-key',undefined,fetcher);
  await expect(provider('Hello',DEFAULT_SPEECH_SETTINGS,new AbortController().signal)).rejects.toThrow('Speech provider unavailable');
  fetcher.mockResolvedValue(new Response(''));
  await expect(provider('Hello',DEFAULT_SPEECH_SETTINGS,new AbortController().signal)).rejects.toThrow('Empty speech response');
});
it('speaks readable prose without code, links or executable speech tags',()=>{
  expect(spokenText('# Hello **world**\n[Read this](https://example.com) [excited]\n```js\nsecret()\n```')).toBe('Hello world\nRead this excited\n Code block omitted.');
});
