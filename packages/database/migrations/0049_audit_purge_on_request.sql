-- Owner request 2026-10-01: an admin can **purge** an access code — delete it and remove it from
-- the audit log, with the purge itself unrecorded. The log stays append-only for everything else:
-- an update is always rejected, and a delete only goes through when the deleting transaction has
-- explicitly set `rlm.audit_purge = on` (`set local`, so it ends with that transaction). Only the
-- access-code purge route sets it.
create or replace function admin_audit_log_reject_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('rlm.audit_purge', true), '') = 'on' then
    return old;
  end if;
  raise exception 'admin_audit_log is append-only';
end;
$$;
