-- 2026-10-30 (owner request): TD receive silences from 30 s up to the 5-minute tolerance are
-- recorded too, as `td_short_receive_silence` (amber on the admin Data outages page; the existing
-- `td_receive_silence`, 5 minutes and over, is red). Admin-only: the maps, playback, signals, run
-- lineage and held-train delays ignore them. Same one-row-per-silence key as 0037's index.
-- feed_gap is tiny (a dozen rows), so a plain index build is instant. Additive and re-runnable.

create unique index if not exists feed_gap_td_short_silence_uk
  on feed_gap (feed_name, affected_sequence_start)
  where detection_reason = 'td_short_receive_silence';
