export type ChatVisibility='PRIVATE'|'PUBLIC';
export type ChatSettingsDialogProps={
  label:string;archived:boolean;
  /** Sharing: the drafted visibility, saved with Save; currentVisibility is what the chat has now. */
  visibility:ChatVisibility;currentVisibility:ChatVisibility;onVisibility(value:ChatVisibility):void;saving:boolean;onSave():void;
  /** Archive acts at once: archived for everyone (read-only, hand-offs paused), or back. */
  archiving:boolean;onArchive(archived:boolean):void;
  onParticipants():void;onCopyLink():void;linkCopied:boolean;
  confirmingDelete:boolean;onConfirmDelete(confirming:boolean):void;onDelete():void;deleting:boolean;
  onClose():void;
  /** Another dialog (participants) is open on top. */
  underlay:boolean;
};

/** Chat settings: Sharing, Archive and Delete for a chat the person may manage. */
export function ChatSettingsDialog(p:ChatSettingsDialogProps) {
  const busy=p.saving||p.archiving||p.deleting;
  return <div className={`dialog-backdrop${p.underlay?' dialog-backdrop-underlay':''}`} role="presentation" onMouseDown={p.onClose}>
    <section aria-modal="true" aria-labelledby="chat-settings-title" className="conversation-dialog participants-dialog chat-settings-dialog" role="dialog" onMouseDown={event=>event.stopPropagation()}>
      <header>
        <div><span>{p.label}</span><h2 id="chat-settings-title">Chat settings</h2></div>
        <button aria-label="Close dialog" className="dialog-close" onClick={p.onClose} type="button">Close</button>
      </header>

      <section className="chat-settings-part" aria-label="Sharing">
        <h3>Sharing</h3>
        <div className="channel-manage-grid">
          <label>
            <span id="channel-visibility-label">Visibility</span>
            <select aria-labelledby="channel-visibility-label" value={p.visibility} disabled={busy}
              onChange={event=>p.onVisibility(event.target.value==='PUBLIC'?'PUBLIC':'PRIVATE')}>
              <option value="PRIVATE">Private</option>
              <option value="PUBLIC">Public</option>
            </select>
          </label>
        </div>
        <div className="channel-manage-quick-actions">
          <button type="button" className="channel-manage-secondary-button" onClick={p.onParticipants} disabled={busy}>Manage participants</button>
          <button type="button" className="channel-manage-secondary-button" onClick={p.onCopyLink} disabled={busy}>{p.linkCopied?'Link copied':'Copy share link'}</button>
        </div>
        <button className="channel-manage-save-button" type="button" onClick={p.onSave} disabled={busy||p.visibility===p.currentVisibility}>{p.saving?'Saving...':'Save'}</button>
      </section>

      <section className="chat-settings-part" aria-label="Archive">
        <h3>Archive</h3>
        <p>{p.archived?'This chat is archived: read-only for everyone, its hand-offs paused.':'Archiving makes this chat read-only for everyone and pauses its hand-offs. You can unarchive it later.'}</p>
        <button type="button" className="channel-manage-secondary-button" onClick={()=>p.onArchive(!p.archived)} disabled={busy}>
          {p.archiving?(p.archived?'Unarchiving…':'Archiving…'):p.archived?'Unarchive chat':'Archive chat'}
        </button>
      </section>

      <section className="chat-settings-part" aria-label="Delete">
        <h3>Delete</h3>
        {p.confirmingDelete?<div className="channel-manage-delete-confirm" role="group" aria-label="Confirm chat deletion">
          <p><strong>Permanently delete {p.label}?</strong> Its messages are removed for everyone and can’t be restored. To keep them read-only instead, archive it.</p>
          <div>
            <button autoFocus className="channel-manage-secondary-button" type="button" onClick={()=>p.onConfirmDelete(false)} disabled={p.deleting}>Cancel</button>
            <button className="channel-manage-delete-button" type="button" onClick={p.onDelete} disabled={p.deleting}>{p.deleting?'Deleting…':'Delete permanently'}</button>
          </div>
        </div>:<button className="channel-manage-delete-button" type="button" onClick={()=>p.onConfirmDelete(true)} disabled={busy}>Delete chat</button>}
      </section>
    </section>
  </div>;
}

/** The chat header's Archived tag, with Unarchive for people who may manage the chat. */
export function ArchivedTag({canUnarchive,onUnarchive,busy=false}:{canUnarchive:boolean;onUnarchive():void;busy?:boolean}) {
  return <span className="chat-archived">
    <span className="chat-archived-tag">Archived</span>
    {canUnarchive?<button type="button" className="chat-archived-undo" onClick={onUnarchive} disabled={busy}>Unarchive</button>:null}
  </span>;
}
