export type ManagementContext = {agentName:string;channelId:string;triggerEventId:string};
export type ManagementClaims = ManagementContext & {v:1};
export function createManagementCapability(context:ManagementContext,key:string):string;
export function verifyManagementCapability(token:string,key:string,agentName:string):ManagementClaims|null;
export function managementEnvironment(env:Record<string,string|undefined>):{NEST_MANAGEMENT_TOKEN:string;NEST_MANAGEMENT_URL:string};
