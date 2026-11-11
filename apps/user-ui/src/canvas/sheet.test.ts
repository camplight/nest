import {describe,expect,it} from 'vitest';
import {toScreen} from './geometry';
import {AREA_HEAD_ROOM,LOOSE_MAX_HEIGHT,cardSheet,looseSheet,presentView,samePlace,stageBounds} from './sheet';

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

  it('sits over the card on screen and never reaches the bottom box',()=>{
    const bounds=stageBounds({w:1200,h:840},760);
    expect(cardSheet({x:300,y:120},bounds)).toEqual({kind:'card',x:300,y:120,w:560,maxH:632});
    // Too far right or left: clamped by the gutter.
    expect(cardSheet({x:1000,y:120},bounds).x).toBe(1200-560-16);
    expect(cardSheet({x:-90,y:-40},bounds)).toMatchObject({x:16,y:16,maxH:720});
    // Too low: lifted so the chat keeps room, and its bottom stays above the box.
    const low=cardSheet({x:300,y:700},bounds);
    expect(low.y).toBe(752-320);
    expect(low.y+low.maxH).toBe(752);
  });

  it('stays within the stage, never over the Loose chats pile beside it',()=>{
    // A 900 px stage at the left of a 1220 px body: the pile takes the last 320 px.
    const place=cardSheet({x:800,y:100},stageBounds({w:900,h:800},700));
    expect(place.x+place.w).toBeLessThanOrEqual(900-16);
  });

  it('centres when the card is not on screen',()=>{
    expect(cardSheet(null,stageBounds({w:1200,h:840},null))).toEqual({kind:'card',x:320,y:60,w:560,maxH:720});
  });

  it('puts a loose chat over the bottom box, centred on the stage',()=>{
    const place=looseSheet(stageBounds({w:1200,h:840},760),840,1000);
    expect(place).toEqual({kind:'loose',x:320,bottom:840-752,w:560,maxH:LOOSE_MAX_HEIGHT});
    // A short window: min(640px, 100vh - 190px).
    expect(looseSheet(stageBounds({w:1200,h:800},720),800,700).maxH).toBe(510);
    expect(looseSheet(stageBounds({w:1200,h:600},520),600,1000).maxH).toBe(496);
  });

  it('compares places by value',()=>{
    const bounds=stageBounds({w:900,h:700},null);
    expect(samePlace(cardSheet({x:100,y:40},bounds),cardSheet({x:100,y:40},bounds))).toBe(true);
    expect(samePlace(cardSheet({x:100,y:40},bounds),cardSheet({x:100,y:41},bounds))).toBe(false);
    expect(samePlace(null,null)).toBe(true);
  });
});
