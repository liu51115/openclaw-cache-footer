/**
 * Cache Footer Plugin v0.8.1
 * Appends prompt cache hit stats to every agent response.
 *
 * Strategy: llm_output (void hook) captures usage keyed by accountId,
 * message_sending (modifying hook) appends footer to matching outbound messages.
 * Keyed by accountId to prevent cross-talk between concurrent agents.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

interface UsageEntry {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  model: string;
  provider: string;
  modelId: string;
  ts: number;
}

/** Load fallback pricing from pricing.json (easy to maintain separately) */
function loadFallbackPricing(): Record<string, { input: number; cacheRead: number; cacheWrite: number; output: number }> {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(dir, "pricing.json"), "utf-8");
    const data = JSON.parse(raw);
    // Filter out metadata keys starting with _
    const pricing: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!k.startsWith("_") && typeof v === "object") pricing[k] = v;
    }
    return pricing;
  } catch {
    return {};
  }
}

const FALLBACK_PRICING = loadFallbackPricing();

function formatCost(cost: number): string {
  if (cost < 0.001) return "<$0.001";
  if (cost < 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}



/** Usage entries keyed by accountId to prevent cross-agent contamination */
const usageByAccount = new Map<string, UsageEntry>();
const STALENESS_MS = 30_000;

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
  if (!provider && !model) return "unknown";

  const isOR = provider.startsWith("openrouter") || model.startsWith("openrouter/");
  const prefix = isOR ? "OR" : "Anthropic";

  // Extract the model slug: last part after /
  const slug = model.split("/").pop() ?? model;
  if (!slug) return prefix;

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

    // Capture usage from each LLM turn, keyed by accountId
    api.on("llm_output", (event: any, ctx: any) => {
      const usage = event?.usage;
      if (!usage) return;
      const totalInput = (usage.input ?? 0) + (usage.cacheRead ?? 0);
      if (totalInput <= 0) return;

      // Extract accountId from sessionKey (format: agent:<accountId>:...)
      const sessionKey: string = ctx?.sessionKey ?? "";
      const parts = sessionKey.split(":");
      const accountId = parts.length >= 2 ? parts[1] : "_default";

      const provider = event?.provider ?? "";
      const model = event?.model ?? "";
      const route = formatRoute(provider, model);

      usageByAccount.set(accountId, {
        input: usage.input ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        output: usage.output ?? 0,
        model: route,
        provider,
        modelId: model,
        ts: Date.now(),
      });
      api.logger.info(`[cache-footer] Captured usage for ${accountId}: input=${usage.input} cacheRead=${usage.cacheRead ?? 0} cacheWrite=${usage.cacheWrite ?? 0} output=${usage.output ?? 0} route=${route}`);
    });

    // Append footer to outgoing messages, matched by accountId
    api.on("message_sending", (event: any, ctx: any) => {
      const rawAccountId: string = ctx?.accountId ?? "_default";
      // Try direct match first, then fall back to most recent entry within staleness window
      let accountId = rawAccountId;
      let entry = usageByAccount.get(accountId);
      if (!entry && (rawAccountId === "_default" || rawAccountId === "default")) {
        // ctx.accountId missing or generic — find the most recent entry
        let bestKey: string | undefined;
        let bestTs = 0;
        for (const [key, val] of usageByAccount.entries()) {
          if (val.ts > bestTs && (Date.now() - val.ts) < STALENESS_MS) {
            bestTs = val.ts;
            bestKey = key;
          }
        }
        if (bestKey) {
          accountId = bestKey;
          entry = usageByAccount.get(bestKey);
        }
      }
      if (!entry) return;

      // Staleness guard
      const age = Date.now() - entry.ts;
      if (age > STALENESS_MS) {
        usageByAccount.delete(accountId);
        return;
      }

      const { input, cacheRead, cacheWrite, model } = entry;
      // Don't delete — let 30s staleness guard handle cleanup.
      // Deleting breaks split messages (multi-chunk Telegram).

      const total = input + cacheRead;
      if (total <= 0) return;

      const pct = Math.round((cacheRead / total) * 100);
      const fmtParts = [`${pct}%`, `${formatK(cacheRead)}/${formatK(total)}`];
      if (cacheWrite > 0) fmtParts.push(`+${formatK(cacheWrite)} new`);

      // Cost: try OC model registry first (OpenRouter), fall back to hardcoded Anthropic
      const registryModel = api.modelRegistry?.find?.(entry.provider, entry.modelId);
      let pricing = (registryModel as any)?.cost;
      if (!pricing || (pricing.input === 0 && pricing.output === 0)) {
        const slug = (entry.modelId.split("/").pop() ?? "").replace(/-\d{8}$/, "");
        pricing = FALLBACK_PRICING[slug];
      }
      if (pricing) {
        const cost =
          (entry.input * (pricing.input ?? 0) +
           entry.cacheRead * (pricing.cacheRead ?? 0) +
           entry.cacheWrite * (pricing.cacheWrite ?? 0) +
           entry.output * (pricing.output ?? 0)) / 1_000_000;
        if (cost > 0) fmtParts.push(formatCost(cost));
      }

      if (model) fmtParts.push(model);
      const footer = `\n📊 ${fmtParts.join(" · ")}`;

      const content = typeof event.content === "string" ? event.content : String(event.content ?? "");
      api.logger.info(`[cache-footer] Appending footer for ${accountId}: ${footer.trim()}`);
      return { content: content + footer };
    });

    api.logger.info("[cache-footer] Hooks registered");
  },
});
