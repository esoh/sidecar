#!/bin/bash
set -euo pipefail

# Install the app separately from the native agent plugins, as Plannotator does.
# Overrides also let maintainers exercise the installer in an isolated directory.
sidecar_install_dir=${SIDECAR_INSTALL_DIR:-"$HOME/.local/share/sidecar"}
sidecar_bin_dir=${SIDECAR_BIN_DIR:-"$HOME/.local/bin"}
sidecar_repository=${SIDECAR_REPOSITORY:-https://github.com/esoh/sidecar.git}
sidecar_ref=${SIDECAR_REF:-main}

for tool in git node pnpm; do
  command -v "$tool" >/dev/null || { echo "Sidecar requires $tool (Node 22+ and pnpm 11+)." >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Sidecar requires Node 22+"); process.exit(1); }'
case "$sidecar_install_dir:$sidecar_bin_dir" in /*:/*) ;; *) echo 'Install and bin directories must be absolute paths.' >&2; exit 1 ;; esac
mkdir -p "$sidecar_install_dir/releases" "$sidecar_bin_dir"
sidecar_target="$sidecar_install_dir/current/scripts/sidecar"
if [ -e "$sidecar_bin_dir/sidecar" ] || [ -L "$sidecar_bin_dir/sidecar" ]; then
  if [ ! -L "$sidecar_bin_dir/sidecar" ] || [ "$(readlink "$sidecar_bin_dir/sidecar")" != "$sidecar_target" ]; then
    echo "Refusing to replace an unrelated command: $sidecar_bin_dir/sidecar" >&2
    exit 1
  fi
fi
sidecar_stage=$(mktemp -d "$sidecar_install_dir/releases/.install.XXXXXX")
trap 'rm -rf "$sidecar_stage"' EXIT
git clone --quiet --depth 1 --branch "$sidecar_ref" -- "$sidecar_repository" "$sidecar_stage/app"
sidecar_revision=$(git -C "$sidecar_stage/app" rev-parse HEAD)
sidecar_release="$sidecar_install_dir/releases/$sidecar_revision"
if [ ! -d "$sidecar_release" ]; then
  pnpm --dir "$sidecar_stage/app" install --prod --frozen-lockfile
  printf '%s\n' "$sidecar_revision" > "$sidecar_stage/app/.sidecar-revision"
  "$sidecar_stage/app/scripts/sidecar" --version
  mv "$sidecar_stage/app" "$sidecar_release"
fi
"$sidecar_release/scripts/sidecar" --version
# Publish only after installation succeeds. Retain old releases for running viewers.
node --input-type=module - "$sidecar_install_dir" "$sidecar_bin_dir" "$sidecar_release" <<'JS'
import { symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const [root, bin, release] = process.argv.slice(2);
// Selecting current is last: a command-link failure must leave the old app active.
for (const [target, path] of [[join(root, 'current/scripts/sidecar'), join(bin, 'sidecar')], [release, join(root, 'current')]]) {
  const temporary = `${path}.${process.pid}`;
  symlinkSync(target, temporary);
  renameSync(temporary, path);
}
JS
printf '\nInstalled %s\n' "$sidecar_bin_dir/sidecar"
case ":$PATH:" in *":$sidecar_bin_dir:"*) ;; *) printf 'Add this directory to your PATH: %s\n' "$sidecar_bin_dir" ;; esac
cat <<'TEXT'

Install the native integration in each agent you use:
  codex plugin marketplace add esoh/sidecar
  codex plugin add sidecar@sidecar

  claude plugin marketplace add esoh/sidecar
  claude plugin install sidecar@sidecar

Restart the agent after installation. Rerun this installer to update the app.
Existing viewers keep their old version until stopped and reopened.
TEXT
