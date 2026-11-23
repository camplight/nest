import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AGENT_PIN_LIMIT_MESSAGE } from '../../schemas/src/canvas';
import { CanvasLimitError, openProductDb } from './index';

let dir: string;
let store: ReturnType<typeof openProductDb>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nest-pins-')); store = openProductDb(join(dir, 'product.sqlite')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('agent pin store', () => {
  it('has no pins until the person saves some, then keeps exactly their order, per person', () => {
    expect(store.agentPins.get('h1')).toBeNull();
    expect(store.agentPins.set('h1', ['Moss', 'Pip', 'Ash'])).toEqual(['Moss', 'Pip', 'Ash']);
    expect(store.agentPins.get('h1')).toEqual(['Moss', 'Pip', 'Ash']);
    expect(store.agentPins.get('h2')).toBeNull();
    store.agentPins.set('h1', ['Ash', 'Moss']);
    expect(store.agentPins.get('h1')).toEqual(['Ash', 'Moss']);
  });

  it('remembers an emptied list as saved, distinct from never saved', () => {
    store.agentPins.set('h1', ['Pip']);
    store.agentPins.set('h1', []);
    expect(store.agentPins.get('h1')).toEqual([]);
  });

  it('keeps the first place of a repeated name and refuses an eighth pin', () => {
    expect(store.agentPins.set('h1', ['Pip', 'Moss', 'Pip'])).toEqual(['Pip', 'Moss']);
    const seven = Array.from({ length: 7 }, (_, n) => `Helper ${n}`);
    expect(store.agentPins.set('h1', seven)).toHaveLength(7);
    expect(() => store.agentPins.set('h1', [...seven, 'Pip'])).toThrow(CanvasLimitError);
    expect(() => store.agentPins.set('h1', [...seven, 'Pip'])).toThrow(AGENT_PIN_LIMIT_MESSAGE);
    expect(store.agentPins.get('h1')).toEqual(seven);
  });
});
