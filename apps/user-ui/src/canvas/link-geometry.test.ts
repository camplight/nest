import {describe,expect,it} from 'vitest';
import {drawnEnds,linkPath,offsetReverse} from './link-geometry';

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
