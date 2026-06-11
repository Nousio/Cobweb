#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_DIR="${RUNNER_TEMP:-${ROOT_DIR}/.tmp}/cobweb-tarballs"
INSTALL_DIR="$(mktemp -d)"
DATA_DIR="$(mktemp -d)"
DAEMON_LOG="${INSTALL_DIR}/cobwebd.log"

cleanup() {
  COBWEB_DATA_DIR="${DATA_DIR}" "${INSTALL_DIR}/bin/cobweb" daemon stop >/dev/null 2>&1 || true
  if [[ -n "${daemon_pid:-}" ]]; then
    wait "${daemon_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${INSTALL_DIR}" "${DATA_DIR}" "${PACK_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"
rm -rf "${PACK_DIR}"
mkdir -p "${PACK_DIR}"
VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('packages/cobweb/package.json', 'utf8')).version")"

bash scripts/pack-release.sh "${PACK_DIR}"

AGGREGATE_TARBALL="${PACK_DIR}/cobweb-${VERSION}.tgz"
if [[ ! -f "${AGGREGATE_TARBALL}" ]]; then
  echo "missing aggregate tarball: ${AGGREGATE_TARBALL}" >&2
  exit 1
fi

npm install --global --prefix "${INSTALL_DIR}" "${AGGREGATE_TARBALL}" >/dev/null

"${INSTALL_DIR}/bin/cobweb" --version | grep -qx "${VERSION}"
"${INSTALL_DIR}/bin/cw" --version | grep -qx "${VERSION}"

COBWEB_DATA_DIR="${DATA_DIR}" "${INSTALL_DIR}/bin/cobwebd" >"${DAEMON_LOG}" 2>&1 &
daemon_pid=$!

for _ in {1..40}; do
  if [[ -S "${DATA_DIR}/cobwebd.sock" ]]; then
    break
  fi
  sleep 0.25
done

if [[ ! -S "${DATA_DIR}/cobwebd.sock" ]]; then
  echo "cobwebd socket was not created" >&2
  exit 1
fi

COBWEB_DATA_DIR="${DATA_DIR}" "${INSTALL_DIR}/bin/cobwebd" --status >/dev/null
node - "${INSTALL_DIR}/bin/cobweb-mcp" "${DATA_DIR}" <<'NODE'
import { spawn } from "node:child_process";

const [bin, dataDir] = process.argv.slice(2);
const child = spawn(bin, [], {
  env: { ...process.env, COBWEB_DATA_DIR: dataDir },
  stdio: ["pipe", "pipe", "inherit"],
});

const responses = new Map();
let buffer = "";
const timeout = setTimeout(() => {
  child.kill();
  console.error("timed out waiting for cobweb-mcp smoke response");
  process.exit(1);
}, 5000);

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      break;
    }
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) {
      continue;
    }
    const message = JSON.parse(line);
    if (message.id !== undefined) {
      responses.set(message.id, message);
    }
    const tools = responses.get(2)?.result?.tools;
    if (Array.isArray(tools) && tools.some((tool) => tool.name === "status")) {
      clearTimeout(timeout);
      child.kill();
      process.exit(0);
    }
  }
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cobweb-smoke", version: "0.0.0" },
  },
});
send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
NODE

COBWEB_DATA_DIR="${DATA_DIR}" "${INSTALL_DIR}/bin/cobweb" daemon stop >/dev/null
wait "${daemon_pid}"
unset daemon_pid

COBWEB_DATA_DIR="${DATA_DIR}" "${INSTALL_DIR}/bin/cobweb" import examples/skills/normal-review --write >/dev/null
COBWEB_DATA_DIR="${DATA_DIR}" "${INSTALL_DIR}/bin/cobweb" daemon status >/dev/null
COBWEB_DATA_DIR="${DATA_DIR}" "${INSTALL_DIR}/bin/cobweb" daemon stop >/dev/null
