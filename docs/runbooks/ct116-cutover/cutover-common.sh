# Shared settings for prep.sh / cutover.sh (sourced, not executed)
CT=116
RAW=/vault/data/images/116/vm-116-disk-0.raw
D1=/vault/subvol-116-disk-1
D2=/vault/subvol-116-disk-2
PGREL=var/lib/docker/volumes/railway-live-map_postgres_data/_data
MREL=var/lib/docker/volumes/railway-live-map_archive_data/_data/railway-raw/raw
MDB=var/lib/docker/volumes/openrail_db_data/_data
LREL=var/lib/docker/volumes/openrail_logs/_data/tddb-detail.log
# MinIO day dirs to re-check: default = only those touched since 00:01 UTC today (yesterday's dir is
# complete once a post-freeze sync has covered it). Override with MSINCE="..." for that one full sync.
MSINCE=${MSINCE:-$(date -d "$(date -u +%F) 00:01 UTC" "+%F %T")}
CLOG=/root/ct116-copy/log/cutover.log
OPTS="-aHAX --numeric-ids --info=stats2"
X() { pct exec $CT -- "$@"; }                     # run inside CT 116
PSQL_PRI() { X docker exec -u postgres railway-live-map-postgres-1 psql -U railway -d railway_live_maps -At -c "$1"; }
PSQL_REP() { X docker exec -u postgres pg-migrate-replica psql -p 5433 -U railway -d railway_live_maps -At -c "$1"; }
pool_ok() {
  [ "$(zpool list -Ho health vault)" = ONLINE ] || return 1
  zpool status -p vault | awk '$1 ~ /^(scsi-|mirror-)/ && ($3+$4+$5)>0 {bad=1} END{exit bad}'
}
remount_views() {   # detach our read-only views (never loop11/live), attach 4 fresh ones
  local i d L
  for i in 0 1 2 3; do
    d=$(findmnt -no SOURCE /mnt/ct116-ro$i 2>/dev/null)
    [ -z "$d" ] && continue
    case "$(losetup -nlO RO "$d" | tr -d " ")" in 1) ;; *) echo "REFUSING: $d is not read-only"; return 1;; esac
    umount /mnt/ct116-ro$i && losetup -d "$d" || return 1
  done
  for i in 0 1 2 3; do
    L=$(losetup -r -f --show $RAW) && mount -t ext4 -o ro,noload $L /mnt/ct116-ro$i || return 1
  done
}
nonpg_sync() {      # $1 = extra rsync flags; MariaDB, MinIO-recent and the rest in parallel
  # containerd's overlay snapshots hold ~750k of the ~790k files, so they are split across 3 more workers
  local x=$1 W=/root/ct116-copy/work-cut; mkdir -p $W; rm -f $W/snap.*
  local SNAP=var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots
  (cd /mnt/ct116-ro2/$MREL && find . -mindepth 4 -maxdepth 4 -type d -newermt "$MSINCE") > $W/mdays
  (cd /mnt/ct116-ro3/$SNAP && ls -1) | awk -v w=$W '{print "./" $0 > (w "/snap." (NR%3))}'
  rsync $OPTS $x --delete /mnt/ct116-ro1/$MDB/ $D1/$MDB/ > /root/ct116-copy/log/cut-mdb.log 2>&1 & p1=$!
  rsync $OPTS $x -r --files-from=$W/mdays /mnt/ct116-ro2/$MREL/ $D1/$MREL/ > /root/ct116-copy/log/cut-minio.log 2>&1 & p2=$!
  rsync $OPTS $x -x --delete --exclude="/$PGREL/*" --exclude="/$MREL/" --exclude="/$LREL" --exclude="/$MDB/" \
    --exclude="/$SNAP/*" /mnt/ct116-ro0/ $D1/ > /root/ct116-copy/log/cut-root.log 2>&1 & p3=$!
  local i r rs=0 ps=()
  for i in 0 1 2; do
    rsync $OPTS $x -r --delete --files-from=$W/snap.$i /mnt/ct116-ro$((i+1))/$SNAP/ $D1/$SNAP/ \
      > /root/ct116-copy/log/cut-snap.$i.log 2>&1 & ps+=($!)
  done
  wait $p1; r1=$?; wait $p2; r2=$?; wait $p3; r3=$?
  for i in 0 1 2; do wait ${ps[$i]}; r=$?; [ $r -gt $rs ] && rs=$r; done
  echo "mariadb=$r1 minio=$r2 root=$r3 snapshots=$rs"
}
