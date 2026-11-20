import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {InlineAudio,MessageAttachments,MessageFiles,focusWhenPending} from './attachments-view';
import {vi} from 'vitest';

describe('message attachments',()=>{
  it('give audio a Play button that loads nothing until pressed',()=>{
    let fetched=0;
    const fetchFile=(async()=>{fetched++;throw new Error('not yet');}) as unknown as typeof fetch;
    const html=renderToStaticMarkup(<InlineAudio name="voice.webm" mime="audio/webm" href="/api/files/v" fetchFile={fetchFile}/>);
    expect(html).toContain('>Play voice.webm</button>');
    // Never disabled: a disabled button drops keyboard focus while the file loads.
    expect(html).not.toMatch(/ disabled=""/);
    expect(html).not.toContain('<audio');
    expect(fetched).toBe(0);
  });

  it('show the Play button for audio items only',()=>{
    const html=renderToStaticMarkup(<MessageAttachments attachments={[
      {fileId:'v',name:'voice.webm',mime:'audio/webm',size:2048},
      {fileId:'d',name:'notes.pdf',mime:'application/pdf'},
    ]}/>);
    expect(html).toContain('Play voice.webm');
    expect(html).not.toContain('Play notes.pdf');
  });

  it('show canvas tiles that keep their links, with audio in the classic list',()=>{
    const html=renderToStaticMarkup(<MessageFiles attachments={[
      {fileId:'i',name:'chart.png',mime:'image/png',size:1024},
      {fileId:'v',name:'voice.webm',mime:'audio/webm'},
    ]}/>);
    expect(html).toContain('href="/api/files/i"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('Play voice.webm');
    expect(html).not.toContain('role="dialog"');
  });
});

describe('focus after Play',()=>{
  it('moves to the player once, only when the button had focus',()=>{
    const element={focus:vi.fn()} as unknown as HTMLElement;
    const pending={current:true};
    focusWhenPending(pending)(element);
    focusWhenPending(pending)(element);
    expect(element.focus).toHaveBeenCalledOnce();
    expect(element.focus).toHaveBeenCalledWith({preventScroll:true});
    const idle={current:false},other={focus:vi.fn()} as unknown as HTMLElement;
    focusWhenPending(idle)(other);
    focusWhenPending({current:true})(null);
    expect(other.focus).not.toHaveBeenCalled();
  });
});
