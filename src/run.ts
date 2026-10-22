// Envoi des messages et boucle d'agent : streaming, outils, approbations, contexte et consommation.
import { api, type ApiMessage, type Conversation, type ImageRequest, type Message, type ModelInfo, type ToolCallRec } from "./api";
import { COMPACT_PROMPT, looksUnfinished, needsApproval, toApiMessages, toolLabel } from "./agent";
import { contextTokens, conversationUsage, fmtCost, fmtDuration, fmtTokens, today } from "./usage";
import { escapeHtml } from "./markdown";
import { workspaceLabel } from "./ssh-ui";
import { scheduleGitRefresh } from "./git-ui";
import { findProject } from "./projects-ui";
import { el, errMsg, maxContext, modelInfo, opts, state, sysPrompt, toolCtx, uid, type Activity, type RunOutcome } from "./state";
import { autoGrow, autoModel, modelTitle, toast } from "./ui";
import { refreshConvs, renderSidebar } from "./sidebar";
import { loadInstructions, renderChrome, toggleWsMenu, updateComposerState } from "./chrome";
import { guessRisk, renderConversation, rerenderMessage, scrollBottom } from "./thread";
import { renderAttachments } from "./attachments";
import { openSettings } from "./settings-ui";
import { checkBudget } from "./budget";

const MAX_CHAT_STEPS = 15;
const MAX_AUTO_CONTINUE = 2;
const AUTO_CONTINUE_TEXT = "Continue : exécute directement les actions annoncées avec les outils, sans les décrire.";

// ---------------------------------------------------------------- envoi et boucle d'agent

export async function saveCurrent() {
  if (!state.current) return;
  state.current.updatedAt = Date.now();
  try {
    await api.saveConversation(state.current);
    await refreshConvs();
  } catch (e) {
    toast(`Sauvegarde impossible : ${errMsg(e)}`, true);
  }
}

export async function send() {
  if (state.busy) return stop();
  const text = el.input.value.trim();
  const { images, files } = state.pending;
  if (!text && !images.length && !files.length) return;
  if (!state.keyConfigured) return openSettings();

  const o = opts();
  if (o.kind === "code" && !o.workspace) {
    toast("Choisissez d'abord le dossier de travail : local ou serveur SSH.", true);
    return toggleWsMenu(true);
  }
  const model = state.selectedModel;
  const imageGen = state.imageMode;
  if (imageGen && (images.length || files.length)) {
    toast("La génération d'images n'utilise pas les pièces jointes : retirez-les ou désactivez « Image ».", true);
    return;
  }
  if (!imageGen && images.length && modelInfo(model)?.vision === false) {
    toast(`Le modèle ${model} ne gère pas les images : choisissez un modèle marqué « vision ».`, true);
    return;
  }

  if (!state.current) {
    const now = Date.now();
    const title = (text || files[0]?.name || "Image").replace(/\s+/g, " ").slice(0, 60);
    state.current = {
      id: uid(),
      title,
      kind: o.kind,
      model,
      createdAt: now,
      updatedAt: now,
      systemPrompt: state.settings.systemPrompts.find((p) => p.id === o.promptId)?.text ?? null,
      promptId: o.promptId ?? "",
      ...(o.reasoningEffort ? { reasoningEffort: o.reasoningEffort } : {}),
      ...(o.character ? { character: o.character } : {}),
      messages: [],
      workspace: o.workspace,
      permissionMode: o.permissionMode,
      webSearch: o.webSearch,
      mcp: o.mcp,
      ...(o.kind === "code" && o.systemAccess ? { systemAccess: true } : {}),
      ...(o.kind === "chat" && o.imageGen ? { imageGen: true } : {}),
      ...(o.projectId ? { projectId: o.projectId } : {}),
    };
  }
  state.current.messages.push({
    id: uid(),
    role: "user",
    content: text,
    createdAt: Date.now(),
    ...(images.length ? { images: [...images] } : {}),
    ...(files.length ? { files: [...files] } : {}),
  });
  el.input.value = "";
  autoGrow(el.input);
  state.pending = { images: [], files: [] };
  renderAttachments();
  await runTurn();
}

/** Réponse au dernier message : texte (agent) ou image selon le mode de la conversation. */
export const runTurn = () => (state.imageMode ? runImage() : runAgent());


// ---------------------------------------------------------------- activité, contexte, consommation

let activityTimer = 0;

function setActivity(phase: string, detail?: string, extra: Partial<Activity> = {}) {
  const a = state.activity;
  if (!a) return;
  if (a.phase !== phase || a.detail !== detail) {
    Object.assign(a, { phase, detail, since: Date.now(), until: undefined }, extra);
  } else {
    Object.assign(a, extra);
  }
  renderActivity();
}

export function renderActivity() {
  const a = state.activity;
  const done = state.lastRun && state.lastRun.convId === state.current?.id ? state.lastRun : null;
  if (a) {
    const now = Date.now();
    const wait = a.until ? ` ${Math.max(0, Math.ceil((a.until - now) / 1000))} s` : "";
    const step = a.maxSteps > 1 ? ` · étape ${a.step}/${a.maxSteps}` : "";
    el.activity.className = "activity busy";
    el.activity.innerHTML = `<span class="pulse"></span><strong>${escapeHtml(a.phase)}${wait}</strong>${
      a.detail ? `<span class="act-detail">${escapeHtml(a.detail)}</span>` : ""
    }<span class="act-meta">${fmtDuration(now - a.since)} · total ${fmtDuration(now - a.runStart)}${step}</span><span class="act-hint">Échap pour arrêter</span>`;
    el.activity.hidden = false;
  } else if (done) {
    const icon = done.kind === "done" ? "✓" : done.kind === "stopped" ? "■" : "⚠";
    el.activity.className = `activity ${done.kind}`;
    el.activity.innerHTML = `<span class="act-icon">${icon}</span><span>${escapeHtml(done.text)}</span>${
      done.canContinue ? '<button type="button" class="btn-primary sm" data-continue>Continuer</button>' : ""
    }`;
    el.activity.hidden = false;
  } else {
    el.activity.hidden = true;
  }
}

el.activity.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("[data-continue]") || state.busy) return;
  el.input.value = "Continue.";
  send();
});



export function renderUsage() {
  const c = state.current;
  if (!c || !c.messages.length || state.imageMode) {
    el.ctxMeter.hidden = true;
    el.usageInfo.hidden = true;
    return;
  }
  const model = state.busy ? c.model : state.selectedModel || c.model;
  const ctx = contextTokens(c, () => toApiMessages(c, sysPrompt(c)));
  const max = maxContext(model);
  const pct = max ? Math.min(100, Math.round((ctx.tokens / max) * 100)) : null;
  el.ctxMeter.hidden = false;
  el.ctxMeter.classList.toggle("warn", (pct ?? 0) >= 70);
  el.ctxMeter.classList.toggle("crit", (pct ?? 0) >= 90);
  el.ctxMeter.innerHTML = `<span class="bar"><i style="width:${pct ?? 0}%"></i></span>${
    pct !== null ? `${pct} %` : `${ctx.exact ? "" : "≈"}${fmtTokens(ctx.tokens)}`
  }`;
  el.ctxMeter.title =
    `Contexte : ${ctx.exact ? "" : "≈ "}${fmtTokens(ctx.tokens)} tokens` +
    (max ? ` sur ${fmtTokens(max)} (${pct} %), reste ${fmtTokens(Math.max(0, max - ctx.tokens))}` : " (taille max du modèle inconnue)") +
    (c.compaction ? `\nHistorique compacté le ${new Date(c.compaction.at).toLocaleString("fr-FR")}` : "") +
    (state.settings.autoCompactPercent ? `\nCompaction automatique à ${state.settings.autoCompactPercent} %` : "") +
    "\nCliquer pour compacter maintenant (résumé de l'historique)";
  const u = conversationUsage(c, state.settings);
  el.usageInfo.hidden = u.promptTokens + u.completionTokens === 0;
  el.usageInfo.textContent = `${fmtTokens(u.promptTokens + u.completionTokens)} tokens · ${u.cost === null ? "coût ?" : fmtCost(u.cost)}`;
  el.usageInfo.title =
    `Consommation de cette conversation\nEntrée : ${u.promptTokens.toLocaleString("fr-FR")} tokens\nSortie : ${u.completionTokens.toLocaleString("fr-FR")} tokens\n` +
    `Coût estimé : ${fmtCost(u.cost)} (tarifs modifiables dans Réglages → Utilisation)`;
}

el.ctxMeter.addEventListener("click", async () => {
  const c = state.current;
  if (!c || state.busy || !c.messages.length) return;
  state.busy = { requestId: "", msgId: "", stopped: false };
  state.activity = { phase: "", since: Date.now(), runStart: Date.now(), step: 0, maxSteps: 0 };
  updateComposerState();
  try {
    await compact(c);
    toast("Historique compacté");
  } catch (e) {
    toast(`Compaction impossible : ${errMsg(e)}`, true);
  } finally {
    state.busy = null;
    state.activity = null;
    updateComposerState();
    renderConversation();
    renderSidebar();
  }
});

function recordUsage(conv: Conversation, model: string, promptTokens: number, completionTokens: number, extra: boolean) {
  api.recordUsage(today(), model, promptTokens, completionTokens).catch(() => {});
  if (extra) {
    conv.extraUsage ??= {};
    const u = (conv.extraUsage[model] ??= { promptTokens: 0, completionTokens: 0 });
    u.promptTokens += promptTokens;
    u.completionTokens += completionTokens;
  }
}

/** Résume l'historique pour libérer le contexte ; les messages restent affichés. */
async function compact(conv: Conversation) {
  setActivity("Compaction du contexte…", "résumé de l'historique par le modèle");
  const messages: ApiMessage[] = toApiMessages(conv, sysPrompt(conv));
  if (messages[messages.length - 1]?.role === "tool") messages.push({ role: "assistant", content: "(Pause.)" });
  messages.push({ role: "user", content: COMPACT_PROMPT });
  let summary = "";
  let failed = "";
  // Les définitions d'outils accompagnent l'historique (qui contient des appels), mais sans appel possible.
  const tools = await api.toolDefinitions(toolCtx(conv)).catch(() => []);
  const requestId = uid();
  if (state.busy) state.busy.requestId = requestId;
  await api.chat(
    requestId,
    { model: conv.model, messages, temperature: 0.2, maxTokens: 4000, tools: tools.map((t) => t.definition), toolChoice: "none" },
    (ev) => {
      if (ev.type === "delta") summary += ev.text;
      else if (ev.type === "usage") recordUsage(conv, conv.model, ev.promptTokens, ev.completionTokens, true);
      else if (ev.type === "retry") setActivity("Compaction : nouvel essai dans", ev.reason, { until: Date.now() + ev.delaySecs * 1000 });
      else if (ev.type === "done" && ev.cancelled) failed = "annulée";
    },
  );
  if (failed || !summary.trim()) throw new Error(failed || "résumé vide");
  conv.compaction = { summary: summary.trim(), upto: conv.messages.length, at: Date.now() };
  await saveCurrent();
}

const shouldCompact = (conv: Conversation) => {
  const pctLimit = state.settings.autoCompactPercent;
  const max = maxContext(conv.model);
  if (!pctLimit || !max || conv.messages.length < 4) return false;
  if (conv.compaction && conv.compaction.upto >= conv.messages.length - 1) return false;
  const ctx = contextTokens(conv, () => toApiMessages(conv, sysPrompt(conv)));
  return ctx.tokens >= (max * pctLimit) / 100;
};

// ---------------------------------------------------------------- boucle d'agent

/** Un tour du modèle en streaming. Renvoie false en cas d'erreur ou d'arrêt. */
async function streamTurn(conv: Conversation, msg: Message, tools: Awaited<ReturnType<typeof api.toolDefinitions>>): Promise<boolean> {
  const requestId = uid();
  if (state.busy) Object.assign(state.busy, { requestId, msgId: msg.id });
  const messages = toApiMessages({ ...conv, messages: conv.messages.filter((m) => m !== msg) }, sysPrompt(conv));
  setActivity("Envoi de la requête…", conv.model);
  let ok = true;
  try {
    await api.chat(
      requestId,
      {
        model: conv.model,
        messages,
        temperature: state.settings.temperature,
        maxTokens: state.settings.maxTokens,
        tools: tools.map((t) => t.definition),
        webSearch: !!conv.webSearch,
        reasoningEffort: conv.reasoningEffort || null,
        characterSlug: conv.kind === "chat" ? (conv.character?.slug ?? null) : null,
      },
      (ev) => {
        switch (ev.type) {
          case "citations":
            msg.citations = ev.items;
            setActivity("Recherche web…", `${ev.items.length} source(s)`);
            break;
          case "delta":
            msg.content += ev.text;
            setActivity("Rédaction…", `≈ ${fmtTokens(Math.round(msg.content.length / 3.5))} tokens`);
            break;
          case "reasoning":
            msg.reasoning = (msg.reasoning ?? "") + ev.text;
            setActivity("Réflexion…", `≈ ${fmtTokens(Math.round(msg.reasoning.length / 3.5))} tokens`);
            break;
          case "usage":
            msg.usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
            recordUsage(conv, conv.model, ev.promptTokens, ev.completionTokens, false);
            break;
          case "toolCalls":
            msg.toolCalls = ev.calls.map((c) => ({ ...c, status: "queued" as const }));
            setActivity("Préparation des actions…", `${ev.calls.length} appel(s) d'outil`);
            break;
          case "retry":
            setActivity("Nouvel essai dans", `${ev.reason} · tentative ${ev.attempt + 1}/${ev.maxAttempts}`, {
              until: Date.now() + ev.delaySecs * 1000,
            });
            break;
          case "done":
            if (ev.cancelled) {
              msg.cancelled = true;
              ok = false;
            }
            if (ev.finishReason === "length") {
              msg.error = "Réponse tronquée (limite de tokens atteinte).";
              ok = false;
            }
            break;
        }
        rerenderMessage(msg);
        if (ev.type === "usage") renderUsage();
      },
    );
  } catch (e) {
    msg.error = errMsg(e);
    ok = false;
  }
  if (!ok) {
    // Appels d'outils jamais exécutés : on les marque pour garder un historique valide.
    for (const tc of msg.toolCalls ?? []) {
      tc.status = "denied";
      tc.result = "Non exécuté (interrompu).";
    }
  }
  return ok && !state.busy?.stopped;
}

function waitApproval(tc: ToolCallRec): Promise<"allow" | "always" | "deny"> {
  return new Promise((resolve) => {
    state.approvals.set(tc.id, (d) => {
      state.approvals.delete(tc.id);
      resolve(d);
    });
  });
}

/** Exécute les appels d'outils d'un message. Renvoie "ok", "denied" ou "stopped". */
async function runToolCalls(conv: Conversation, msg: Message): Promise<"ok" | "denied" | "stopped"> {
  const ctx = toolCtx(conv);
  const calls = msg.toolCalls ?? [];
  for (let i = 0; i < calls.length; i++) {
    const tc = calls[i];
    const skipRest = (reason: string) => {
      for (const rest of calls.slice(i)) {
        if (rest.status === "queued" || rest.status === "pending" || rest.status === "running") {
          rest.status = "denied";
          rest.result ??= reason;
        }
      }
      rerenderMessage(msg, true);
    };
    if (state.busy?.stopped) {
      skipRest("Non exécuté : arrêté par l'utilisateur.");
      return "stopped";
    }

    const risk = state.risks.get(tc.name) ?? guessRisk(tc.name);
    // Accès système : un chemin hors du projet demande une approbation renforcée.
    if (ctx.system && (risk === "read" || risk === "write")) {
      tc.outside = (await api.toolOutside(ctx, tc.name, tc.arguments).catch(() => null)) ?? undefined;
    }
    if (needsApproval(risk, tc.name, conv.permissionMode ?? "ask", state.settings, !!tc.outside)) {
      if (risk === "write") {
        try {
          tc.diff = (await api.previewTool(ctx, tc.name, tc.arguments)) ?? undefined;
        } catch (e) {
          // Modification impossible (texte introuvable…) : on renvoie l'erreur au modèle sans déranger l'utilisateur.
          tc.status = "error";
          tc.result = `Erreur : ${errMsg(e)}`;
          rerenderMessage(msg, true);
          continue;
        }
      }
      tc.status = "pending";
      rerenderMessage(msg, true);
      scrollBottom();
      setActivity("En attente de votre approbation", toolLabel(tc));
      notifyAttention();
      const decision = await waitApproval(tc);
      if (decision === "deny") {
        tc.status = "denied";
        tc.result = "L'utilisateur a refusé cette action. Arrête-toi et demande-lui comment procéder.";
        skipRest("Non exécuté : une action précédente a été refusée.");
        return state.busy?.stopped ? "stopped" : "denied";
      }
      if (decision === "always") {
        if (risk === "mcp") {
          state.settings.mcpAlwaysAllow = [...new Set([...state.settings.mcpAlwaysAllow, tc.name])];
          api.saveSettings(state.settings).catch((e) => toast(errMsg(e), true));
        } else if (risk === "write" && !tc.outside) {
          conv.permissionMode = "acceptEdits";
          renderChrome();
        }
      }
    }

    tc.status = "running";
    rerenderMessage(msg, true);
    setActivity("Exécution", toolLabel(tc));
    const requestId = uid();
    if (state.busy) Object.assign(state.busy, { requestId, msgId: msg.id });
    try {
      const out = await api.runTool(requestId, ctx, tc.name, tc.arguments);
      tc.result = out.content;
      tc.status = out.isError ? "error" : "done";
      if (out.diff) tc.diff = out.diff;
    } catch (e) {
      tc.result = `Erreur : ${errMsg(e)}`;
      tc.status = "error";
    }
    rerenderMessage(msg, true);
  }
  await saveCurrent();
  renderUsage();
  if (conv.kind === "code") scheduleGitRefresh();
  return state.busy?.stopped ? "stopped" : "ok";
}

/** Attire l'attention si la fenêtre n'a pas le focus (approbation requise). */
function notifyAttention() {
  if (document.hasFocus()) return;
  document.title = "⏸ Approbation requise — Venice Desktop";
  window.addEventListener("focus", () => (document.title = "Venice Desktop"), { once: true });
}

export async function runAgent() {
  const conv = state.current;
  if (!conv) return;
  conv.model = state.selectedModel;
  const maxSteps = conv.kind === "code" ? Math.max(5, state.settings.maxSteps || 100) : MAX_CHAT_STEPS;
  const runStart = Date.now();
  state.busy = { requestId: "", msgId: "", stopped: false };
  state.lastRun = null;
  state.activity = { phase: "Préparation…", since: runStart, runStart, step: 1, maxSteps };
  clearInterval(activityTimer);
  activityTimer = window.setInterval(renderActivity, 1000);
  updateComposerState();
  renderSidebar();

  if (conv.projectId && findProject(conv.projectId)?.files.length) {
    // Gros projets : seuls les extraits pertinents pour la dernière question sont joints.
    const question = [...conv.messages].reverse().find((m) => m.role === "user" && !m.auto)?.content ?? "";
    setActivity("Recherche dans les fichiers du projet…");
    try {
      state.projectCtx.set(conv.id, await api.projectContext(conv.projectId, question));
    } catch {
      state.projectCtx.delete(conv.id);
    }
  }
  if (conv.kind === "code" && conv.workspace) {
    // Relu à chaque tâche : l'agent ou l'utilisateur ont pu modifier AGENTS.md.
    setActivity("Lecture des consignes du projet…", workspaceLabel(conv.workspace).name);
    await loadInstructions(conv.workspace);
  }

  let tools: Awaited<ReturnType<typeof api.toolDefinitions>> = [];
  try {
    tools = await api.toolDefinitions(toolCtx(conv));
    for (const t of tools) state.risks.set(t.definition.function.name, t.risk);
  } catch (e) {
    toast(`Outils indisponibles : ${errMsg(e)}`, true);
  }

  renderConversation();
  await saveCurrent();
  let outcome: Omit<RunOutcome, "convId"> = { kind: "done", text: "", canContinue: false };
  let steps = 0;
  let nudges = 0;
  try {
    for (let step = 1; ; step++) {
      if (step > maxSteps) {
        outcome = { kind: "limit", text: `Limite de ${maxSteps} étapes atteinte (réglable dans Réglages → Code).`, canContinue: true };
        break;
      }
      steps = step;
      if (state.activity) state.activity.step = step;
      if (shouldCompact(conv)) {
        try {
          await compact(conv);
          renderConversation();
        } catch (e) {
          toast(`Compaction automatique impossible : ${errMsg(e)}`, true);
        }
      }
      const msg: Message = { id: uid(), role: "assistant", content: "", model: conv.model, createdAt: Date.now() };
      conv.messages.push(msg);
      if (state.busy) state.busy.msgId = msg.id;
      rerenderMessage(msg, true);
      const ok = await streamTurn(conv, msg, tools);
      if (!msg.content && !msg.reasoning && !msg.toolCalls?.length && !msg.error && !msg.cancelled) {
        msg.error = "Réponse vide du modèle.";
      }
      rerenderMessage(msg, true);
      await saveCurrent();
      renderUsage();
      if (!ok) {
        outcome = state.busy?.stopped || msg.cancelled
          ? { kind: "stopped", text: "Arrêté à votre demande.", canContinue: true }
          : msg.error?.startsWith("Réponse tronquée")
            ? { kind: "truncated", text: "Réponse coupée : limite de tokens de sortie atteinte (réglage « Tokens max »).", canContinue: true }
            : { kind: "error", text: `Interrompu par une erreur : ${msg.error ?? "inconnue"}`, canContinue: true };
        break;
      }
      if (!msg.toolCalls?.length) {
        // Réponse finale… ou action annoncée sans être exécutée : relance automatique.
        if (conv.kind === "code" && state.settings.autoContinue && nudges < MAX_AUTO_CONTINUE && looksUnfinished(msg.content)) {
          nudges++;
          conv.messages.push({ id: uid(), role: "user", content: AUTO_CONTINUE_TEXT, createdAt: Date.now(), auto: true });
          renderConversation();
          continue;
        }
        break;
      }
      const res = await runToolCalls(conv, msg);
      if (res === "denied") {
        outcome = { kind: "denied", text: "En pause : vous avez refusé une action. Donnez vos consignes pour continuer.", canContinue: false };
        break;
      }
      if (res === "stopped") {
        outcome = { kind: "stopped", text: "Arrêté à votre demande.", canContinue: true };
        break;
      }
    }
  } finally {
    const elapsed = fmtDuration(Date.now() - runStart);
    if (outcome.kind === "done") {
      const u = conversationUsage(conv, state.settings);
      outcome.text = `Terminé en ${elapsed} · ${steps} étape${steps > 1 ? "s" : ""} · ${fmtTokens(u.promptTokens + u.completionTokens)} tokens dans la conversation`;
    } else {
      outcome.text += ` (${elapsed}, ${steps} étape${steps > 1 ? "s" : ""})`;
    }
    state.lastRun = { ...outcome, convId: conv.id };
    state.busy = null;
    state.activity = null;
    clearInterval(activityTimer);
    for (const resolve of state.approvals.values()) resolve("deny");
    state.approvals.clear();
    const last = conv.messages[conv.messages.length - 1];
    if (last) rerenderMessage(last, true);
    updateComposerState();
    renderActivity();
    renderSidebar();
    renderUsage();
    await saveCurrent();
    checkBudget();
  }
}

// ---------------------------------------------------------------- génération d'images

/** Taille demandée : format imposé par le modèle, sinon largeur × hauteur (≈ 1 mégapixel). */
export function imageSize(info: ModelInfo | undefined, aspect: string): Pick<ImageRequest, "aspectRatio" | "resolution" | "width" | "height"> {
  const c = info?.constraints;
  if (c?.aspectRatios?.length) {
    return {
      aspectRatio: c.aspectRatios.includes(aspect) ? aspect : (c.defaultAspectRatio ?? c.aspectRatios[0]),
      ...(c.defaultResolution ? { resolution: c.defaultResolution } : {}),
    };
  }
  let [a, b] = aspect.split(":").map(Number);
  if (!(a > 0 && b > 0)) [a, b] = [1, 1];
  const div = c?.widthHeightDivisor || 16;
  const w = Math.sqrt((1024 * 1024 * a) / b);
  const h = (w * b) / a;
  const scale = Math.min(1, 1280 / Math.max(w, h));
  const round = (n: number) => Math.max(div, Math.round((n * scale) / div) * div);
  return { width: round(w), height: round(h) };
}

/**
 * Tâche de génération (image, retouche…) affichée comme une réponse : activité, arrêt, bilan.
 * `job` remplit le message et renvoie le texte du bilan.
 */
export async function runMediaJob(
  phase: string,
  detail: string,
  model: string,
  job: (requestId: string, msg: Message) => Promise<string>,
): Promise<Message | null> {
  const conv = state.current;
  if (!conv || state.busy) return null;
  const msg: Message = { id: uid(), role: "assistant", content: "", model, createdAt: Date.now() };
  conv.messages.push(msg);
  const requestId = uid();
  const runStart = Date.now();
  state.busy = { requestId, msgId: msg.id, stopped: false };
  state.lastRun = null;
  state.activity = { phase, detail, since: runStart, runStart, step: 1, maxSteps: 1 };
  clearInterval(activityTimer);
  activityTimer = window.setInterval(renderActivity, 1000);
  updateComposerState();
  renderSidebar();
  renderConversation();
  await saveCurrent();
  let outcome: Omit<RunOutcome, "convId">;
  try {
    const text = await job(requestId, msg);
    outcome = { kind: "done", text: `${text} en ${fmtDuration(Date.now() - runStart)}`, canContinue: false };
  } catch (e) {
    if (state.busy?.stopped) {
      msg.cancelled = true;
      outcome = { kind: "stopped", text: "Arrêté à votre demande.", canContinue: false };
    } else {
      msg.error = errMsg(e);
      outcome = { kind: "error", text: `Échec : ${msg.error}`, canContinue: false };
    }
  }
  state.lastRun = { ...outcome, convId: conv.id };
  state.busy = null;
  state.activity = null;
  clearInterval(activityTimer);
  rerenderMessage(msg, true);
  updateComposerState();
  renderActivity();
  renderSidebar();
  await saveCurrent();
  checkBudget();
  return msg.error || msg.cancelled ? null : msg;
}

/** Génère une ou plusieurs images à partir du dernier message de l'utilisateur. */
export async function runImage() {
  const conv = state.current;
  if (!conv) return;
  const prompt = [...conv.messages].reverse().find((m) => m.role === "user")?.content.trim() ?? "";
  const model = state.selectedImageModel || autoModel("image");
  const info = state.imageModels.find((m) => m.id === model);
  const variants = Math.min(4, Math.max(1, state.imageVariants || state.settings.imageVariants || 1));
  // Graine choisie (réutilisée) ou tirée au hasard, gardée pour pouvoir la réutiliser.
  const seed = state.lockedSeed ?? Math.floor(Math.random() * 2 ** 31);
  await runMediaJob("Génération de l'image…", info?.name ?? model, model, async (requestId, msg) => {
    const limit = info?.constraints?.promptCharacterLimit;
    if (!prompt) throw new Error("Décrivez l'image à générer.");
    if (limit && prompt.length > limit) throw new Error(`Description trop longue pour ${model} : ${prompt.length} caractères, ${limit} au maximum.`);
    const res = await api.generateImage(requestId, {
      model,
      prompt,
      negativePrompt: state.settings.imageNegativePrompt,
      ...imageSize(info, state.imageAspect || state.settings.imageAspect),
      safeMode: state.settings.imageSafeMode,
      hideWatermark: state.settings.imageHideWatermark,
      variants,
      seed,
    });
    msg.generated = res.images;
    msg.seed = seed;
    if (res.blurred) msg.blurred = true;
    const cost = info?.imagePrice ? ` · ${fmtCost(info.imagePrice * res.images.length)}` : "";
    return `${res.images.length > 1 ? `${res.images.length} images générées` : "Image générée"}${cost}${res.blurred ? " · floutée par le mode sûr (Réglages → Outils)" : ""}`;
  });
}

const TRANSFORM_LABEL = {
  upscale2: "Agrandir ×2",
  upscale4: "Agrandir ×4",
  background: "Supprimer l'arrière-plan",
  edit: "Modifier",
} as const;
export type ImageOp = keyof typeof TRANSFORM_LABEL;

/** Retouche une image ; le résultat est ajouté à la conversation et renvoyé (data URL). */
export async function runTransform(op: ImageOp, src: string, prompt = ""): Promise<string | null> {
  const conv = state.current;
  if (!conv || state.busy) return null;
  const label = op === "edit" ? `Modifier l'image : ${prompt}` : TRANSFORM_LABEL[op];
  const model = op === "edit" ? state.settings.imageEditModel || autoModel("edit") : op === "background" ? "background-remove" : "upscale";
  // L'image d'origine accompagne la demande, mais n'est jamais envoyée au modèle de texte.
  conv.messages.push({ id: uid(), role: "user", content: label, createdAt: Date.now(), images: [src], imageOp: true });
  const msg = await runMediaJob(`${TRANSFORM_LABEL[op]}…`, op === "edit" ? model : "", model, async (requestId, m) => {
    m.generated = [await api.transformImage(requestId, { op, image: src, prompt, model })];
    return TRANSFORM_LABEL[op] === "Modifier" ? "Image modifiée" : `${TRANSFORM_LABEL[op]} : terminé`;
  });
  return msg?.generated?.[0] ?? null;
}

export async function stop() {
  const b = state.busy;
  if (!b) return;
  b.stopped = true;
  for (const resolve of [...state.approvals.values()]) resolve("deny");
  if (b.requestId) await api.cancel(b.requestId).catch(() => {});
}


el.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});
el.input.addEventListener("input", () => autoGrow(el.input));
el.input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;
  if ((state.settings.sendOnEnter && !e.shiftKey) || mod) {
    e.preventDefault();
    send();
  }
});
el.modelSelect.addEventListener("change", () => {
  if (state.imageMode) state.selectedImageModel = el.modelSelect.value;
  else state.selectedModel = el.modelSelect.value;
  renderChrome();
  el.modelSelect.title = modelTitle((state.imageMode ? state.imageModels : state.models).find((m) => m.id === el.modelSelect.value));
  renderUsage();
});
el.exportBtn.addEventListener("click", async () => {
  if (!state.current) return;
  try {
    if (await api.exportConversation(state.current.id)) toast("Conversation exportée");
  } catch (e) {
    toast(errMsg(e), true);
  }
});
