#!/bin/bash
# Full non-Postgres catch-up from a freeze-consistent view (CT 116 keeps running). Run under ct116-copy with the throttle.
set -u
. /root/ct116-copy/cutover-common.sh
log() { echo "$(date -Is) CATCHUP $*" | tee -a "$CLOG"; }
R=/proc/$(lxc-info -n $CT -pH)/root; sync; fsfreeze -f "$R"; fsfreeze -u "$R"
remount_views || { log "remount failed"; exit 1; }
log "fresh post-freeze views; MSINCE=$MSINCE"
t=$(date +%s); res=$(nonpg_sync ""); log "done in $(( $(date +%s)-t ))s: $res"
