-- Owner request 2026-10-12.
--
-- 1. A third access-code scope, `all_maps`: every map, public or not, including maps added
--    later. (`site` stays "every public map"; `maps` stays "only the maps named".)
-- 2. A module is not a map anyone views on its own: a code can no longer name one. Any module
--    already attached to a code is detached here; the code keeps its real maps.
alter table access_code drop constraint access_code_scope_check;
alter table access_code
  add constraint access_code_scope_check check (scope in ('site', 'all_maps', 'maps'));

delete from access_code_map acm
 using map m
 where m.id = acm.map_id and m.kind = 'module';
