// The composer picker's triggers (spec 6.9, 7.4.1): `@` keeps every mention rule, `/` opens commands only at the
// start of a line. Neither opens inside code or with a selection.
export type TriggerQuery={trigger:'@'|'/';start:number;end:number;query:string};
export function findTrigger(value:string,caret:number,selectionEnd=caret):TriggerQuery|null{
  if(caret!==selectionEnd)return null;
  const before=value.slice(0,caret);
  if((before.match(/```/g)?.length??0)%2)return null;
  if((before.split('\n').at(-1)?.match(/`/g)?.length??0)%2)return null;
  const mention=before.match(/(?:^|[\s([{])@([\p{L}\p{N}_.-]{0,64})$/u);
  if(mention)return {trigger:'@',start:caret-mention[1].length-1,end:caret,query:mention[1]};
  const command=before.match(/(?:^|\n)\/([\p{L}\p{N}_-]{0,32})$/u);
  if(command)return {trigger:'/',start:caret-command[1].length-1,end:caret,query:command[1]};
  return null;
}
