# pi-chleba Extensions

Custom extensions for the pi-chleba fork, versioned in this repo. All files
are plain TypeScript — pi loads and runs them directly from
`~/.pi/agent/extensions/` at startup, so the source **is** the build. No
compile step.

## Extensions

- **ollamamq** — Connects pi to an [ollamaMQ](https://github.com/Chleba/ollamaMQ)
  dispatcher that fronts Ollama / LM Studio / vLLM backends. Discovers the full
  routable inventory from `/admin/models` at startup and on every catalog
  refresh, registers it under the `ollamamq` provider, and sends an
  `X-User-ID` header for per-user queuing. **Supersedes lmstudio** (and the
  unversioned vllm extension) — those are disabled in
  `~/.pi/agent/extensions-disabled/`.
- **lmstudio** *(disabled — superseded by ollamamq)* — Connects pi to a local
  LM Studio server on another PC. Discovers models from the `/v1/models`
  endpoint at startup and registers them under the `lmstudio` provider. Server
  address is configurable via the `LMSTUDIO_BASE_URL` env var (default
  `http://192.168.1.74:1234/v1`).
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
ln -sf "$(pwd)/pi-chleba-extensions/ollamamq.ts" ~/.pi/agent/extensions/
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
rm -f ~/.pi/agent/extensions/ollamamq.ts \
      ~/.pi/agent/extensions/lmstudio.ts \
      ~/.pi/agent/extensions/model-params.ts \
      ~/.pi/agent/extensions/omarchy-system-theme.ts
```

## Usage

### ollamamq

No configuration needed if the dispatcher runs at the default address. On
startup the extension queries the proxy's `/admin/models` endpoint (falling
back to `/v1/models`) and registers every model available on any online
backend under the `ollamamq` provider. The list is re-fetched whenever pi
refreshes its catalogs (`/model`), so models on backends that come online later
appear without a restart. Embedding models are filtered out, and vision support
is detected heuristically from the model id (same rules as lmstudio).

Env vars (optional):

| Var | Default |
| --- | ------- |
| `OLLAMA_MQ_BASE_URL` | `http://192.168.1.23:11435` |
| `OLLAMA_MQ_API_KEY` | `ollamaMQ` (set when the proxy runs with auth) |
| `OLLAMA_MQ_USER_ID` | `pi-<hostname>-<pid>` (auto, unique per pi instance) |
| `OLLAMA_MQ_MAX_TOKENS` | `32768` |
| `OLLAMA_MQ_CONTEXT_WINDOW` | `128000` |
| `OLLAMA_MQ_MODEL_CTX` | — (per-model context windows, e.g. `"qwendoc3=262144"`) |
| `OLLAMA_MQ_MODEL_MAXTOK` | — (per-model max output tokens) |
| `OLLAMA_MQ_VISION_MODELS` / `OLLAMA_MQ_TEXT_ONLY_MODELS` | — (substring overrides for vision detection) |

> Tip: set per-model context windows with `OLLAMA_MQ_MODEL_CTX` to match the
> `max_ctx` values in your ollamaMQ `appconf.yaml`.

### lmstudio

*(Disabled by default — superseded by ollamamq. Re-enable by moving the file
back into `~/.pi/agent/extensions/`.)*

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
