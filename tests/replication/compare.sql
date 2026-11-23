SELECT 'travel_plans' AS table_name,
       count(*) AS rows,
       md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) AS checksum
FROM travel_plans t
UNION ALL
SELECT 'locations',
       count(*),
       md5(coalesce(string_agg(l::text, '|' ORDER BY l.id), ''))
FROM locations l;

SELECT id, title, budget, version, updated_at
FROM travel_plans
ORDER BY updated_at DESC
LIMIT 5;
