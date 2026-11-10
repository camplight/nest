import {describe,expect,it} from 'vitest';
import {droppedFiles} from './file-drop';

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
