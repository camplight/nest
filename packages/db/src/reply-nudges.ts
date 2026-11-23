import type Database from 'better-sqlite3';

const CURSOR_KEY='reply_nudge_cursor';

// Where Nest's reply-nudge worker has read engine turn completions up to.
// The nudges themselves are engine events, deduplicated by idempotency key.
export function createReplyNudgeStore(db:Database.Database) {
  return {
    cursor():number|null {
      const row=db.prepare('SELECT value_json FROM product_settings WHERE key=?').get(CURSOR_KEY) as {value_json:string}|undefined;
      const value=row?Number(JSON.parse(row.value_json)):NaN;
      return Number.isFinite(value)?value:null;
    },
    setCursor(value:number) {
      db.prepare('INSERT INTO product_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(CURSOR_KEY,JSON.stringify(value));
    },
  };
}
export type ReplyNudgeStore=ReturnType<typeof createReplyNudgeStore>;
