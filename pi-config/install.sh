#!/usr/bin/env bash
# pi-config/install.sh — bootstrap the live pi agent config (~/.pi/agent) from
# the versioned copy in this repo (pi-config/ + pi-chleba-extensions/).
#
# - Idempotent: re-running is a no-op when everything is already linked.
# - Anything overwritten is backed up under ~/.pi/backups/<timestamp>/,
#   preserving its path relative to the agent dir.
# - Symlink targets are computed relative at runtime, so the repo can live
#   anywhere (and multiple clones can coexist).
#
# auth.json is NEVER read, copied, or printed by this script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${HOME}/.pi/backups/${TIMESTAMP}"

LINKED=()
SKIPPED=()
BACKED_UP=()

# Print a path relative to AGENT_DIR (for tidy output).
rel_to_agent() {
	local p="$1"
	if [[ "$p" == "$AGENT_DIR"/* ]]; then
		printf '%s\n' "${p#"$AGENT_DIR"/}"
	else
		printf '%s\n' "$p"
	fi
}

# Move an existing real file/dir at $1 (a path under AGENT_DIR) into the
# backup root, preserving its path relative to AGENT_DIR. The backup root is
# created lazily — only when something is actually backed up.
backup_item() {
	local dst="$1"
	local rel bp
	rel="$(rel_to_agent "$dst")"
	bp="${BACKUP_ROOT}/${rel}"
	mkdir -p "$(dirname "$bp")"
	mv "$dst" "$bp"
	BACKED_UP+=("$rel")
}

# link_into_agent <src> <dst>
# Make <dst> a symlink to <src>, using a relative target computed at runtime.
#   dst symlink already resolving to src  -> skip
#   dst symlink pointing elsewhere        -> replace
#   dst real file/dir                     -> back up, then symlink
#   dst missing                           -> symlink directly
link_into_agent() {
	local src="$1"
	local dst="$2"

	if [[ ! -e "$src" ]]; then
		echo "ERROR: source does not exist: $src" >&2
		exit 1
	fi

	mkdir -p "$(dirname "$dst")"
	local rel_target
	rel_target="$(realpath --relative-to="$(dirname "$dst")" "$src")"

	if [[ -L "$dst" ]]; then
		local cur
		cur="$(realpath "$dst" 2>/dev/null || true)"
		if [[ "$cur" == "$(realpath "$src")" ]]; then
			SKIPPED+=("$(rel_to_agent "$dst")")
			return
		fi
		rm "$dst"
		ln -s "$rel_target" "$dst"
		LINKED+=("$(rel_to_agent "$dst")")
		return
	fi

	if [[ -e "$dst" ]]; then
		backup_item "$dst"
	fi
	ln -s "$rel_target" "$dst"
	LINKED+=("$(rel_to_agent "$dst")")
}

mkdir -p "$AGENT_DIR"

# --- versioned config: pi-config/* -> $AGENT_DIR ---
link_into_agent "$REPO_ROOT/pi-config/settings.json"              "$AGENT_DIR/settings.json"
link_into_agent "$REPO_ROOT/pi-config/model-params.json"          "$AGENT_DIR/model-params.json"
link_into_agent "$REPO_ROOT/pi-config/orch/config.json"           "$AGENT_DIR/orch/config.json"
link_into_agent "$REPO_ROOT/pi-config/themes/omarchy-system.json" "$AGENT_DIR/themes/omarchy-system.json"
link_into_agent "$REPO_ROOT/pi-config/skills"                     "$AGENT_DIR/skills"
link_into_agent "$REPO_ROOT/pi-config/extensions-disabled"        "$AGENT_DIR/extensions-disabled"

# --- extensions versioned in this repo -> $AGENT_DIR/extensions ---
link_into_agent "$REPO_ROOT/pi-chleba-extensions/ollamamq.ts"     "$AGENT_DIR/extensions/ollamamq.ts"
link_into_agent "$REPO_ROOT/pi-chleba-extensions/model-params.ts" "$AGENT_DIR/extensions/model-params.ts"
link_into_agent "$REPO_ROOT/pi-chleba-extensions/omarchy-system-theme.ts" "$AGENT_DIR/extensions/omarchy-system-theme.ts"
link_into_agent "$REPO_ROOT/pi-chleba-extensions/searxng.ts"      "$AGENT_DIR/extensions/searxng.ts"
link_into_agent "$REPO_ROOT/packages/coding-agent/examples/extensions/sampling-params.ts" "$AGENT_DIR/extensions/sampling-params.ts"

# auth.json is deliberately not versioned (secrets) — warn if it is missing.
if [[ ! -f "$AGENT_DIR/auth.json" ]]; then
	{
		echo "WARNING: $AGENT_DIR/auth.json not found."
		echo "  auth.json is intentionally not versioned and must be restored manually:"
		echo "  copy it from an existing machine, or run 'pi' and complete the auth login."
	} >&2
fi

# Reconcile the npm packages declared in settings.json (pi-playwright,
# pi-orch-extension, pi-hermes-memory). Best effort: skip silently when pi is
# not installed; warn without failing when the update itself fails.
if command -v pi >/dev/null 2>&1; then
	if ! pi update --extensions; then
		echo "WARNING: 'pi update --extensions' failed (non-fatal)." >&2
		echo "  Run it manually to (re)install the npm packages from settings.json." >&2
	fi
fi

# --- summary ---
echo
echo "=== pi-config install summary ==="
echo "agent dir: $AGENT_DIR"
if [[ ${#BACKED_UP[@]} -gt 0 ]]; then
	echo "backed up (${#BACKED_UP[@]}) -> $BACKUP_ROOT:"
	printf '  %s\n' "${BACKED_UP[@]}"
fi
if [[ ${#LINKED[@]} -gt 0 ]]; then
	echo "linked (${#LINKED[@]}):"
	printf '  %s\n' "${LINKED[@]}"
fi
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
	echo "already linked, skipped (${#SKIPPED[@]}):"
	printf '  %s\n' "${SKIPPED[@]}"
fi
if [[ ${#LINKED[@]} -eq 0 && ${#BACKED_UP[@]} -eq 0 ]]; then
	echo "nothing to do — all links already in place."
fi
