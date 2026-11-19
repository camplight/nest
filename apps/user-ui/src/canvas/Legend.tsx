// What the card dots mean (the mock's `.legend`): a small pill above the zoom buttons. Hidden in split screen and on phones by its parent.

/** `heading` is the tray's visible heading (see `trayHeading`), so the hint names what the person can see. */
export function Legend({heading}: {heading: string}) {
  return <aside className="canvas-legend" aria-label="Legend">
    <ul>
      <li><span className="canvas-legend-dot is-working" aria-hidden="true"/>working</li>
      <li><span className="canvas-legend-dot is-waiting" aria-hidden="true"/>waiting on you</li>
      <li><span className="canvas-legend-dot is-quiet" aria-hidden="true"/>gone quiet</li>
    </ul>
    <p>Drag an agent from {heading} onto a chat. Drag its face off a card to remove it.</p>
  </aside>;
}
