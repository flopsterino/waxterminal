-- From the first version (watches + price_alerts) to the second. Run once.
CREATE TABLE IF NOT EXISTS chats (
  chat_id INTEGER PRIMARY KEY, created INTEGER NOT NULL, mute_until INTEGER NOT NULL DEFAULT 0,
  digest_hour INTEGER NOT NULL DEFAULT -1, tz INTEGER NOT NULL DEFAULT 0, digest_day INTEGER NOT NULL DEFAULT 0,
  favs TEXT NOT NULL DEFAULT '[]');
ALTER TABLE watches ADD COLUMN opts TEXT NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
  label TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}', created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS alerts_chat ON alerts(chat_id);
INSERT INTO alerts (chat_id, kind, target, label, params, state, created)
  SELECT chat_id, 'price', upper(substr(token, 1, instr(token, '-') - 1)) || '@' || substr(token, instr(token, '-') + 1),
         symbol, json_object('dir', dir, 'value', price, 'unit', 'usd'), '{}', created FROM price_alerts;
DROP TABLE price_alerts;
INSERT OR IGNORE INTO chats (chat_id, created) SELECT chat_id, MIN(created) FROM watches GROUP BY chat_id;
