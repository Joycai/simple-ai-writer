#!/usr/bin/env bash
# Run on a disposable Docker host; resources get unique names and are cleaned up.
set -euo pipefail
image=${1:?Usage: docker-smoke-test.sh IMAGE}
name="aiw-smoke-$$"
volume="$name-data"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
start() {
  docker run -d --name "$name" -v "$volume:/data" "$@" "$image" >/dev/null
  for attempt in $(seq 1 60); do
    if [ "$(docker inspect --format '{{.State.Health.Status}}' "$name")" = healthy ]; then
      return
    fi
    sleep 2
  done
  # Do not print startup logs: they contain generated credentials.
  echo 'Container did not become healthy' >&2
  exit 1
}
request() {
  docker exec "$name" curl --silent --show-error "$@" http://127.0.0.1:8787/v1/kbs
}
start
test "$(docker exec "$name" id -u)" != 0
test "$(request -o /dev/null -w '%{http_code}')" = 401
before=$(docker exec "$name" sha256sum /data/config.toml)
docker rm -f "$name" >/dev/null
token=container-smoke-test-token-0123456789
start -e "AIW_KB_TOKENS=$token" -e AIW_KB_ADMIN_USER=operator \
  -e AIW_KB_ADMIN_PASSWORD=smoke-password -e AIW_KB_ADMIN_SESSION_HOURS=24
test "$before" = "$(docker exec "$name" sha256sum /data/config.toml)"
test "$(request -o /dev/null -w '%{http_code}')" = 401
test "$(request --fail -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"id":"smoke","name":"Persistence test"}' -o /dev/null -w '%{http_code}')" = 201
docker rm -f "$name" >/dev/null
start -e "AIW_KB_TOKENS=$token"
request --fail -H "Authorization: Bearer $token" | grep -q 'Persistence test'
echo 'Container health, authentication, non-root user and recreation persistence passed.'
