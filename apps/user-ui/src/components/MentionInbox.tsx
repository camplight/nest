import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MentionNotification, ProjectAccessNotification } from '@nest/schemas';
import { apiJson } from '../api';
import { decideProjectAccess, loadProjectAccessRequests } from '../project-access';
import { ProjectAccessRequestList } from './ProjectAccessRequestList';
import './mentions.css';

export function MentionInbox({onOpen, onProjectAccessChanged, icon, channelLabel}: {
  onOpen: (channelId: string, eventId: string) => void;
  onProjectAccessChanged: () => void;
  icon?: ReactNode;
  channelLabel?: (channelId: string, fallback: string) => string;
}) {
  const [items, setItems] = useState<MentionNotification[]>([]);
  const [requests, setRequests] = useState<ProjectAccessNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [mentionError, setMentionError] = useState(false);
  const [requestError, setRequestError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
  }, [open]);

  const loadMentions = useCallback(async () => {
    try {
      const result = await apiJson<{items: MentionNotification[]}>('/api/mentions');
      if (!Array.isArray(result.items)) throw Error('Invalid mention response');
      setItems(result.items);
      setMentionError(false);
    } catch {
      setMentionError(true);
    }
  }, []);

  const loadRequests = useCallback(async () => {
    try {
      const result = await loadProjectAccessRequests();
      if (!Array.isArray(result)) throw Error('Invalid access request response');
      setRequests(result);
      setRequestError(false);
    } catch {
      setRequestError(true);
    }
  }, []);

  const load = useCallback(() => {
    void loadMentions();
    void loadRequests();
  }, [loadMentions, loadRequests]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 30_000);
    window.addEventListener('focus', load);
    window.addEventListener('nest-message', load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener('nest-message', load);
    };
  }, [load]);

  function close() {
    dialog.current?.close();
    setOpen(false);
  }

  async function visit(item: MentionNotification) {
    setBusy(item.id);
    try {
      await apiJson(`/api/mentions/${encodeURIComponent(item.id)}/read`, {method: 'POST'});
      setItems(current => current.map(notification => notification.id === item.id ? {...notification, readAt: Date.now()} : notification));
      close();
      onOpen(item.channelId, item.id);
    } catch {
      setMentionError(true);
    } finally {
      setBusy(null);
    }
  }

  async function decide(item: ProjectAccessNotification, decision: 'approve' | 'deny') {
    setBusy(item.id);
    setRequestError(false);
    try {
      await decideProjectAccess(item.projectId, item.id, decision);
      await loadRequests();
      onProjectAccessChanged();
    } catch {
      setRequestError(true);
    } finally {
      setBusy(null);
    }
  }

  const unread = requests.length > 0 || items.some(item => !item.readAt);
  return <section className={`mention-inbox ${icon ? 'mention-inbox-header' : ''}`} aria-label="Notifications">
    <button
      className="mention-inbox-toggle"
      aria-label="Notifications"
      title="Notifications"
      aria-expanded={open}
      onClick={() => { setOpen(!open); load(); }}
    >
      {icon ?? 'Notifications'}{' '}
      {unread && <span className="mention-unread-dot" aria-label="Unread notifications"/>}
    </button>
    {open && <dialog
      ref={dialog}
      className="mention-inbox-panel"
      aria-label="Notifications"
      onCancel={event => { event.preventDefault(); close(); }}
      onClose={() => setOpen(false)}
    >
      <div className="mention-heading">Notifications <button aria-label="Close notifications" onClick={close}>×</button></div>
      <section className="notification-section" aria-labelledby="project-access-notifications-heading">
        <h3 id="project-access-notifications-heading">Project access</h3>
        {requestError && <p role="alert">Could not load project access requests. <button onClick={() => void loadRequests()}>Retry</button></p>}
        {!requestError && !requests.length && <p className="mention-empty">No pending project access requests.</p>}
        <ProjectAccessRequestList items={requests} busyId={busy} onApprove={item => void decide(item, 'approve')} onDeny={item => void decide(item, 'deny')}/>
      </section>
      <section className="notification-section" aria-labelledby="mention-notifications-heading">
        <h3 id="mention-notifications-heading">Mentions</h3>
        {mentionError && <p role="alert">Could not load mentions. <button onClick={() => void loadMentions()}>Retry</button></p>}
        {!mentionError && !items.length && <p className="mention-empty">No mentions yet. People can notify you by selecting your name from @.</p>}
        <div className="mention-inbox-items">
          {items.map(item => <button
            className={item.readAt ? 'mention-notification' : 'mention-notification unread'}
            key={item.id}
            disabled={Boolean(busy)}
            onClick={() => void visit(item)}
          >
            <strong>{item.sender} mentioned you</strong>
            <span>{channelLabel?.(item.channelId, item.channelName) ?? item.channelName}</span>
            <p>{item.text}</p>
            <small>{new Date(item.createdAt).toLocaleString()}</small>
          </button>)}
        </div>
      </section>
    </dialog>}
  </section>;
}
