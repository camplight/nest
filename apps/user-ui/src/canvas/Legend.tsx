// What the card dots mean (the mock's `.legend`): a small pill above the zoom buttons. Hidden in split screen and on phones by its parent.
import {TRAY_HEADING} from './AgentTray';

export function Legend() {
  return <aside className="canvas-legend" aria-label="Legend">
    <ul>
      <li><span className="canvas-legend-dot is-working" aria-hidden="true"/>working</li>
      <li><span className="canvas-legend-dot is-waiting" aria-hidden="true"/>waiting on you</li>
      <li><span className="canvas-legend-dot is-quiet" aria-hidden="true"/>gone quiet</li>
    </ul>
    <p>Drag an agent from {TRAY_HEADING} onto a chat. Drag its face off a card to remove it.</p>
  </aside>;
}
