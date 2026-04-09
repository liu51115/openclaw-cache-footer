# cache-footer

OpenClaw plugin that appends prompt cache hit statistics and cost as a footer to agent responses.

## What it does

After each LLM turn, the plugin captures token usage and appends a one-line footer to the outgoing message:

```
📊 100% · 67k/67k · $0.04 · Anthropic · Opus 4.6
```

The footer shows:
- **Cache hit %** — percentage of input tokens served from cache
- **Token counts** — cache read / total input (compact `k` notation)
- **Cache write** — new tokens written to cache (if any)
- **Cost per message** — estimated cost using hybrid pricing (OC model registry for OpenRouter, `pricing.json` fallback for direct Anthropic)
- **Model routing** — provider and model name (e.g. `Anthropic · Opus 4.6`, `OR · Sonnet 4.5`)

## Features

- **Per-account keying** — usage entries are stored per `accountId`, preventing cross-talk when multiple agents run concurrently
- **Hybrid cost calculation** — queries the OC model registry first (covers OpenRouter models), falls back to `pricing.json` for direct Anthropic calls
- **`pricing.json`** — external file for easy maintenance of fallback pricing rates; update without touching plugin code
- **Staleness guard** — usage data expires after 30 seconds to avoid stale footers

## Requirements

- **Telegram only** — streaming must be disabled (`streaming: false`). Streaming bypasses `message_sending` hooks, so the footer won't appear.

## Install

Clone or symlink into your OpenClaw extensions directory:

```
~/.openclaw/extensions/cache-footer/
```

Then add `cache-footer` to the plugins array in your `openclaw.json` config.

## How it works

The plugin registers two hooks:

1. **`llm_output`** (void hook) — captures usage stats (input tokens, cache read/write, model, provider) from each LLM response, keyed by `accountId`
2. **`message_sending`** (modifying hook) — appends the formatted footer to the next outgoing message for the matching account

## Configuration

No configuration required. Works out of the box.

To update Anthropic pricing, edit `pricing.json` (rates in $ per million tokens).

## License

MIT
