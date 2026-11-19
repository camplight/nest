import {describe,expect,it} from 'vitest';
import {capabilitiesFrom} from './engine-capabilities';

describe('engine capabilities',()=>{
  it('turns on Stop when the engine declares turn cancellation',()=>{
    expect(capabilitiesFrom({eventTypes:[{type:'message.created'},{type:'agent.turn.cancel_requested'}]})).toEqual({cancelTurn:true});
  });
  it('leaves Stop off for an engine without it or an unexpected answer',()=>{
    expect(capabilitiesFrom({eventTypes:[{type:'message.created'}]})).toEqual({cancelTurn:false});
    expect(capabilitiesFrom({error:'Forbidden'})).toEqual({cancelTurn:false});
    expect(capabilitiesFrom(null)).toEqual({cancelTurn:false});
  });
});
