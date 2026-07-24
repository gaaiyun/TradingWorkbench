-- Extend the default monitoring profile without overwriting user edits.
-- The guarded inserts make this migration idempotent on local and production D1.
UPDATE workbench_settings
SET
  settings_json = json_set(
    settings_json,
    '$.profiles[0].targets',
    json_insert(
      json_extract(settings_json, '$.profiles[0].targets'),
      '$[#]',
      json('{"symbol":"GOOGL","name":"Alphabet","market":"US","role":"driver","analysis":"signal"}')
    )
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1
  AND json_type(settings_json, '$.profiles[0].targets') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(settings_json, '$.profiles[0].targets')
    WHERE json_extract(value, '$.symbol') = 'GOOGL'
  );

UPDATE workbench_settings
SET
  settings_json = json_set(
    settings_json,
    '$.profiles[0].targets',
    json_insert(
      json_extract(settings_json, '$.profiles[0].targets'),
      '$[#]',
      json('{"symbol":"3887.HK","name":"比特小鹿","market":"HK","role":"driver","analysis":"signal"}')
    )
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1
  AND json_type(settings_json, '$.profiles[0].targets') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(settings_json, '$.profiles[0].targets')
    WHERE json_extract(value, '$.symbol') = '3887.HK'
  );
