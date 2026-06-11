#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_DIR="${1:-${ROOT_DIR}}"
STAGE_DIR="$(mktemp -d)"
AGGREGATE_STAGE="${STAGE_DIR}/cobweb"

cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"
mkdir -p "${PACK_DIR}"
VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('packages/cobweb/package.json', 'utf8')).version")"

npm run build

npm pack --workspace packages/core --pack-destination "${PACK_DIR}" >/dev/null
npm pack --workspace packages/daemon --pack-destination "${PACK_DIR}" >/dev/null
npm pack --workspace packages/cli --pack-destination "${PACK_DIR}" >/dev/null
npm pack --workspace packages/mcp --pack-destination "${PACK_DIR}" >/dev/null

mkdir -p "${AGGREGATE_STAGE}/dist"
cp packages/cobweb/package.json "${AGGREGATE_STAGE}/package.json"
cp packages/cobweb/README.md "${AGGREGATE_STAGE}/README.md"
cp packages/cobweb/dist/* "${AGGREGATE_STAGE}/dist/"

(
  cd "${AGGREGATE_STAGE}"
  npm install --omit=dev --package-lock=false \
    "${PACK_DIR}/cobweb-core-${VERSION}.tgz" \
    "${PACK_DIR}/cobweb-daemon-${VERSION}.tgz" \
    "${PACK_DIR}/cobweb-cli-${VERSION}.tgz" \
    "${PACK_DIR}/cobweb-mcp-${VERSION}.tgz" >/dev/null
  npm pack --pack-destination "${PACK_DIR}" >/dev/null
)
