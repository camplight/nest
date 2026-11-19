import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CanvasBoard} from '@nest/schemas';
import {PHONE_VIEW_KEY,canvasChrome,phoneView} from './phone-view';
import {PhoneViewToggle} from './PhoneList';
import {Surface} from './Surface';

const board:CanvasBoard={
  canvas:{id:'cv',ownerId:'h',name:'Launch',visibility:'private',version:1,createdAt:0,updatedAt:0,role:'owner'} as CanvasBoard['canvas'],
  areas:[{id:'a1',canvasId:'cv',title:'Research',x:0,y:0,w:800,h:500,tint:'pip',version:0}],
  cards:[{canvasId:'cv',channelId:'c1',x:40,y:80,w:280,version:0,placedBy:'h',placedAt:0,access:'locked',ownerLabel:'owner'}],
  links:[],etag:'e',
};

describe('phone view',()=>{
  it('shows the canvas unless the list was chosen',()=>{
    expect(PHONE_VIEW_KEY).toBe('nest-canvas-phone-view');
    expect(phoneView(null)).toBe('canvas');
    expect(phoneView('')).toBe('canvas');
    expect(phoneView('grid')).toBe('canvas');
    expect(phoneView('canvas')).toBe('canvas');
    expect(phoneView('list')).toBe('list');
  });

  it('hides the legend and zoom buttons on a phone canvas, and keeps the drawer, Needs you and the List toggle',()=>{
    expect(canvasChrome(true,'canvas',false)).toEqual({list:false,legend:false,zoom:false,drawer:true,needsButton:true,viewToggle:true});
    expect(canvasChrome(true,'list',false)).toEqual({list:true,legend:false,zoom:false,drawer:false,needsButton:false,viewToggle:true});
    expect(canvasChrome(false,'list',false)).toEqual({list:false,legend:true,zoom:true,drawer:true,needsButton:true,viewToggle:false});
    expect(canvasChrome(false,'canvas',true).legend).toBe(false);
  });
});

describe('the phone canvas',()=>{
  it('renders the surface without zoom buttons',()=>{
    const html=renderToStaticMarkup(<Surface board={board} humanId="" onApply={async()=>true} zoomButtons={false}/>);
    expect(html).toContain('canvas-surface');
    expect(html).toContain('Research');
    expect(html).toContain('aria-label="Canvas tools"');
    expect(html).not.toContain('canvas-zoom');
    expect(html).not.toContain('Zoom in');
    expect(html).not.toContain('canvas-legend');
    // The desktop keeps them.
    expect(renderToStaticMarkup(<Surface board={board} humanId="" onApply={async()=>true}/>)).toContain('aria-label="Zoom in"');
  });

  it('has a List toggle that says whether the list is shown',()=>{
    const canvas=renderToStaticMarkup(<PhoneViewToggle view="canvas" onChange={()=>{}}/>);
    expect(canvas).toMatch(/<button[^>]*aria-pressed="false"[^>]*>List<\/button>/);
    const list=renderToStaticMarkup(<PhoneViewToggle view="list" onChange={()=>{}}/>);
    expect(list).toMatch(/<button[^>]*aria-pressed="true"[^>]*>List<\/button>/);
  });
});
