#!/bin/bash
# Pre-cutover warm-up. CT 116 keeps running; nothing here stops anything.
set -u
. /root/ct116-copy/cutover-common.sh
log() { echo "$(date -Is) PREP $*" | tee -a $CLOG; }
log "start"
pool_ok || { log "STOP: pool has new device errors"; exit 1; }
remount_views || { log "STOP: remount failed"; exit 1; }
log "fresh views mounted"
t=$(date +%s); log "warm sync (non-Postgres) $(nonpg_sync "") secs=$(( $(date +%s)-t ))"
t=$(date +%s); cat /mnt/ct116-ro1/$MDB/rail/*.ibd /mnt/ct116-ro1/$MDB/ib_logfile0 /mnt/ct116-ro1/$MDB/undo00* > /dev/null
log "MariaDB hot files warmed into ARC secs=$(( $(date +%s)-t ))"
PSQL_PRI "CHECKPOINT" >/dev/null && log "primary CHECKPOINT done"
PSQL_REP "CHECKPOINT" >/dev/null && log "replica CHECKPOINT (restartpoint) done"
log "replica lag: $(PSQL_PRI "select pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn))||' / '||coalesce(replay_lag::text,'0') from pg_stat_replication where application_name='ct116_migrate'")"
pool_ok && log "pool OK" || log "WARNING: pool has new device errors"
log "done"
