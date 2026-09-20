-- Milestone 55 (docs/IMPLEMENTATION_PLAN.md, docs/adr/0014): level crossing barrier state from
-- S-Class, alongside Milestone 36b's signal state.
--
-- A barrier binding is structurally the same as a `td_s_bit` one (area + address + bit) but says
-- what a set bit means in the barrier's own vocabulary, so an author never has to think of a
-- barrier in signal terms and a barrier bit can never be mistaken for a signal bit. It is
-- therefore its own `binding_type` rather than a widened `td_s_bit`.
--
-- `map_binding_index` is small (12,061 rows on production, 2026-09-20), so rewriting its check
-- constraints is fast: adding a CHECK revalidates every row, which at this size is instant, and
-- nothing busy is locked. No existing row changes meaning either — every current row is
-- 'td_berth' or 'td_s_bit' and satisfies the widened constraints unchanged.
--
-- The three checks being widened were created in 0010 and 0037, two of them as *column-level*
-- checks whose names Postgres generated. Rather than hardcode names this migration cannot verify
-- (getting one wrong would leave the old, narrower check in place and reject every barrier row —
-- a failure that would only show up when the first crossing was published), it drops whatever
-- check constraints on this table actually mention the relevant columns, then adds explicitly
-- named replacements. Re-runnable: after the first run the old checks are gone, the new ones are
-- named, and the same statements reproduce exactly this state.

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
  check (binding_type in ('td_berth', 'td_s_bit', 'td_s_bit_barrier'));

alter table map_binding_index add constraint map_binding_index_berth_fields_check check (
  (binding_type = 'td_berth' and berth is not null and address is null and bit is null)
  or
  (binding_type in ('td_s_bit', 'td_s_bit_barrier')
   and address is not null and bit is not null and berth is null)
);

-- 'up'/'down' join 'on'/'off': the same column, each binding type using its own vocabulary. The
-- pairing is enforced here rather than left to application code, so a barrier row can never
-- claim a signal aspect or vice versa (CLAUDE.md: use database constraints for invariants).
alter table map_binding_index add constraint map_binding_index_active_means_check check (
  active_means is null
  or (binding_type = 'td_s_bit' and active_means in ('on', 'off'))
  or (binding_type = 'td_s_bit_barrier' and active_means in ('up', 'down'))
);

-- Mirrors the `td_s_bit` pair from 0010: one element bound to one barrier bit per published map
-- version, and the same hot-path lookup the live delta publisher joins on.
create unique index if not exists map_binding_index_barrier_unique
  on map_binding_index (map_version_id, td_area, address, bit)
  where binding_type = 'td_s_bit_barrier';

create index if not exists map_binding_index_barrier_lookup_idx
  on map_binding_index (td_area, address, bit)
  where binding_type = 'td_s_bit_barrier';
