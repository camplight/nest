import {useEffect,useRef,useState} from 'react';
import {apiFetch,apiJson} from '../api';
import {apiUrl} from '../config';

function waitFor(target:EventTarget,event:string,signal:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    const clean=()=>{target.removeEventListener(event,done);target.removeEventListener('error',fail);signal.removeEventListener('abort',fail);};
    const done=()=>{clean();resolve();},fail=()=>{clean();reject(Error('Speech interrupted'));};
    target.addEventListener(event,done,{once:true});target.addEventListener('error',fail,{once:true});signal.addEventListener('abort',fail,{once:true});
    if(signal.aborted)fail();
  });
}
export function MessageSpeech({eventId}:{eventId:string}) {
  const [url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const current=useRef<{abort:AbortController;objectUrl?:string}|null>(null);
  const audio=useRef<HTMLAudioElement>(null);
  function dispose() {
    current.current?.abort.abort();
    if(current.current?.objectUrl)URL.revokeObjectURL(current.current.objectUrl);
    current.current=null;
    const player=audio.current;
    if(player){player.pause();player.removeAttribute('src');player.load();}
  }
  useEffect(()=>()=>dispose(),[eventId]);
  function close(){dispose();setUrl('');setBusy(false);setError('');}
  async function listen() {
    dispose();const request:{abort:AbortController;objectUrl?:string}={abort:new AbortController()};current.current=request;
    const signal=request.abort.signal;
    setBusy(true);setError('');
    try {
      const response=await apiJson<{url:string}>('/api/speech/messages/'+encodeURIComponent(eventId),{method:'POST',signal});
      if(current.current!==request)return;
      if(!/^\/api\/speech\/streams\/[a-f0-9]{48}$/.test(response.url))throw Error('Invalid playback URL');
      if(typeof MediaSource==='undefined'||!MediaSource.isTypeSupported('audio/mpeg')) {
        setUrl(apiUrl(response.url));return;
      }
      const media=new MediaSource();
      const opened=waitFor(media,'sourceopen',signal);
      request.objectUrl=URL.createObjectURL(media);setUrl(request.objectUrl);
      await opened;
      const buffer=media.addSourceBuffer('audio/mpeg');
      const stream=await apiFetch(response.url,{signal});
      if(!stream.body)throw Error('No speech stream');
      const reader=stream.body.getReader();
      try {
        while(!signal.aborted) {
          const {done,value}=await reader.read();if(done)break;
          const updated=waitFor(buffer,'updateend',signal);
          // Keep only one chunk pending in JS while the media decoder consumes it.
          buffer.appendBuffer(new Uint8Array(value).buffer);
          await updated;
        }
        if(!signal.aborted&&media.readyState==='open')media.endOfStream();
      } finally {await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    } catch(reason) {
      if(signal.aborted)return;
      request.abort.abort();
      let message='Speech was interrupted or could not be played. Close audio and choose Listen to retry.';
      if(reason instanceof Error){try {const parsed=JSON.parse(reason.message);if(typeof parsed.error==='string')message=parsed.error;}catch{/* Keep a friendly fallback. */}}
      setError(message);setBusy(false);
    }
  }
  return <div className="message-speech" data-aui-quote-selectable="false">
    {!url&&<button type="button" className="message-speech-button" disabled={busy} onClick={()=>void listen()} aria-label="Listen to message">{busy?'Preparing speech…':'Listen'}</button>}
    {(busy||url)&&<button type="button" className="message-speech-button" onClick={close}>{busy?'Cancel':'Close audio'}</button>}
    {url&&<audio ref={audio} controls autoPlay preload="auto" crossOrigin="use-credentials" src={url} aria-label="Spoken message"
      onCanPlay={()=>setBusy(false)} onError={()=>{current.current?.abort.abort();setBusy(false);setError('Speech was interrupted or could not be played. Close audio and choose Listen to retry.');}}/>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
