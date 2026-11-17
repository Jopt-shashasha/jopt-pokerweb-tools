CREATE TABLE resource_events (
 resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
 event TEXT NOT NULL REFERENCES event_series(name),
 event_scope_id TEXT REFERENCES event_scopes(id),
 PRIMARY KEY(resource_id,event)
);
CREATE INDEX resource_events_filter ON resource_events(event,event_scope_id,resource_id);
INSERT INTO resource_events(resource_id,event,event_scope_id)
 SELECT id,event,event_scope_id FROM resources WHERE event IN (SELECT name FROM event_series);
