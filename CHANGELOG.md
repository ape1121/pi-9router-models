# Changelog

## 0.2.0

- Cost tracking: models get API-equivalent list prices from models.dev (cached 24h), resolved through combos (nested combos followed to their first member). Context price tiers supported.
- New config: `pricing`, `combos`, `prices`. Debug output shows each model's price and its source.

## 0.1.0

- Live-sync 9router `/v1/models` into Pi's `9router` provider at startup.
- Capability mapping (context window, max output, vision, reasoning, always-on thinking).
- `include`/`exclude` by `owned_by` group or id glob; combos only by default.
- Offline cache fallback; `/9router-sync` command; env overrides.
