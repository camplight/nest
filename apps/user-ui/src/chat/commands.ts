// Slash commands (spec 7.4.2): each is offered only where the user may run it.
export type CommandContext={canInvite:boolean;inProject:boolean;openInvite():void;openFiles():void};
export type SlashCommand={name:'invite'|'files';label:string;available(ctx:CommandContext):boolean;run(ctx:CommandContext):void};
export const SLASH_COMMANDS:readonly SlashCommand[]=[
  {name:'invite',label:'Add people or agents to this chat',available:ctx=>ctx.canInvite,run:ctx=>ctx.openInvite()},
  {name:'files',label:'Open this project’s files',available:ctx=>ctx.inProject,run:ctx=>ctx.openFiles()},
];
/** The commands available here whose name starts with the query, in list order. */
export function matchCommands(ctx:CommandContext,query:string){
  const q=query.toLocaleLowerCase();
  return SLASH_COMMANDS.filter(command=>command.available(ctx)&&command.name.startsWith(q));
}
