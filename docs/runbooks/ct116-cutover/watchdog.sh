#!/bin/bash
# Independent cutover watchdog (own systemd unit). Usage: watchdog.sh <T0 epoch> <limit seconds>
# If the config-switch marker does not exist by T0+limit, it runs abort.sh itself - whatever step the
# cutover script is stuck in.
T0=$1; LIMIT=$2
MARK=/root/ct116-copy/switched
while [ $(( $(date +%s) - T0 )) -lt "$LIMIT" ]; do
  [ -e "$MARK" ] && exit 0
  sleep 1
done
[ -e "$MARK" ] && exit 0
echo "$(date -Is) WATCHDOG fired at T+${LIMIT}s - no config switch yet" >> /root/ct116-copy/log/cutover.log
exec /root/ct116-copy/abort.sh
