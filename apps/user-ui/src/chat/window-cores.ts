import type {ChannelEventsCore} from './channel-events';
import type {EventRow} from '../types';

export type WindowCores={
  acquire(channelId:string):ChannelEventsCore;
  release(channelId:string):void;
  ingest(event:EventRow):void;
  refreshAll():void;
};

// Ref-counted live cores for passive canvas chat windows: one per open channel, fed from App's realtime handler.
export function createWindowCores(create:()=>ChannelEventsCore):WindowCores{
  const held=new Map<string,{core:ChannelEventsCore;count:number}>();
  return {
    acquire(channelId){
      const existing=held.get(channelId);
      if(existing){existing.count+=1;return existing.core;}
      const core=create();
      held.set(channelId,{core,count:1});
      void core.switchTo(channelId);
      return core;
    },
    release(channelId){
      const entry=held.get(channelId);
      if(!entry)return;
      entry.count-=1;
      if(entry.count<=0)held.delete(channelId);
    },
    ingest(event){
      if(!event.channelId)return;
      const entry=held.get(event.channelId);
      if(!entry)return;
      entry.core.observeLifecycle(event);
      entry.core.ingest(event);
    },
    refreshAll(){
      for(const {core} of held.values())void core.refresh();
    },
  };
}
