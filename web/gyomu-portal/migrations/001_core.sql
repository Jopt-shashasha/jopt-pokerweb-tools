PRAGMA foreign_keys = ON;
CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
 google_sub TEXT UNIQUE, department_id TEXT REFERENCES departments(id), role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE source_identities (
 source_system TEXT NOT NULL, source_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 PRIMARY KEY(source_system,source_id)
);
CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE resources (
 id TEXT PRIMARY KEY, source_system TEXT, source_id TEXT,
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 creator_id TEXT NOT NULL REFERENCES users(id), registered_by TEXT REFERENCES users(id),
 department_id TEXT REFERENCES departments(id), kind TEXT CHECK(kind IN ('document','tool') OR kind IS NULL),
 event TEXT, edition TEXT, tags TEXT NOT NULL DEFAULT '[]',
 url TEXT, status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
 visibility TEXT NOT NULL CHECK(visibility IN ('company','private')),
 access_request INTEGER NOT NULL DEFAULT 0, publisher_slack_id TEXT,
 preview_blob TEXT, html_blob TEXT, original_filename TEXT,
 source_metadata TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(source_system,source_id)
);
CREATE INDEX resource_order ON resources(status,visibility,updated_at,id);
CREATE INDEX resource_creator ON resources(creator_id);
CREATE INDEX resource_department ON resources(department_id);
CREATE TABLE saved_resources (
 user_id TEXT NOT NULL REFERENCES users(id), resource_id TEXT NOT NULL REFERENCES resources(id),
 created_at TEXT NOT NULL, PRIMARY KEY(user_id,resource_id)
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE oauth_requests (
 state TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL,
 nonce TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE audit (
 id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL,
 resource_id TEXT, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE access_requests (
 id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id),
 requester_id TEXT NOT NULL REFERENCES users(id), state TEXT NOT NULL CHECK(state IN ('pending','notified','resolved')),
 created_at TEXT NOT NULL, UNIQUE(resource_id,requester_id,state)
);
CREATE TABLE news_cache (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, fetched_at INTEGER NOT NULL);
