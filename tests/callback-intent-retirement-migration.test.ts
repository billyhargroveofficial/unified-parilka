import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";

test("v16 and v18 databases converge on v20 without callback intent state", (t) => {
  const v16Path = tempDbPath(t);
  const v16 = new MessageStore(v16Path);
  v16.close();
  const downgradeV16 = new DatabaseSync(v16Path);
  downgradeV16.exec("PRAGMA user_version = 16");
  downgradeV16.close();

  const migratedV16 = new MessageStore(v16Path);
  assert.equal(migratedV16.getSchemaVersion(), 24);
  migratedV16.close();

  const v18Path = tempDbPath(t);
  const v18 = new MessageStore(v18Path);
  v18.close();
  const downgradeV18 = new DatabaseSync(v18Path);
  downgradeV18.exec(`
    CREATE TABLE bot_callback_intents (id INTEGER PRIMARY KEY, token TEXT NOT NULL);
    CREATE INDEX idx_bot_callback_intents_expiry ON bot_callback_intents(token);
    PRAGMA user_version = 18;
  `);
  downgradeV18.close();

  const migratedV18 = new MessageStore(v18Path);
  assert.equal(migratedV18.getSchemaVersion(), 24);
  migratedV18.close();

  const inspect = new DatabaseSync(v18Path, { readOnly: true });
  try {
    const table = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bot_callback_intents'")
      .get();
    const index = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_bot_callback_intents_expiry'")
      .get();
    assert.equal(table, undefined);
    assert.equal(index, undefined);
  } finally {
    inspect.close();
  }
});

function tempDbPath(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "telegram-callback-retirement-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "messages.sqlite");
}
