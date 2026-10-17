#!/bin/bash
# Emergency abort for the CT 116 cutover: bring production back on the ORIGINAL raw disk, fast.
# Safe to run any time BEFORE the config switch (the watchdog only calls it if the switch marker is absent).
set -u
. /root/ct116-copy/cutover-common.sh
log() { echo "$(date -Is) ABORT $*" | tee -a "$CLOG"; }
MARK=/root/ct116-copy/switched
if [ -e "$MARK" ]; then log "config already switched - abort.sh refusing (use the post-switch rollback instead)"; exit 1; fi
log "start"
# 1. stop the cutover script and any copy in flight (never our own process)
for p in $(pgrep -f "/root/ct116-copy/cutover.sh"); do [ "$p" != "$$" ] && kill "$p" 2>/dev/null; done
pkill -x rsync 2>/dev/null
# 2. detach our read-only views (they block CT 116's pre-start hook)
for i in 0 1 2 3; do
  d=$(findmnt -no SOURCE /mnt/ct116-ro$i 2>/dev/null); [ -z "$d" ] && continue
  umount -l /mnt/ct116-ro$i; losetup -d "$d" 2>/dev/null
done
log "views detached; raw disk loops now: $(losetup -nlO NAME,RO -j "$RAW" | tr '\n' ' ')"
# 3. start CT 116 on the untouched config (rootfs = raw disk)
grep -q "^rootfs: data:116/vm-116-disk-0.raw" /etc/pve/lxc/116.conf || log "WARNING: rootfs is not the raw disk"
if ! pct status $CT | grep -q running; then pct start $CT || { sleep 2; pct start $CT; }; fi
log "CT 116: $(pct status $CT)"
# 4. Postgres was stopped with docker stop (unless-stopped) -> start it explicitly
for _ in $(seq 1 60); do X docker info >/dev/null 2>&1 && break; sleep 1; done
X docker start railway-live-map-postgres-1 >/dev/null 2>&1
for _ in $(seq 1 60); do X docker exec -u postgres railway-live-map-postgres-1 pg_isready -q 2>/dev/null && break; sleep 1; done
log "Postgres ready: $(X docker exec -u postgres railway-live-map-postgres-1 pg_isready 2>&1)"
log "done - production restored on the original disk. FOLLOW-UP: drop slot ct116_migrate; replica is diverged."
