#!/bin/sh
# World Monitor entrypoint (R-11).
#
# The server writes runs/latest.json every sweep. When /app/runs is a mounted
# volume it arrives owned by the host user, so a container that starts as
# uid 1001 cannot write it — sweep persistence breaks silently on Linux.
# macOS Docker Desktop's file-sharing layer masks this, so it passes locally
# and fails on deploy.
#
# We therefore start as root, align ownership, then drop to `crucix` for the
# server itself. `USER crucix` in the Dockerfile is deliberately absent: with
# it, su-exec dies at setgroups("Operation not permitted").
set -e

mkdir -p /app/runs 2>/dev/null || true
chown -R crucix:crucix /app/runs 2>/dev/null || true

# A real write probe. `test -w` reads permission bits and returns true on a
# read-only mount, so it cannot detect ro.
if ! su-exec crucix sh -c ': > /app/runs/.wm-write-probe && rm -f /app/runs/.wm-write-probe' 2>/dev/null; then
  echo "[WorldMonitor] FATAL: /app/runs is not writable by crucix (read-only mount or un-chownable volume)" >&2
  exit 78
fi

# Delegate to the base image's entrypoint so `docker run IMG --version` and
# `docker run IMG script.mjs` keep working.
exec su-exec crucix docker-entrypoint.sh "$@"
