import {describe,expect,it} from 'vitest';
import {toScreen} from './geometry';
import {LOOSE_MAX_HEIGHT,SHEET_MAX_HEIGHT,SHEET_WIDTH,cardSheet,looseSheet,presentView,samePlace,sheetSize} from './sheet';

describe('canvas chat sheet',()=>{
  it('is 560 px wide and at most 720 px tall, 16 px clear of the edges',()=>{
    expect(sheetSize({w:1400,h:900})).toEqual({w:SHEET_WIDTH,h:SHEET_MAX_HEIGHT});
    expect(sheetSize({w:500,h:600})).toEqual({w:468,h:568});
  });

  it('opens a card at zoom 1 with its top-left where a centred sheet starts',()=>{
    const card={x:400,y:-200,w:280,h:190};
    const view=presentView(card,{w:1200,h:840});
    expect(view.zoom).toBe(1);
    expect(toScreen(view,card)).toEqual({x:(1200-560)/2,y:(840-720)/2});
  });

  it('zooms below 1 only to fit a card that is taller than the canvas',()=>{
    const view=presentView({x:0,y:0,w:280,h:1000},{w:1200,h:532});
    expect(view.zoom).toBe(0.5);
    expect(view.x).toBe(320);
    expect(view.y).toBe(16);
  });

  it('sits over the card on screen and stays inside the canvas',()=>{
    expect(cardSheet({x:300,y:120},{w:1200,h:840})).toEqual({kind:'card',x:300,y:120,w:560,maxH:704});
    // Too far right or left: clamped by the gutter.
    expect(cardSheet({x:1000,y:120},{w:1200,h:840}).x).toBe(1200-560-16);
    expect(cardSheet({x:-90,y:-40},{w:1200,h:840})).toMatchObject({x:16,y:16,maxH:720});
    // Too low: lifted so the chat keeps room.
    expect(cardSheet({x:300,y:800},{w:1200,h:840}).y).toBe(840-16-320);
  });

  it('centres when the card is not on screen',()=>{
    expect(cardSheet(null,{w:1200,h:840})).toEqual({kind:'card',x:320,y:60,w:560,maxH:720});
  });

  it('puts a loose chat over the bottom box, centred on the canvas',()=>{
    const place=looseSheet({w:1200,h:840},500,84,1000);
    expect(place).toEqual({kind:'loose',x:220,bottom:84,w:560,maxH:LOOSE_MAX_HEIGHT});
    // A short window: min(640px, 100vh - 190px).
    expect(looseSheet({w:1200,h:800},600,84,700).maxH).toBe(510);
    expect(looseSheet({w:1200,h:600},600,84,1000).maxH).toBe(500);
    expect(looseSheet({w:1200,h:840},40,84,1000).x).toBe(16);
  });

  it('compares places by value',()=>{
    expect(samePlace(cardSheet({x:1,y:2},{w:900,h:700}),cardSheet({x:1,y:2},{w:900,h:700}))).toBe(true);
    expect(samePlace(cardSheet({x:100,y:40},{w:900,h:700}),cardSheet({x:100,y:41},{w:900,h:700}))).toBe(false);
    expect(samePlace(null,null)).toBe(true);
  });
});
