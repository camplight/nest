import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {VoiceButton,VoiceStatus} from './VoiceButton';
import type {VoiceNoteHook} from './useVoiceNote';

const voice=(state:VoiceNoteHook['state'],seconds=0)=>({state,seconds,error:null,start:async()=>{},stop:()=>{},cancel:()=>{}}) as unknown as VoiceNoteHook;
const visibleText=(html:string)=>html.replace(/<[^>]+>/g,'').trim();

describe('VoiceButton in the reply box',()=>{
  beforeAll(()=>{
    vi.stubGlobal('MediaRecorder',class{});
    vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:async()=>({})}});
  });
  afterAll(()=>vi.unstubAllGlobals());

  it('is an icon-only mic with an accessible name',()=>{
    const html=renderToStaticMarkup(<VoiceButton voice={voice('idle')} variant="composer"/>);
    expect(html).toContain('aria-label="Record a voice note"');
    expect(html).toContain('title="Speak instead of typing"');
    expect(html).toContain('voice-note-mic');
    expect(visibleText(html)).toBe('');
  });

  it('turns the same mic into a coral stop while recording, with an icon-only Cancel',()=>{
    const html=renderToStaticMarkup(<VoiceButton voice={voice('recording',65)} variant="composer"/>);
    expect(html).toMatch(/<button[^>]*class="[^"]*voice-note-mic[^"]*is-recording[^"]*"[^>]*aria-label="Stop recording \(1:05\)"[^>]*title="Stop and transcribe"/);
    expect(html).toContain('aria-label="Cancel recording"');
    expect(visibleText(html)).toBe('');
  });

  it('keeps text on the Projects page footer',()=>{
    expect(visibleText(renderToStaticMarkup(<VoiceButton voice={voice('idle')} variant="page"/>))).toBe('Voice note');
  });

  it('shows a Listening… chip with bars and the time while recording',()=>{
    const html=renderToStaticMarkup(<VoiceStatus voice={voice('recording',7)}/>);
    expect(html).toContain('Listening…');
    expect(html.match(/class="voice-note-bar"/g)).toHaveLength(9);
    expect(html).toMatch(/class="voice-note-time"[^>]*>0:07</);
  });
});
