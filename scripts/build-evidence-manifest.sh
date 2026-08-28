#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

manifest_file=MANIFEST.sha256
temporary_file=$(mktemp "${TMPDIR:-/tmp}/evidence-manifest.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM

if command -v shasum >/dev/null 2>&1; then
  hash_command='shasum -a 256'
elif command -v sha256sum >/dev/null 2>&1; then
  hash_command='sha256sum'
else
  echo 'missing SHA-256 tool: install shasum or sha256sum' >&2
  exit 1
fi

find . -type f \
  -not -path './.git/*' \
  -not -path './node_modules/*' \
  -not -path '*/node_modules/*' \
  -not -path './.venv/*' \
  -not -path '*/.venv/*' \
  -not -path './__pycache__/*' \
  -not -path '*/__pycache__/*' \
  -not -path './.mypy_cache/*' \
  -not -path '*/.mypy_cache/*' \
  -not -path './.pytest_cache/*' \
  -not -path '*/.pytest_cache/*' \
  -not -path './.ruff_cache/*' \
  -not -path '*/.ruff_cache/*' \
  -not -path './build/*' \
  -not -path '*/build/*' \
  -not -path '*/dist/*' \
  -not -path '*/coverage/*' \
  -not -name '*.pyc' \
  -not -name '*.db' \
  -not -name "$manifest_file" \
  -not -name '.DS_Store' \
  -print | LC_ALL=C sort | while IFS= read -r evidence_file; do
    $hash_command "$evidence_file"
  done > "$temporary_file"

mv "$temporary_file" "$manifest_file"
trap - EXIT HUP INT TERM
echo "Wrote $manifest_file"
