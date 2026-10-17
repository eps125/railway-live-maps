# CT 116 → native ZFS cutover (gap-free)

Status: **COMPLETE (2026-10-16 17:07 BST), with zero data loss.** The v2 cutover (`ct116-cutover/cutover.sh`) took T0→done
in 163 s: the switch was at about T+118 s, Postgres was the primary at T+159 s, and the watchdog limit was 165 s. Verified against the independent
`nr-backstop` capture: RLM TD per-10 s counts were identical for 16:06–16:10Z, RLM TRUST per-minute counts were equal, and openrail TD
was complete. CT 116 now runs on `vault:subvol-116-disk-1` (rootfs) and `vault:subvol-116-disk-2` (Postgres). The old raw
disk is `unused0` and is kept until the owner approves deleting it.

Previous status: **PARKED (2026-10-16 01:30) after a failed first cutover attempt that lost data.** The v2 scripts in
`ct116-cutover/` (watchdog, abort, freeze pre-sync) replace the procedure below. The replica must be rebuilt
from scratch, and the `nr-backstop` capture must be started (`systemctl start nr-backstop`) before any
retry. See the incident notes at the end.

Earlier status: **Phase A DONE (2026-10-16 00:09)**: replica `pg-migrate-replica` is streaming from slot `ct116_migrate`,
consistent at `2C5/23641120`, and `disk-2` is hot-plugged at `/mnt/pgnew` (`mp0`). Phases B–D not yet applied. Every
phase needs the owner's explicit go-ahead.

Phase A deviations from the plan below, as executed:

- **Freeze:** the base was taken from fresh `noload` views mounted right after a 0.32 s
  `fsfreeze -f/-u` of CT 116's root, which checkpoints the ext4 journal. It was not taken from the
  live view, which ran at about 3 MB/s through loop11's single queue. 43 GB of changed files were
  copied in 20 min with 4 workers.
- **Plug file:** the drive firmware bad-LBA bug hit a write to the new copy (mirror-0). The damaged
  copy is kept as `/.badlba-plug-1088182.1` in `disk-2`'s root, so the bad blocks stay allocated.
  It must never be deleted. The sync protects it with `--filter='P /.badlba-plug-*'`. It is listed
  as a permanent ZFS data error by design, and the throttle's pool check now ignores it (it checks
  ONLINE state plus device error counters).
- **Not migrated:** openrail `tddb-detail.log` (31.7 GB, unrotated). Its history stays on the old
  raw disk.

## Goal and constraint

Move CT 116 (the `docker` LXC running the `railway-live-map` and `openrail` stacks) off
`data:116/vm-116-disk-0.raw` (ext4 inside a 1 TB raw file on a `dir` storage) onto native ZFS:

- `vault:subvol-116-disk-1`: new rootfs (128K records)
- `vault:subvol-116-disk-2`: Postgres data dir (`recordsize=16K`, `atime=off`)

**Hard constraint: no feed gaps.** NR holds durable-subscription messages for 5 minutes after a
disconnect (Milestone 68). Both NR consumers in CT 116 are durable:

- RLM `ingest-td`: `NR_TD_DURABLE_SUBSCRIPTION=true`, name `railway-live-maps-td`
- openrail `stompy` (TRUST, VSTP, TD): fixed `client-id` plus `activemq.subscriptionName`

So the time from **CT 116 stopping consuming** to **both consumers reconnected** must be
under 5 minutes. Target is 3 minutes. **Abort at 3 m 30 s** (see phase C).

## Why a plain "stop, final rsync, start" does not fit

Pass 2 showed about 30 GB of Postgres files rewritten in about 9 hours. Hot index and table
segments are touched constantly, and rsync re-copies a changed file whole. A stopped-container
final pass would spend several minutes on Postgres alone. Phase A removes Postgres from the
final pass by keeping a streaming replica on `disk-2`.

## Already done (2026-10-15)

- `vault/subvol-116-disk-1`, `vault/subvol-116-disk-2` created (1 TB refquota, no reservation)
- Pass 1 (full copy) complete, with pass 2 and pass 3 (catch-up) run from fresh read-only
  `noload` views. Scripts and logs are in `/root/ct116-copy/` on .201 (`events.log` has
  per-stage timings).
- The 31.7 GB unrotated openrail `tddb-detail.log` is copied with `rsync --append`.

## Facts this plan relies on

| Fact                                                      | Value                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| Postgres image                                            | `postgres:17-alpine`, uid 70, data at `/var/lib/postgresql/data` |
| Postgres volume (in CT)                                   | `/var/lib/docker/volumes/railway-live-map_postgres_data/_data`   |
| `wal_level` / `max_wal_senders` / `max_replication_slots` | `replica` / 10 / 10 (no restart needed)                          |
| `pg_hba.conf`                                             | `host replication all 127.0.0.1/32 trust` already present        |
| `full_page_writes`                                        | on (required for the base backup method below)                   |
| CT 116 memory                                             | 16 GB, about 7 GB available                                      |
| openrail MariaDB                                          | `mariadb:11`, `openrail_db_data`, about 10 GB                    |

## Phase A: Postgres streaming replica on disk-2 (CT 116 keeps running)

Production changes: **one physical replication slot** (dropped again in phase D, or on abort).
No `pg_hba` or `postgresql.conf` change and no restart. The replica shares the primary
container's network namespace, so it reaches the primary on `127.0.0.1`, which is already trusted
for replication.

Preconditions: pass 3 finished, and no further copy pass touches `disk-2`. Later passes must
exclude Postgres.

1. Attach disk-2 to the running CT at a staging path (mount-point hotplug):
   ```
   pct set 116 -mp0 vault:subvol-116-disk-2,mp=/mnt/pgnew
   ```
2. On the primary, in **one psql session kept open until step 5**:
   ```sql
   SELECT pg_create_physical_replication_slot('ct116_migrate', true);
   SELECT pg_backup_start('ct116-migrate', true);
   ```
3. Re-sync the data dir from the **live** view (not a `noload` view: a stale view can show pages
   older than the backup checkpoint, which WAL replay would not repair):
   ```
   SRC=/proc/$(lxc-info -n 116 -pH)/root/var/lib/docker/volumes/railway-live-map_postgres_data/_data/
   rsync -aHAX --numeric-ids --delete \
     --exclude=/postmaster.pid --exclude=/postmaster.opts \
     --exclude='/pg_wal/*' --exclude='/pg_replslot/*' --exclude='/pg_stat_tmp/*' \
     "$SRC" /vault/subvol-116-disk-2/
   ```
   This runs under the adaptive throttle. Expected size is the hot-file delta, about 30 GB.
4. In the same psql session:
   ```sql
   SELECT labelfile, spcmapfile FROM pg_backup_stop(true);
   ```
   Write `labelfile` verbatim to `/vault/subvol-116-disk-2/backup_label`, owned `100070:100070`.
   `spcmapfile` is empty because there are no tablespaces.
5. Configure as a standby:
   - `touch /vault/subvol-116-disk-2/standby.signal` (owned `100070:100070`)
   - append to `postgresql.auto.conf`:
     `primary_conninfo = 'host=127.0.0.1 port=5432 user=railway application_name=ct116_migrate'`
     and `primary_slot_name = 'ct116_migrate'`
6. Start the replica inside CT 116:
   ```
   docker run -d --name pg-migrate-replica \
     --network container:railway-live-map-postgres-1 \
     -v /mnt/pgnew:/var/lib/postgresql/data postgres:17-alpine \
     postgres -p 5433 -c listen_addresses=127.0.0.1 -c shared_buffers=512MB
   ```
7. Verify on the primary: `pg_stat_replication` shows `ct116_migrate` streaming, with
   `replay_lag` in seconds. Watch the slot's retained WAL until it is caught up.

## Phase B: rehearsal (isolated clone, no network)

Purpose: prove Docker (overlayfs on ZFS 2.3), Postgres, MinIO and MariaDB start from the new
datasets, and **time the stack start-up**. That time is a direct input to the phase C budget.

1. `zfs snapshot vault/subvol-116-disk-1@rehearsal vault/subvol-116-disk-2@rehearsal`
   (disk-2 snapshot taken while the replica runs is crash-consistent)
2. `zfs clone` each to `vault/subvol-9116-disk-1` and `vault/subvol-9116-disk-2`
3. CT 9116 config: copy of 116.conf with **no `net0`**, `onboot: 0`, `memory: 8192`,
   `hostname: ct116-rehearsal`, rootfs is the 9116 disk-1 clone, and `mp0` is the 9116 disk-2 clone at the
   Postgres volume path. In the disk-2 clone, delete `standby.signal` so it starts as a primary.
4. `pct start 9116` and time it until every container is up. Check:
   - `docker info` storage driver
   - `psql -c 'select 1'` (and the row count of a recent partition)
   - MinIO health endpoint
   - `mariadb -e 'select 1'`
5. `pct stop 9116`, `pct destroy 9116` (removes the 9116 clones), then
   `zfs destroy vault/subvol-116-disk-{1,2}@rehearsal`.

No network means the clone cannot reach NR, garner or the public site.

## Phase C: cutover (owner picks the window, ideally late evening)

T-15 min: warm pass of everything except Postgres (fresh read-only views, normal throttle),
then **re-arm the stopwatch**.

| T      | Action                                                                                                                                                                                             | Budget                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 0:00   | `docker stop railway-live-map-postgres-1` (fast shutdown; walsender ships the shutdown checkpoint to the replica). NR consumers stop acking, so **the 5-min clock starts**.                        | 15 s                                          |
| 0:15   | Check replica `pg_last_wal_replay_lsn()` = primary's final checkpoint (`pg_controldata` on the old data dir), then `docker exec pg-migrate-replica pg_ctl promote` and stop the replica            | 15 s                                          |
| 0:30   | `pct shutdown 116 --timeout 60`                                                                                                                                                                    | ≤ 45 s                                        |
| 1:15   | Remount fresh read-only views, then final pass of everything **except Postgres**, `--delete`, no throttle                                                                                          | ≤ 60 s (measured in pass 3 and the warm pass) |
| 2:15   | Edit `/etc/pve/lxc/116.conf`: `rootfs: vault:subvol-116-disk-1,size=1T`; `mp0: vault:subvol-116-disk-2,mp=/var/lib/docker/volumes/railway-live-map_postgres_data/_data`; old raw becomes `unused0` | 5 s                                           |
| 2:20   | `pct start 116`; containers start via restart policies; `ingest-td` and `stompy` reconnect to their durable subscriptions                                                                          | ≤ 60 s (measured in phase B)                  |
| ≤ 3:20 | Verify both feeds consuming; check NR backlog delivered (`feed_gap` rows, TD event timestamps continuous)                                                                                          |                                               |

**Abort rule:** if the config switch (2:15) has not happened by **3:30**, abandon. Leave
116.conf unchanged, run `pct start 116`, and the original raw disk comes back within the buffer.
Afterwards, drop the slot (`SELECT pg_drop_replication_slot('ct116_migrate')`) and remove the
replica container. The raw disk is never written by any phase, so abort is always available.

## Phase D: after cutover

- Confirm no `feed_gap` row spans the window; spot-check TD and TRUST continuity.
- Measure against the baseline (`/root/rlm-zfs-baseline-2026-10-15.txt`): loop device gone,
  Postgres checkpoint times, pool ops.
- Remove the stale `primary_conninfo`/`primary_slot_name` lines from `postgresql.auto.conf`.
- Detach and remove the read-only loop devices and `/mnt/ct116-ro*`.
- Keep `vm-116-disk-0.raw` as `unused0` until the owner approves deleting it.
- About a week later: consider `full_page_writes = off` (only safe on native ZFS).
- Follow-up: rotate openrail `tddb-detail.log` (about 700 MB/day, unrotated).

## Rollback after a completed cutover

`pct stop 116`, restore `rootfs: data:116/vm-116-disk-0.raw,size=1T` and remove `mp0`, then `pct start 116`.
Data written after cutover would be lost in that case. Only use it if the new layout is broken.

## Incident: cutover attempt 1 (2026-10-16 00:55 BST): data lost

- **Timeline:** T0 00:55:48 (Postgres stopped). Handover was clean by +23 s and the CT stopped at +60 s. The final
  pass's MinIO stage overran, and the manual abort came at about +290 s. The first `pct start` failed (the read-only views
  held the raw disk). CT 116 came back at 01:01:17, and Postgres was ready at 01:01:46 (started explicitly).
- **Lost:** RLM TD from 23:55:49 to about 23:56:44Z (about 24 s of that is recoverable from openrail's `tddb-detail.log`, which
  has TD to 23:56:13Z). openrail TRUST/VSTP/TD from 23:56:13 to 23:56:48Z. Net loss in both systems: about 31 s of TD and 35 s of
  TRUST/VSTP. `feed_gap` row: TD 00:55:49 to 01:01:47 BST.
- **Causes:**
  - The "warm" rehearsal read a stale `noload` view that could not see most of the day's MinIO objects, so it
    under-measured the final pass.
  - The deadline was only checked between steps.
  - The abort path started the CT with the views still attached.
  - NR expires messages 5 minutes after they are sent, so the window runs from the first un-acked message, not from the disconnect.
- **Fixes (v2):** an independent watchdog unit (abort at T0+180 s); abort.sh detaches the views first and
  `docker start`s Postgres (its policy is `unless-stopped`); a freeze-based pre-T0 sync so the final pass covers only minutes; MinIO
  re-checks only today's dir; the throttle detects the live loop device (its number changes on CT restart); and the
  `nr-backstop` raw capture runs during any cutover so that even a total failure is recoverable.
- **Side effect:** since the CT restart, `deploy-deploy-runner-1` restart-loops with "already configured". Recreate it via Portainer.
