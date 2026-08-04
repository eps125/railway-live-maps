-- Proves the migration pipeline end-to-end. Real event/projection schema arrives in Milestone 2.
create table if not exists app_meta (
  key text primary key,
  value text not null
);

insert into app_meta (key, value)
values ('bootstrapped_at', now()::text)
on conflict (key) do nothing;
