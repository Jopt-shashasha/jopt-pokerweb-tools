CREATE TABLE event_series (name TEXT PRIMARY KEY, sort_order INTEGER NOT NULL);
INSERT INTO event_series VALUES ('共通',0),('JOPT',1),('SPADIE',2),('U-30',3),('戦国',4);
CREATE TABLE event_scopes (
 id TEXT PRIMARY KEY, event TEXT NOT NULL REFERENCES event_series(name),
 name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, UNIQUE(event,name)
);
INSERT INTO event_scopes VALUES
 ('jopt-tokyo','JOPT','Tokyo',0),('jopt-fukuoka','JOPT','Fukuoka',1),('jopt-osaka','JOPT','Osaka',2),('jopt-sapporo','JOPT','Sapporo',3),
 ('spadie-tokyo','SPADIE','Tokyo',0),('spadie-fukuoka','SPADIE','Fukuoka',1),('spadie-osaka','SPADIE','Osaka',2),('spadie-sapporo','SPADIE','Sapporo',3),
 ('sengoku-spring','戦国','春',0),('sengoku-autumn','戦国','秋',1);
ALTER TABLE resources ADD COLUMN event_scope_id TEXT REFERENCES event_scopes(id);
CREATE TABLE resource_search (
 resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
 body TEXT NOT NULL DEFAULT '', normalized_text TEXT NOT NULL,
 normalized_title TEXT NOT NULL, normalized_summary TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE resource_markdown (
 resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
 blob TEXT NOT NULL, filename TEXT NOT NULL, bytes INTEGER NOT NULL,
 sha256 TEXT NOT NULL, search_text TEXT NOT NULL,
 updated_by TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL
);
