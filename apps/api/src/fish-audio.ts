import type {SpeechSettings} from '@nest/schemas';

export type SpeechProvider = (text:string, settings:SpeechSettings, signal:AbortSignal) => Promise<ReadableStream<Uint8Array>>;
// Keep formatting noise and provider control tags out of the spoken message.
export function spokenText(text:string):string {
  return text.replace(/```[\s\S]*?```/g, ' Code block omitted. ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[\[\]]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+])\s+/gm, '')
    .replace(/[*_`]/g, '').trim();
}
export function createFishAudio(apiKey:string, model='s2.1-pro', transport:typeof fetch=fetch):SpeechProvider {
  return async (text, settings, signal) => {
    const response = await transport('https://api.fish.audio/v1/tts', {
      method:'POST', redirect:'error', signal,
      headers:{Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json', model},
      body:JSON.stringify({text:(settings.style==='neutral'?'':`[${settings.style}] `)+text,
        reference_id:settings.voiceId, format:'mp3', mp3_bitrate:128, latency:'low', chunk_length:100, prosody:{speed:settings.speed}}),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error('Speech provider unavailable');
    }
    return response.body;
  };
}

// Forward chunks with backpressure. Never collect the complete audio in memory.
export function relaySpeech(source:ReadableStream<Uint8Array>, abort:AbortController, signal:AbortSignal, onDone:()=>void) {
  const reader=source.getReader();
  let size=0, finished=false;
  let controller:ReadableStreamDefaultController<Uint8Array>;
  const finish=()=>{if(finished)return;finished=true;signal.removeEventListener('abort',stop);onDone();};
  const stop=()=>{
    if(finished)return;
    finish();void reader.cancel().catch(()=>undefined);
    controller.error(new Error('Speech stream interrupted'));
  };
  return new ReadableStream<Uint8Array>({
    start(c){controller=c;signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();},
    async pull(c){
      try {
        const {done,value}=await reader.read();
        if(finished)return;
        if(done){if(!size)throw Error('Empty audio');finish();c.close();return;}
        size+=value.byteLength;
        if(size>10*1024*1024)throw Error('Audio too large');
        c.enqueue(value);
      } catch {
        if(finished)return;
        finish();abort.abort();void reader.cancel().catch(()=>undefined);
        c.error(new Error('Speech stream interrupted'));
      }
    },
    async cancel(){finish();abort.abort();await reader.cancel().catch(()=>undefined);},
  },{highWaterMark:0});
}
