import {useEffect, useRef, useState} from 'react';
import {Headphones} from 'lucide-react';
import type {Agent, Channel, EventRow} from '../types';

type HuddleView = typeof import('./Huddle')['default'];

export function HuddleButton(props: {channel: Channel; label: string; username: string; agents: Agent[]; events: EventRow[]; canPost: boolean}) {
  const [open, setOpen] = useState(false);
  const [Huddle, setHuddle] = useState<HuddleView | null>(null), [failed, setFailed] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const close = () => {setOpen(false); window.requestAnimationFrame(() => launcher.current?.focus());};
  useEffect(() => {
    if (!open || Huddle) return;
    let current = true; setFailed(false);
    void import('./Huddle').then(module => {if (current) setHuddle(() => module.default);}).catch(() => {if (current) setFailed(true);});
    return () => {current = false;};
  }, [open, Huddle]);
  return <>
    <button ref={launcher} type="button" className="huddle-launch" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Headphones size={17} aria-hidden="true"/>Huddle</button>
    {open && (Huddle ? <Huddle {...props} onClose={close}/> : <div className="huddle-load-notice" role={failed ? 'alert' : 'status'}>
      <span>{failed ? 'Huddle couldn’t load. Refresh the page to try again.' : 'Loading huddle…'}</span>
      {failed && <button type="button" onClick={() => window.location.reload()}>Refresh page</button>}
      <button type="button" onClick={close}>Cancel</button>
    </div>)}
  </>;
}
