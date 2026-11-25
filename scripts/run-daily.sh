#!/bin/sh
# Run the fetch now, then every day at FETCH_HOUR_UTC (default 03:00 UTC).
# Used by the `fetcher` service in docker-compose.yml.
HOUR="${FETCH_HOUR_UTC:-3}"

while true; do
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] fetch starting"
  if node scripts/fetch-data.mjs; then
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] fetch done"
  else
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] fetch FAILED (will retry at next scheduled run)"
  fi

  now=$(date -u +%s)
  next=$(( now / 86400 * 86400 + HOUR * 3600 ))
  [ "$next" -le "$now" ] && next=$(( next + 86400 ))
  echo "next run: $(date -u -d "@$next" '+%Y-%m-%d %H:%M UTC')"
  sleep $(( next - now ))
done
