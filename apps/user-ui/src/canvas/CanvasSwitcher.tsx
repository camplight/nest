// Top-bar canvas menu: Yours / Shared with you, New canvas, and the owner's Rename and Delete canvas….
import {useEffect,useId,useRef,useState,type FormEvent,type KeyboardEvent as ReactKeyboardEvent,type ReactNode} from 'react';
import type {Canvas} from '@nest/schemas';

export type SwitcherCanvas = Pick<Canvas, 'id' | 'name' | 'role'>;
const ROLE_BADGE = {edit: 'Can edit', view: 'Can view'} as const;
const SAVE_FAILED = 'Could not save that. Try again.';

type SwitcherProps = {
  canvases: Canvas[];
  current: SwitcherCanvas | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSelect(id: string): void;
  onCreate(name: string): Promise<void>;
  onRename(name: string): Promise<void>;
  onDelete(): Promise<void>;
};
type Action = 'create' | 'rename' | 'delete' | null;

export function CanvasSwitcher({canvases, current, open, onOpenChange, onSelect, onCreate, onRename, onDelete}: SwitcherProps) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [action, setAction] = useState<Action>(null);
  const closeRef = useRef(onOpenChange); closeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) closeRef.current(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[aria-modal="true"]:not(.canvas-chat)')) return;
      event.preventDefault();
      closeRef.current(false);
      trigger.current?.focus({preventScroll: true});
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); };
  }, [open]);

  const yours = canvases.filter(c => c.role === 'owner');
  const shared = canvases.filter(c => c.role !== 'owner');
  const item = (canvas: Canvas) => <li key={canvas.id} role="none">
    <button type="button" role="menuitem" className="canvas-menu-item" aria-current={canvas.id === current?.id ? 'true' : undefined}
      onClick={() => { onOpenChange(false); if (canvas.id !== current?.id) onSelect(canvas.id); }}>
      <span className="canvas-menu-name">{canvas.name}</span>
      {canvas.role !== 'owner' ? <span className="canvas-menu-badge">{ROLE_BADGE[canvas.role]}</span> : null}
    </button>
  </li>;
  const choose = (next: Action) => { onOpenChange(false); setAction(next); };
  const done = () => { setAction(null); trigger.current?.focus({preventScroll: true}); };

  return <div className="canvas-switcher-root" ref={root}>
    <button ref={trigger} type="button" className="canvas-switcher" aria-label="Switch canvas" aria-haspopup="menu" aria-expanded={open}
      onClick={() => onOpenChange(!open)}>Canvases <span aria-hidden="true">▾</span></button>
    {open ? <div className="canvas-menu" role="menu" aria-label="Canvases">
      <p className="canvas-menu-group" role="presentation">Yours</p>
      {yours.length ? <ul role="none">{yours.map(item)}</ul> : <p className="canvas-menu-empty" role="presentation">No canvases of your own yet.</p>}
      {shared.length ? <>
        <p className="canvas-menu-group" role="presentation">Shared with you</p>
        <ul role="none">{shared.map(item)}</ul>
      </> : null}
      <div className="canvas-menu-actions" role="none">
        <button type="button" role="menuitem" className="canvas-menu-item" onClick={() => choose('create')}>New canvas</button>
        {current?.role === 'owner' ? <>
          <button type="button" role="menuitem" className="canvas-menu-item" onClick={() => choose('rename')}>Rename</button>
          <button type="button" role="menuitem" className="canvas-menu-item is-danger" onClick={() => choose('delete')}>Delete canvas…</button>
        </> : null}
      </div>
    </div> : null}
    {action === 'create' ? <NameDialog title="New canvas" submit="Create canvas" initial="" placeholder="Launch" onSubmit={onCreate} onClose={done}/> : null}
    {action === 'rename' && current ? <NameDialog title="Rename canvas" submit="Rename" initial={current.name} onSubmit={onRename} onClose={done}/> : null}
    {action === 'delete' && current ? <ConfirmDialog title="Delete canvas" submit="Delete canvas" onSubmit={onDelete} onClose={done}>
      Delete canvas "{current.name}"? The chats on it are not deleted.
    </ConfirmDialog> : null}
  </div>;
}

/** A small modal: Escape and Cancel close it; focus starts on the first field. */
export function Modal({label, onClose, children}: {label: string; onClose(): void; children: ReactNode}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    // Focus goes back to what opened the dialog, when that is still on the page.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (panel.current?.querySelector<HTMLElement>('input,select,button:not([data-close])') ?? panel.current)?.focus({preventScroll: true});
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (opener?.isConnected) opener.focus({preventScroll: true});
    };
  }, []);
  // Tab and Shift+Tab wrap between the first and last control.
  const trap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>('input,select,button,textarea,[tabindex]:not([tabindex="-1"])')].filter(el => !(el as HTMLInputElement).disabled);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (active === panel.current || !panel.current.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="canvas-modal-backdrop" onKeyDown={trap} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} className="canvas-modal" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>{children}</div>
  </div>;
}

function useSubmit(run: () => Promise<void>, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await run(); if (mounted.current) onClose(); } catch { if (mounted.current) { setError(SAVE_FAILED); setBusy(false); } }
  }
  return {busy, error, submit};
}

function NameDialog({title, submit: submitLabel, initial, placeholder, onSubmit, onClose}: {
  title: string; submit: string; initial: string; placeholder?: string; onSubmit(name: string): Promise<void>; onClose(): void;
}) {
  const [name, setName] = useState(initial);
  const field = useId();
  const {busy, error, submit} = useSubmit(() => onSubmit(name.trim()), onClose);
  return <Modal label={title} onClose={onClose}>
    <form onSubmit={submit}>
      <h2>{title}</h2>
      <label htmlFor={field}>Canvas name</label>
      <input id={field} value={name} maxLength={120} placeholder={placeholder} onChange={event => setName(event.target.value)}/>
      {error ? <p className="canvas-error" role="alert">{error}</p> : null}
      <div className="canvas-modal-actions">
        <button type="button" data-close className="canvas-modal-cancel" onClick={onClose}>Cancel</button>
        <button type="submit" className="canvas-button" disabled={!name.trim() || busy}>{submitLabel}</button>
      </div>
    </form>
  </Modal>;
}

function ConfirmDialog({title, submit: submitLabel, onSubmit, onClose, children}: {title: string; submit: string; onSubmit(): Promise<void>; onClose(): void; children: ReactNode}) {
  const {busy, error, submit} = useSubmit(onSubmit, onClose);
  return <Modal label={title} onClose={onClose}>
    <h2>{title}</h2>
    <p>{children}</p>
    {error ? <p className="canvas-error" role="alert">{error}</p> : null}
    <div className="canvas-modal-actions">
      <button type="button" data-close className="canvas-modal-cancel" onClick={onClose}>Cancel</button>
      <button type="button" className="canvas-button is-danger" disabled={busy} onClick={() => void submit()}>{submitLabel}</button>
    </div>
  </Modal>;
}
