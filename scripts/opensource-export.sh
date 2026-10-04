#!/usr/bin/env bash
# Export the public source tree. This is intentionally the only supported export
# path: it reads tracked files from git, never copies a working directory.
set -euo pipefail

usage() {
  echo "usage: $0 <empty-output-dir> [git-ref]" >&2
  exit 2
}

out="${1:-}"
ref="${2:-HEAD}"
[[ -n "$out" ]] || usage
[[ ! -e "$out" ]] || { echo "refusing to overwrite existing output: $out" >&2; exit 2; }

root="$(git rev-parse --show-toplevel)"
cd "$root"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Keep the public cookbook and shipped skills, but not internal process records.
paths=()
while IFS= read -r -d '' path; do
  case "$path" in
    # Current OpenSpec contracts and public active changes are source material.
    # Archived work and this one-time release safety record are not.
    openspec/changes/archive/*|openspec/changes/opensource-release/*)
      continue
      ;;
    AGENTS.md|CLAUDE.md|.task-9-report.md|OPENSOURCE-AUDIT.md|OPENSOURCE-PLAN.md|docs/superpowers/*|docs/POSITIONING.md|docs/ROADMAP.md|docs/TODO.md|docs/research/*|data/*|.claude/*)
      [[ "$path" == .claude/skills/* ]] || continue
      ;;
  esac
  paths+=("$path")
done < <(git ls-files -z)

mkdir -p "$out"
git archive --format=tar "$ref" -- "${paths[@]}" | tar -xf - -C "$out"
node "$script_dir/opensource-scrub-public-docs.mjs" "$out"

# A tree with local state is not a release candidate. Leave it in place for
# inspection rather than deleting evidence of a failed safety gate.
hits=()
while IFS= read -r hit; do hits+=("$hit"); done < <(
  rg --files --hidden "$out" -g '.env' -g '*.env' -g 'config.yaml' -g 'cookies.json' -g '*.db' || true
)
[[ -d "$out/data" ]] && hits+=("$out/data/")
if ((${#hits[@]})); then
  printf '[opensource-export] refused: forbidden release content:\n' >&2
  printf '  %s\n' "${hits[@]}" >&2
  : > "$out/.EXPORT_REJECTED"
  exit 1
fi

printf '[opensource-export] wrote %s from %s\n' "$out" "$ref"
