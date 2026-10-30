-- 2026-10-30 (owner request): the small "Unofficial · not for safety-critical use" line on the map
-- shows for the most basic viewers and not for everyone else. A permission that *hides* it, so Admin
-- (which holds every permission) is among those who don't see it. Granted to every user type except
-- the public one and the Basic User types; changeable in Admin › User types. The notice itself stays
-- in the header menu and the map options for everyone (CLAUDE.md rule 16). Additive and re-runnable.

insert into permission (key) values ('map.hide_notice') on conflict do nothing;

insert into user_type_permission (user_type_id, permission)
select t.id, 'map.hide_notice' from user_type t
 where t.system_key is null and t.name not like 'Basic User%'
on conflict do nothing;
