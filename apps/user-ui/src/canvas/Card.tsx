// A chat card on the surface. Minimal body for now; Task 6 adds live status, faces and Nudge.
import {memo,useCallback} from 'react';
import type {BoardCard} from '@nest/schemas';

export type CardProps = {
  card: BoardCard;
  /** Editors can move every card, including locked and unavailable ones; viewers move none. */
  draggable: boolean;
  /** Drag preview offset in canvas units; the stored position changes only on drop. */
  dx: number;
  dy: number;
  dragging: boolean;
  /** Reports the mounted element so the surface can measure its height. */
  measure(channelId: string, element: HTMLElement | null): void;
};

export function cardTitle(card: BoardCard) {
  return card.access === 'open' ? card.title || 'Untitled chat' : card.access === 'locked' ? 'Private chat' : 'This chat is no longer available';
}

export const Card = memo(function Card({card, draggable, dx, dy, dragging, measure}: CardProps) {
  const title = cardTitle(card);
  const ref = useCallback((element: HTMLElement | null) => measure(card.channelId, element), [card.channelId, measure]);
  return <article
    ref={ref}
    className={`canvas-card${dragging ? ' is-dragging' : ''}`}
    data-channel-id={card.channelId}
    data-access={card.access}
    data-drag={draggable ? 'card' : undefined}
    aria-label={`Chat ${title}`}
    style={{width: card.w, transform: `translate(${card.x + dx}px, ${card.y + dy}px)`}}>
    <h3 className="canvas-card-title">{title}</h3>
  </article>;
});
