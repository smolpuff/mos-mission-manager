#!/bin/sh
# Copied to a private sibling staging directory before launch. No app runtime required.
set -u
umask 077
target=$1
transaction=$2
parent_pid=$3
token=$4
version=$5
lock=$6

state() {
  printf '%s\n' "$1" > "$transaction/state.next"
  /bin/mv -f "$transaction/state.next" "$transaction/state"
}
unlock() {
  if [ "$(/bin/cat "$lock/token" 2>/dev/null)" = "$token" ]; then
    /bin/rm -f "$lock/token"
    /bin/rmdir "$lock" 2>/dev/null || true
  fi
}
abort() { state "$1"; unlock; exit 1; }
reopen_old() {
  if [ -e "$target" ]; then
    /bin/mv "$target" "$transaction/failed.app" || abort recovery_required
  fi
  /bin/mv "$transaction/backup.app" "$target" || abort recovery_required
  state rolled_back
  unlock
  /usr/bin/open -n "$target" || true
  exit 1
}

[ "$(/bin/cat "$lock/token" 2>/dev/null)" = "$token" ] || exit 1
printf '%s\n' "$$" > "$transaction/helper.pid"
state ready
: > "$transaction/ready"
count=0
while [ ! -f "$transaction/commit" ]; do
  [ ! -f "$transaction/cancel" ] || abort cancelled
  kill -0 "$parent_pid" 2>/dev/null || abort cancelled
  count=$((count + 1))
  [ "$count" -lt 90 ] || abort commit_timeout
  /bin/sleep 1
done
count=0
while kill -0 "$parent_pid" 2>/dev/null; do
  [ ! -f "$transaction/cancel" ] || abort cancelled
  count=$((count + 1))
  [ "$count" -lt 60 ] || abort exit_timeout
  /bin/sleep 1
done
[ ! -f "$transaction/cancel" ] || abort cancelled
state replacing
if ! /bin/mv "$target" "$transaction/backup.app"; then
  state replace_failed
  unlock
  /usr/bin/open -n "$target" || true
  exit 1
fi
state backed_up
/bin/mv "$transaction/payload/missions-v3-mcp.app" "$target" || reopen_old
state opening
/usr/bin/open -n "$target" --args "--missions-update-token=$token" || reopen_old
count=0
while [ "$(/bin/cat "$transaction/healthy" 2>/dev/null)" != "$token $version" ]; do
  count=$((count + 1))
  if [ "$count" -ge 120 ]; then
    # The new app may be running: never swap it out merely because acknowledgement is late.
    abort startup_timeout
  fi
  /bin/sleep 1
done
state complete
unlock
# Keep the small journal/log for diagnostics; remove only this transaction's owned payloads.
/bin/rm -rf "$transaction/backup.app" "$transaction/payload"
/bin/rm -f "$transaction/update.zip" "$transaction/failed.app"
exit 0
