import {describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {MouseEvent,ReactElement} from 'react';
import {Dialog} from 'radix-ui';
import {FileTile,type FileTileProps} from './FileTile';
import {FileViewer,FileViewerBody,FileViewerContext,FileViewerContent,FileViewerProvider,ViewableFileTile,useFileViewer} from './FileViewer';
import {VIEWER_MAX_BYTES,returnFocus,startViewerLoad,type ViewerResult} from './file-viewer';

const noFetch=(async()=>{throw new Error('no fetch during render');}) as unknown as typeof fetch;
const opened=(file:Parameters<typeof FileViewerContent>[0]['file'])=>
  renderToStaticMarkup(<Dialog.Root open><FileViewerContent file={file} fetchFile={noFetch}/></Dialog.Root>);

describe('FileViewer',()=>{
  it('renders nothing while closed',()=>{
    expect(renderToStaticMarkup(<FileViewer file={{name:'a.pdf',href:'/api/files/f1'}} open={false} onOpenChange={()=>{}} fetchFile={noFetch}/>)).toBe('');
  });

  it('opens with the file name as title, its type and size, and a Download link',()=>{
    const html=opened({name:'Q3 report.pdf',mime:'application/octet-stream',size:5*1024,href:'/api/files/f1'});
    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-file-viewer=""');
    expect(html).toMatch(/<h2[^>]*>Q3 report.pdf<\/h2>/);
    expect(html).toContain('>PDF · 5.0 KB<');
    expect(html).toMatch(/<a[^>]*href="\/api\/files\/f1"[^>]*download="Q3 report.pdf"[^>]*>Download<\/a>/);
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('Loading');
  });

  it('never loads HTML or SVG and refuses a file known to pass the cap',()=>{
    expect(opened({name:'page.html',mime:'text/html',href:'/f'})).toContain('No preview for this file type.');
    expect(opened({name:'logo.svg',href:'/f'})).toContain('No preview for this file type.');
    expect(opened({name:'film.mp4',size:VIEWER_MAX_BYTES+1,href:'/f'})).toContain('Too large to preview here.');
  });
});

describe('FileViewerBody',()=>{
  const body=(kind:Parameters<typeof FileViewerBody>[0]['kind'],state:Parameters<typeof FileViewerBody>[0]['state'])=>
    renderToStaticMarkup(<FileViewerBody name="file" kind={kind} state={state}/>);

  it('shows text as text, never as markup',()=>{
    const html=body('text',{status:'text',text:'<script>alert(1)</script>',cut:false});
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('says when text was cut to its first 1 MB',()=>{
    expect(body('text',{status:'text',text:'abc',cut:true})).toContain('Showing the first 1 MB. Download for the rest.');
    expect(body('text',{status:'text',text:'abc',cut:false})).not.toContain('Showing the first');
  });

  it('names the table\'s scroll region',()=>{
    expect(body('table',{status:'table',rows:[['a']],cut:false})).toMatch(/<div class="file-viewer-table-scroll" tabindex="0" role="region" aria-label="file">/);
  });

  it('offers a PDF in a new tab too, for phones that show no PDF inline',()=>{
    expect(body('pdf',{status:'url',url:'blob:x'})).toMatch(/<a class="file-viewer-pdf-tab" href="blob:x" target="_blank" rel="noreferrer">Open in a new tab<\/a>/);
  });

  it('switches to the failed copy when a picture or player cannot decode the file',()=>{
    for(const kind of ['image','audio','video'] as const){
      const onFailed=vi.fn();
      const element=FileViewerBody({name:'file',kind,state:{status:'url',url:'blob:x'},onFailed}) as ReactElement<{onError?():void;onFailed?():void}>;
      // The voice player takes onFailed and hands it to its own <audio onError>.
      (element.props.onError??element.props.onFailed)!();
      expect(onFailed,kind).toHaveBeenCalledOnce();
    }
  });

  it('shows a table and says when it was cut',()=>{
    const html=body('table',{status:'table',rows:[['a','b'],['1','2']],cut:true});
    expect(html).toContain('<th scope="col">a</th>');
    expect(html).toContain('<td>2</td>');
    expect(html).toContain('Showing the first 200 rows and 30 columns.');
    expect(body('table',{status:'table',rows:[['a']],cut:false})).not.toContain('Showing the first');
  });

  it('plays, shows or embeds an object URL by kind',()=>{
    expect(body('image',{status:'url',url:'blob:x'})).toContain('<img');
    const audio=body('audio',{status:'url',url:'blob:x'});
    expect(audio).toContain('class="voice-player"');
    expect(audio).not.toMatch(/<audio[^>]*controls/);
    expect(body('video',{status:'url',url:'blob:x'})).toMatch(/<video[^>]*controls/);
    expect(body('pdf',{status:'url',url:'blob:x'})).toMatch(/<iframe[^>]*src="blob:x"[^>]*title="file"/);
  });

  it('says why nothing is shown',()=>{
    expect(body('pdf',{status:'failed'})).toContain('Could not open this file. Download it instead.');
    expect(body('pdf',{status:'too-large'})).toContain('Too large to preview here.');
    expect(body('none',{status:'none'})).toContain('No preview for this file type.');
  });
});

describe('opening tiles',()=>{
  it('keep each tile’s link, so a modified click still opens a tab or downloads',()=>{
    const open=()=>{};
    const ctx=renderToStaticMarkup(<FileTile name="brief.txt" mime="text/plain" href="/ctx/1" download onOpen={open}/>);
    expect(ctx).toBe(renderToStaticMarkup(<FileTile name="brief.txt" mime="text/plain" href="/ctx/1" download/>));
    expect(ctx).toContain('download="brief.txt"');
    const card=renderToStaticMarkup(<FileTile name="voice.webm" mime="audio/webm" href="/api/files/v" onOpen={open}/>);
    expect(card).toContain('target="_blank"');
    expect(card).toContain('href="/api/files/v"');
  });

  it('render a viewable tile with no dialog until it is opened',()=>{
    const html=renderToStaticMarkup(<ViewableFileTile name="chart.png" href="/api/files/f2"/>);
    expect(html).toContain('canvas-file-tile');
    expect(html).not.toContain('role="dialog"');
  });
});

/** Renders a tile once and hands back its link's click handler, so a click can be tried without a DOM. */
function tileClick(props:FileTileProps){
  let link:ReactElement|undefined;
  function Harness(){
    const item=FileTile(props) as ReactElement<{children:ReactElement[]}>;
    link=item.props.children[0];
    return item;
  }
  renderToStaticMarkup(<Harness/>);
  return (link!.props as {onClick?:(event:MouseEvent<HTMLAnchorElement>)=>void}).onClick;
}
const click=(change:Partial<Record<'button'|'ctrlKey'|'metaKey'|'shiftKey'|'altKey',number|boolean>>={})=>{
  const event={button:0,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,defaultPrevented:false,currentTarget:{},...change,preventDefault:vi.fn()};
  return event as typeof event&MouseEvent<HTMLAnchorElement>;
};

describe('tile clicks',()=>{
  it('open the viewer on a plain click, for any kind, instead of following the link',()=>{
    for(const props of [{name:'voice.webm',mime:'audio/webm',href:'/api/files/v'},{name:'brief.txt',href:'/ctx/1',download:true},{name:'chart.png',href:'/f'}]){
      const onOpen=vi.fn();
      const event=click();
      tileClick({...props,onOpen})!(event);
      expect(event.preventDefault,props.name).toHaveBeenCalledOnce();
      expect(onOpen,props.name).toHaveBeenCalledWith(event);
    }
  });

  it('let modified and middle clicks follow the link (new tab or download)',()=>{
    for(const change of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}]){
      const onOpen=vi.fn();
      const event=click(change);
      tileClick({name:'brief.txt',href:'/ctx/1',download:true,onOpen})!(event);
      expect(event.preventDefault,JSON.stringify(change)).not.toHaveBeenCalled();
      expect(onOpen,JSON.stringify(change)).not.toHaveBeenCalled();
    }
  });

  it('leave the link alone without onOpen',()=>expect(tileClick({name:'a.pdf',href:'/f'})).toBeUndefined());
});

describe('loading lifecycle',()=>{
  /** A fetch that waits until the test settles it; it rejects like the browser when its signal aborts. */
  function pendingFetch(){
    const seen:{signal?:AbortSignal;settle(response:Response):void}={settle:()=>{}};
    const fetchFile=((_href:string,init?:RequestInit)=>new Promise<Response>(resolve=>{seen.signal=init?.signal??undefined;seen.settle=resolve;})) as unknown as typeof fetch;
    return {seen,fetchFile};
  }
  const urls=()=>({createObjectURL:vi.fn(()=>'blob:made'),revokeObjectURL:vi.fn()});
  const flush=()=>new Promise(resolve=>setTimeout(resolve,0));

  it('closing mid-fetch aborts, never makes a URL and reports nothing',async()=>{
    const {seen,fetchFile}=pendingFetch(), objectUrls=urls(), results:ViewerResult[]=[];
    const stop=startViewerLoad({file:{name:'voice.webm',mime:'audio/webm',href:'/api/files/v'},kind:'audio',fetchFile,onResult:r=>results.push(r),urls:objectUrls});
    await flush();
    stop();
    expect(seen.signal?.aborted).toBe(true);
    seen.settle(new Response(new Uint8Array([1,2])));
    await flush();
    expect(objectUrls.createObjectURL).not.toHaveBeenCalled();
    expect(objectUrls.revokeObjectURL).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('closing after a failed or aborted request reports nothing',async()=>{
    const results:ViewerResult[]=[];
    const fetchFile=((_href:string,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))) as unknown as typeof fetch;
    const stop=startViewerLoad({file:{name:'a.pdf',href:'/f'},kind:'pdf',fetchFile,onResult:r=>results.push(r),urls:urls()});
    stop();
    await flush();
    expect(results).toEqual([]);
  });

  it('reports a typed URL once loaded and revokes it on close',async()=>{
    const {seen,fetchFile}=pendingFetch(), objectUrls=urls(), results:ViewerResult[]=[];
    const stop=startViewerLoad({file:{name:'clip.mp4',href:'/api/files/c'},kind:'video',fetchFile,onResult:r=>results.push(r),urls:objectUrls});
    await flush();
    seen.settle(new Response(new Uint8Array([1,2,3])));
    await flush();
    expect(objectUrls.createObjectURL).toHaveBeenCalledOnce();
    expect((objectUrls.createObjectURL.mock.calls[0] as unknown as [Blob])[0].type).toBe('video/mp4');
    expect(results).toEqual([{status:'url',url:'blob:made'}]);
    stop();
    expect(objectUrls.revokeObjectURL).toHaveBeenCalledWith('blob:made');
    stop();
    expect(objectUrls.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('reports a failed request',async()=>{
    const results:ViewerResult[]=[];
    startViewerLoad({file:{name:'a.png',href:'/f'},kind:'image',fetchFile:(async()=>new Response('no',{status:500})) as unknown as typeof fetch,onResult:r=>results.push(r),urls:urls()});
    await flush();
    expect(results).toEqual([{status:'failed'}]);
  });
});

describe('closing the viewer',()=>{
  it('returns focus to the tile that opened it, when it is still on the page',()=>{
    const tile={isConnected:true,focus:vi.fn()};
    expect(returnFocus(tile)).toBe(true);
    expect(tile.focus).toHaveBeenCalledWith({preventScroll:true});
    const gone={isConnected:false,focus:vi.fn()};
    expect(returnFocus(gone)).toBe(false);
    expect(gone.focus).not.toHaveBeenCalled();
    expect(returnFocus(null)).toBe(false);
  });

  it('wires that into the dialog, instead of Radix focusing the missing trigger',()=>{
    let content:ReactElement|undefined;
    const opener={isConnected:true,focus:vi.fn()} as unknown as HTMLElement;
    function Harness(){
      content=FileViewerContent({file:{name:'a.pdf',href:'/f'},fetchFile:noFetch,opener}) as ReactElement;
      return content;
    }
    renderToStaticMarkup(<Dialog.Root open><Harness/></Dialog.Root>);
    const event={preventDefault:vi.fn()};
    (content!.props as {onCloseAutoFocus(event:Event):void}).onCloseAutoFocus(event as unknown as Event);
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});

describe('one shared viewer',()=>{
  it('lets a tile hand its file and link to the shared viewer',()=>{
    const open=vi.fn();
    let tile:ReactElement<{onOpen(event:MouseEvent<HTMLAnchorElement>):void}>|undefined;
    function Harness(){
      const fragment=ViewableFileTile({name:'voice.webm',mime:'audio/webm',size:3,href:'/api/files/v'}) as ReactElement<{children:ReactElement[]}>;
      tile=fragment.props.children[0] as typeof tile;
      return fragment;
    }
    renderToStaticMarkup(<FileViewerContext.Provider value={open}><Harness/></FileViewerContext.Provider>);
    const link={isConnected:true};
    tile!.props.onOpen({currentTarget:link} as unknown as MouseEvent<HTMLAnchorElement>);
    expect(open).toHaveBeenCalledWith({name:'voice.webm',mime:'audio/webm',size:3,href:'/api/files/v'},link);
  });

  it('is there under the provider and missing outside it (tiles then keep their own dialog)',()=>{
    let inside:unknown,outside:unknown='unset';
    function In(){inside=useFileViewer();return null;}
    function Out(){outside=useFileViewer();return null;}
    expect(renderToStaticMarkup(<FileViewerProvider><In/><p>page</p></FileViewerProvider>)).toBe('<p>page</p>');
    renderToStaticMarkup(<Out/>);
    expect(typeof inside).toBe('function');
    expect(outside).toBeNull();
  });
});
