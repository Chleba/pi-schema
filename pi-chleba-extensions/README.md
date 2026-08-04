# pi-chleba Extensions

Custom extensions for the pi-chleba fork, versioned in this repo. All files
are plain TypeScript — pi loads and runs them directly from
`~/.pi/agent/extensions/` at startup, so the source **is** the build. No
compile step.

## Extensions

- **lmstudio** — Connects pi to a local LM Studio server on another PC.
  Discovers models from the `/v1/models` endpoint at startup and registers
  them under the `lmstudio` provider. Server address is configurable via the
  `LMSTUDIO_BASE_URL` env var (default `http://192.168.1.74:1234/v1`).
- **model-params** — `/params` slash command to set temperature, top_p, etc.
  per model or globally. Config stored at `~/.pi/agent/model-params.json`.
- **omarchy-system-theme** — Syncs pi's light/dark theme with the active
  Omarchy desktop theme.

## Install

Install via symlink so `~/.pi/agent/extensions/` always points at the
versioned files in this repo — edits here are picked up by pi immediately
(extensions reload with the next session, or run `/reload` to hot-reload):

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf "$(pwd)/pi-chleba-extensions/lmstudio.ts" ~/.pi/agent/extensions/
ln -sf "$(pwd)/pi-chleba-extensions/model-params.ts" ~/.pi/agent/extensions/
ln -sf "$(pwd)/pi-chleba-extensions/omarchy-system-theme.ts" ~/.pi/agent/extensions/
```

Run from the repo root (`/home/chleba/Documents/pi-chleba`). To re-install
after pulling changes, just re-run the `ln -sf` commands — they update the
symlink targets in place.

> Prefer symlinks over copying (`cp`). Copies go stale when the repo changes
> and give no hint about where the source lives.

## Uninstall

```bash
rm -f ~/.pi/agent/extensions/lmstudio.ts \
      ~/.pi/agent/extensions/model-params.ts \
      ~/.pi/agent/extensions/omarchy-system-theme.ts
```

## Usage

### lmstudio

No configuration needed. On startup the extension queries LM Studio's
`/v1/models` endpoint and registers the discovered models under the
`lmstudio` provider. If the server is unreachable, a fallback
`lmstudio/local-model` is registered instead.

Env vars (optional):

| Var                 | Default                 |
| ------------------- | ----------------------- |
| `LMSTUDIO_BASE_URL` | `http://192.168.1.74:1234/v1` |
| `LMSTUDIO_API_KEY`  | `lm-studio`             |

### model-params

```
/params                        # show current params for active model
/params temperature 0.6        # set global default
/params m:qwen3.6-27b temperature 0.8  # set model-specific
/params reset                  # clear all
/params reset qwen3.6-27b      # clear model-specific
```

Config file: `~/.pi/agent/model-params.json`

```json
{
  "default": {
    "temperature": 0.6,
    "top_p": 0.95
  },
  "models": {
    "lmstudio/unsloth/qwen3.6-27b": {
      "temperature": 0.8
    }
  }
}
```

Model-specific params override the global defaults for the matching model.

### omarchy-system-theme

No configuration needed. Runs automatically — polls every 2 seconds for
theme changes.

## Development

Edit the `.ts` files in this directory, then either start a new pi session or
run `/reload` inside a running session to pick up the changes. Keep the
symlinks in `~/.pi/agent/extensions/` pointing at this directory so the
installed version always matches the repo.
