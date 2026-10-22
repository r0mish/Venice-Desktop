// Barre du haut et compositeur : options de la conversation, consignes AGENTS.md, choix du dossier.
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, type InstructionFile, type MediaMode, type PermissionMode } from "./api";
import { escapeHtml } from "./markdown";
import { openSshDialog, parseRemote, workspaceLabel } from "./ssh-ui";
import { scheduleGitRefresh, toggleGitPanel } from "./git-ui";
import { findProject, projectList } from "./projects-ui";
import { el, errMsg, opts, state, type Draft } from "./state";
import { autoModel, copy, fillTopModelSelect, icons, isVenice, toast, visibleModels } from "./ui";
import { openCharacterDialog } from "./characters-ui";
import { newChat, projectOptions } from "./sidebar";
import { renderConversation, renderWelcome } from "./thread";
import { renderActivity, renderUsage, saveCurrent } from "./run";

// ---------------------------------------------------------------- options de la conversation


export function setOpt<K extends keyof Draft>(key: K, value: Draft[K]) {
  if (state.current) {
    (state.current as unknown as Draft)[key] = value;
    saveCurrent();
  } else {
    state.draft[key] = value;
  }
  renderChrome();
}

const mcpToolCount = () => state.mcp.filter((s) => s.state === "ready").reduce((n, s) => n + s.tools.length, 0);

/** Barre du haut et bascules du compositeur. */
export function renderChrome() {
  const c = state.current;
  const o = opts();
  el.title.textContent = c?.title ?? (o.kind === "code" ? "Nouvelle session de code" : "Nouvelle conversation");
  el.exportBtn.hidden = !c;
  el.wsChip.hidden = o.kind !== "code" || !o.workspace;
  if (o.workspace) {
    const l = workspaceLabel(o.workspace);
    el.wsChip.querySelector("span")!.textContent = l.name;
    el.wsChip.title = l.remote ? `${l.detail}\nCliquer pour copier le chemin` : `${l.detail}\nCliquer pour ouvrir le dossier`;
    el.wsChip.classList.toggle("remote", l.remote);
  }
  renderInstrChip(o.kind === "code" ? o.workspace : undefined);
  renderWsPicker();
  const projects = projectList();
  el.convProject.hidden = projects.length === 0;
  if (projects.length) {
    el.convProject.innerHTML = projectOptions("Sans projet");
    el.convProject.value = o.projectId && findProject(o.projectId) ? o.projectId : "";
    el.convProject.classList.toggle("on", !!el.convProject.value);
  }
  renderPromptSelect(o.promptId, c?.systemPrompt ?? null, o.kind === "chat" ? o.character : undefined);
  renderEffortSelect(o.reasoningEffort);
  renderCompareSelect(o.kind === "chat" ? o.compareModel : "");
  if (o.kind !== "code" || !o.workspace) toggleGitPanel(false);
  if (o.kind === "code") scheduleGitRefresh(200);
  else el.gitBtn.hidden = true;
  el.permSelect.hidden = o.kind !== "code";
  el.permSelect.value = o.permissionMode;
  const media = state.mediaMode;
  const img = media === "image";
  const creating = !!media;
  el.webToggle.classList.toggle("on", o.webSearch);
  el.webToggle.hidden = creating;
  const venice = o.kind === "chat" && isVenice();
  el.imgToggle.hidden = !venice || !state.imageModels.length;
  el.imgToggle.classList.toggle("on", img);
  el.vidToggle.hidden = !venice || !state.videoModels.length;
  el.vidToggle.classList.toggle("on", media === "video");
  el.musicToggle.hidden = !venice || !state.musicModels.length;
  el.musicToggle.classList.toggle("on", media === "music");
  renderMediaOpts(media === "video" || media === "music" ? media : undefined);
  el.imgAspect.hidden = !img;
  el.imgVariants.hidden = !img;
  el.imgVariants.value = String(state.imageVariants || state.settings.imageVariants || 1);
  el.seedChip.hidden = !img || state.lockedSeed == null;
  el.seedChip.textContent = `Graine ${state.lockedSeed} ×`;
  if (img) renderAspects();
  const configured = state.mcp.filter((s) => s.state !== "disabled").length;
  el.mcpToggle.hidden = configured === 0;
  el.mcpToggle.classList.toggle("on", o.mcp);
  el.sysToggle.hidden = o.kind !== "code";
  el.sysToggle.classList.toggle("on", o.systemAccess);
  el.mcpToggle.querySelector("span")!.textContent = `MCP ${mcpToolCount()}`;
  el.mcpToggle.title = state.mcp.map((s) => `${s.name} : ${s.state === "ready" ? `${s.tools.length} outils` : s.state}`).join("\n");
  el.input.placeholder =
    o.kind === "code"
      ? "Décrivez la tâche à réaliser dans le projet…"
      : img
        ? "Décrivez l'image à générer…"
        : media === "video"
          ? "Décrivez la vidéo (joignez une image pour l'animer)…"
          : media === "music"
            ? "Décrivez la musique ou le son (paroles éventuelles après une ligne « Paroles : »)…"
            : "Écrivez à Venice…";
  el.mcpToggle.hidden ||= creating;
  el.promptSelect.hidden ||= creating;
  el.effortSelect.hidden ||= creating;
  el.compareSelect.hidden ||= creating || o.kind !== "chat";
  el.composer.classList.toggle("image-mode", creating);
  updateComposerState();
  renderUsage();
  renderActivity();
}

/** Instructions système et personnage Venice de la conversation (barre du haut). */
function renderPromptSelect(promptId: string | undefined, snapshot: string | null, character?: { slug: string; name: string }) {
  const presets = state.settings.systemPrompts ?? [];
  const venice = isVenice() && opts().kind === "chat";
  // Ancienne conversation ou instruction supprimée : son texte reste utilisé, affiché à part.
  const orphan = !presets.some((p) => p.id === promptId) && !!snapshot?.trim();
  el.promptSelect.hidden = !presets.length && !orphan && !venice;
  if (el.promptSelect.hidden) return;
  el.promptSelect.innerHTML =
    '<option value="">Sans instructions</option>' +
    (orphan ? '<option value="__keep">Instructions de la conversation</option>' : "") +
    presets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || "Sans nom")}</option>`).join("") +
    (venice
      ? `<optgroup label="Personnages Venice">${character ? `<option value="__charset">🎭 ${escapeHtml(character.name)}</option>` : ""}<option value="__char">Choisir un personnage…</option></optgroup>`
      : "");
  el.promptSelect.value = character && venice ? "__charset" : orphan ? "__keep" : (promptId ?? "");
  el.promptSelect.classList.toggle("on", !!el.promptSelect.value);
  const text = orphan ? snapshot! : presets.find((p) => p.id === promptId)?.text ?? "";
  el.promptSelect.title = character
    ? `Personnage Venice : ${character.name}`
    : text
      ? `Instructions système :\n${text.slice(0, 600)}${text.length > 600 ? "…" : ""}`
      : "Aucune instruction système";
}

el.promptSelect.addEventListener("change", () => {
  const id = el.promptSelect.value;
  if (id === "__keep" || id === "__charset") return;
  if (id === "__char") {
    renderChrome();
    return openCharacterDialog((c) => setOpt("character", c));
  }
  if (state.current) {
    state.current.systemPrompt = state.settings.systemPrompts.find((p) => p.id === id)?.text ?? null;
    state.current.character = undefined;
  } else {
    state.draft.character = undefined;
  }
  setOpt("promptId", id);
});

const EFFORT_LABEL: Record<string, string> = {
  none: "aucune",
  minimal: "minimale",
  low: "faible",
  medium: "moyenne",
  high: "élevée",
  xhigh: "très élevée",
  max: "maximale",
};

/** Effort de raisonnement, pour les modèles qui réfléchissent. */
function renderEffortSelect(effort: string) {
  const m = state.models.find((x) => x.id === (state.current && state.busy ? state.current.model : state.selectedModel));
  el.effortSelect.hidden = !m || (!m.reasoning && !m.reasoningEfforts.length);
  if (el.effortSelect.hidden || !m) return;
  const levels = m.reasoningEfforts.filter((e) => e !== "none");
  const def = m.defaultEffort ? ` (${EFFORT_LABEL[m.defaultEffort] ?? m.defaultEffort})` : "";
  el.effortSelect.innerHTML =
    `<option value="">Réflexion : par défaut${def}</option>` +
    levels.map((l) => `<option value="${escapeHtml(l)}">Réflexion : ${escapeHtml(EFFORT_LABEL[l] ?? l)}</option>`).join("") +
    '<option value="off">Sans réflexion (plus rapide)</option>';
  el.effortSelect.value = levels.includes(effort) || effort === "off" ? effort : "";
  el.effortSelect.classList.toggle("on", !!el.effortSelect.value);
  el.effortSelect.title = "Effort de raisonnement du modèle : plus d'effort = réponses plus réfléchies, mais plus lentes et plus coûteuses";
}

el.effortSelect.addEventListener("change", () => setOpt("reasoningEffort", el.effortSelect.value));

/** Second modèle qui répond aussi, pour comparer les réponses côte à côte. */
function renderCompareSelect(model: string) {
  const list = visibleModels(state.models);
  el.compareSelect.hidden = list.length < 2;
  if (el.compareSelect.hidden) return;
  el.compareSelect.innerHTML =
    '<option value="">Comparer : non</option>' +
    list.map((m) => `<option value="${escapeHtml(m.id)}">⇄ ${escapeHtml(m.name || m.id)}</option>`).join("");
  el.compareSelect.value = list.some((m) => m.id === model) ? model : "";
  el.compareSelect.classList.toggle("on", !!el.compareSelect.value);
}

el.compareSelect.addEventListener("change", () => setOpt("compareModel", el.compareSelect.value));

el.webToggle.addEventListener("click", () => setOpt("webSearch", !opts().webSearch));
/** Bascule de création : un clic active ce mode (image, vidéo, musique), un second revient au texte. */
function toggleMedia(mode: MediaMode) {
  setOpt("imageGen", false);
  setOpt("media", state.mediaMode === mode ? "" : mode);
  fillTopModelSelect();
  renderChrome();
}
el.imgToggle.addEventListener("click", () => toggleMedia("image"));
el.vidToggle.addEventListener("click", () => toggleMedia("video"));
el.musicToggle.addEventListener("click", () => toggleMedia("music"));

const sel = (key: string, label: string, values: string[], current: string, fmt = (v: string) => v) =>
  `<select class="aspect-select" data-opt="${key}" title="${escapeHtml(label)}">${values
    .map((v) => `<option value="${escapeHtml(v)}"${v === current ? " selected" : ""}>${escapeHtml(fmt(v))}</option>`)
    .join("")}</select>`;

/** Options de la vidéo (durée, format, résolution, son) ou de la musique (durée, instrumental). */
function renderMediaOpts(kind: "video" | "music" | undefined) {
  el.mediaOpts.hidden = !kind;
  if (!kind) return;
  const o = state.mediaOpts;
  if (kind === "video") {
    const m = state.videoModels.find((x) => x.id === (state.selectedVideoModel || autoModel("video")));
    const c = ((m?.spec ?? {}) as { constraints?: { durations?: string[]; aspect_ratios?: string[]; resolutions?: string[]; audio_configurable?: boolean } }).constraints ?? {};
    const pick = (v: string, list: string[] = []) => (list.includes(v) ? v : (list[0] ?? ""));
    o.duration = pick(o.duration, c.durations);
    o.aspect = pick(o.aspect, c.aspect_ratios);
    o.resolution = pick(o.resolution, c.resolutions);
    el.mediaOpts.innerHTML =
      (c.durations?.length ? sel("duration", "Durée", c.durations, o.duration) : "") +
      (c.aspect_ratios?.length ? sel("aspect", "Format", c.aspect_ratios, o.aspect) : "") +
      (c.resolutions?.length ? sel("resolution", "Résolution", c.resolutions, o.resolution) : "") +
      (c.audio_configurable ? `<button type="button" class="toggle${o.audio ? " on" : ""}" data-opt-toggle="audio" title="Bande son générée">Son</button>` : "");
  } else {
    const m = state.musicModels.find((x) => x.id === (state.selectedMusicModel || autoModel("music")));
    const spec = (m?.spec ?? {}) as { duration_options?: number[]; default_duration?: number; supports_force_instrumental?: boolean };
    const durations = (spec.duration_options ?? []).map(String);
    if (!durations.includes(o.duration)) o.duration = String(spec.default_duration ?? durations[0] ?? "");
    el.mediaOpts.innerHTML =
      (durations.length ? sel("duration", "Durée", durations, o.duration, (v) => `${v} s`) : "") +
      (spec.supports_force_instrumental ? `<button type="button" class="toggle${o.instrumental ? " on" : ""}" data-opt-toggle="instrumental" title="Sans voix">Instrumental</button>` : "");
  }
}

el.mediaOpts.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  const key = t.dataset.opt as "duration" | "aspect" | "resolution" | undefined;
  if (key) state.mediaOpts[key] = t.value;
});
el.mediaOpts.addEventListener("click", (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>("[data-opt-toggle]")?.dataset.optToggle as "audio" | "instrumental" | undefined;
  if (!key) return;
  state.mediaOpts[key] = !state.mediaOpts[key];
  renderChrome();
});

const ASPECTS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];
const imageModel = () => state.imageModels.find((m) => m.id === state.selectedImageModel);

/** Formats proposés : ceux imposés par le modèle, sinon les formats usuels. */
function renderAspects() {
  const allowed = imageModel()?.constraints?.aspectRatios;
  const list = allowed?.length ? allowed : ASPECTS;
  const cur = list.includes(state.imageAspect) ? state.imageAspect : list.includes(state.settings.imageAspect) ? state.settings.imageAspect : list[0];
  state.imageAspect = cur;
  el.imgAspect.innerHTML = list.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
  el.imgAspect.value = cur;
}
el.imgAspect.addEventListener("change", () => (state.imageAspect = el.imgAspect.value));
el.imgVariants.addEventListener("change", () => (state.imageVariants = Number(el.imgVariants.value)));
el.seedChip.addEventListener("click", () => {
  state.lockedSeed = null;
  renderChrome();
});
el.mcpToggle.addEventListener("click", () => setOpt("mcp", !opts().mcp));
el.sysToggle.addEventListener("click", () => {
  const on = !opts().systemAccess;
  setOpt("systemAccess", on);
  if (on) toast("Accès système activé : l'agent peut lire et modifier des fichiers hors du projet, avec votre approbation.");
});
el.permSelect.addEventListener("change", () => setOpt("permissionMode", el.permSelect.value as PermissionMode));
el.wsChip.addEventListener("click", () => {
  const ws = opts().workspace;
  if (!ws) return;
  const r = parseRemote(ws);
  if (r) {
    copy(r.path);
    toast(`Chemin copié : ${r.path}`);
  } else {
    revealItemInDir(ws).catch((e) => toast(errMsg(e), true));
  }
});

const instrLoading = new Set<string>();

/** (Re)lit les fichiers de consignes du dossier. */
export async function loadInstructions(ws: string): Promise<InstructionFile[]> {
  instrLoading.add(ws);
  try {
    const files = await api.workspaceInstructions(ws).catch(() => [] as InstructionFile[]);
    state.instructions.set(ws, files);
    return files;
  } finally {
    instrLoading.delete(ws);
    if (opts().kind === "code" && opts().workspace === ws) {
      renderInstrChip(ws);
      if (!state.current) renderWelcome();
      else renderUsage();
    }
  }
}

function renderInstrChip(ws: string | undefined) {
  const files = ws ? state.instructions.get(ws) : undefined;
  if (ws && !files && !instrLoading.has(ws)) loadInstructions(ws);
  el.instrChip.hidden = !files?.length;
  if (!ws || !files?.length) return;
  el.instrChip.querySelector("span")!.textContent = files.map((f) => f.name).join(" + ");
  el.instrChip.title =
    "Consignes du projet lues automatiquement par l'agent à chaque tâche :\n" +
    files.map((f) => `• ${f.name} (${(f.content.length / 1024).toFixed(1)} Ko${f.truncated ? ", tronqué" : ""})`).join("\n") +
    (parseRemote(ws) ? "" : "\nCliquer pour afficher le fichier");
}

el.instrChip.addEventListener("click", () => {
  const ws = opts().workspace;
  const f = ws ? state.instructions.get(ws)?.[0] : undefined;
  if (!ws || !f || parseRemote(ws)) return;
  const sep = ws.includes("\\") && !ws.includes("/") ? "\\" : "/";
  revealItemInDir(`${ws.replace(/[\\/]$/, "")}${sep}${f.name}`).catch((e) => toast(errMsg(e), true));
});

export function selectWorkspace(ws: string) {
  toggleWsMenu(false);
  state.draft.workspace = ws;
  api
    .touchWorkspace(ws)
    .then(() => api.listWorkspaces())
    .then((w) => (state.workspaces = w))
    .catch(() => {});
  renderConversation();
  el.input.focus();
}

/** Bouton « dossier » de la zone de saisie (nouvelle session de code uniquement). */
function renderWsPicker() {
  const show = !state.current && state.mode === "code";
  el.wsPicker.hidden = !show;
  if (!show) return toggleWsMenu(false);
  const ws = state.draft.workspace;
  const l = ws ? workspaceLabel(ws) : null;
  el.wsPicker.querySelector("span")!.textContent = l ? l.name : "Choisir un dossier";
  el.wsPicker.classList.toggle("on", !!ws);
  el.wsPicker.classList.toggle("remote", !!l?.remote);
  el.wsPicker.title = l ? `${l.detail}\nCliquer pour changer de dossier` : "Choisir le dossier de travail : local ou serveur SSH";
}

export function toggleWsMenu(open = el.wsMenu.hidden) {
  if (!open) {
    el.wsMenu.hidden = true;
    return;
  }
  const cur = state.draft.workspace;
  const recent = state.workspaces
    .slice(0, 8)
    .map((w) => {
      const l = workspaceLabel(w);
      return `<button type="button" class="ws-menu-item${w === cur ? " current" : ""}" data-ws="${escapeHtml(w)}" title="${escapeHtml(l.detail)}">${l.remote ? icons.server : icons.folder}<span>${escapeHtml(l.name)}</span><small>${escapeHtml(l.detail)}</small></button>`;
    })
    .join("");
  el.wsMenu.innerHTML = `${recent ? `<div class="group">Dossiers récents</div>${recent}<hr />` : ""}
    <button type="button" class="ws-menu-item action" data-pick-ws>${icons.folder}<span>Ouvrir un dossier local…</span></button>
    <button type="button" class="ws-menu-item action" data-ssh>${icons.server}<span>Dossier sur un serveur SSH…</span></button>`;
  el.wsMenu.hidden = false;
}

el.wsPicker.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleWsMenu();
});
el.wsMenu.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const ws = t.closest<HTMLElement>("[data-ws]")?.dataset.ws;
  if (ws) return selectWorkspace(ws);
  if (t.closest("[data-pick-ws]")) {
    toggleWsMenu(false);
    return chooseWorkspace();
  }
  if (t.closest("[data-ssh]")) {
    toggleWsMenu(false);
    return openSshDialog();
  }
});
document.addEventListener("click", (e) => {
  if (!el.wsMenu.hidden && !(e.target as HTMLElement).closest("#ws-menu, #ws-picker")) toggleWsMenu(false);
});

export function openRemoteWorkspace(ws: string) {
  api.listWorkspaces().then((w) => (state.workspaces = w)).catch(() => {});
  if (state.current) newChat();
  state.draft.workspace = ws;
  renderConversation();
  el.input.focus();
}

export async function chooseWorkspace() {
  try {
    const path = await api.pickWorkspace();
    if (!path) return;
    state.workspaces = await api.listWorkspaces();
    state.draft.workspace = path;
    renderConversation();
    el.input.focus();
  } catch (e) {
    toast(errMsg(e), true);
  }
}

export function updateComposerState() {
  el.app.classList.toggle("is-streaming", !!state.busy);
  el.sendBtn.title = state.busy ? "Arrêter (Échap)" : "Envoyer";
  el.hint.textContent = state.settings?.sendOnEnter ? "Entrée pour envoyer · Maj+Entrée pour un retour ligne" : "Ctrl+Entrée pour envoyer";
}
