// Up to three initials of the people a canvas is shared with (membership, not presence), then `+N`.
import type {CanvasMembers} from './api';

const MAX_SHOWN = 3;
type Member = CanvasMembers['members'][number];

export function avatarPeople(members: readonly Member[], viewerId: string): {shown: Member[]; more: number} {
  const others = members.filter(member => member.humanId !== viewerId);
  return {shown: others.slice(0, MAX_SHOWN), more: Math.max(0, others.length - MAX_SHOWN)};
}

export function ShareAvatars({members, viewerId}: {members: readonly Member[]; viewerId: string}) {
  const {shown, more} = avatarPeople(members, viewerId);
  if (!shown.length) return null;
  return <span className="canvas-share-avatars" title="People with access" role="img" aria-label={`People with access: ${shown.map(m => m.username).join(', ')}${more ? ` and ${more} more` : ''}`}>
    {shown.map(member => <span key={member.humanId} className="canvas-share-avatar" aria-hidden="true">{member.username.slice(0, 1).toUpperCase()}</span>)}
    {more ? <span className="canvas-share-more" aria-hidden="true">+{more}</span> : null}
  </span>;
}
