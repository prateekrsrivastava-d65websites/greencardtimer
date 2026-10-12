CREATE TABLE IF NOT EXISTS community_daily (
  day TEXT PRIMARY KEY NOT NULL CHECK(length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  total INTEGER NOT NULL CHECK(total >= 0 AND total <= 10000),
  counters TEXT NOT NULL CHECK(json_valid(counters))
);

-- The first contribution of each UTC day removes expired aggregate rows.
CREATE TRIGGER IF NOT EXISTS community_daily_retention
AFTER INSERT ON community_daily
BEGIN
  DELETE FROM community_daily WHERE day < date(NEW.day, '-89 days');
END;
