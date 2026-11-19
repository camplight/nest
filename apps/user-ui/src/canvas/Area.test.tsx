import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CanvasArea} from '@nest/schemas';
import {Area,type AreaProps} from './Area';

const area:CanvasArea={id:'a1',canvasId:'cv',title:'Autumn Retreat',x:0,y:0,w:600,h:400,tint:'moss',version:0};
const render=(props:Partial<AreaProps>)=>renderToStaticMarkup(<Area area={area} dx={0} dy={0} w={600} h={400} canEdit compact={false} onRename={()=>{}} onDelete={()=>{}} {...props}/>);

describe('Area + Chat',()=>{
  it('offers editors a new chat in the area',()=>{
    const html=render({onNewChat:()=>{}});
    expect(html).toContain('canvas-area-new');
    expect(html).toContain('aria-label="New chat in Autumn Retreat"');
  });
  it('hides it from viewers, at far zoom and without a handler',()=>{
    expect(render({canEdit:false,onNewChat:()=>{}})).not.toContain('canvas-area-new');
    expect(render({compact:true,onNewChat:()=>{}})).not.toContain('canvas-area-new');
    expect(render({})).not.toContain('canvas-area-new');
  });
});
