-- WaxEDGE alert bot. Only what an alert needs: which chat asked for what.
CREATE TABLE IF NOT EXISTS watches (
  chat_id   INTEGER NOT NULL,
  account   TEXT    NOT NULL,
  -- JSON: { "<posId>": 1 | 0 } — in range or not, as last seen
  state     TEXT    NOT NULL DEFAULT '{}',
  created   INTEGER NOT NULL,
  PRIMARY KEY (chat_id, account)
);
CREATE TABLE IF NOT EXISTS price_alerts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id   INTEGER NOT NULL,
  token     TEXT    NOT NULL,   -- symbol-contract, the way Alcor names tokens
  symbol    TEXT    NOT NULL,
  dir       TEXT    NOT NULL CHECK (dir IN ('above', 'below')),
  price     REAL    NOT NULL,   -- USD
  created   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursor (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS watches_account ON watches(account);
