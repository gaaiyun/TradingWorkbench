-- 03887.HK is HashKey Holdings Limited. Correct profiles seeded before the
-- listed-company identity was verified, without changing user-selected roles.
UPDATE workbench_settings
SET
  settings_json = json_set(
    settings_json,
    (
      SELECT '$.profiles[0].targets[' || key || '].name'
      FROM json_each(settings_json, '$.profiles[0].targets')
      WHERE json_extract(value, '$.symbol') = '3887.HK'
      LIMIT 1
    ),
    'HashKey Holdings'
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1
  AND EXISTS (
    SELECT 1
    FROM json_each(settings_json, '$.profiles[0].targets')
    WHERE json_extract(value, '$.symbol') = '3887.HK'
  );
