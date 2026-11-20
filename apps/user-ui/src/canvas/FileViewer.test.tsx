import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Dialog} from 'radix-ui';
import {FileTile} from './FileTile';
import {FileViewer,FileViewerBody,FileViewerContent,ViewableFileTile} from './FileViewer';
import {VIEWER_MAX_BYTES} from './file-viewer';

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
    const html=body('text',{status:'text',text:'<script>alert(1)</script>'});
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
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
    expect(body('audio',{status:'url',url:'blob:x'})).toMatch(/<audio[^>]*controls/);
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
