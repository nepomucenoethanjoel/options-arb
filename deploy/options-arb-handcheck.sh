#!/bin/bash
# options-arb daily live handchecks — run from cron
# (deploy/options-arb-handcheck.cron). Re-verifies one Olive × Derive signal
# (handcheck.ts) and one book-venue pair (handcheck-books.ts) against fresh
# venue data. Exit codes from the scripts: 0 ✓, 1 a field ✗ / error, 3
# nothing to check right now. Each check gets up to 3 attempts a minute
# apart (Olive check compares a fresh fetch to the cycle, so one-tick quote
# drift can fail a single attempt); only a check that fails every attempt
# alerts, via the server's configured transports (npm run alert:test).
set -uo pipefail
cd /opt/options-arb/server
LOG=/var/log/options-arb-handcheck.log

check() {
  local name=$1 script=$2 out code=1
  for attempt in 1 2 3; do
    out=$(HANDCHECK_AUTO=1 timeout 300 npx --no-install tsx "$script" 2>&1)
    code=$?
    if [ "$code" -eq 0 ] || [ "$code" -eq 3 ]; then break; fi
    [ "$attempt" -lt 3 ] && sleep 60
  done
  { echo "$(date -Is) $name exit=$code (attempt $attempt)"; echo "$out" | tail -40; } >> "$LOG"
  if [ "$code" -ne 0 ] && [ "$code" -ne 3 ]; then
    local lines
    lines=$(echo "$out" | grep -E '✗|FAILED|MISMATCH' | head -6)
    npx --no-install tsx src/scripts/alert-test.ts "⚠️ options-arb handcheck ($name) failed 3 attempts (exit $code):
$lines
log: $LOG" >> "$LOG" 2>&1
  fi
}

check olive src/scripts/handcheck.ts
check books src/scripts/handcheck-books.ts
