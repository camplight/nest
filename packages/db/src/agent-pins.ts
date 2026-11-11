// The agents each person pinned to their canvas tray. Personal, across canvases and devices.
import type Database from 'better-sqlite3';
import { AGENT_PIN_LIMIT_MESSAGE, AGENT_PIN_MAX } from '../../schemas/src/canvas';
import { CanvasLimitError } from './canvases';

export function createAgentPinStore(db: Database.Database, now: () => number = Date.now) {
  /** The person's pins in tray order, or null when they have never saved any. */
  function get(humanId: string): string[] | null {
    const row = db.prepare('SELECT agent_names_json FROM product_agent_pins WHERE human_id=?').get(humanId) as { agent_names_json: string } | undefined;
    if (!row) return null;
    try {
      const names = JSON.parse(row.agent_names_json);
      return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
    } catch { return []; }
  }
  /** Replaces the whole list. Duplicates keep their first place; more than AGENT_PIN_MAX is refused. */
  function set(humanId: string, agentNames: string[]): string[] {
    const names = [...new Set(agentNames)];
    if (names.length > AGENT_PIN_MAX) throw new CanvasLimitError(AGENT_PIN_LIMIT_MESSAGE);
    db.prepare('INSERT INTO product_agent_pins(human_id,agent_names_json,updated_at) VALUES (?,?,?) ON CONFLICT(human_id) DO UPDATE SET agent_names_json=excluded.agent_names_json,updated_at=excluded.updated_at')
      .run(humanId, JSON.stringify(names), now());
    return names;
  }
  return { get, set };
}
export type AgentPinStore = ReturnType<typeof createAgentPinStore>;
