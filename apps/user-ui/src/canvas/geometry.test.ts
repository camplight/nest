import {describe,expect,it} from 'vitest';
import type {CanvasArea} from '@nest/schemas';
import {MAX_ZOOM,MIN_ZOOM,areaMembers,cardCentre,fit,isCompact,overlaps,toCanvas,toScreen,growToFit,visible,zoomAt,type View} from './geometry';

const area=(id:string,x:number,y:number,w:number,h:number):CanvasArea=>({id,canvasId:'c',title:id,x,y,w,h,tint:'moss',version:0});

describe('canvas geometry',()=>{
  it('maps between screen and canvas points',()=>{
    const view:View={x:100,y:-50,zoom:2};
    expect(toScreen(view,{x:10,y:20})).toEqual({x:120,y:-10});
    expect(toCanvas(view,{x:120,y:-10})).toEqual({x:10,y:20});
  });

  it('zoomAt keeps the canvas point under the cursor fixed',()=>{
    const p={x:400,y:300};
    for(const [view,factor] of [[{x:0,y:0,zoom:1},1.5],[{x:-230,y:75,zoom:0.8},0.6],[{x:12,y:-900,zoom:1.7},1.1]] as [View,number][]){
      const before=toCanvas(view,p),next=zoomAt(view,factor,p),after=toCanvas(next,p);
      expect(next.zoom).not.toBe(view.zoom);
      expect(after.x).toBeCloseTo(before.x,9);
      expect(after.y).toBeCloseTo(before.y,9);
    }
  });

  it('clamps zoom to 0.2 and 2',()=>{
    expect(MIN_ZOOM).toBe(0.2);
    expect(MAX_ZOOM).toBe(2);
    expect(zoomAt({x:0,y:0,zoom:1},100,{x:0,y:0}).zoom).toBe(2);
    expect(zoomAt({x:0,y:0,zoom:1},0.001,{x:0,y:0}).zoom).toBe(0.2);
    // A clamped zoom still keeps the point fixed.
    const v=zoomAt({x:30,y:40,zoom:1.5},10,{x:400,y:300});
    expect(toCanvas(v,{x:400,y:300}).x).toBeCloseTo(toCanvas({x:30,y:40,zoom:1.5},{x:400,y:300}).x,9);
  });

  it('fit puts every rect inside the viewport with padding',()=>{
    const rects=[{x:-500,y:200,w:280,h:160},{x:2400,y:1600,w:280,h:160}];
    const viewport={w:1200,h:800};
    const view=fit(rects,viewport);
    for(const r of rects){
      const a=toScreen(view,{x:r.x,y:r.y}),b=toScreen(view,{x:r.x+r.w,y:r.y+r.h});
      expect(a.x).toBeGreaterThanOrEqual(48-1e-9);expect(a.y).toBeGreaterThanOrEqual(48-1e-9);
      expect(b.x).toBeLessThanOrEqual(1200-48+1e-9);expect(b.y).toBeLessThanOrEqual(800-48+1e-9);
    }
    expect(view.zoom).toBeGreaterThanOrEqual(0.2);
  });

  it('fit does not zoom past 100% and centres a small layout; no rects is the origin',()=>{
    const view=fit([{x:0,y:0,w:280,h:160}],{w:1000,h:600});
    expect(view.zoom).toBe(1);
    expect(toScreen(view,{x:140,y:80})).toEqual({x:500,y:300});
    expect(fit([],{w:1000,h:600})).toEqual({x:0,y:0,zoom:1});
  });

  it('visible drops an item 1000 px off-screen and keeps one 150 px off-screen',()=>{
    const view:View={x:0,y:0,zoom:1},viewport={w:1000,h:800};
    const near={id:'near',x:1000+150,y:100,w:280,h:160};
    const far={id:'far',x:1000+1000,y:100,w:280,h:160};
    const above={id:'above',x:100,y:-150-160,w:280,h:160};
    const on={id:'on',x:10,y:10,w:280,h:160};
    expect(visible([near,far,above,on],view,viewport).map(i=>i.id)).toEqual(['near','above','on']);
    // The margin is in screen pixels, so it shrinks in canvas units when zoomed in.
    expect(visible([near],{x:0,y:0,zoom:2},viewport).map(i=>i.id)).toEqual([]);
  });

  it('isCompact is true below 50% zoom',()=>{
    expect(isCompact({x:0,y:0,zoom:0.49})).toBe(true);
    expect(isCompact({x:0,y:0,zoom:0.5})).toBe(false);
  });

  it('membership uses the shared card height, and nested areas travel with their parent',()=>{
    expect(cardCentre({x:0,y:0,w:280})).toEqual({x:140,y:80});
    const outer=area('outer',0,0,1000,800),inner=area('inner',100,100,400,300),other=area('other',2000,0,400,400);
    const cards=[
      {channelId:'in-outer',x:600,y:500,w:280},
      {channelId:'in-inner',x:150,y:150,w:280},
      {channelId:'outside',x:2100,y:100,w:280},
      // Its top-left is inside, but its centre (by the shared 160 px height) is below the area.
      {channelId:'edge',x:600,y:760,w:280},
    ];
    const members=areaMembers('outer',cards,[outer,inner,other]);
    expect([...members.cards].sort()).toEqual(['in-inner','in-outer']);
    expect([...members.areas]).toEqual(['inner']);
  });
});

describe('overlaps',()=>{
  it('is true only when the rects share area',()=>{
    const a={x:0,y:0,w:100,h:100};
    expect(overlaps(a,{x:50,y:50,w:100,h:100})).toBe(true);
    expect(overlaps(a,{x:10,y:10,w:10,h:10})).toBe(true);
    expect(overlaps(a,{x:100,y:0,w:50,h:50})).toBe(false);
    expect(overlaps(a,{x:0,y:-50,w:50,h:50})).toBe(false);
  });
});

describe('growToFit', () => {
  const area = {x: 0, y: 0, w: 600, h: 400};
  it('leaves an area alone when the cards already fit with room', () => {
    expect(growToFit(area, [{x: 100, y: 100, w: 280, h: 160}])).toBeNull();
    expect(growToFit(area, [])).toBeNull();
  });
  it('grows right and down to fit a card hanging over the edge, with side padding', () => {
    expect(growToFit(area, [{x: 400, y: 300, w: 280, h: 160}])).toEqual({x: 0, y: 0, w: 712, h: 492});
  });
  it('grows left and up, keeping the title bar clear above the card', () => {
    expect(growToFit(area, [{x: -50, y: 20, w: 280, h: 160}])).toEqual({x: -82, y: -52, w: 682, h: 452});
  });
  it('fits a whole dropped grid at once and never shrinks', () => {
    const grid = [{x: 100, y: 100, w: 280, h: 160}, {x: 400, y: 100, w: 280, h: 160}, {x: 700, y: 300, w: 280, h: 160}];
    expect(growToFit(area, grid)).toEqual({x: 0, y: 0, w: 1012, h: 492});
  });
  it('stays within the API size limit', () => {
    expect(growToFit(area, [{x: 30_000, y: 0, w: 280, h: 160}])!.w).toBe(20_000);
  });
});
