import {describe,expect,it} from 'vitest';
import {TEXT_DISPLAY_MAX,VIEWER_MAX_BYTES,blobType,fileViewerOpen,fileViewerOwns,insideFileViewer,isPlainClick,loadViewerFile,parseTable,truncateText,viewerKind} from './file-viewer';

describe('viewerKind',()=>{
  it('classifies by the known MIME type first',()=>{
    const cases:[string,string,string][]=[
      ['image/png','a.bin','image'],['image/jpeg','a','image'],['image/gif','a','image'],['image/webp','a','image'],['image/avif','a','image'],
      ['audio/mpeg','a','audio'],['audio/webm','voice.webm','audio'],['audio/ogg','a','audio'],
      ['video/mp4','a','video'],['video/webm','a.webm','video'],
      ['application/pdf','a','pdf'],
      ['text/plain','a','text'],['text/markdown','a','text'],['application/json','a','text'],
      ['text/csv','a','table'],['text/tab-separated-values','a','table'],
      ['image/svg+xml','a.png','none'],['text/html','a.txt','none'],['application/zip','a.zip','none'],
    ];
    for(const [mime,name,kind] of cases)expect(viewerKind(mime,name),`${mime} ${name}`).toBe(kind);
  });

  it('falls back to the extension when the type is missing or octet-stream',()=>{
    const cases:[string,string][]=[
      ['a.png','image'],['a.jpg','image'],['a.jpeg','image'],['a.gif','image'],['a.webp','image'],['a.avif','image'],
      ['a.mp3','audio'],['a.m4a','audio'],['a.aac','audio'],['a.ogg','audio'],['a.oga','audio'],['a.opus','audio'],['a.wav','audio'],['a.flac','audio'],
      ['a.mp4','video'],['a.mov','video'],['a.m4v','video'],['a.webm','video'],
      ['a.pdf','pdf'],
      ['a.txt','text'],['a.md','text'],['a.markdown','text'],['a.json','text'],['a.log','text'],['a.yaml','text'],['a.yml','text'],
      ['a.csv','table'],['a.tsv','table'],
      ['a.svg','none'],['a.html','none'],['a.htm','none'],['a.docx','none'],['noextension','none'],
    ];
    for(const [name,kind] of cases){
      expect(viewerKind('application/octet-stream',name),`octet ${name}`).toBe(kind);
      expect(viewerKind(undefined,name),`missing ${name}`).toBe(kind);
      expect(viewerKind('',name),`empty ${name}`).toBe(kind);
    }
  });

  it('reads extensions in any case and a .webm as audio only when its type says so',()=>{
    expect(viewerKind(undefined,'VOICE.MP3')).toBe('audio');
    expect(viewerKind('application/octet-stream','Report.PDF')).toBe('pdf');
    expect(viewerKind('Audio/WebM','note.webm')).toBe('audio');
    expect(viewerKind(undefined,'note.webm')).toBe('video');
    expect(viewerKind('IMAGE/SVG+XML','x')).toBe('none');
  });
});

describe('blobType',()=>{
  it('types object URLs from the allowlist only',()=>{
    expect(blobType('audio','audio/webm','voice.webm')).toBe('audio/webm');
    expect(blobType('video','application/octet-stream','clip.mp4')).toBe('video/mp4');
    expect(blobType('audio',undefined,'song.mp3')).toBe('audio/mpeg');
    expect(blobType('audio',undefined,'voice.webm')).toBe('audio/webm');
    expect(blobType('image','application/octet-stream','chart.png')).toBe('image/png');
    expect(blobType('image',undefined,'photo.JPG')).toBe('image/jpeg');
    expect(blobType('image','image/webp','x')).toBe('image/webp');
    expect(blobType('pdf','application/octet-stream','a.pdf')).toBe('application/pdf');
    expect(blobType('pdf','application/pdf','a')).toBe('application/pdf');
    expect(blobType('text','text/plain','a.txt')).toBeNull();
    expect(blobType('table','text/csv','a.csv')).toBeNull();
    expect(blobType('none','text/html','a.html')).toBeNull();
  });

  it('never keeps a type that does not match the kind',()=>{
    // A file named .png but typed as HTML is not viewable at all; a mismatched known type falls back to the extension.
    expect(blobType('image','text/html','a.png')).toBe('image/png');
    expect(blobType('audio','video/mp4','a.m4a')).toBe('audio/mp4');
    expect(blobType('image','image/svg+xml','a.gif')).toBe('image/gif');
  });

  it('caps the viewer at 25 MB',()=>expect(VIEWER_MAX_BYTES).toBe(25*1024*1024));
});

describe('parseTable',()=>{
  it('reads quoted fields with commas, doubled quotes and newlines',()=>{
    const text='name,note\r\n"Smith, Jo","said ""hi"""\n"Two\nlines",plain\n';
    expect(parseTable(text,',')).toEqual({rows:[['name','note'],['Smith, Jo','said "hi"'],['Two\nlines','plain']],cut:false});
  });

  it('reads TSV and keeps empty fields',()=>{
    expect(parseTable('a\tb\tc\n1\t\t3',  '\t')).toEqual({rows:[['a','b','c'],['1','','3']],cut:false});
  });

  it('cuts at 200 rows and 30 columns and says so',()=>{
    const wide=Array.from({length:40},(_,i)=>`c${i}`).join(',');
    const tall=Array.from({length:250},(_,i)=>`r${i}`).join('\n');
    const byCols=parseTable(wide,',');
    expect(byCols.rows[0]).toHaveLength(30);
    expect(byCols.cut).toBe(true);
    const byRows=parseTable(tall,',');
    expect(byRows.rows).toHaveLength(200);
    expect(byRows.rows[199]).toEqual(['r199']);
    expect(byRows.cut).toBe(true);
    expect(parseTable(Array.from({length:200},(_,i)=>`r${i}`).join('\n'),',').cut).toBe(false);
    expect(parseTable('a,b\n1,2\n3,4',',',2,1)).toEqual({rows:[['a'],['1']],cut:true});
  });

  it('reads an empty file as no rows',()=>expect(parseTable('',',')).toEqual({rows:[],cut:false}));
});

describe('isPlainClick',()=>{
  const plain={button:0,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,defaultPrevented:false};
  it('accepts only an unmodified primary click',()=>{
    expect(isPlainClick(plain)).toBe(true);
    for(const change of [{button:1},{button:2},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{defaultPrevented:true}])
      expect(isPlainClick({...plain,...change}),JSON.stringify(change)).toBe(false);
  });
});

describe('loadViewerFile',()=>{
  const calls:{href:string;init?:RequestInit}[]=[];
  const fetchWith=(response:()=>Response)=>(async(href:string,init?:RequestInit)=>{calls.push({href,init});return response();}) as unknown as typeof fetch;
  const file=(name:string,mime?:string,size?:number)=>({name,mime,size,href:`/api/files/${name}`});

  it('fetches with credentials (the API may be on another origin) and the abort signal and types media from the allowlist',async()=>{
    calls.length=0;
    const signal=new AbortController().signal;
    const result=await loadViewerFile(file('voice.webm','audio/webm'),'audio',fetchWith(()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'application/octet-stream'}})),signal);
    expect(calls).toEqual([{href:'/api/files/voice.webm',init:{credentials:'include',signal}}]);
    expect(result.status).toBe('media');
    if(result.status==='media'){expect(result.blob.type).toBe('audio/webm');expect(result.blob.size).toBe(3);}
  });

  it('reads text as text and CSV/TSV as a table',async()=>{
    expect(await loadViewerFile(file('notes.md'),'text',fetchWith(()=>new Response('<b>hi</b>')))).toEqual({status:'text',text:'<b>hi</b>',cut:false});
    expect(await loadViewerFile(file('a.csv'),'table',fetchWith(()=>new Response('a,b\n1,2')))).toEqual({status:'table',rows:[['a','b'],['1','2']],cut:false});
    expect(await loadViewerFile(file('a.tsv'),'table',fetchWith(()=>new Response('a\tb')))).toEqual({status:'table',rows:[['a','b']],cut:false});
  });

  it('refuses over the cap by known size, then content-length, then the bytes read',async()=>{
    calls.length=0;
    const never=fetchWith(()=>{throw new Error('should not fetch');});
    expect(await loadViewerFile(file('big.mp4',undefined,VIEWER_MAX_BYTES+1),'video',never)).toEqual({status:'too-large'});
    expect(calls).toHaveLength(0);
    const long=fetchWith(()=>new Response('x',{headers:{'content-length':String(VIEWER_MAX_BYTES+1)}}));
    expect(await loadViewerFile(file('big.pdf'),'pdf',long)).toEqual({status:'too-large'});
    const chunk=new Uint8Array(8*1024*1024);
    let sent=0;
    const stream=new ReadableStream<Uint8Array>({pull(controller){if(sent++<4)controller.enqueue(chunk);else controller.close();}});
    expect(await loadViewerFile(file('big.txt'),'text',fetchWith(()=>new Response(stream)))).toEqual({status:'too-large'});
    expect(sent).toBeLessThanOrEqual(5);
  });

  it('shows nothing for files it cannot view and fails on an error status',async()=>{
    const never=fetchWith(()=>{throw new Error('should not fetch');});
    expect(await loadViewerFile(file('page.html','text/html'),'none',never)).toEqual({status:'none'});
    await expect(loadViewerFile(file('a.png'),'image',fetchWith(()=>new Response('no',{status:404})))).rejects.toThrow('404');
  });
});

describe('truncateText',()=>{
  it('keeps the first 1 MB of characters and says when it cut',()=>{
    expect(TEXT_DISPLAY_MAX).toBe(1024*1024);
    expect(truncateText('short')).toEqual({text:'short',cut:false});
    const exact='a'.repeat(TEXT_DISPLAY_MAX);
    expect(truncateText(exact)).toEqual({text:exact,cut:false});
    const long=truncateText('b'.repeat(TEXT_DISPLAY_MAX+10));
    expect(long.text).toHaveLength(TEXT_DISPLAY_MAX);
    expect(long.cut).toBe(true);
    expect(truncateText('abcdef',3)).toEqual({text:'abc',cut:true});
  });

  it('applies to text the viewer loads',async()=>{
    const big='x'.repeat(TEXT_DISPLAY_MAX+1);
    const result=await loadViewerFile({name:'big.log',href:'/f'},'text',(async()=>new Response(big)) as unknown as typeof fetch);
    expect(result.status==='text'&&result.text.length).toBe(TEXT_DISPLAY_MAX);
    expect(result.status==='text'&&result.cut).toBe(true);
  });
});

describe('telling the viewer apart',()=>{
  const element=(inside:boolean)=>({closest:(selector:string)=>selector==='[data-file-viewer]'&&inside?{}:null});
  it('knows a press inside the viewer',()=>{
    expect(insideFileViewer(element(true) as unknown as EventTarget)).toBe(true);
    expect(insideFileViewer(element(false) as unknown as EventTarget)).toBe(false);
    expect(insideFileViewer(null)).toBe(false);
    expect(insideFileViewer({} as EventTarget)).toBe(false);
  });
  it('lets popovers leave the viewer\'s presses and keys alone',()=>{
    expect(fileViewerOwns({target:element(true)} as unknown as Event)).toBe(true);
    expect(fileViewerOwns({target:element(false)} as unknown as Event)).toBe(false);
  });
  it('knows when a viewer is open',()=>{
    expect(fileViewerOpen({querySelector:()=>({}) as Element})).toBe(true);
    expect(fileViewerOpen({querySelector:()=>null})).toBe(false);
  });
});
