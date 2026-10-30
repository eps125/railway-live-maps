-- 2026-10-30 (owner request): admin "Data outages" page with an unseen-count pill. Records, per
-- user, the newest `feed_gap` row they have seen on that page; the pill counts gaps with a higher
-- id. Gaps only ever get new ids when first recorded (later classification updates the row in
-- place), so "unseen" means "recorded since you last looked". Additive and re-runnable.

create table if not exists feed_gap_seen (
  user_id bigint primary key references app_user (id) on delete cascade,
  seen_through_gap_id bigint not null default 0,
  seen_at timestamptz not null default now()
);
