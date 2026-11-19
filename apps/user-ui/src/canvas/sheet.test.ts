import {describe,expect,it} from 'vitest';
import {toScreen} from './geometry';
import {AREA_HEAD_ROOM,clearOfDrawer,presentView,stageBounds} from './sheet';

describe('canvas chat sheet',()=>{
  it('keeps 16 px gutters and stops 8 px above the bottom box',()=>{
    expect(stageBounds({w:1000,h:820},740)).toEqual({left:16,top:16,right:984,bottom:732});
    expect(stageBounds({w:1000,h:820},null)).toEqual({left:16,top:16,right:984,bottom:804});
    expect(stageBounds({w:1000,h:820},740,{x:72,y:0}).left).toBe(88);
  });

  it('opens a card at zoom 1, centring the sheet by its real height',()=>{
    const card={x:400,y:-200,w:280,h:190};
    const bounds=stageBounds({w:1200,h:860},780);
    const view=presentView(card,bounds,440);
    expect(view.zoom).toBe(1);
    // Centred between the top (16) and the bottom box (772): 16 + (756 - 440) / 2 = 174.
    expect(toScreen(view,card)).toEqual({x:(1200-560)/2,y:174});
  });

  it('leaves room above the card for its area title even when the sheet is tall',()=>{
    const view=presentView({x:0,y:0,w:280,h:190},stageBounds({w:1200,h:820},740),720);
    expect(toScreen(view,{x:0,y:0}).y).toBe(AREA_HEAD_ROOM);
  });

  it('zooms below 1 only to fit a card that is taller than the canvas',()=>{
    const view=presentView({x:0,y:0,w:280,h:1000},stageBounds({w:1200,h:532},null),400);
    expect(view.zoom).toBe(0.5);
    expect(view.x).toBe(320);
  });

  it('keeps clear of an open Loose chats drawer when a full sheet fits beside it, else overlaps it',()=>{
    // The drawer: 16 px in, 370 px wide.
    const wide=stageBounds({w:1400,h:840},760);
    expect(clearOfDrawer(wide,386)).toEqual({...wide,left:402});
    expect(clearOfDrawer(wide,null)).toBe(wide);
    // 960 wide: 944 - 402 = 542 < 560, so the bounds are unchanged.
    const narrow=stageBounds({w:960,h:840},760);
    expect(clearOfDrawer(narrow,386)).toBe(narrow);
    // A card opened beside the drawer lands right of it.
    const view=presentView({x:0,y:0,w:280,h:190},clearOfDrawer(wide,386),440);
    expect(toScreen(view,{x:0,y:0}).x).toBe(402+(1384-402-560)/2);
  });
});
