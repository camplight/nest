// Link lines between cards and their labels (the mock's renderLinks): `.lk` lines under the cards, a moving `.lk-flow`
// over each line that is on, and a `.lab` pill at each line's midpoint that opens the Hand-off popover, or, on a fork's
// line, pauses and resumes its findings. A link the viewer cannot read either chat of is a bare line with no label.
import {memo,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {linkLabel,type BoardLink} from '@nest/schemas';
import type {Point,Rect} from './geometry';
import {drawnEnds,linkPath,offsetReverse} from './link-geometry';

export type LinksProps = {
  links: readonly BoardLink[];
  /** Each card's rect on the canvas (with any drag preview applied), by channel id. */
  rects: ReadonlyMap<string, Rect>;
  /** The selected card: lines touching it are highlighted (`.hl`). */
  selected: string | null;
  /** A link's label was pressed: open its Hand-off popover under that label. */
  onOpen(linkId: string, anchor: HTMLElement): void;
  /** A fork's label was pressed: findings stop or start flowing back, with no popover. */
  onToggleFork(linkId: string): void;
};

export const LINK_TITLE = 'Click to change what passes along, when, and to whom';
export const FORK_ON_TITLE = 'Findings flow back · click to pause';
export const FORK_OFF_TITLE = 'Paused · click to reconnect';

/** The mock's FORK_IC. */
export function ForkIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11.5 7"/>
  </svg>;
}

/** The mock's IC_LINK: two chats with an arrow between them, on the connect buttons and the Setup line. */
export function LinkIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="5.5" cy="12" r="2.5"/><circle cx="18.5" cy="12" r="2.5"/><path d="M8 12h4.5M10.5 9l3 3-3 3"/>
  </svg>;
}

/** A path's midpoint by length (the mock's getPointAtLength(len / 2)). */
export function labelPoint(path: SVGPathElement): Point {
  const point = path.getPointAtLength(path.getTotalLength() / 2);
  return {x: point.x, y: point.y};
}
const samePoints = (a: ReadonlyMap<string, Point>, b: ReadonlyMap<string, Point>) =>
  a.size === b.size && [...a].every(([id, p]) => b.get(id)?.x === p.x && b.get(id)?.y === p.y);

export const Links = memo(function Links({links, rects, selected, onOpen, onToggleFork}: LinksProps) {
  const lines = useMemo(() => {
    const drawn = links.flatMap(link => {
      const {a, b} = drawnEnds(link), A = rects.get(a), B = rects.get(b);
      return A && B ? [{link, a, b, A, B}] : [];
    });
    const offsets = offsetReverse(drawn.map(d => ({id: d.link.id, from: d.a, to: d.b})));
    return drawn.map(({link, a, b, A, B}) => {
      const off = offsets.get(link.id) ?? 0;
      return {link, d: linkPath({...A, y: A.y + off}, {...B, y: B.y + off}), hl: selected !== null && (a === selected || b === selected)};
    });
  }, [links, rects, selected]);

  // Labels sit on each drawn path's midpoint, measured once the paths are in the DOM.
  const paths = useRef(new Map<string, SVGPathElement>());
  const [points, setPoints] = useState<ReadonlyMap<string, Point>>(new Map());
  useLayoutEffect(() => {
    const next = new Map<string, Point>();
    for (const {link} of lines) {
      const path = paths.current.get(link.id);
      if (link.access === 'open' && path && typeof path.getTotalLength === 'function') next.set(link.id, labelPoint(path));
    }
    setPoints(current => samePoints(current, next) ? current : next);
  }, [lines]);

  return <>
    <svg className="canvas-links" width="1" height="1" aria-hidden="true">
      {lines.map(({link, d, hl}) => {
        const open = link.access === 'open';
        const classes = ['lk', open ? (link.on ? 'on' : 'off') : '', link.kind === 'fork' ? 'fork' : '', hl ? 'hl' : ''].filter(Boolean).join(' ');
        return <g key={link.id}>
          <path ref={element => { if (element) paths.current.set(link.id, element); else paths.current.delete(link.id); }}
            className={classes} d={d} data-link-id={link.id}/>
          {open && link.on ? <path className="lk-flow" d={d}/> : null}
        </g>;
      })}
    </svg>
    {lines.map(({link}) => {
      if (link.access !== 'open') return null;
      const at = points.get(link.id);
      if (!at) return null;
      const fork = link.kind === 'fork';
      return <button key={link.id} type="button" className={`lab${link.on ? '' : ' off'}`} data-link-id={link.id} style={{left: at.x, top: at.y}}
        title={fork ? (link.on ? FORK_ON_TITLE : FORK_OFF_TITLE) : LINK_TITLE} aria-haspopup={fork ? undefined : 'dialog'}
        onClick={event => fork ? onToggleFork(link.id) : onOpen(link.id, event.currentTarget)}>
        {fork ? <ForkIcon/> : <i aria-hidden="true"/>}{linkLabel(link)}
      </button>;
    })}
  </>;
});
