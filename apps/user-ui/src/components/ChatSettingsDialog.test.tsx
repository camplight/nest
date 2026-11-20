import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ArchivedTag,ChatSettingsDialog,type ChatSettingsDialogProps} from './ChatSettingsDialog';

const noop=()=>{};
const props=(over:Partial<ChatSettingsDialogProps>={}):ChatSettingsDialogProps=>({
  label:'Weekly metrics',archived:false,visibility:'PRIVATE',currentVisibility:'PRIVATE',onVisibility:noop,saving:false,onSave:noop,
  archiving:false,onArchive:noop,onParticipants:noop,onCopyLink:noop,linkCopied:false,
  confirmingDelete:false,onConfirmDelete:noop,onDelete:noop,deleting:false,onClose:noop,underlay:false,...over,
});
const text=(html:string)=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');

describe('ChatSettingsDialog',()=>{
  it('is titled Chat settings with Sharing, Archive and Delete in that order',()=>{
    const html=renderToStaticMarkup(<ChatSettingsDialog {...props()}/>);
    expect(html).toContain('<h2 id="chat-settings-title">Chat settings</h2>');
    const parts=[...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map(m=>m[1]);
    expect(parts).toEqual(['Sharing','Archive','Delete']);
    expect(html).not.toMatch(/type="checkbox"/);
    expect(text(html)).not.toContain('Manage channel');
  });
  it('archives an active chat at once and says what that does',()=>{
    const html=text(renderToStaticMarkup(<ChatSettingsDialog {...props()}/>));
    expect(html).toContain('Archive chat');
    expect(html).toContain('Archiving makes this chat read-only for everyone and pauses its hand-offs. You can unarchive it later.');
  });
  it('offers Unarchive chat for an archived chat',()=>{
    const html=text(renderToStaticMarkup(<ChatSettingsDialog {...props({archived:true})}/>));
    expect(html).toContain('Unarchive chat');
    expect(html).toContain('This chat is archived: read-only for everyone, its hand-offs paused.');
  });
  it('keeps Save off until the visibility changes',()=>{
    expect(renderToStaticMarkup(<ChatSettingsDialog {...props()}/>)).toMatch(/<button[^>]*class="channel-manage-save-button"[^>]*disabled/);
    expect(renderToStaticMarkup(<ChatSettingsDialog {...props({visibility:'PUBLIC'})}/>)).not.toMatch(/<button[^>]*class="channel-manage-save-button"[^>]*disabled/);
  });
});

describe('ArchivedTag',()=>{
  it('shows Unarchive only to people who may manage the chat',()=>{
    const allowed=renderToStaticMarkup(<ArchivedTag canUnarchive onUnarchive={noop}/>);
    expect(text(allowed)).toContain('Archived');expect(allowed).toMatch(/<button[^>]*>Unarchive<\/button>/);
    const view=renderToStaticMarkup(<ArchivedTag canUnarchive={false} onUnarchive={noop}/>);
    expect(text(view)).toContain('Archived');expect(view).not.toContain('<button');
  });
});
