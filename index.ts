/**
 * Cache Footer Plugin v3
 * Appends prompt cache hit stats to every agent response.
 *
 * Strategy: llm_output (void hook) captures usage per session,
 * message_sending (modifying hook) appends footer to outbound messages.
 * Since message_sending ctx lacks sessionKey, we use a recent-usage
 * queue keyed by timestamp — the most recent llm_output usage is
 * consumed by the next message_sending call.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

interface UsageEntry {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  model: string;
  ts: number;
}

let lastUsage: UsageEntry | null = null;

function formatK(tokens: number): string {
  if (tokens >= 1000) return (tokens / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(tokens);
}

/** Map model IDs to friendly names like "Anthropic · Opus 4.6" */
const MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-5": "Opus 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-haiku-4-5": "Haiku 4.5",
};

function formatRoute(provider: string, model: string): string {
  const isOR = provider.startsWith("openrouter") || model.startsWith("openrouter/");
  const prefix = isOR ? "OR" : "Anthropic";

  // Extract the model slug: last part after /
  const slug = model.split("/").pop() ?? model;
  // Strip date suffix like -20251001
  const base = slug.replace(/-\d{8}$/, "");

  const friendly = MODEL_NAMES[base] ?? base;
  return `${prefix} · ${friendly}`;
}

export default definePluginEntry({
  id: "cache-footer",
  name: "Cache Footer",
  description: "Appends prompt cache hit stats to agent responses",

  register(api) {
    api.logger.info("[cache-footer] Plugin registering hooks");

    // Capture usage from each LLM turn
    api.on("llm_output", (event: any, _ctx: any) => {
      const usage = event?.usage;
      if (!usage) return;
      const totalInput = (usage.input ?? 0) + (usage.cacheRead ?? 0);
      if (totalInput <= 0) return;

      // Extract model — event has provider and model fields
      const provider = event?.provider ?? "";
      const model = event?.model ?? "";
      const route = formatRoute(provider, model);

      lastUsage = {
        input: usage.input ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        model: route,
        ts: Date.now(),
      };
      api.logger.info(`[cache-footer] Captured usage: input=${lastUsage.input} cacheRead=${lastUsage.cacheRead} route=${route} model=${model}`);
    });

    // Append footer to outgoing messages
    api.on("message_sending", (event: any, _ctx: any) => {
      if (!lastUsage) return;

      // Only use usage from the last 30 seconds (avoid stale data)
      const age = Date.now() - lastUsage.ts;
      if (age > 30_000) {
        lastUsage = null;
        return;
      }

      const { input, cacheRead, cacheWrite, model } = lastUsage;
      lastUsage = null; // consume once

      const total = input + cacheRead;
      if (total <= 0) return;

      const pct = Math.round((cacheRead / total) * 100);
      const parts = [`${pct}%`, `${formatK(cacheRead)}/${formatK(total)}`];
      if (cacheWrite > 0) parts.push(`+${formatK(cacheWrite)} new`);

      if (model) parts.push(model);
      const footer = `\n📊 ${parts.join(" · ")}`;

      const content = typeof event.content === "string" ? event.content : String(event.content ?? "");
      api.logger.info(`[cache-footer] Appending footer: ${footer.trim()}`);
      return { content: content + footer };
    });

    api.logger.info("[cache-footer] Hooks registered");
  },
});
