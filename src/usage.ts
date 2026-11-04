// Comptage des tokens, estimation des coûts et du contexte.
import type { ApiMessage, Conversation, Pricing, Settings, StreamEvent, Usage, UsageLog } from "./api";

/** Tarifs publiés par l'API (liste des modèles), $ par million de tokens. */
export const modelPricing = new Map<string, Pricing>();

/** Tarif personnalisé (préfixe le plus long), sinon celui publié par l'API. */
export function priceFor(model: string, settings: Settings): Pricing | null {
  let best: string | null = null;
  for (const prefix of Object.keys(settings.prices ?? {})) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix;
  }
  if (!best) return modelPricing.get(model) ?? null;
  const [input, output] = settings.prices[best];
  return { input, output, cacheInput: null, cacheWrite: null, extended: null };
}

/** Consommation d'un événement « usage » du flux. */
export const usageOf = (ev: Extract<StreamEvent, { type: "usage" }>): Usage => ({
  promptTokens: ev.promptTokens,
  completionTokens: ev.completionTokens,
  cachedTokens: ev.cachedTokens,
  cacheWriteTokens: ev.cacheWriteTokens,
});

/** Additionne `u` à `into` (compteurs de cache compris). */
export function addUsage(into: Usage, u: Usage) {
  into.promptTokens += u.promptTokens;
  into.completionTokens += u.completionTokens;
  into.cachedTokens = (into.cachedTokens ?? 0) + (u.cachedTokens ?? 0);
  into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}

/**
 * Coût estimé comme Venice le facture : entrée lue en cache au tarif réduit, écrite en cache au tarif
 * d'écriture, reste au tarif normal. `perRequest` : `u` est une seule requête, le tarif « contexte long »
 * s'applique au-delà du seuil (impossible à savoir pour des totaux cumulés).
 */
export function cost(model: string, u: Usage, settings: Settings, perRequest = true): number | null {
  const p = priceFor(model, settings);
  if (!p) return null;
  const t = perRequest && p.extended && u.promptTokens > p.extended.threshold ? p.extended : p;
  const cached = Math.min(u.cachedTokens ?? 0, u.promptTokens);
  const written = Math.min(u.cacheWriteTokens ?? 0, u.promptTokens - cached);
  const fresh = u.promptTokens - cached - written;
  return (fresh * t.input + cached * (t.cacheInput ?? t.input) + written * (t.cacheWrite ?? t.input) + u.completionTokens * t.output) / 1e6;
}

/** Consommation cumulée d'une conversation (toutes les requêtes facturées). */
export function conversationUsage(conv: Conversation, settings: Settings) {
  const sum: Usage = { promptTokens: 0, completionTokens: 0 };
  let total = 0;
  let priced = true;
  const add = (model: string, u: Usage, perRequest: boolean) => {
    addUsage(sum, u);
    const c = cost(model, u, settings, perRequest);
    if (c === null) priced = false;
    else total += c;
  };
  for (const m of conv.messages) if (m.role === "assistant" && m.usage) add(m.model ?? conv.model, m.usage, true);
  // Requêtes annexes (compaction, second modèle comparé, message de commit) : cumulées par modèle.
  for (const [model, u] of Object.entries(conv.extraUsage ?? {})) add(model, u, false);
  return { ...sum, cost: priced ? total : total || null };
}

/** Taille approximative (en tokens) d'une liste de messages : ~3,5 caractères par token. */
export const estimateTokens = (messages: ApiMessage[]) =>
  Math.round(messages.reduce((n, m) => n + m.content.length + JSON.stringify(m.toolCalls ?? "").length + 12, 0) / 3.5);

/** Tokens occupés dans la fenêtre de contexte au prochain appel. */
export function contextTokens(conv: Conversation, apiMessages: () => ApiMessage[]): { tokens: number; exact: boolean } {
  const upto = conv.compaction?.upto ?? 0;
  for (let i = conv.messages.length - 1; i >= upto; i--) {
    const m = conv.messages[i];
    if (m.role === "assistant" && m.usage) {
      // Messages ajoutés depuis (résultats d'outils, nouvelle question) : estimés.
      const tail = conv.messages.slice(i + 1).reduce((n, x) => n + x.content.length + (x.toolCalls ?? []).reduce((k, t) => k + (t.result?.length ?? 0), 0), 0);
      const own = (m.toolCalls ?? []).reduce((k, t) => k + (t.result?.length ?? 0), 0);
      return { tokens: m.usage.promptTokens + m.usage.completionTokens + Math.round((tail + own) / 3.5), exact: tail + own === 0 };
    }
  }
  return { tokens: estimateTokens(apiMessages()), exact: false };
}

export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",")} M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1).replace(".", ",")} k` : String(n);

export const fmtCost = (c: number | null) =>
  c === null ? "coût inconnu" : c < 0.01 ? "< 0,01 $" : `≈ ${c.toFixed(c < 1 ? 3 : 2).replace(".", ",")} $`;

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Agrège le journal sur les `days` derniers jours (0 = tout). */
export function aggregate(log: UsageLog, days: number, settings: Settings) {
  const since = days ? new Date(Date.now() - (days - 1) * 86400000) : null;
  const sinceKey = since
    ? `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`
    : "";
  const byModel = new Map<string, number[]>();
  for (const [day, models] of Object.entries(log)) {
    if (day < sinceKey) continue;
    for (const [model, counts] of Object.entries(models)) {
      const cur = byModel.get(model) ?? [0, 0, 0, 0, 0];
      byModel.set(model, cur.map((n, i) => n + (counts[i] ?? 0)));
    }
  }
  let total = 0;
  let unknown = false;
  const rows = [...byModel.entries()]
    .sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1]))
    .map(([model, [p, c, r, cached, written]]) => {
      const k = cost(model, { promptTokens: p, completionTokens: c, cachedTokens: cached, cacheWriteTokens: written }, settings, false);
      if (k === null) unknown = true;
      else total += k;
      return { model, prompt: p, completion: c, cached, requests: r, cost: k };
    });
  return { rows, total, unknown };
}
