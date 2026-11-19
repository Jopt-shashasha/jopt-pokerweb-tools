WITH candidates AS MATERIALIZED (
 SELECT r.id,
        COALESCE(
         NULLIF(json_extract(r.source_metadata, '$.target_url'), ''),
         CASE WHEN r.source_system = 'drop' AND r.status = 'draft' AND r.visibility = 'private'
              THEN json_extract(r.source_metadata, '$.preview_url') END
        ) AS drop_url
 FROM resources r
 WHERE r.url LIKE 'https://drive.google.com/file/d/%'
   AND (
    r.source_system = 'drop'
    OR (r.source_system = 'aifact' AND EXISTS (
     SELECT 1 FROM resources d WHERE d.source_system = 'drop' AND d.url = r.url
    ))
   )
), hosts AS (
 SELECT id, drop_url,
        substr(substr(drop_url, 9), 1, instr(substr(drop_url || '/', 9), '/') - 1) AS host
 FROM candidates
 WHERE drop_url GLOB 'https://*'
)
UPDATE resources AS r
SET url = h.drop_url,
    source_metadata = json_set(r.source_metadata, '$.drive_backup_url', r.url),
    version = r.version + 1
FROM hosts h
WHERE r.id = h.id
  AND h.host GLOB 'd-*.jopt-html-share.pages.dev'
  AND h.host NOT GLOB '*[^a-z0-9.-]*';
