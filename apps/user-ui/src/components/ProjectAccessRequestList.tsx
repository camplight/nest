import type { ProjectAccessNotification } from '@nest/schemas';

export function ProjectAccessRequestList({items, busyId, onApprove, onDeny}: {
  items: ProjectAccessNotification[];
  busyId: string | null;
  onApprove: (item: ProjectAccessNotification) => void;
  onDeny: (item: ProjectAccessNotification) => void;
}) {
  if (!items.length) return null;
  return <div className="project-access-request-list">
    {items.map(item => {
      const busy = busyId === item.id;
      return <article className="project-access-request" key={item.id}>
        <strong>{item.requesterUsername} requested access to {item.projectName}</strong>
        <p>Approval includes normal project chat and files. Personal connected-account permissions remain unchanged.</p>
        {item.projectCollaboration === 'private' && <p className="project-access-policy">Approving makes this a team project.</p>}
        {!item.requesterAvailable && <p role="status">This requester account is unavailable. You can deny the request, but approval is disabled.</p>}
        {item.status === 'approving' && <p role="status">Approval needs completion. Retry approval to reconcile confirmed membership.</p>}
        <div className="project-access-request-actions">
          <button
            type="button"
            className="dashboard-action project-primary"
            aria-label={item.status === 'approving' ? `Retry approval for ${item.requesterUsername} in ${item.projectName}` : `Approve ${item.requesterUsername} for ${item.projectName}`}
            disabled={busy || !item.requesterAvailable}
            onClick={() => onApprove(item)}
          >{item.status === 'approving' ? 'Retry approval' : 'Approve'}</button>
          {item.status === 'pending' && <button
            type="button"
            className="dashboard-action"
            aria-label={`Deny ${item.requesterUsername} for ${item.projectName}`}
            disabled={busy}
            onClick={() => onDeny(item)}
          >Deny</button>}
        </div>
        {busy && <p className="project-access-progress" role="status">Updating project access…</p>}
      </article>;
    })}
  </div>;
}
