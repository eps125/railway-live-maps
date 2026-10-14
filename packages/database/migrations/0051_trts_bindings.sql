-- Milestone 92 (docs/IMPLEMENTATION_PLAN.md): Train Ready To Start (TRTS) indicators.
--
-- A starting signal's TRTS bit gets its own `td_s_bit_trts` binding_type with its own `lit`/`unlit`
-- `active_means` vocabulary, so a TRTS bit can never be consumed as the signal's aspect, a barrier
-- position or a route, and the pairing is enforced here rather than left to application code.
--
-- Same approach and reasoning as 0039/0040/0042: `map_binding_index` is small, so replacing its
-- check constraints is instant; every existing row satisfies the widened checks unchanged; and the
-- checks are dropped by what they mention rather than by name, then re-added explicitly named,
-- which keeps this re-runnable. Not destructive: no row is changed or removed.

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where rel.relname = 'map_binding_index'
      and nsp.nspname = current_schema()
      and con.contype = 'c'
      and (
        pg_get_constraintdef(con.oid) like '%binding_type%'
        or pg_get_constraintdef(con.oid) like '%active_means%'
      )
  loop
    execute format('alter table map_binding_index drop constraint %I', constraint_name);
  end loop;
end
$$;

alter table map_binding_index add constraint map_binding_index_binding_type_check
  check (binding_type in (
    'td_berth', 'td_s_bit', 'td_s_bit_barrier', 'td_s_bit_barrier_input', 'td_s_bit_route',
    'td_s_bit_trts'
  ));

alter table map_binding_index add constraint map_binding_index_berth_fields_check check (
  (binding_type = 'td_berth' and berth is not null and address is null and bit is null)
  or
  (binding_type in (
     'td_s_bit', 'td_s_bit_barrier', 'td_s_bit_barrier_input', 'td_s_bit_route', 'td_s_bit_trts'
   )
   and address is not null and bit is not null and berth is null)
);

alter table map_binding_index add constraint map_binding_index_active_means_check check (
  active_means is null
  or (binding_type in ('td_s_bit', 'td_s_bit_barrier_input') and active_means in ('on', 'off'))
  or (binding_type = 'td_s_bit_barrier' and active_means in ('up', 'down'))
  or (binding_type = 'td_s_bit_route' and active_means in ('set', 'unset'))
  or (binding_type = 'td_s_bit_trts' and active_means in ('lit', 'unlit'))
);

-- One TRTS per bit per published map version, and the hot-path lookup the live publisher joins on.
create unique index if not exists map_binding_index_trts_unique
  on map_binding_index (map_version_id, td_area, address, bit)
  where binding_type = 'td_s_bit_trts';

create index if not exists map_binding_index_trts_lookup_idx
  on map_binding_index (td_area, address, bit)
  where binding_type = 'td_s_bit_trts';
