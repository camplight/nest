import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {droppedFiles,insideActiveCanvasChat,outsideCanvasChat} from './file-drop';

const item=(file:File|null,directory=false)=>({kind:'file',getAsFile:()=>file,webkitGetAsEntry:()=>({isDirectory:directory})});
const data=(items:unknown[],files:File[]=[])=>({items,files}) as unknown as DataTransfer;

describe('droppedFiles',()=>{
  it('keeps files and reports that a folder was left out',()=>{
    const a=new File(['a'],'a.txt');
    expect(droppedFiles(data([item(a),item(null,true)]))).toEqual({files:[a],folders:true});
  });
  it('reports a folder-only drop as no files',()=>{
    expect(droppedFiles(data([item(null,true)]))).toEqual({files:[],folders:true});
  });
  it('falls back to the file list without items',()=>{
    const a=new File(['a'],'a.txt');
    expect(droppedFiles(data([],[a]))).toEqual({files:[a],folders:false});
  });
});

// The node test run has no DOM: a stand-in Element whose closest() matches the selectors these helpers ask about.
describe('which drop zone takes a drop',()=>{
  class FakeElement{constructor(private readonly classes:string[][]){}
    closest(selector:string){
      const wants=selector.split(',').map(part=>part.trim());
      const hit=(chain:string[])=>wants.some(want=>{
        const [base,...nots]=want.split(':not(');
        const required=base.split('.').filter(Boolean);
        const banned=nots.map(not=>not.replace(/[).]/g,''));
        return required.every(name=>chain.includes(name))&&banned.every(name=>!chain.includes(name));
      });
      return this.classes.some(hit)?this:null;
    }
  }
  beforeEach(()=>{vi.stubGlobal('Element',FakeElement);});
  afterEach(()=>{vi.unstubAllGlobals();});
  const inside=(...ancestors:string[][])=>new FakeElement(ancestors) as unknown as EventTarget;
  it('leaves a passive window to its own drop handler',()=>{
    const target=inside(['canvas-chat','is-passive']);
    expect(insideActiveCanvasChat(target)).toBe(false);
    expect(outsideCanvasChat(target)).toBe(false);
  });
  it('gives the active window to the app drop zone and keeps the bottom box out',()=>{
    const target=inside(['canvas-chat']);
    expect(insideActiveCanvasChat(target)).toBe(true);
    expect(outsideCanvasChat(target)).toBe(false);
  });
  it('gives the bottom box every drop outside chats and drop targets',()=>{
    expect(outsideCanvasChat(inside(['canvas']))).toBe(true);
    expect(outsideCanvasChat(inside(['canvas-card']))).toBe(false);
  });
});
