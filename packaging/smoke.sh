#!/bin/sh
# Versioned smoke run of a STAGED binary (never an installed one). Own window
# only, private short roots under $HOME/.m4s-smoke, removed afterwards. The
# probe flags are deliberately set here, NOT through the launcher (it refuses
# them). Usage: packaging/smoke.sh <stage-dir>   (needs DISPLAY/XAUTHORITY)
set -eu
stage="${1:?usage: smoke.sh <stage-dir>}"
root="$HOME/.m4s-smoke"
mkdir -m 700 "$root" "$root/project"
trap 'rmdir "$root/sock" 2>/dev/null || true; rmdir "$root/project" "$root"' EXIT
GDK_BACKEND=x11 ABITO_PROBE=1 ABITO_PROJECT_ROOT="$root/project" ABITO_SOCKET_DIR="$root/sock" \
  timeout -s KILL 70 "$stage/abito-island" > "$root/probe.log" 2>&1 || true
grep -o '"ready_ok":[a-z]*\|"notice_count":[0-9]*\|"connections_while_connected":[0-9]*\|"svg_elements_rendered_by_clay_engine":[0-9]*\|"canvas_elements":[0-9]*' "$root/probe.log"
rm -f "$root/probe.log"
