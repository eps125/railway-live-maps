-- 2026-10-30 (owner request): the redesigned train popup, as a permission on the matrix (docs/adr/0022
-- §1 — a new permission is a registry entry plus a row here). Granted to no user type: Admin holds
-- every permission anyway, and the owner grants it to others in Admin › User types. Without it a
-- viewer keeps the original popup layout. Additive and re-runnable.

insert into permission (key) values ('popup.new_layout') on conflict do nothing;
