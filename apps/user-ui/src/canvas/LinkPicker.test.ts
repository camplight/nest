import {describe,expect,it} from 'vitest';
import type {BoardCard,CanvasArea} from '@nest/schemas';
import {pickGroups} from './LinkPicker';

const base={canvasId:'k1',w:264,version:1,placedBy:'h1',placedAt:1};
const open=(channelId:string,title:string,x:number,y:number,archived=false):BoardCard=>({...base,channelId,x,y,projectId:null,access:'open',title,participants:[],archived,canManage:true,forkOf:null} as BoardCard);
const area=(id:string,title:string,x:number):CanvasArea=>({id,canvasId:'k1',title,x,y:0,w:600,h:500,tint:'moss',version:1} as CanvasArea);
const names=(groups:ReturnType<typeof pickGroups>)=>groups.map(([title,cards])=>[title,cards.map(card=>card.channelId)]);

describe('the chat picker\'s groups (the mock\'s renderLinkPick)',()=>{
  const areas=[area('a1','Launch',0),area('a2','Review',1000)];
  const cards:BoardCard[]=[
    open('from','Podcast',40,40),
    open('blog','Blog post',100,200),
    open('qa','Release check',1100,60),
    open('loose','Research notes',2000,60),
    {...base,channelId:'locked',x:120,y:60,access:'locked',ownerLabel:'mate'} as BoardCard,
    open('old','Old archive',2200,60,true),
  ];

  it('lists every other open chat by area, then the ones outside areas, leaving out empty groups',()=>{
    expect(names(pickGroups('from',cards,areas,''))).toEqual([['Launch',['blog']],['Review',['qa']],['Not in an area',['loose']]]);
  });

  it('finds chats by name, case-insensitively',()=>{
    expect(names(pickGroups('from',cards,areas,'BLO'))).toEqual([['Launch',['blog']]]);
    expect(pickGroups('from',cards,areas,'nothing like this')).toEqual([]);
  });
});
