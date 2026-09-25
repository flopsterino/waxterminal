-- WaxEDGE alert bot. Only what an alert needs: which chat asked for what.
CREATE TABLE IF NOT EXISTS chats (
  chat_id     INTEGER PRIMARY KEY,
  created     INTEGER NOT NULL,
  mute_until  INTEGER NOT NULL DEFAULT 0,
  digest_hour INTEGER NOT NULL DEFAULT -1,   -- local hour, -1 = off
  tz          INTEGER NOT NULL DEFAULT 0,    -- minutes from UTC
  digest_day  INTEGER NOT NULL DEFAULT 0,    -- local day number of the last digest
  favs        TEXT    NOT NULL DEFAULT '[]', -- token ids, SYM@contract
  pending     TEXT    NOT NULL DEFAULT '',   -- a question waiting for its answer (see ask)
  pending_at  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS watches (
  chat_id   INTEGER NOT NULL,
  account   TEXT    NOT NULL,
  state     TEXT    NOT NULL DEFAULT '{}',   -- what has been said already (see stateOf)
  created   INTEGER NOT NULL,
  opts      TEXT    NOT NULL DEFAULT '{}',   -- /settings, over OPT_DEF
  PRIMARY KEY (chat_id, account)
);
-- price | move | whale | newpool | newfarm | floor
CREATE TABLE IF NOT EXISTS alerts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id   INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  target    TEXT    NOT NULL,   -- token id, collection, or '*'
  label     TEXT    NOT NULL,
  params    TEXT    NOT NULL DEFAULT '{}',
  state     TEXT    NOT NULL DEFAULT '{}',
  created   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursor (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS watches_account ON watches(account);
CREATE INDEX IF NOT EXISTS alerts_chat ON alerts(chat_id);
