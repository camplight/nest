import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {FileTile,fileSlots} from './FileTile';
import {cardFilesWidth} from './Card';

describe('file tiles',()=>{
  it('fill a row and turn the last slot into +N when more files were posted',()=>{
    const width=cardFilesWidth(264);
    expect(fileSlots(width,3)).toEqual({shown:3,more:0});
    expect(fileSlots(width,4)).toEqual({shown:4,more:0});
    expect(fileSlots(width,5)).toEqual({shown:3,more:2});
    expect(fileSlots(width,9,6)).toEqual({shown:3,more:6});
    // A wider card holds more; the pulse lists 6 at most, so the rest are counted.
    expect(fileSlots(cardFilesWidth(420),6)).toEqual({shown:6,more:0});
    expect(fileSlots(cardFilesWidth(420),10,6)).toEqual({shown:5,more:5});
    expect(fileSlots(cardFilesWidth(500),10,6)).toEqual({shown:6,more:4});
    expect(fileSlots(40,3)).toEqual({shown:0,more:3});
    expect(fileSlots(width,0)).toEqual({shown:0,more:0});
  });

  it('name a card tile by its file, with the type in the tooltip, and preview raster images only',()=>{
    const sheet=renderToStaticMarkup(<FileTile name="Q3 model.xlsx" mime="application/octet-stream" href="/api/files/f1"/>);
    expect(sheet).toContain('data-kind="sheet"');
    expect(sheet).toContain('title="Q3 model.xlsx · Excel spreadsheet"');
    expect(sheet).toContain('target="_blank"');
    expect(sheet).not.toContain('aria-label');
    expect(sheet).not.toContain('background-image');
    const png=renderToStaticMarkup(<FileTile name="chart.png" href="/api/files/f2"/>);
    expect(png).toContain('data-kind="image"');
    expect(png).toContain('background-image:url(&quot;/api/files/f2&quot;)');
    expect(renderToStaticMarkup(<FileTile name="diagram.svg" mime="image/svg+xml" href="/api/files/f3"/>)).not.toContain('background-image');
  });

  it('name a message tile by file, type and size, with type and size as its tooltip',()=>{
    const html=renderToStaticMarkup(<FileTile name="Q3 model.xlsx" href="/api/files/f1" size={5*1024} detailed/>);
    expect(html).toContain('aria-label="Q3 model.xlsx, Excel spreadsheet, 5.0 KB"');
    expect(html).toContain('title="Excel spreadsheet · 5.0 KB"');
    expect(html).toContain('>Q3 model.xlsx</span>');
    expect(renderToStaticMarkup(<FileTile name="notes" href="/f" detailed/>)).toContain('aria-label="notes, File"');
  });

  it('download context files and keep their remove button',()=>{
    const html=renderToStaticMarkup(<FileTile name="brief.txt" mime="text/plain" href="/ctx/1" download onRemove={()=>{}}/>);
    expect(html).toContain('download="brief.txt"');
    expect(html).not.toContain('target=');
    expect(html).toContain('aria-label="Remove brief.txt"');
  });
});
