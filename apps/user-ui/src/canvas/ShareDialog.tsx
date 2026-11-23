// Owner-only sharing: Private or chosen people, each with Can edit / Can view. Save calls putMembers.
import {useEffect,useId,useMemo,useState} from 'react';
import {MAX_MEMBERS,type CanvasVisibility} from '@nest/schemas';
import {getMembers,putMembers,withFreshVersion} from './api';
import {Modal} from './CanvasSwitcher';

export type SharePerson = {id?: string; username: string};
type Role = 'edit' | 'view';
const SEARCH_ABOVE = 8;

type ShareProps = {
  canvasId: string;
  ownerId: string;
  /** App's people; the owner is left out. */
  humans: SharePerson[];
  /** The canvas version now, and re-read after a conflict (null when the canvas is gone). */
  version(): number;
  freshVersion(): Promise<number | null>;
  onSaved(): void;
  onClose(): void;
};

export function ShareDialog({canvasId, ownerId, humans, version, freshVersion, onSaved, onClose}: ShareProps) {
  const [visibility, setVisibility] = useState<CanvasVisibility | null>(null);
  const [roles, setRoles] = useState<Map<string, Role>>(new Map());
  const [known, setKnown] = useState<{id: string; username: string}[]>([]);
  const [query, setQuery] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const group = useId();

  useEffect(() => {
    let current = true;
    getMembers(canvasId).then(result => {
      if (!current) return;
      setVisibility(result.visibility);
      setRoles(new Map(result.members.flatMap(m => m.role === 'edit' || m.role === 'view' ? [[m.humanId, m.role] as const] : [])));
      setKnown(result.members.map(m => ({id: m.humanId, username: m.username})));
    }).catch(() => { if (current) setLoadFailed(true); });
    return () => { current = false; };
  }, [canvasId]);

  // Everyone App knows, plus anyone already a member who it does not list.
  const people = useMemo(() => {
    const byId = new Map<string, string>();
    for (const person of humans) if (person.id && person.id !== ownerId) byId.set(person.id, person.username);
    for (const person of known) if (person.id !== ownerId && !byId.has(person.id)) byId.set(person.id, person.username);
    return [...byId].map(([id, username]) => ({id, username})).sort((a, b) => a.username.localeCompare(b.username));
  }, [humans, known, ownerId]);
  const shown = people.filter(person => person.username.toLowerCase().includes(query.trim().toLowerCase()));
  // The server takes at most 30 members: at the cap, only chosen people can still be changed.
  const chosen = [...roles.keys()].filter(id => people.some(p => p.id === id)).length;
  const full = chosen >= MAX_MEMBERS;
  const capId = useId();

  const setRole = (id: string, role: Role | null) => setRoles(current => {
    const next = new Map(current);
    if (role) next.set(id, role); else next.delete(id);
    return next;
  });
  async function save() {
    if (!visibility || busy) return;
    setBusy(true); setError('');
    const members = visibility === 'private' ? [] : [...roles].filter(([id]) => people.some(p => p.id === id)).map(([humanId, role]) => ({humanId, role}));
    try {
      await withFreshVersion(version(), freshVersion, v => putMembers(canvasId, {visibility, members, version: v}));
      onSaved();
      onClose();
    } catch {
      setError('Could not save sharing. Try again.');
      setBusy(false);
    }
  }

  return <Modal label="Share canvas" onClose={onClose}>
    <h2>Share canvas</h2>
    {loadFailed ? <p className="canvas-error" role="alert">Could not load sharing. Close this and try again.</p> : !visibility ? <p>Loading…</p> : <>
      <div role="radiogroup" aria-label="Visibility" className="canvas-share-visibility">
        <label><input type="radio" name={group} checked={visibility === 'private'} onChange={() => setVisibility('private')}/>Private</label>
        <label><input type="radio" name={group} checked={visibility === 'shared'} onChange={() => setVisibility('shared')}/>Shared with chosen people</label>
      </div>
      {visibility === 'shared' ? <div className="canvas-share-people">
        {people.length > SEARCH_ABOVE ? <input type="search" aria-label="Search people" placeholder="Search people" value={query} onChange={event => setQuery(event.target.value)}/> : null}
        {full ? <p id={capId} className="canvas-share-cap">Up to {MAX_MEMBERS} people.</p> : null}
        {shown.length ? <ul aria-label="People">
          {shown.map(person => {
            const role = roles.get(person.id);
            return <li key={person.id}>
              <label><input type="checkbox" checked={Boolean(role)} disabled={full && !role} aria-describedby={full && !role ? capId : undefined}
                onChange={event => setRole(person.id, event.target.checked ? 'view' : null)}/>{person.username}</label>
              <select aria-label={`Access for ${person.username}`} value={role ?? 'view'} disabled={!role} onChange={event => setRole(person.id, event.target.value as Role)}>
                <option value="edit">Can edit</option>
                <option value="view">Can view</option>
              </select>
            </li>;
          })}
        </ul> : <p className="canvas-menu-empty">{people.length ? 'No one matches.' : 'There is no one else to share with yet.'}</p>}
      </div> : null}
      <p className="canvas-share-note">Sharing covers the layout and areas. Each chat keeps its own access.</p>
      {error ? <p className="canvas-error" role="alert">{error}</p> : null}
      <div className="canvas-modal-actions">
        <button type="button" data-close className="canvas-modal-cancel" onClick={onClose}>Cancel</button>
        <button type="button" className="canvas-button" disabled={busy} onClick={() => void save()}>Save</button>
      </div>
    </>}
  </Modal>;
}
