import {lazy, Suspense, useRef, useState} from 'react';
import {Headphones} from 'lucide-react';
import type {Agent, Channel, EventRow} from '../types';

const Huddle = lazy(() => import('./Huddle'));

export function HuddleButton(props: {channel: Channel; label: string; username: string; agents: Agent[]; events: EventRow[]; canPost: boolean}) {
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const close = () => {setOpen(false); window.requestAnimationFrame(() => launcher.current?.focus());};
  return <>
    <button ref={launcher} type="button" className="huddle-launch" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Headphones size={17} aria-hidden="true"/>Huddle</button>
    {open && <Suspense fallback={<p className="notice" role="status">Loading huddle…</p>}><Huddle {...props} onClose={close}/></Suspense>}
  </>;
}
