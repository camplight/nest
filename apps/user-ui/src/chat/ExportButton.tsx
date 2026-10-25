// Export the loaded chat as Markdown (spec 7.5.2): messages with authors, times and attachment links, activity as one
// count line. Mounted in the toolbar row above the viewport inside .nest-chat; renders nothing for an empty chat.
import {DownloadIcon} from 'lucide-react';
import {chatToMarkdown} from './export';
import type {TimelineItem} from './timeline';
import {Button} from './ui/button';

const fileName=(label:string)=>`${label.replace(/[\\/:*?"<>|]+/g,'-').trim()||'chat'}.md`;

export function ExportButton({items,channelLabel}:{items:readonly TimelineItem[];channelLabel:string}):JSX.Element|null{
 if(items.length===0)return null;
 const download=()=>{
  const url=URL.createObjectURL(new Blob([chatToMarkdown(items,{channelLabel})],{type:'text/markdown'}));
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download=fileName(channelLabel);
  anchor.click();
  // The download has started from the click; release the blob on the next task.
  setTimeout(()=>URL.revokeObjectURL(url),0);
 };
 return <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={download}>
  <DownloadIcon aria-hidden="true"/>Export chat
 </Button>;
}
