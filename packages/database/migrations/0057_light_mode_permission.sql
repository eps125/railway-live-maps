-- 2026-10-29 (owner request): light mode, as a permission on the matrix (docs/adr/0022 §1 —
-- a new permission is a registry entry plus a row here). Granted to every user type that isn't
-- built in — everyone except the public type (Admin holds every permission anyway). Changeable in
-- Admin › User types. Additive and re-runnable.

insert into permission (key) values ('site.light_mode') on conflict do nothing;

insert into user_type_permission (user_type_id, permission)
select t.id, 'site.light_mode' from user_type t where t.system_key is null
on conflict do nothing;
