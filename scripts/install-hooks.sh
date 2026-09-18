#!/usr/bin/env bash
# =============================================================================
# install-hooks.sh
# Installs AlphaForge git hooks into .git/hooks/
# Run once per clone: `make install-hooks`  or  `bash scripts/install-hooks.sh`
# =============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SRC="${PROJECT_ROOT}/scripts/git-hooks"
HOOKS_DST="${PROJECT_ROOT}/.git/hooks"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
ok()  { echo -e "${GREEN}✓${RESET} $*"; }
log() { echo -e "${CYAN}»${RESET} $*"; }

if [[ ! -d "$HOOKS_DST" ]]; then
  echo "Error: .git/hooks not found — are you inside a git repo?" >&2
  exit 1
fi

for hook_file in "$HOOKS_SRC"/*; do
  hook_name="$(basename "$hook_file")"
  dst="${HOOKS_DST}/${hook_name}"

  # Back up any existing hook that isn't already ours
  if [[ -f "$dst" ]] && ! grep -q "AlphaForge" "$dst" 2>/dev/null; then
    log "Backing up existing ${hook_name} → ${hook_name}.bak"
    cp "$dst" "${dst}.bak"
  fi

  cp "$hook_file" "$dst"
  chmod +x "$dst"
  ok "Installed ${hook_name}"
done

echo ""
ok "All hooks installed. Auto-redeploy is active."
echo ""
echo "  • Every git commit will rebuild affected Docker services."
echo "  • Set SKIP_DEPLOY=1 before committing to skip a rebuild."
echo "  • Logs are written to scripts/deploy.log"
echo ""
