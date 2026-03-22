#!/bin/bash
set -euo pipefail

SESSIONS_DIR="${HOME}/.claude/projects"
OUTPUT="/tmp/slop-auto-improve-sessions.json"
RECENCY_HOURS="${SLOP_RECENCY_HOURS:-24}"

cutoff=$(date -v-${RECENCY_HOURS}H "+%Y-%m-%dT%H:%M:%S" 2>/dev/null || \
         date -d "${RECENCY_HOURS} hours ago" "+%Y-%m-%dT%H:%M:%S" 2>/dev/null || \
         echo "2020-01-01")

tmpfile=$(mktemp)
trap "rm -f $tmpfile" EXIT

fd --type f --extension jsonl --changed-after "$cutoff" . "$SESSIONS_DIR" \
    --exec rg -l -i "slop|mcp__claude-in-chrome|claude-in-chrome" {} \; 2>/dev/null | head -50 > "$tmpfile" || true

count=$(wc -l < "$tmpfile" | tr -d ' ')

if [ "$count" -eq 0 ]; then
    echo "[]" > "$OUTPUT"
    exit 1
fi

jq -R -s 'split("\n") | map(select(length > 0))' < "$tmpfile" > "$OUTPUT"
echo "$count sessions with slop references found (last ${RECENCY_HOURS}h)"
exit 0
