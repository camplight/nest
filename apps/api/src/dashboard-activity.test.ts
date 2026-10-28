import {it,expect} from 'vitest';
import {dashboardActivity} from './dashboard-activity';
const channel={id:'chat',name:'Chat'};
const agent={name:'Builder'};
const event=(type:string,createdAt:number,triggerEventId='trigger',channelId='chat')=>({id:type+createdAt,type,createdAt,source:'agent:Builder',channelId,payload:{triggerEventId}});
it('pairs completed and failed turns without confusing online agents with work',()=>{
 expect(dashboardActivity([], [agent],[channel]).runs).toEqual([]);
 const events=[event('agent.turn.started',10),event('agent.turn.completed',20),event('agent.turn.started',30,'next')];
 expect(dashboardActivity(events,[agent],[channel],40).runs).toEqual([expect.objectContaining({agent:'Builder',startedAt:30,state:'working'})]);
 expect(dashboardActivity([...events,event('agent.turn.failed',40,'next')],[agent],[channel],50).runs).toEqual([]);
});
it('preserves simultaneous chats and visible shared-agent turns',()=>{
 expect(dashboardActivity([event('agent.turn.started',10),event('agent.turn.started',20,'second','other')],[],[channel,{id:'other'}],30).runs).toHaveLength(2);
});
it('handles equal timestamps, stopped agents, archived and inaccessible chats',()=>{
 expect(dashboardActivity([event('agent.turn.completed',10),event('agent.turn.started',10)],[agent],[channel],20).runs).toEqual([]);
 expect(dashboardActivity([event('agent.turn.started',10)],[{...agent,desiredState:'STOPPED',updatedAt:11}],[channel],20).runs).toEqual([]);
 expect(dashboardActivity([event('agent.turn.started',10)],[agent],[{...channel,archivedAt:1}],20).runs).toEqual([]);
 expect(dashboardActivity([event('agent.turn.started',10)],[agent],[],20).runs).toEqual([]);
});
it('marks missing fresh telemetry instead of promising a stale run is working',()=>{
 expect(dashboardActivity([event('agent.turn.started',10)],[agent],[channel],200000).runs[0].state).toBe('unconfirmed');
 expect(dashboardActivity([event('agent.turn.started',10)],[{...agent,lastHeartbeatAt:199999}],[channel],200000).runs[0].state).toBe('working');
});
it('marks bounded history and drops an ambiguous timestamp boundary',()=>{
 const events=Array.from({length:1000},(_,i)=>event('agent.turn.started',10,'trigger'+i));
 expect(dashboardActivity(events,[agent],[channel],20)).toMatchObject({limited:true,runs:[]});
});
