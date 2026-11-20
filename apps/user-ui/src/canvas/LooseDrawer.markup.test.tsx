import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {LooseDrawer,bulkArchiveLabel} from './LooseDrawer';
import type {LooseChat} from './loose';

const row=(channelId:string,patch:Partial<LooseChat>={}):LooseChat=>({channelId,projectId:null,title:`Chat ${channelId}`,participants:[],lastActivityAt:Date.UTC(2026,10,20,9),agents:[],state:'done',reason:null,line:'',manageable:true,archived:false,...patch});
const noop=()=>{};
const yes=async()=>true;

describe('LooseDrawer archive rows',()=>{
  it('offers Unarchive on an archived row and Unhide on a hidden one',()=>{
    const html=renderToStaticMarkup(<LooseDrawer id="d" open chats={[row('a',{archived:true}),row('h',{manageable:false})]} count={0} hidden={new Set(['h'])} showHidden onShowHidden={noop}
      canPlace draggable onNewArea={yes} onArchive={yes} onClose={noop} now={()=>Date.UTC(2026,10,20,12)} focusKey={0}/>);
    const rows=html.split('<li').slice(1);
    const a=rows.find(r=>r.includes('data-channel-id="a"'))!,h=rows.find(r=>r.includes('data-channel-id="h"'))!;
    expect(a).toMatch(/>Archived<\/span>/);expect(a).toMatch(/<button[^>]*>Unarchive<\/button>/);
    expect(h).toMatch(/>Hidden<\/span>/);expect(h).toMatch(/<button[^>]*>Unhide<\/button>/);
  });
});

describe('bulkArchiveLabel',()=>{
  it('reads Archive when a selected chat is the person\'s to archive, else Hide from my list',()=>{
    const chats=[row('m'),row('t',{manageable:false}),row('x',{archived:true})];
    expect(bulkArchiveLabel(chats,['m','t'])).toBe('Archive');
    expect(bulkArchiveLabel(chats,['t'])).toBe('Hide from my list');
    expect(bulkArchiveLabel(chats,['x','t'])).toBe('Hide from my list');
  });
});
