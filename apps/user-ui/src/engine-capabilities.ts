import {useEffect,useState} from 'react';
import {apiJson} from './api';

/** Engine features Nest turns on only when the running OrgOps declares them. */
export type EngineCapabilities={cancelTurn:boolean};
export const NO_CAPABILITIES:EngineCapabilities={cancelTurn:false};

/** Reads capabilities from the engine's declared event types; an unknown or failed answer means none. */
export function capabilitiesFrom(response:unknown):EngineCapabilities{
  const types=(response as {eventTypes?:unknown})?.eventTypes;
  const names=new Set(Array.isArray(types)?types.map(type=>(type as {type?:unknown})?.type).filter((name):name is string=>typeof name==='string'):[]);
  return {cancelTurn:names.has('agent.turn.cancel_requested')};
}

let pending:Promise<EngineCapabilities>|null=null;
export function loadEngineCapabilities(load:()=>Promise<unknown>=()=>apiJson('/api/event-types')):Promise<EngineCapabilities>{
  pending??=load().then(capabilitiesFrom,()=>{pending=null;return NO_CAPABILITIES;});
  return pending;
}

export function useEngineCapabilities(enabled:boolean):EngineCapabilities{
  const [capabilities,setCapabilities]=useState(NO_CAPABILITIES);
  useEffect(()=>{
    if(!enabled)return;
    let live=true;
    void loadEngineCapabilities().then(value=>{if(live)setCapabilities(value);});
    return()=>{live=false;};
  },[enabled]);
  return capabilities;
}
