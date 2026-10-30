-- 2026-10-30 (owner request): berth and train describer references in the train popup (the berth's
-- name, TD area and berth codes, when the train entered the berth) as a permission on the matrix
-- (docs/adr/0022 §1), so basic users can be kept from raw berth codes. Granted to no user type:
-- Admin holds every permission anyway, and the owner grants it to others in Admin › User types.
-- Additive and re-runnable.

insert into permission (key) values ('popup.berth_codes') on conflict do nothing;
