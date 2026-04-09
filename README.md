# cache-footer

OpenClaw plugin that appends prompt cache hit statistics as a footer to agent responses.

## What it does

After each LLM turn, the plugin captures token usage (input, cache read, cache write) and appends a one-line footer to the outgoing message:

```
📊 87% · 142k/163k · Anthropic · Opus 4.6
```

The footer shows:
- **Cache hit rate** — percentage of input tokens served from cache
- **Token counts** — cache read / total input (in compact `k` notation)
- **Cache write** — new tokens written to cache (if any)
- **Model routing** — provider and model name (e.g. `Anthropic · Opus 4.6`, `OR · Sonnet 4.6`)

## Install

Copy or symlink into your OpenClaw extensions directory:

```
~/.openclaw/extensions/cache-footer/
```

Then enable the plugin in your OpenClaw config.

## How it works

The plugin registers two hooks:

1. **`llm_output`** — captures usage stats (input tokens, cache read/write, model info) from each LLM response, keyed by `accountId` extracted from the session
2. **`message_sending`** — appends the formatted footer to the next outgoing message for the matching account, consuming the captured stats

**Per-account keying** — usage entries are stored per `accountId`, preventing cross-talk when multiple agents run concurrently under different accounts.

**Model routing label** — the footer shows provider and model in friendly form (e.g. `Anthropic · Opus 4.6`, `OR · Sonnet 4.5`). OpenRouter-routed models display with the `OR` prefix.

Usage data expires after 30 seconds to avoid stale footers.

## Configuration

No configuration required. The plugin works out of the box.

## License

MIT
