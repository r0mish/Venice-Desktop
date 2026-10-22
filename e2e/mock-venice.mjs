// Faux serveur de l'API Venice pour les tests de bout en bout : modèles, chat en streaming
// (SSE) et transcription. Réponses déterministes selon le dernier message utilisateur.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { attestation, decrypt, enclavePubHex, encryptFor } from "./enclave.mjs";

/** Requêtes reçues, pour les vérifications des tests. */
export const requests = [];
/** Générations vidéo/audio en cours : nombre de consultations par modèle. */
const jobs = new Map();

const MODELS = [
  { id: "zai-org-glm-5-1", name: "GLM 5.1", traits: ["default"], privacy: "private", vision: false, code: false },
  { id: "qwen3-coder-e2e", name: "Qwen 3 Coder", traits: ["default_code"], privacy: "private", vision: false, code: true },
  { id: "modele-e2e-vision", name: "Modèle E2E", traits: [], privacy: "private", vision: true, code: false },
  { id: "modele-tiers-e2e", name: "Modèle tiers", traits: [], privacy: "anonymized", vision: true, code: false },
  { id: "enclave-e2e", name: "Enclave E2E", traits: [], privacy: "private", vision: false, code: false, e2ee: true },
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
  if (ask.includes("copie de secours")) {
    return { content: system.includes("NAS est restauré") ? "Passage trouvé : NAS" : "Passage absent" };
  }
  if (ask.includes("RÉFLÉCHIS")) {
    return { content: "<think>raisonnement caché</think>\n\nConclusion visible." };
  }
  return { content: `Réponse simulée à : ${ask.slice(0, 60)}. Le mot témoin est **pamplemousse** [${req.model}].` };
}

/** Requête E2EE : messages déchiffrés par l'enclave, réponse chiffrée pour la clé du client. */
function chatE2ee(req, headers, res) {
  const clientPub = headers["x-venice-tee-client-pub-key"];
  if (headers["x-venice-tee-model-pub-key"] !== enclavePubHex || !clientPub) {
    return res.writeHead(400).end(JSON.stringify({ error: "clés TEE absentes ou inconnues" }));
  }
  let plain;
  try {
    plain = { ...req, messages: req.messages.map((m) => ({ ...m, content: decrypt(m.content) })) };
  } catch {
    return res.writeHead(400).end(JSON.stringify({ error: "message non chiffré pour l'enclave" }));
  }
  requests.at(-1).decrypted = plain.messages;
  const parts = script(plain).content.match(/.{1,16}/gsu) ?? [""];
  sse(res, [
    ...parts.map((p) => ({ choices: [{ index: 0, delta: { content: encryptFor(clientPub, p) }, finish_reason: null }] })),
    { choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } },
  ]);
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
      supportsE2EE: !!m.e2ee,
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
        if (url.searchParams.get("type") === "video") {
          return json(200, {
            object: "list",
            data: [{ id: "video-e2e", type: "video", model_spec: { name: "Vidéo E2E", privacy: "private", traits: ["default"], constraints: { durations: ["5s", "10s"], aspect_ratios: ["16:9", "9:16"], resolutions: ["720p"], model_type: "text-to-video", audio: true, audio_configurable: true } } }],
          });
        }
        if (url.searchParams.get("type") === "music") {
          return json(200, {
            object: "list",
            data: [{ id: "music-e2e", type: "music", model_spec: { name: "Musique E2E", privacy: "private", traits: ["default"], duration_options: [30, 60], default_duration: 30, supports_force_instrumental: true, supports_lyrics: true } }],
          });
        }
        if (["tts", "embedding"].includes(url.searchParams.get("type"))) return json(200, { object: "list", data: [] });
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
      if (req.method === "POST" && url.pathname === "/v1/embeddings") {
        const parsed = JSON.parse(body);
        requests.push({ path: url.pathname, model: parsed.model, count: parsed.input.length });
        // Vecteurs « sémantiques » simulés : sauvegarde ≈ NAS, sans mot commun.
        const vec = (t) => [/NAS|copie de secours/.test(t) ? 1 : 0, /météo/.test(t) ? 1 : 0, 0.1];
        return json(200, { object: "list", data: parsed.input.map((t, index) => ({ object: "embedding", index, embedding: vec(t) })) });
      }
      if (req.method === "GET" && url.pathname === "/v1/tee/attestation") {
        requests.push({ path: url.pathname, model: url.searchParams.get("model") });
        return json(200, attestation(url.searchParams.get("model"), url.searchParams.get("nonce")));
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const parsed = JSON.parse(body);
        requests.push({ auth: req.headers.authorization, ...parsed });
        if (parsed.venice_parameters?.enable_e2ee) return chatE2ee(parsed, req.headers, res);
        return chat(parsed, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
        requests.push({ path: url.pathname, size: body.length, timestamps: body.includes('name="timestamps"') });
        return json(200, body.includes("memo-e2e") ? { text: "Transcription simulée du mémo" } : { text: "Dictée simulée" });
      }
      if (req.method === "POST" && url.pathname === "/v1/audio/voices") {
        requests.push({ path: url.pathname, model: body.match(/name="model"\r\n\r\n([^\r]+)/)?.[1] });
        return json(200, { id: "vv_e2e123", model: "tts-chatterbox-hd" });
      }
      if (req.method === "POST" && /^\/v1\/(video|audio)\/quote$/.test(url.pathname)) return json(200, { quote: 0.25 });
      if (req.method === "POST" && /^\/v1\/(video|audio)\/queue$/.test(url.pathname)) {
        const parsed = JSON.parse(body);
        requests.push({ path: url.pathname, ...parsed });
        jobs.set(parsed.model, 0);
        return json(200, { model: parsed.model, queue_id: `q-${parsed.model}` });
      }
      if (req.method === "POST" && /^\/v1\/(video|audio)\/retrieve$/.test(url.pathname)) {
        const parsed = JSON.parse(body);
        const polls = (jobs.get(parsed.model) ?? 0) + 1;
        jobs.set(parsed.model, polls);
        if (polls < 2) return json(200, { status: "PROCESSING", average_execution_time: 20000, execution_duration: 4000 });
        const video = url.pathname.startsWith("/v1/video");
        res.writeHead(200, { "Content-Type": video ? "video/mp4" : "audio/mpeg" });
        return res.end(Buffer.alloc(2048, video ? 1 : 2));
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
