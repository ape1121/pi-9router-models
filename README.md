# pi-9router-models

Pi extension that makes 9router the single source of truth for Pi models.

- On every Pi start it fetches `GET /v1/models` from 9router and registers them as provider `9router` (replacing any static `models.json` list).
- Context window, max output, vision and reasoning flags come from 9router's capabilities.
- Last good catalogue cached at `~/.pi/agent/cache/9router-models.json`; used when 9router is down.
- `/9router-sync` refreshes a running session.

## Install

```sh
pi install /home/alp/src/pi-9router-models
```

Installed as a local-path package, so `pi update` / `pi update --extensions` never overwrite it.

## Config

`~/.pi/agent/9router.json` (all optional):

```json
{
  "baseUrl": "http://127.0.0.1:20128/v1",
  "apiKey": "!python3 /home/alp/src/hermes-pi-control/router_key.py",
  "include": ["combo"],
  "exclude": [],
  "timeoutMs": 3000
}
```

`include`/`exclude` entries match 9router `owned_by` groups (`combo`, `cx`, `cc`, `ag`) or id globs (`cx/gpt-6-*`).

Debug: `PI_9ROUTER_DEBUG=1 pi --list-models`.
