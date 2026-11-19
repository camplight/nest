import {describe,expect,it} from 'vitest';
import {mergeChatFiles} from './ChatFilesBridge';

const a=new File(['a'],'a.txt'),b=new File(['b'],'b.txt');

describe('mergeChatFiles',()=>{
  it('starts a drop with the way it was dropped',()=>{
    expect(mergeChatFiles(null,'c1',[a],true)).toEqual({channelId:'c1',files:[a],autoSend:true});
    expect(mergeChatFiles(null,'c1',[a],false)).toEqual({channelId:'c1',files:[a],autoSend:false});
  });
  it('joins files for the same chat and sends itself only if every drop asked to',()=>{
    expect(mergeChatFiles({channelId:'c1',files:[a],autoSend:true},'c1',[b],true)).toEqual({channelId:'c1',files:[a,b],autoSend:true});
    expect(mergeChatFiles({channelId:'c1',files:[a],autoSend:true},'c1',[b],false)).toEqual({channelId:'c1',files:[a,b],autoSend:false});
  });
  it('replaces a drop for another chat',()=>{
    expect(mergeChatFiles({channelId:'c1',files:[a],autoSend:false},'c2',[b],true)).toEqual({channelId:'c2',files:[b],autoSend:true});
  });
});
