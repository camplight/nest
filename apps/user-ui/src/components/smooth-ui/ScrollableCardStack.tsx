/*
 * Adapted from SmoothUI's Scrollable Card Stack (MIT, Eduardo Calvo).
 * Source: https://smoothui.dev/r/scrollable-card-stack.json (2026-10-01).
 * See LICENSE. Nest adds renderItem, responsive card height, stable item identity,
 * and page-friendly gestures; the Motion stack transforms come from SmoothUI.
 */
import { LazyMotion, domAnimation, m, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import "./scrollable-card-stack.css";

const MIN_SCROLL_INTERVAL = 300;
const SCROLL_THRESHOLD = 20;
const SCALE_FACTOR = 0.08;
const FRAME_OFFSET = -24;
const FRAMES_VISIBLE_LENGTH = 3;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

type Props<T extends { id: string }> = {
  items: T[];
  label: string;
  renderItem: (item: T) => ReactNode;
};

export function ScrollableCardStack<T extends { id: string }>({ items, label, renderItem }: Props<T>) {
  const [selectedId, setSelectedId] = useState(items[0]?.id);
  const currentIndex = Math.max(0, items.findIndex(item => item.id === selectedId));
  const currentItem = items[currentIndex];
  const [cardHeight, setCardHeight] = useState(120);
  const activeCardRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastScrollTime = useRef(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClickUntil = useRef(0);
  const shouldReduceMotion = useReducedMotion();

  // Keep selection attached to an item when polling, filtering or reading changes the list.
  useEffect(() => { setSelectedId(currentItem?.id); }, [currentItem?.id]);

  useEffect(() => {
    const card = activeCardRef.current;
    if (!card) return;
    const observer = new ResizeObserver(() => setCardHeight(card.offsetHeight));
    observer.observe(card);
    return () => observer.disconnect();
  }, [currentItem?.id]);

  function goTo(index: number) {
    const item = items[clamp(index, 0, items.length - 1)];
    if (item) setSelectedId(item.id);
  }

  function handleKeyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.matches("input, textarea, select, [contenteditable=true]")) return;
    const destination = ({
      ArrowUp: currentIndex - 1, ArrowLeft: currentIndex - 1,
      ArrowDown: currentIndex + 1, ArrowRight: currentIndex + 1,
      Home: 0, End: items.length - 1,
    } as Record<string, number>)[event.key];
    if (destination === undefined) return;
    event.preventDefault();
    // Moving from a card action must not strand focus in an unmounted card.
    containerRef.current?.focus({ preventScroll: true });
    goTo(destination);
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheel = (event: WheelEvent) => {
      // Ordinary page scrolling stays ordinary until the carousel has focus.
      if (!container.contains(document.activeElement) || Math.abs(event.deltaY) < SCROLL_THRESHOLD) return;
      const nextIndex = clamp(currentIndex + (event.deltaY > 0 ? 1 : -1), 0, items.length - 1);
      if (nextIndex === currentIndex) return;
      event.preventDefault();
      if (Date.now() - lastScrollTime.current < MIN_SCROLL_INTERVAL) return;
      lastScrollTime.current = Date.now();
      container.focus({ preventScroll: true });
      setSelectedId(items[nextIndex].id);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [currentIndex, items]);

  if (!currentItem) return null;

  return <LazyMotion features={domAnimation} strict><div className="smooth-card-stack" role="region" aria-roledescription="carousel" aria-label={label}>
    <div
      className="smooth-card-stack-viewport"
      ref={containerRef}
      role="group"
      aria-label={`${label} cards. Use arrow keys to navigate.`}
      tabIndex={items.length > 1 ? 0 : -1}
      onKeyDown={handleKeyDown}
      style={{ height: cardHeight + 48, perspective: 1000 }}
      onTouchStart={event => {
        touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        suppressClickUntil.current = 0;
      }}
      onTouchEnd={event => {
        if (!touchStart.current) return;
        const dx = touchStart.current.x - event.changedTouches[0].clientX;
        const dy = touchStart.current.y - event.changedTouches[0].clientY;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
          suppressClickUntil.current = Date.now() + 350;
          goTo(currentIndex + (dx > 0 ? 1 : -1));
        }
        touchStart.current = null;
      }}
      onTouchCancel={() => { touchStart.current = null; suppressClickUntil.current = 0; }}
      onClickCapture={event => {
        if (Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); suppressClickUntil.current = 0; }
      }}
    >
      {items.slice(currentIndex, currentIndex + FRAMES_VISIBLE_LENGTH).map((item, offsetIndex) => {
        const isActive = offsetIndex === 0;
        const scale = shouldReduceMotion ? 1 : clamp(1 - offsetIndex * SCALE_FACTOR, .08, 2);
        const y = shouldReduceMotion ? 0 : clamp(offsetIndex * FRAME_OFFSET, FRAME_OFFSET * FRAMES_VISIBLE_LENGTH, Infinity);
        return <m.div
          key={item.id}
          className="smooth-card-stack-card"
          data-active={isActive}
          aria-hidden={!isActive}
          role={isActive ? "group" : undefined}
          aria-roledescription={isActive ? "slide" : undefined}
          aria-label={isActive ? `${currentIndex + 1} of ${items.length}` : undefined}
          initial={false}
          animate={{ scale, y }}
          transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", damping: 20, mass: .5, stiffness: 250 }}
          style={{ zIndex: FRAMES_VISIBLE_LENGTH - offsetIndex, minHeight: cardHeight, pointerEvents: isActive ? "auto" : "none" }}
        >
          {isActive && <div ref={activeCardRef}>{renderItem(item)}</div>}
        </m.div>;
      })}
    </div>
    {items.length > 1 && <div className="smooth-card-stack-controls" aria-label={`${label} navigation`}>
      <button type="button" className="smooth-card-stack-arrow" aria-label={`Previous ${label.toLowerCase()} card`} disabled={currentIndex === 0} onClick={() => goTo(currentIndex - 1)}>←</button>
      <div className="smooth-card-stack-dots">
        {items.map((item, index) => <button key={item.id} type="button" aria-label={`Go to ${label.toLowerCase()} card ${index + 1} of ${items.length}`} aria-current={index === currentIndex ? "true" : undefined} onClick={() => goTo(index)}><span /></button>)}
      </div>
      <button type="button" className="smooth-card-stack-arrow" aria-label={`Next ${label.toLowerCase()} card`} disabled={currentIndex === items.length - 1} onClick={() => goTo(currentIndex + 1)}>→</button>
    </div>}
    <p className="smooth-card-stack-announcement" role="status" aria-atomic="true">Card {currentIndex + 1} of {items.length}</p>
  </div></LazyMotion>;
}
