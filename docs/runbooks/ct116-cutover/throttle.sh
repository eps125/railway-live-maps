#!/bin/bash
# Adaptive throttle for ct116-copy.service. Production health signal: average write
# latency of CT 116's own writes on its live (read-write) loop device. Baseline 6.9 ms.
# DEVS: space-separated copy source devices; each gets the same per-device limit.
set -u
UNIT=ct116-copy.service; DEVS=${DEVS:-/dev/loop10}
BW=${BW:-40}; IOPS=${IOPS:-800}
MINBW=5; MAXBW=${MAXBW:-400}; MINIOPS=100; MAXIOPS=${MAXIOPS:-8000}
# latency bands in tenths of ms: raise below LO, hold to HI, cut to MAXL, halve above
LO=${LO:-100}; HI=${HI:-150}; MAXL=${MAXL:-250}
LOG=/root/ct116-copy/log/throttle.log
apply() { local a=() d; for d in $DEVS; do a+=("IOReadBandwidthMax=$d ${BW}M" "IOReadIOPSMax=$d $IOPS"); done; systemctl set-property --runtime $UNIT "${a[@]}"; }
# CT 116's live disk = the read-WRITE loop device backing the raw image (its number changes on CT restart)
live() { losetup -nlO NAME,RO -j /vault/data/images/116/vm-116-disk-0.raw | awk '$2==0{print $1}' | head -1 | xargs -r basename; }
st() { local r=0 s=0 d x L; L=$(live); for d in $DEVS; do x=($(cat /sys/block/$(basename $d)/stat)); r=$((r+x[0])); s=$((s+x[2])); done; echo $r $s $(awk '{print $5, $8}' /sys/block/${L:?no live loop}/stat); }
pool_ok() {  # ONLINE and no new device errors (the known bad-LBA plug file stays listed as a data error by design)
  [ "$(zpool list -Ho health vault)" = ONLINE ] || return 1
  zpool status -p vault | awk '$1 ~ /^(scsi-|mirror-)/ && ($3+$4+$5)>0 {bad=1} END{exit bad}'
}
apply
echo "$(date -Is) start bands=$LO/$HI/$MAXL devs=[$DEVS] bw=${BW}M iops=$IOPS (per device)" >> $LOG
paused=0; hot=0; COOL=${COOL:-180}
while systemctl is-active -q $UNIT; do
  read r0 s0 w0 wt0 < <(st); sleep 30; read r1 s1 w1 wt1 < <(st)
  dw=$((w1-w0)); lat10=0; [ $dw -gt 0 ] && lat10=$(( (wt1-wt0)*10/dw ))
  rmb=$(( (s1-s0)*512/30/1048576 )); riops=$(( (r1-r0)/30 ))
  if ! pool_ok; then
    [ $paused = 0 ] && systemctl kill -s STOP $UNIT && paused=1
    echo "$(date -Is) POOL NOT HEALTHY - copy paused (SIGSTOP)" >> $LOG; continue
  fi
  if [ $lat10 -gt $MAXL ]; then hot=$((hot+1)); else hot=0; fi
  if [ $hot -ge 2 ]; then
    systemctl kill -s STOP $UNIT
    echo "$(date -Is) AUTO-PAUSE: ct_wlat_ms=$((lat10/10)) above limit twice; copy stopped for ${COOL}s" >> $LOG
    sleep $COOL; systemctl kill -s CONT $UNIT; hot=0
    BW=$MINBW; IOPS=$MINIOPS; apply
    echo "$(date -Is) AUTO-RESUME at minimum bw=${BW}M iops=$IOPS" >> $LOG; continue
  fi
  if   [ $lat10 -gt $MAXL ]; then BW=$((BW/2)); IOPS=$((IOPS/2)); act=halve
  elif [ $lat10 -gt $HI ]; then BW=$((BW*3/4)); IOPS=$((IOPS*3/4)); act=cut
  elif [ $lat10 -lt $LO ]; then BW=$((BW*5/4+1)); IOPS=$((IOPS*5/4+1)); act=raise
  else act=hold; fi
  [ $BW -lt $MINBW ] && BW=$MINBW; [ $BW -gt $MAXBW ] && BW=$MAXBW
  [ $IOPS -lt $MINIOPS ] && IOPS=$MINIOPS; [ $IOPS -gt $MAXIOPS ] && IOPS=$MAXIOPS
  apply
  echo "$(date -Is) ct_writes/s=$((dw/30)) ct_wlat_ms=$((lat10/10)).$((lat10%10)) copy_read=${rmb}MB/s ${riops}iops -> $act bw=${BW}M iops=$IOPS per dev" >> $LOG
done
echo "$(date -Is) copy unit inactive, throttle exiting" >> $LOG
