import {describe,expect,it} from 'vitest';
import {drawnEnds,linkPath,linkRelease,offsetReverse,tempLinkPath} from './link-geometry';

describe('link geometry (the mock\'s geom)',()=>{
  it('joins side by side cards from the right edge to the left edge, bowed by 40% of the gap',()=>{
    expect(linkPath({x:0,y:0,w:280,h:160},{x:600,y:0,w:280,h:160})).toBe('M280 80C520 80 360 80 600 80');
  });

  it('goes right to left when the second card is on the left',()=>{
    expect(linkPath({x:600,y:0,w:280,h:160},{x:0,y:0,w:280,h:160})).toBe('M600 80C360 80 520 80 280 80');
  });

  it('uses the bottom and top edges when the second card is below',()=>{
    // dy 400 against dx 0: vertical, k = max(50, 160).
    expect(linkPath({x:0,y:0,w:280,h:160},{x:0,y:400,w:280,h:160})).toBe('M140 160C140 320 140 240 140 400');
  });

  it('uses the top and bottom edges when the second card is above, with a 50 px minimum bow',()=>{
    // dy -100 (0.75 × |dx| = 0 is not more than |dy|), k = max(50, 40).
    expect(linkPath({x:0,y:200,w:280,h:100},{x:0,y:100,w:280,h:100})).toBe('M140 200C140 150 140 250 140 200');
  });

  it('offsets a reverse pair: the lower id up 22, the other down 22; single links stay',()=>{
    const offsets=offsetReverse([{id:'b',from:'x',to:'y'},{id:'a',from:'y',to:'x'},{id:'c',from:'x',to:'z'}]);
    expect(offsets.get('a')).toBe(-22);
    expect(offsets.get('b')).toBe(22);
    expect(offsets.get('c')).toBe(0);
  });

  it('draws a fork from the parent (its target) to the child (its source)',()=>{
    expect(drawnEnds({kind:'fork',from:'child',to:'parent'})).toEqual({a:'parent',b:'child'});
    expect(drawnEnds({kind:'link',from:'a',to:'b'})).toEqual({a:'a',b:'b'});
  });
});

describe('dragging a card\'s + port (the mock\'s link gesture)',()=>{
  it('draws the temporary line from the right edge at mid-height to the pointer',()=>{
    expect(tempLinkPath({x:80,y:140,w:264,h:200},{x:700,y:300})).toBe('M344 240C424 240 620 300 700 300');
  });

  // A tiny stand-in for the DOM: an element knows its classes and attributes, and its parent.
  type Fake={cls:string[];attrs?:Record<string,string>;parent?:Fake};
  const matches=(f:Fake,selector:string)=>selector.split(',').map(s=>s.trim()).some(s=>s.startsWith('.')?f.cls.includes(s.slice(1)):s.startsWith('[')?Boolean(f.attrs?.[s.slice(1,-1).split('=')[0]]):f.cls.includes(`tag:${s}`));
  const el=(f:Fake):Element=>({
    closest:(selector:string)=>{let at:Fake|undefined=f;while(at){if(matches(at,selector))return el(at);at=at.parent;}return null;},
    getAttribute:(name:string)=>f.attrs?.[name]??null,
    __fake:f,
  }) as unknown as Element;
  const surfaceFake:Fake={cls:['canvas-surface']};
  const surface={contains:(other:Element)=>{let at:Fake|undefined=(other as unknown as {__fake:Fake}).__fake;while(at){if(at===surfaceFake)return true;at=at.parent;}return false;}} as unknown as Element;
  const world:Fake={cls:['canvas-world'],parent:surfaceFake};
  const card=(id:string):Fake=>({cls:['canvas-card'],attrs:{'data-channel-id':id},parent:world});
  const open=(id:string)=>id!=='locked';

  it('connects on another open card, anywhere inside it',()=>{
    expect(linkRelease(el({cls:['canvas-card-title'],parent:card('b')}),surface,'a',open)).toEqual({kind:'card',channelId:'b'});
  });
  it('does nothing on its own card or a card that is not open',()=>{
    expect(linkRelease(el(card('a')),surface,'a',open)).toBeNull();
    expect(linkRelease(el(card('locked')),surface,'a',open)).toBeNull();
  });
  it('counts the bare surface and an area\'s inside as empty canvas',()=>{
    expect(linkRelease(el(surfaceFake),surface,'a',open)).toEqual({kind:'empty'});
    expect(linkRelease(el({cls:['canvas-area'],parent:world}),surface,'a',open)).toEqual({kind:'empty'});
  });
  it('never counts chrome, an area\'s title bar, a line label or anything outside the surface',()=>{
    expect(linkRelease(el({cls:['tag:button'],parent:{cls:['canvas-chrome','canvas-zoom'],parent:surfaceFake}}),surface,'a',open)).toBeNull();
    expect(linkRelease(el({cls:['canvas-area-title'],parent:{cls:['canvas-area-bar'],parent:{cls:['canvas-area'],parent:world}}}),surface,'a',open)).toBeNull();
    expect(linkRelease(el({cls:['lab'],parent:world}),surface,'a',open)).toBeNull();
    expect(linkRelease(el({cls:['canvas-drawer']}),surface,'a',open)).toBeNull();
    expect(linkRelease(null,surface,'a',open)).toBeNull();
  });
});
