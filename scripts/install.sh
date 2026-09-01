#!/usr/bin/env bash
# Installs this monorepo as a local dev setup on a fresh machine:
# installs deps, builds all workspace packages, and links `pi` onto PATH.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Node version check (minimum from root package.json engines.node) ---
if ! command -v node >/dev/null 2>&1; then
  # No node available to parse package.json, so extract the requirement with sed.
  echo "error: Node.js not found in PATH (required: $(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json), found: none)" >&2
  exit 1
fi

required="$(node -p "require('./package.json').engines.node")" # e.g. >=22.19.0
min_version="${required//[^0-9.]/}"                            # 22.19.0
current="$(node --version)"                                    # vXX.YY.ZZ

if ! node -e '
  const [min, cur] = process.argv.slice(1).map((v) => v.replace(/^v/, "").split(".").map(Number));
  const score = (p) => ((p[0] || 0) * 100 + (p[1] || 0)) * 100 + (p[2] || 0);
  process.exit(score(cur) >= score(min) ? 0 : 1);
' "$min_version" "$current"; then
  echo "error: Node.js ${required} required, found ${current}" >&2
  exit 1
fi

# --- Install and build ---
npm install --ignore-scripts # repo rule: never run lifecycle scripts
npm run build                # builds all workspace packages in dependency order

# --- Link `pi` onto PATH ---
mkdir -p "$HOME/.local/bin"
target="$REPO_ROOT/packages/coding-agent/dist/cli.js"
link="$HOME/.local/bin/pi"

if [ -e "$link" ] || [ -L "$link" ]; then
  if [ ! -L "$link" ]; then
    echo "error: $link exists and is not a symlink. Move it out of the way, then rerun this script." >&2
    exit 1
  fi
  rm "$link" # replace existing symlink
fi
ln -s "$target" "$link"

# --- PATH check ---
case ":${PATH}:" in
*":$HOME/.local/bin:"*) ;;
*)
  echo "warning: $HOME/.local/bin is not in your PATH. Add this to your shell rc and reload the shell:" >&2
  echo '         export PATH="$HOME/.local/bin:$PATH"' >&2
  ;;
esac

# --- Optional config restore (tarball expected to contain a .pi/ directory) ---
if [ -n "${PI_CONFIG_TARBALL:-}" ]; then
  if [ ! -f "$PI_CONFIG_TARBALL" ]; then
    echo "error: PI_CONFIG_TARBALL is set but $PI_CONFIG_TARBALL does not exist" >&2
    exit 1
  fi
  tar xzf "$PI_CONFIG_TARBALL" -C "$HOME"
fi

# --- Verify and summarize ---
echo "pi version check:"
"$link" --version

cat <<'EOF'
Next steps:
- Provider auth/config lives in ~/.pi. Copy it from another machine, or set
  PI_CONFIG_TARBALL=/path/to/pi-config.tar.gz (containing .pi/) and rerun this
  script, or just run `pi` and log in.
- `pi` is now available on PATH (reload your shell if a PATH warning was shown).
EOF
