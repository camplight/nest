import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createVoiceNote,pickMime,voiceFileName,MAX_VOICE_SECONDS,VOICE_BLOCKED,VOICE_TRANSCRIPTION_OFF,VOICE_TRANSCRIBE_FAILED,type VoiceDeps,type VoiceSnapshot} from './voice-note';

// Fakes stand in for the browser's MediaRecorder and microphone only.
class FakeRecorder {
  static supported=['audio/webm','audio/mp4'];
  static last:FakeRecorder|null=null;
  static isTypeSupported=(type:string)=>FakeRecorder.supported.includes(type);
  mimeType:string;state='inactive';
  ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;onerror:(()=>void)|null=null;
  stops=0;
  constructor(readonly stream:unknown,options?:{mimeType?:string}){this.mimeType=options?.mimeType??'';FakeRecorder.last=this;}
  start(){this.state='recording';}
  stop(){
    if(this.state==='inactive')throw new Error('InvalidStateError');
    this.state='inactive';this.stops++;
    // Like a browser: the data and the stop event arrive after stop() returns.
    setTimeout(()=>{this.ondataavailable?.({data:new Blob(['audio-bytes'],{type:this.mimeType})});this.onstop?.();},0);
  }
}
const track=()=>({stop:vi.fn()});
function setup(overrides:Partial<VoiceDeps>={}){
  const tracks=[track(),track()];
  const log:string[]=[];
  const states:string[]=[];
  const deps={
    getUserMedia:vi.fn(async()=>({getTracks:()=>tracks})),
    Recorder:FakeRecorder as unknown as VoiceDeps['Recorder'],
    upload:vi.fn(async(file:File)=>{log.push(`upload ${file.name} ${file.type}`);return 'file-1';}),
    transcriptionEnabled:vi.fn(async()=>true),
    transcribe:vi.fn(async()=>'Plan the spring launch'),
    attachRoom:vi.fn((): {ok:true}|{ok:false;error:string}=>({ok:true})),onAudio:vi.fn(),onDiscard:vi.fn(),onTranscript:vi.fn(),
    ...overrides,
  } satisfies VoiceDeps;
  const note=createVoiceNote(deps);
  note.subscribe(()=>{const s=note.snapshot().state;if(states.at(-1)!==s)states.push(s);});
  return {deps,note,tracks,log,states};
}
const flush=async()=>{for(let i=0;i<10;i++)await vi.advanceTimersByTimeAsync(0);};
const snap=(note:{snapshot():VoiceSnapshot})=>note.snapshot();

describe('createVoiceNote',()=>{
  beforeEach(()=>{vi.useFakeTimers();FakeRecorder.supported=['audio/webm','audio/mp4'];FakeRecorder.last=null;});
  afterEach(()=>vi.useRealTimers());

  it('goes idle, recording, uploading, transcribing, idle and delivers the audio and the transcript',async()=>{
    const {deps,note,states,tracks}=setup();
    await note.start();
    expect(snap(note).state).toBe('recording');
    await vi.advanceTimersByTimeAsync(2000);
    expect(snap(note).seconds).toBe(2);
    note.stop();
    await flush();
    expect(states).toEqual(['idle','recording','uploading','transcribing','idle']);
    expect(deps.onAudio).toHaveBeenCalledWith({fileId:'file-1',name:'Voice note.webm',mime:'audio/webm',size:11});
    expect(deps.transcribe).toHaveBeenCalledWith('file-1');
    expect(deps.onTranscript).toHaveBeenCalledWith('Plan the spring launch');
    expect(tracks.every(t=>t.stop.mock.calls.length>=1)).toBe(true);
  });

  it('records audio/mp4 as a .m4a file when webm is not supported',async()=>{
    FakeRecorder.supported=['audio/mp4'];
    const {deps,note,log}=setup();
    await note.start();note.stop();await flush();
    expect(log).toEqual(['upload Voice note.m4a audio/mp4']);
    expect(deps.onAudio).toHaveBeenCalledWith(expect.objectContaining({name:'Voice note.m4a',mime:'audio/mp4'}));
    expect(pickMime(FakeRecorder)).toBe('audio/mp4');
    expect(voiceFileName('audio/webm;codecs=opus')).toBe('Voice note.webm');
  });

  it('stops by itself at 300 seconds',async()=>{
    const {deps,note}=setup();
    await note.start();
    await vi.advanceTimersByTimeAsync((MAX_VOICE_SECONDS-1)*1000);
    expect(snap(note).state).toBe('recording');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1);await flush();
    expect(FakeRecorder.last?.stops).toBe(1);
    expect(deps.upload).toHaveBeenCalledTimes(1);
    expect(deps.onTranscript).toHaveBeenCalled();
  });

  it('with transcription off attaches the audio, shows the notice and inserts no transcript',async()=>{
    const {deps,note}=setup({transcriptionEnabled:vi.fn(async()=>false)});
    await note.start();note.stop();await flush();
    expect(deps.onAudio).toHaveBeenCalledTimes(1);
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(snap(note)).toMatchObject({state:'error',error:VOICE_TRANSCRIPTION_OFF});
  });

  it('keeps the audio attached and shows an error when transcription fails',async()=>{
    const {deps,note}=setup({transcribe:vi.fn(async()=>{throw new Error('boom');})});
    await note.start();note.stop();await flush();
    expect(deps.onAudio).toHaveBeenCalledTimes(1);
    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(snap(note)).toMatchObject({state:'error',error:VOICE_TRANSCRIBE_FAILED});
  });

  it('shows a blocked-microphone message when permission is denied',async()=>{
    const {deps,note}=setup({getUserMedia:vi.fn(async()=>{throw new DOMException('no','NotAllowedError');})});
    await note.start();
    expect(snap(note)).toMatchObject({state:'error',error:VOICE_BLOCKED});
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('cancel throws the recording away and releases the microphone',async()=>{
    const {deps,note,tracks}=setup();
    await note.start();
    await vi.advanceTimersByTimeAsync(3000);
    note.cancel();
    await flush();
    expect(snap(note)).toEqual({state:'idle',seconds:0,error:null});
    for(const t of tracks)expect(t.stop).toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.onAudio).not.toHaveBeenCalled();
    expect(deps.onTranscript).not.toHaveBeenCalled();
    // The timers are gone too: nothing stops a recording that no longer exists.
    await vi.advanceTimersByTimeAsync(MAX_VOICE_SECONDS*1000);
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('cancel during the upload drops the result',async()=>{
    let release:(id:string)=>void=()=>undefined;
    const {deps,note}=setup({upload:vi.fn(()=>new Promise<string>(resolve=>{release=resolve;}))});
    await note.start();note.stop();await flush();
    expect(snap(note).state).toBe('uploading');
    note.cancel();
    release('late');await flush();
    expect(deps.onAudio).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(snap(note).state).toBe('idle');
  });

  it('destroy mid-recording releases the microphone and delivers nothing',async()=>{
    const {deps,note,tracks}=setup();
    await note.start();
    note.destroy();
    await vi.advanceTimersByTimeAsync(MAX_VOICE_SECONDS*1000);await flush();
    for(const t of tracks)expect(t.stop).toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('releases a microphone granted after cancel',async()=>{
    let grant:(stream:{getTracks():{stop():void}[]})=>void=()=>undefined;
    const late=track();
    const {note,deps}=setup({getUserMedia:vi.fn(()=>new Promise<{getTracks():{stop():void}[]}>(resolve=>{grant=resolve;}))});
    const starting=note.start();
    note.cancel();
    grant({getTracks:()=>[late]});
    await starting;
    expect(late.stop).toHaveBeenCalled();
    expect(snap(note).state).toBe('idle');
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('a second Stop while stopping is a no-op and the recording is kept',async()=>{
    const {deps,note}=setup();
    await note.start();
    note.stop();note.stop();
    await flush();
    expect(FakeRecorder.last?.stops).toBe(1);
    expect(deps.onAudio).toHaveBeenCalledTimes(1);
    expect(deps.onTranscript).toHaveBeenCalledWith('Plan the spring launch');
    expect(snap(note).state).toBe('idle');
  });

  it('the 300 s auto-stop racing a manual Stop stops once',async()=>{
    const {deps,note}=setup();
    await note.start();
    await vi.advanceTimersByTimeAsync((MAX_VOICE_SECONDS-1)*1000+999);
    note.stop();
    await vi.advanceTimersByTimeAsync(5000);await flush();
    expect(FakeRecorder.last?.stops).toBe(1);
    expect(deps.upload).toHaveBeenCalledTimes(1);
    expect(snap(note).error).toBeNull();
  });

  it('cancel during transcription takes the audio back off and inserts no transcript',async()=>{
    let release:(text:string)=>void=()=>undefined;
    const {deps,note}=setup({transcribe:vi.fn(()=>new Promise<string>(resolve=>{release=resolve;}))});
    await note.start();note.stop();await flush();
    expect(snap(note).state).toBe('transcribing');
    expect(deps.onAudio).toHaveBeenCalledTimes(1);
    note.cancel();
    release('late words');await flush();
    expect(deps.onDiscard).toHaveBeenCalledWith('file-1');
    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(snap(note).state).toBe('idle');
  });

  it('unmounting during transcription takes the audio back off and inserts no transcript',async()=>{
    let release:(text:string)=>void=()=>undefined;
    const {deps,note}=setup({transcribe:vi.fn(()=>new Promise<string>(resolve=>{release=resolve;}))});
    await note.start();note.stop();await flush();
    note.destroy();
    release('late words');await flush();
    expect(deps.onDiscard).toHaveBeenCalledWith('file-1');
    expect(deps.onTranscript).not.toHaveBeenCalled();
  });

  it('a finished note, or one whose transcription failed or is off, keeps its audio when later cancelled',async()=>{
    const done=setup();
    await done.note.start();done.note.stop();await flush();done.note.cancel();
    expect(done.deps.onDiscard).not.toHaveBeenCalled();
    const failed=setup({transcribe:vi.fn(async()=>{throw new Error('x');})});
    await failed.note.start();failed.note.stop();await flush();failed.note.cancel();
    expect(failed.deps.onDiscard).not.toHaveBeenCalled();
  });

  it('shows the cap error instead of dropping the audio when the attachment list is full',async()=>{
    const {deps,note}=setup({attachRoom:vi.fn(()=>({ok:false as const,error:'You can attach up to 20 files. 1 file was not added.'}))});
    await note.start();note.stop();await flush();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.onAudio).not.toHaveBeenCalled();
    expect(snap(note)).toMatchObject({state:'error',error:'You can attach up to 20 files. 1 file was not added.'});
  });
});
