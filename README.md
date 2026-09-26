<div align="center">

# pi-9router-models

**Your [9router](https://github.com/decolua/9router) combos, live in [Pi](https://github.com/earendil-works/pi). No more hand-editing `models.json`.**

[![CI](https://github.com/ape1121/pi-9router-models/actions/workflows/ci.yml/badge.svg)](https://github.com/ape1121/pi-9router-models/actions/workflows/ci.yml)
![pi-package](https://img.shields.io/badge/pi-package-7c3aed)
![license](https://img.shields.io/badge/license-MIT-blue)
![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

</div>

```
$ pi --list-models
provider  model  context  max-out  thinking  images
9router   ape    1M       128K     yes       yes
9router   astra  272K     128K     yes       yes
9router   fable  1M       128K     yes       yes
9router   opus   1M       128K     yes       yes
```

You manage models in 9router: combos, fallbacks, accounts. Pi keeps its own static model list. They drift. You rename a combo in the dashboard and every Pi worker, Pi Web session, and orchestrator that spawns Pi quietly points at a model that no longer exists.

This extension makes **9router the single source of truth**. On every Pi start it reads `GET /v1/models`, maps 9router's capability metadata onto Pi models, and registers them as the `9router` provider.

## Features

- ⚡ **Live sync at startup.** Pi awaits the extension before resolving models, so `--list-models`, `--model 9router/<combo>`, Pi Web and headless workers all see the current catalogue.
- 🧠 **Real capabilities.** Context window, max output, vision and reasoning come from 9router, not guesses. Always-on thinking models get `off` hidden.
- 🎯 **Curated by default.** Only your **combos** show up. Opt in to direct models by group (`cx`, `cc`, `ag`, …) or glob (`cx/gpt-6-*`).
- 🛟 **Offline-safe.** The last good catalogue is cached. 9router down? Pi still starts with the models you had.
- 💵 **Costs in dollars.** Models get API-equivalent list prices from [models.dev](https://models.dev) (the catalogue 9router itself uses), resolved through your combos (`ape → opus → cc/claude-opus-5-5`). Pi's footer, session stats and orchestrators like Paperclip show spend instead of `$0`.
- 🔄 **`/9router-sync`** refreshes a running session after you edit combos.
- 🔐 **Pi-native secrets.** `apiKey` accepts Pi config values: `$ENV`, `${ENV}`, or `!command` (password managers, key scripts).
- 📦 **Zero dependencies**, one file, survives `pi update`.

## Install

```sh
pi install git:github.com/ape1121/pi-9router-models
export NINEROUTER_API_KEY=sk-...        # your 9router key
pi --list-models
```

That's it for a default 9router on `http://127.0.0.1:20128/v1`.

Pin a release for reproducible installs: `pi install git:github.com/ape1121/pi-9router-models@v0.2.0`.

> **Migrating from a static list?** Remove the `9router` provider from `~/.pi/agent/models.json` (the extension replaces its model list either way), and set `"enabledModels": ["9router/**"]` in `~/.pi/agent/settings.json` if you want Ctrl+P cycling to follow 9router too.

## Configuration

Everything is optional. Create `~/.pi/agent/9router.json`:

```json
{
  "provider": "9router",
  "baseUrl": "http://127.0.0.1:20128/v1",
  "apiKey": "$NINEROUTER_API_KEY",
  "include": ["combo"],
  "exclude": [],
  "timeoutMs": 3000,
  "pricing": "models.dev",
  "combos": {},
  "prices": {}
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `9router` | Pi provider id, so models are `9router/<id>` |
| `baseUrl` | `http://127.0.0.1:20128/v1` | 9router OpenAI-compatible endpoint |
| `apiKey` | `$NINEROUTER_API_KEY` | `$ENV`, `${ENV}`, `!command`, or literal |
| `include` | `["combo"]` | 9router `owned_by` groups and/or id globs |
| `exclude` | `[]` | Same syntax; wins over `include` |
| `timeoutMs` | `3000` | Startup fetch timeout before falling back to cache |
| `pricing` | `"models.dev"` | Price source for cost tracking; `false` registers `$0` |
| `combos` | `{}` | Pin which model prices a combo, e.g. `{ "ape": "cc/claude-opus-5-5" }` |
| `prices` | `{}` | Hard overrides in $/1M tokens: `{ "ape": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } }` |

Environment overrides: `NINEROUTER_BASE_URL`, `NINEROUTER_INCLUDE` (comma-separated).

### Recipes

```jsonc
// Combos plus GPT-6 direct routes, minus review/ultra variants
{ "include": ["combo", "cx/gpt-6-*"], "exclude": ["*-review", "*(ultra)"] }

// Everything 9router exposes
{ "include": ["*"] }

// Key from a script or password manager
{ "apiKey": "!pass show 9router/api-key" }

// 9router on another box
{ "baseUrl": "http://homelab.lan:20128/v1" }
```

## How it works

```
 pi start ──▶ extension factory (awaited)
                 │
                 ├─ GET {baseUrl}/models ──▶ 9router
                 │        ok? ──▶ write ~/.pi/agent/cache/9router-models.json
                 │        fail? ─▶ read cache
                 │
                 ├─ filter include/exclude
                 ├─ map capabilities ─▶ Pi model defs
                 └─ pi.registerProvider("9router", { api: "openai-completions", models })
```

| 9router field | Pi model field |
| --- | --- |
| `capabilities.contextWindow` / `context_length` | `contextWindow` |
| `capabilities.maxOutput` / `max_completion_tokens` | `maxTokens` |
| `capabilities.vision` | `input: ["text", "image"]` |
| `capabilities.reasoning` | `reasoning` |
| `capabilities.thinkingCanDisable: false` | `thinkingLevelMap: { off: null }` |

### Costs

Pi computes the cost of every response from the model's `cost` rates; anything reading Pi's usage (the footer, `/session`, Paperclip's cost dashboard and budgets) aggregates it. The extension fills those rates with **API-equivalent list prices**:

1. `prices[id]` from your config, if set.
2. Otherwise the combo is resolved to its **first** member, following nested combos. Membership comes from `combos` in config, else from 9router's local dashboard API using the same machine-local CLI token the `9router` CLI uses (read from `~/.9router`, localhost only, never sent anywhere else).
3. That model is looked up on models.dev (9router alias → vendor: `cc` → Anthropic, `cx` → OpenAI, …). Context-length price tiers carry over. The catalogue is cached for 24h in `~/.pi/agent/cache/`.

Caveats, read these before setting budgets:

- **List price ≠ what you pay.** Subscription-backed routes (Claude Code, Codex, Copilot…) are flat-rate; the number is what the same tokens would cost on the public API. Great for comparing agents, tickets and models. Don't treat it as an invoice.
- **Fallbacks are priced as the primary.** Pi only knows it called `ape`, not which member 9router actually used. Pin `combos`/`prices` if a combo mixes very differently priced models.

## Works great with

- **Pi Web.** The session daemon loads extension providers at start, so restart it once after installing.
- **Orchestrators that spawn Pi** (e.g. Paperclip's `pi_local` adapter). Their model pickers call `pi --list-models`, so they inherit 9router's catalogue for free.
- **Subagent packages.** Children resolve `9router/<combo>` like any other model.

## Troubleshooting

```sh
PI_9ROUTER_DEBUG=1 pi --list-models   # prints count, source (live / cache / none) and per-model price + where it came from
```

- **`no models registered`**: 9router unreachable and no cache yet. Check `baseUrl` and the key.
- **`No models match pattern "9router/x"`**: your `enabledModels` or `--models` names a combo 9router no longer has. That warning is the drift this extension exists to surface.
- **Stale list in a long-running session**: run `/9router-sync`.
- **A model shows `(no price)`**: models.dev has no match. Add it to `prices` or `combos`.
- **Orchestrator model picker is stale**: it caches `pi --list-models`. Paperclip keeps it for 60 seconds and its *Refresh models* button doesn't bypass that for Pi, so wait a minute and reopen the picker.

## Development

```sh
git clone https://github.com/ape1121/pi-9router-models && cd pi-9router-models
npm test                                   # node --test, Node >= 22.6 (native TS)
pi -e ./extensions/9router-models.ts --list-models
```

## License

MIT
