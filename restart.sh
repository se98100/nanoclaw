#!/bin/bash
set -e

systemctl stop nanoclaw &
STOP_PID=$!
sleep 5
kill $STOP_PID 2>/dev/null || true

pids=$(pgrep -f nano 2>/dev/null || true)
if [ -n "$pids" ]; then
  echo "Killing leftover nano processes: $pids"
  kill -9 $pids
else
  echo "No leftover nano processes found"
fi

systemctl start nanoclaw
echo "nanoclaw started"
