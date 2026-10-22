// Faux serveur de l'API Venice pour les tests de bout en bout : modèles, chat en streaming
// (SSE) et transcription. Réponses déterministes selon le dernier message utilisateur.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

/** Requêtes reçues, pour les vérifications des tests. */
export const requests = [];

const MODELS = [
  { id: "zai-org-glm-5-1", name: "GLM 5.1", traits: ["default"], privacy: "private", vision: false, code: false },
  { id: "qwen3-coder-e2e", name: "Qwen 3 Coder", traits: ["default_code"], privacy: "private", vision: false, code: true },
  { id: "modele-e2e-vision", name: "Modèle E2E", traits: [], privacy: "private", vision: true, code: false },
  { id: "modele-tiers-e2e", name: "Modèle tiers", traits: [], privacy: "anonymized", vision: true, code: false },
];

const lastUser = (messages) => [...messages].reverse().find((m) => m.role === "user");
const text = (c) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join(""));

const IMAGE_MODELS = [
  { id: "image-e2e", name: "Image E2E", traits: ["default"], constraints: { promptCharacterLimit: 1500, steps: { default: 8, max: 30 }, widthHeightDivisor: 16 } },
  { id: "image-format-e2e", name: "Image à formats", traits: [], constraints: { aspectRatios: ["1:1", "16:9"], defaultAspectRatio: "1:1", promptCharacterLimit: 1500, steps: { default: 8, max: 8 }, widthHeightDivisor: 1 } },
];

/** Image renvoyée : PNG 1×1 transparent, ou fichier base64 désigné par E2E_IMAGE (captures d'écran). */
const PIXEL = process.env.E2E_IMAGE
  ? readFileSync(process.env.E2E_IMAGE, "utf8").trim()
  : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const CITATIONS = [
  { title: "Météo-France", url: "https://meteofrance.example/paris", date: "2026-10-21", content: "Pluie" },
  { title: "Infoclimat", url: "https://infoclimat.example/paris", content: "Averses" },
];

/** Réponse scénarisée : texte, ou appel d'outil puis texte une fois le résultat reçu. */
function script(req) {
  const msgs = req.messages;
  const last = msgs[msgs.length - 1];
  const system = text(msgs.find((m) => m.role === "system")?.content);
  const ask = text(lastUser(msgs)?.content);
  if (last.role === "tool") {
    return { content: `Outil terminé. Résultat : ${text(last.content).slice(0, 200)}` };
  }
  const run = ask.match(/EXÉCUTE (.+)/);
  if (run) return { toolCalls: [{ name: "run_command", arguments: { command: run[1] } }] };
  if (ask.includes("ÉCRIS")) {
    return { toolCalls: [{ name: "write_file", arguments: { path: "notes/e2e.txt", content: "créé par le test e2e\n" } }] };
  }
  if (ask.includes("CONSIGNES")) {
    return { content: system.includes("RÈGLE-E2E-42") ? "Consignes reçues : RÈGLE-E2E-42" : "Consignes absentes" };
  }
  if (ask.includes("PROJET")) {
    return { content: system.includes("CONSIGNE-PROJET-E2E") ? "Projet reçu : CONSIGNE-PROJET-E2E" : "Projet absent" };
  }
  if (ask.includes("CHERCHE") && req.venice_parameters?.enable_web_search !== "off") {
    return {
      citations: CITATIONS,
      content:
        "**Demain à Paris** : temps pluvieux^1^.\n\n| Moment | Ciel | Température |\n|---|---|---|\n| Matin | Averses | 9 °C |\n| Après-midi | Éclaircies | 14 °C |\n\n" +
        "Prévoyez un parapluie : de nouvelles averses sont attendues en soirée^1,2^.",
    };
  }
  if (ask.includes("INSTRUCTIONS")) {
    const found = system.match(/MARQUEUR-\w+/g) ?? [];
    return { content: `Instructions reçues : ${found.join(", ") || "aucune"}` };
  }
  if (ask.includes("RÉFLÉCHIS")) {
    return { content: "<think>raisonnement caché</think>\n\nConclusion visible." };
  }
  return { content: `Réponse simulée à : ${ask.slice(0, 60)}. Le mot témoin est **pamplemousse**.` };
}

function sse(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function chat(req, res) {
  const out = script(req);
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  if (out.toolCalls) {
    const tool_calls = out.toolCalls.map((t, i) => ({
      id: `call_${Date.now() % 1e6}${i}`,
      type: "function",
      index: i,
      function: { name: t.name, arguments: JSON.stringify(t.arguments) },
    }));
    return sse(res, [
      { choices: [{ index: 0, delta: { role: "assistant", content: "", tool_calls }, finish_reason: "tool_calls" }] },
      { choices: [], usage },
    ]);
  }
  const parts = out.content.match(/.{1,16}/gsu) ?? [""];
  const head = out.citations ? [{ choices: [], venice_parameters: { web_search_citations: out.citations } }] : [];
  sse(res, [
    ...head,
    ...parts.map((p) => ({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })),
    { choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] },
    // Venice (comme OpenAI) envoie la consommation dans un dernier morceau sans choix.
    { choices: [], usage },
  ]);
}

const modelJson = (m) => ({
  id: m.id,
  type: "text",
  object: "model",
  model_spec: {
    name: m.name,
    availableContextTokens: 128000,
    privacy: m.privacy,
    traits: m.traits,
    capabilities: {
      supportsVision: m.vision,
      supportsFunctionCalling: true,
      optimizedForCode: m.code,
      supportsReasoning: m.traits.includes("default"),
      supportsReasoningEffort: m.traits.includes("default"),
      reasoningEffortOptions: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
    pricing: { input: { usd: 0.5, diem: 0.5 }, output: { usd: 2, diem: 2 } },
  },
});

export function startMock(port = 0) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (url.searchParams.get("type") === "inpaint") {
          return json(200, { object: "list", data: [{ id: "edit-e2e", type: "inpaint", model_spec: { name: "Retouche E2E", privacy: "private", traits: ["default"] } }] });
        }
        if (["video", "music", "tts", "embedding"].includes(url.searchParams.get("type"))) return json(200, { object: "list", data: [] });
        if (url.searchParams.get("type") === "image") {
          return json(200, {
            object: "list",
            type: "image",
            data: IMAGE_MODELS.map((m) => ({
              id: m.id,
              type: "image",
              model_spec: { name: m.name, privacy: "private", traits: m.traits, constraints: m.constraints, pricing: { generation: { usd: 0.01, diem: 0.01 } } },
            })),
          });
        }
        return json(200, { object: "list", data: MODELS.map(modelJson) });
      }
      if (req.method === "POST" && url.pathname === "/v1/image/generate") {
        const parsed = JSON.parse(body);
        requests.push({ auth: req.headers.authorization, path: url.pathname, ...parsed });
        const n = Math.min(4, parsed.variants ?? 1);
        return json(200, { id: "generate-image-e2e", images: Array(n).fill(PIXEL), timing: { inferenceDuration: 1, inferencePreprocessingTime: 0, inferenceQueueTime: 0, total: 1200 } });
      }
      if (req.method === "POST" && ["/v1/image/upscale", "/v1/image/background-remove", "/v1/image/edit"].includes(url.pathname)) {
        const parsed = JSON.parse(body);
        requests.push({ auth: req.headers.authorization, path: url.pathname, ...parsed });
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(Buffer.from(PIXEL, "base64"));
      }
      if (req.method === "GET" && url.pathname === "/v1/characters") {
        const all = [
          { slug: "alan-watts", name: "Alan Watts", description: "Philosophe", tags: ["philosophie"], adult: false, modelId: "zai-org-glm-5-1" },
          { slug: "coach-e2e", name: "Coach E2E", description: "Coach sportif", tags: ["sport"], adult: false, modelId: "zai-org-glm-5-1" },
        ];
        const q = (url.searchParams.get("search") ?? "").toLowerCase();
        return json(200, { object: "list", data: all.filter((c) => !q || c.name.toLowerCase().includes(q)) });
      }
      if (req.method === "GET" && url.pathname === "/v1/billing/balance") {
        return json(200, { canConsume: true, consumptionCurrency: "USD", balances: { usd: 2.5, diem: null, bundledCredits: null, earnedCredits: null }, diemEpochAllocation: 0 });
      }
      if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        return res.end(Buffer.alloc(16));
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const parsed = JSON.parse(body);
        requests.push({ auth: req.headers.authorization, ...parsed });
        return chat(parsed, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
        return json(200, { text: "Dictée simulée" });
      }
      json(404, { error: `inconnu : ${req.method} ${req.url}` });
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Lancement direct : `node e2e/mock-venice.mjs 8765` (tests manuels).
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startMock(Number(process.argv[2] ?? 8765));
  console.log(`Faux serveur Venice sur http://127.0.0.1:${server.address().port}`);
}
