import {describe,expect,it} from 'vitest';
import type {BoardCard,CanvasArea} from '@nest/schemas';
import {NO_AREA,phoneGroups} from './phone';

const area=(id:string,x:number,y:number,w:number,h:number):CanvasArea=>({id,canvasId:'c',title:`Area ${id}`,x,y,w,h,tint:'pip',version:0});
const card=(channelId:string,x:number,y:number):BoardCard=>({canvasId:'c',channelId,x,y,w:280,version:0,placedBy:'h',placedAt:0,access:'locked',ownerLabel:'owner'});

describe('phone list groups',()=>{
  it('lists each area with the cards whose centre is in it, in reading order, then the cards in no area',()=>{
    const areas=[area('b',0,1000,800,600),area('a',0,0,800,600)];
    const cards=[card('a2',400,100),card('out',2000,0),card('a1',40,100),card('b1',40,1100),card('a3',40,300)];
    expect(phoneGroups(cards,areas).map(group=>[group.id,group.title,group.cards.map(c=>c.channelId)])).toEqual([
      ['a','Area a',['a1','a2','a3']],
      ['b','Area b',['b1']],
      [NO_AREA,'Not in an area',['out']],
    ]);
  });

  it('puts a card only in the innermost area, keeps empty areas and drops the no-area group when it is empty',()=>{
    const areas=[area('outer',0,0,2000,2000),area('inner',100,100,600,400)];
    const groups=phoneGroups([card('in',150,150),card('rest',1200,1200)],areas);
    expect(groups.map(group=>[group.id,group.cards.map(c=>c.channelId)])).toEqual([['outer',['rest']],['inner',['in']]]);
    expect(phoneGroups([],[area('empty',0,0,300,300)])).toEqual([{id:'empty',title:'Area empty',tint:'pip',cards:[]}]);
  });
});
