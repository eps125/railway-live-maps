#!/bin/bash
# Gap-free cutover of CT 116 onto native ZFS (runbook phase C), v2 after the 2026-10-16 00:55 overrun.
# Runs on the Proxmox host (10.1.1.201). Run only after the owner's go-ahead.
#
# v2 changes:
#  - PRE-T0 freeze sync: a 0.3 s fsfreeze makes fresh views current, and a warm sync runs while the CT is
#    still up, so the downtime pass only covers the minutes since then. Abort before T0 if it is too slow.
#  - Independent WATCHDOG unit: if the config switch has not happened by T0+LIMIT it runs abort.sh,
#    whatever step this script is stuck in.
#  - abort.sh detaches the read-only views before pct start and restarts Postgres explicitly.
set -u
. /root/ct116-copy/cutover-common.sh
CONF=/etc/pve/lxc/116.conf
MARK=/root/ct116-copy/switched
LIMIT=${LIMIT:-165}          # watchdog: config switch must happen by T0+LIMIT (abort itself takes ~40-60 s)
PRESYNC_MAX=${PRESYNC_MAX:-150}
T0=0
el() { [ "$T0" = 0 ] && echo 0 || echo $(( $(date +%s) - T0 )); }
log() { echo "$(date -Is) CUT +$(el)s $*" | tee -a "$CLOG"; }
fail_pre() { log "NOT STARTING: $*"; exit 1; }   # before T0 nothing has been stopped

# ---- pre-checks (no impact) ----
rm -f "$MARK"
grep -q "^rootfs: data:116/vm-116-disk-0.raw" $CONF || fail_pre "config not in the expected pre-cutover state"
pool_ok || fail_pre "pool has new device errors"
systemctl is-active -q nr-backstop || fail_pre "backstop capture (nr-backstop) is not running"
lag=$(PSQL_PRI "select pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) from pg_stat_replication where application_name='ct116_migrate'")
[ -n "$lag" ] && [ "${lag%.*}" -lt 100000000 ] || fail_pre "replica not streaming / not caught up (lag=$lag)"

# ---- pre-T0 freeze sync (CT 116 keeps running) ----
log "pre-sync: freeze + fresh views + warm sync"
R=/proc/$(lxc-info -n $CT -pH)/root; sync; fsfreeze -f "$R"; fsfreeze -u "$R"
remount_views || fail_pre "remount failed"
t=$(date +%s); res=$(nonpg_sync ""); ps=$(( $(date +%s) - t ))
log "pre-sync done in ${ps}s: $res"
[ "$ps" -le "$PRESYNC_MAX" ] || fail_pre "pre-sync took ${ps}s (> ${PRESYNC_MAX}s): final pass would not fit"
# MariaDB hot files back into ARC (the final pass re-copies them whole)
cat /mnt/ct116-ro1/$MDB/rail/*.ibd /mnt/ct116-ro1/$MDB/ib_logfile0 /mnt/ct116-ro1/$MDB/undo00* > /dev/null
PSQL_PRI "CHECKPOINT" >/dev/null; PSQL_REP "CHECKPOINT" >/dev/null
cp $CONF /root/ct116-copy/116.conf.pre-cutover

# ---- T0 (RLM's NR clock starts: ingest-td can no longer ack) ----
T0=$(date +%s)
systemctl reset-failed ct116-watchdog 2>/dev/null
systemd-run --unit=ct116-watchdog /root/ct116-copy/watchdog.sh "$T0" "$LIMIT" >/dev/null
log "T0: watchdog armed (T+${LIMIT}s); stopping production Postgres (fast shutdown)"
X docker stop -t 60 railway-live-map-postgres-1 >/dev/null || exec /root/ct116-copy/abort.sh
CTL=$(X docker run --rm --network none --user 70:70 -v "/$PGREL:/d:ro" postgres:17-alpine pg_controldata /d)
state=$(echo "$CTL" | sed -n "s/^Database cluster state: *//p")
ckpt=$(echo "$CTL" | sed -n "s/^Latest checkpoint location: *//p")
log "old primary: state='$state' checkpoint=$ckpt"
[ "$state" = "shut down" ] || exec /root/ct116-copy/abort.sh
ok=f
for _ in $(seq 1 20); do
  ok=$(PSQL_REP "select pg_last_wal_replay_lsn() >= '$ckpt'::pg_lsn"); [ "$ok" = t ] && break; sleep 1
done
[ "$ok" = t ] || exec /root/ct116-copy/abort.sh
X docker exec -u postgres pg-migrate-replica pg_ctl promote -D /var/lib/postgresql/data -w -t 30 >/dev/null || exec /root/ct116-copy/abort.sh
PSQL_REP "CHECKPOINT" >/dev/null
X docker stop -t 60 pg-migrate-replica >/dev/null || exec /root/ct116-copy/abort.sh
log "replica promoted, checkpointed and stopped cleanly"

# ---- stop CT 116 (openrail's NR clock starts here) ----
pct shutdown $CT --timeout 45 || { log "shutdown timed out - forcing stop"; pct stop $CT; }
log "CT 116 stopped"

# ---- final pass from the now-clean filesystem (only the minutes since the pre-sync) ----
remount_views || exec /root/ct116-copy/abort.sh
res=$(nonpg_sync "")
log "final pass: $res"
for r in $(echo "$res" | grep -oE "=[0-9]+" | tr -d =); do
  [ "$r" = 0 ] || [ "$r" = 24 ] || exec /root/ct116-copy/abort.sh
done
sed -i "/ct116 migration replica/d;/^primary_conninfo/d;/^primary_slot_name/d" "$D2/postgresql.auto.conf"
rm -f "$D2/standby.signal" "$D2/postmaster.pid"

# ---- config switch: only if well inside the watchdog limit ----
[ "$(el)" -le $(( LIMIT - 10 )) ] || exec /root/ct116-copy/abort.sh
touch "$MARK"                      # watchdog stands down from here
systemctl stop ct116-watchdog 2>/dev/null
for i in 0 1 2 3; do d=$(findmnt -no SOURCE /mnt/ct116-ro$i 2>/dev/null); [ -n "$d" ] && umount /mnt/ct116-ro$i && losetup -d "$d"; done
sed -i "s|^rootfs: .*|rootfs: vault:subvol-116-disk-1,size=1T|; s|^mp0: .*|mp0: vault:subvol-116-disk-2,mp=/$PGREL,size=1T|" $CONF
grep -q "^unused0:" $CONF || echo "unused0: data:116/vm-116-disk-0.raw" >> $CONF
log "config switched: $(grep -E '^(rootfs|mp0|unused0)' $CONF | tr '\n' ' ')"

# ---- start on native ZFS ----
pct start $CT || { sleep 2; pct start $CT; }
log "CT 116 started: $(pct status $CT)"
for _ in $(seq 1 60); do X docker info >/dev/null 2>&1 && break; sleep 1; done
X docker start railway-live-map-postgres-1 >/dev/null && log "Postgres container started explicitly"
for _ in $(seq 1 60); do X docker exec -u postgres railway-live-map-postgres-1 pg_isready -q 2>/dev/null && break; sleep 1; done
log "Postgres primary: $(X docker exec -u postgres railway-live-map-postgres-1 psql -U railway -d railway_live_maps -Atc 'select not pg_is_in_recovery()' 2>&1)"
log "containers running: $(X docker ps -q | wc -l); storage driver: $(X docker info --format '{{.Driver}}')"
log "DONE. Verify feeds now (ingest-td frames, openrail stompy, feed_gap)."
