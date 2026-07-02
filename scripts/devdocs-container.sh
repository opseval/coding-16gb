#!/usr/bin/env bash
# devdocs-container.sh — OPTIONAL DevDocs web UI via the existing Colima runtime.
# The `docs` TOOL does NOT need this — it reads ~/.pi/devdocs/docs off disk. This exists only for
# (a) browsing docs at http://localhost:9292 and (b) refreshing docsets via `thor docs:download`,
# both writing to the SAME shared dir the tool reads. Even a tuned Colima VM reserves ~1-2 GiB that
# competes with the model on a 16GB box — start it on demand, `down` it when done.
#   scripts/devdocs-container.sh up             # colima (if needed) + devdocs on :9292
#   scripts/devdocs-container.sh down           # stop+remove the container (colima left running)
#   scripts/devdocs-container.sh download git   # thor docs:download <slug>… into the shared dir
#   scripts/devdocs-container.sh status
set -euo pipefail

DIR="${PI_DEVDOCS_DIR:-$HOME/.pi/devdocs/docs}"
IMAGE="${DEVDOCS_IMAGE:-ghcr.io/freecodecamp/devdocs:latest}"
NAME="devdocs"
PORT="${DEVDOCS_PORT:-9292}"
need() { command -v "$1" >/dev/null || { echo "$1 not found — $2" >&2; exit 1; }; }

cmd="${1:-up}"; shift || true
case "$cmd" in
  up)
    need colima "brew install colima docker"
    need docker "brew install docker"
    colima status >/dev/null 2>&1 || { echo "starting colima (vz, 2GB)…"; colima start --vm-type vz --memory 2; }
    mkdir -p "$DIR"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "$PORT:9292" -v "$DIR:/devdocs/public/docs" "$IMAGE" >/dev/null
    echo "devdocs starting on http://localhost:$PORT (first hit may lag while it boots)"
    echo "empty list? populate: scripts/devdocs-download.sh   or:   $0 download <slug>"
    ;;
  down)
    need docker "brew install docker"
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed $NAME" || echo "(not running)"
    ;;
  download)
    need docker "brew install docker"
    [ "${1:-}" ] || { echo "usage: $0 download <slug> [slug…]" >&2; exit 2; }
    docker exec "$NAME" thor docs:download "$@"
    echo "downloaded into shared dir: $DIR"
    ;;
  status)
    command -v colima >/dev/null && colima status 2>&1 | sed 's/^/colima: /' || echo "colima: not installed"
    command -v docker >/dev/null && docker ps --filter "name=$NAME" --format '  container: {{.Names}} {{.Status}}' || true
    if curl -sf "http://localhost:$PORT" >/dev/null 2>&1; then echo "  http: :$PORT responding"; else echo "  http: :$PORT not responding"; fi
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
