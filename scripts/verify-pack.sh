#!/usr/bin/env bash
set -euo pipefail

# Guard against shipping dev/test code in any published package.
# Inspects the exact file set npm would publish and fails if it contains
# test sources, raw src, or known dev-only paths.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PACKAGES=(core daemon cli mcp cobweb)
status=0

for pkg in "${PACKAGES[@]}"; do
  manifest="$(npm pack --dry-run --json --workspace "packages/${pkg}" 2>/dev/null)"
  offenders="$(
    node -e '
      const data = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const files = data.flatMap((entry) => entry.files ?? []).map((file) => file.path);
      const isOffender = (path) =>
        /\.test\./.test(path) ||
        /(^|\/)src\//.test(path) ||
        /(^|\/)(tests?|__tests__)\//.test(path) ||
        /(^|\/)(vitest|vite)\.config\./.test(path) ||
        /(^|\/)scripts\//.test(path);
      process.stdout.write(files.filter(isOffender).join("\n"));
    ' <<<"${manifest}"
  )"

  if [[ -n "${offenders}" ]]; then
    echo "FAIL @cobweb/${pkg}: publish set contains dev/test files:" >&2
    echo "${offenders}" | sed 's/^/  - /' >&2
    status=1
  else
    echo "OK   @cobweb/${pkg}: no test/src/dev files in publish set"
  fi
done

if [[ "${status}" -ne 0 ]]; then
  echo "" >&2
  echo "Publish guard failed. Keep tests under the root test/ directory and outside every package publish set." >&2
fi

exit "${status}"
