import type {SpeechSettings} from '@nest/schemas';

export type SpeechProvider = (text:string, settings:SpeechSettings, signal:AbortSignal) => Promise<Uint8Array>;
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
        reference_id:settings.voiceId, format:'mp3', mp3_bitrate:128, prosody:{speed:settings.speed}}),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error('Speech provider unavailable');
    }
    const reader=response.body.getReader(), chunks:Uint8Array[]=[];
    let size=0;
    try {
      while (true) {
        const {done,value}=await reader.read();
        if (done) break;
        size+=value.byteLength;
        if (size>10*1024*1024) throw Error('Speech response too large');
        chunks.push(value);
      }
    } finally {await reader.cancel().catch(()=>undefined); reader.releaseLock();}
    if (!size) throw Error('Empty speech response');
    const result=new Uint8Array(size);
    let offset=0;
    for (const chunk of chunks) {result.set(chunk,offset); offset+=chunk.byteLength;}
    return result;
  };
}
