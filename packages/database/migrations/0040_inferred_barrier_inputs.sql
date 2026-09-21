-- Milestone 59 (docs/IMPLEMENTATION_PLAN.md, docs/adr/0015): level crossings whose barrier
-- position is inferred from their protecting signals, for areas whose feed publishes signals but
-- no crossing (LXC) bit.
--
-- Each input signal of an inferred crossing gets one `td_s_bit_barrier_input` row: the crossing's
-- element_id plus one signal bit and what a set bit means *for that signal* (`on`/`off` — the
-- signal vocabulary, since an input is a signal, not a barrier). The live publisher groups a
-- crossing's rows by (map_version_id, element_id) to get its full input list. Its own
-- binding_type, so an input row can never be consumed as a signal binding or a direct barrier
-- binding, and so the same bit can legitimately be both a drawn signal's binding and a crossing's
-- input in one map version.
--
-- Same approach and reasoning as 0039: `map_binding_index` is small, so replacing its check
-- constraints is instant; every existing row satisfies the widened checks unchanged; and the
-- checks are dropped by what they mention rather than by name, then re-added explicitly named,
-- which keeps this re-runnable.

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
  check (binding_type in ('td_berth', 'td_s_bit', 'td_s_bit_barrier', 'td_s_bit_barrier_input'));

alter table map_binding_index add constraint map_binding_index_berth_fields_check check (
  (binding_type = 'td_berth' and berth is not null and address is null and bit is null)
  or
  (binding_type in ('td_s_bit', 'td_s_bit_barrier', 'td_s_bit_barrier_input')
   and address is not null and bit is not null and berth is null)
);

alter table map_binding_index add constraint map_binding_index_active_means_check check (
  active_means is null
  or (binding_type in ('td_s_bit', 'td_s_bit_barrier_input') and active_means in ('on', 'off'))
  or (binding_type = 'td_s_bit_barrier' and active_means in ('up', 'down'))
);

-- One row per input bit per crossing per published version. Not unique on the bit alone: two
-- crossings protected by the same signal are both inferred from it.
create unique index if not exists map_binding_index_barrier_input_unique
  on map_binding_index (map_version_id, element_id, td_area, address, bit)
  where binding_type = 'td_s_bit_barrier_input';

create index if not exists map_binding_index_barrier_input_lookup_idx
  on map_binding_index (td_area, address, bit)
  where binding_type = 'td_s_bit_barrier_input';
