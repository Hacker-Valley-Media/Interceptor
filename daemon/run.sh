#!/bin/bash
echo "$(date) run.sh started" >> /tmp/slop-browser-run.log
echo "$(date) PATH=$PATH" >> /tmp/slop-browser-run.log
echo "$(date) pwd=$(pwd)" >> /tmp/slop-browser-run.log
exec /Users/ronaldeddings/.bun/bin/bun run /Volumes/VRAM/00-09_System/01_Tools/slop-browser/daemon/index.ts 2>> /tmp/slop-browser-run.log
