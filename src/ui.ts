// Utilitaires d'interface : notifications, thème, presse-papiers, icônes et liste des modèles.
import { api, type ModelInfo, type Settings } from "./api";
import { escapeHtml } from "./markdown";
import { modelPrices } from "./usage";
import { defaultModelFor, el, errMsg, state } from "./state";

// ---------------------------------------------------------------- utilitaires

let toastTimer = 0;
export function toast(msg: string, isError = false) {
  el.toast.textContent = msg;
  el.toast.className = isError ? "error" : "";
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), isError ? 6000 : 2500);
}

export function applyTheme(theme: Settings["theme"]) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}

export async function copy(text: string, btn?: HTMLElement) {
  await navigator.clipboard.writeText(text);
  if (btn) {
    const old = btn.innerHTML;
    btn.textContent = "Copié";
    setTimeout(() => (btn.innerHTML = old), 1200);
  }
}

export const icons = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  server: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
};

export function autoGrow(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
}

// ---------------------------------------------------------------- modèles

/** Modèles de repli tant que la liste n'est pas chargée (ou si l'API ne répond pas). */
export const FALLBACK_MODEL = "zai-org-glm-5-1";

/** API Venice (images, voix, recherche intégrée), sinon serveur compatible OpenAI. */
export const isVenice = () => state.platform.venice;

/** Modèles proposés : sans les modèles « anonymisés » (fournisseurs tiers) si l'option est active. */
export const visibleModels = (list: ModelInfo[]) =>
  state.settings.privateOnly ? list.filter((m) => m.privacy !== "anonymized") : list;

/** Modèle désigné par Venice pour un rôle (trait « default », « default_code »…). */
function byTrait(list: ModelInfo[], ...traits: string[]): ModelInfo | undefined {
  for (const t of traits) {
    const m = list.find((x) => x.traits.includes(t));
    if (m) return m;
  }
}

/** Choix automatique : modèle par défaut de Venice, en respectant l'option « modèles privés ». */
export function autoModel(kind: "chat" | "code" | "image"): string {
  if (kind === "image") {
    const list = visibleModels(state.imageModels);
    return (byTrait(list, "default") ?? list[0])?.id ?? "";
  }
  const list = visibleModels(state.models);
  const pick =
    kind === "code"
      ? byTrait(list, "default_code", "code", "most_intelligent") ?? list.find((m) => m.code && m.tools) ?? byTrait(list, "default")
      : byTrait(list, "default") ?? list.find((m) => m.tools);
  return (pick ?? list[0])?.id ?? FALLBACK_MODEL;
}

/** Libellé d'un modèle : nom, puis particularités (confidentialité, vision, raisonnement…). */
export function modelLabel(m: ModelInfo): string {
  const tags = [
    m.privacy === "anonymized" ? "◐ anonymisé" : "",
    m.vision ? "vision" : "",
    m.reasoning ? "raisonnement" : "",
    m.uncensored ? "non censuré" : "",
    m.beta ? "bêta" : "",
  ].filter(Boolean);
  return `${m.name || m.id}${tags.length ? ` · ${tags.join(" · ")}` : ""}`;
}

export function modelTitle(m: ModelInfo | undefined): string {
  if (!m) return "Modèle";
  const lines = [
    `${m.name || m.id} (${m.id})`,
    m.privacy === "private"
      ? "🔒 Privé : exécuté par Venice, aucune conservation des requêtes"
      : m.privacy === "anonymized"
        ? "◐ Anonymisé : modèle d'un fournisseur tiers, requêtes transmises sans votre identité"
        : "",
    m.maxContextLength ? `Contexte : ${m.maxContextLength.toLocaleString("fr-FR")} tokens` : "",
    m.price ? `Tarif : ${m.price[0]} $ / ${m.price[1]} $ par million de tokens (entrée / sortie)` : "",
    m.imagePrice ? `Tarif : ${m.imagePrice} $ par image` : "",
    m.description ?? "",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Remplit un <select> de modèles. `auto` : première option « Automatique » (valeur vide).
 * `kind` image : liste des modèles d'image.
 */
export function fillModelSelect(select: HTMLSelectElement, value: string, { auto = false, kind = "text" as "text" | "image" } = {}) {
  const source = kind === "image" ? state.imageModels : state.models;
  const list = visibleModels(source);
  const extras = kind === "image" ? [value] : [state.current?.model, value];
  const options = list.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(modelLabel(m))}</option>`);
  if (!source.length && kind === "text") options.push(`<option value="${FALLBACK_MODEL}">${FALLBACK_MODEL}</option>`);
  for (const extra of extras) {
    if (extra && !list.some((m) => m.id === extra) && !(extra === FALLBACK_MODEL && !source.length)) {
      const known = source.find((m) => m.id === extra);
      options.unshift(`<option value="${escapeHtml(extra)}">${escapeHtml(known ? modelLabel(known) : extra)}</option>`);
    }
  }
  if (auto) options.unshift('<option value="">Automatique (modèle recommandé par Venice)</option>');
  select.innerHTML = options.join("");
  select.value = value;
  select.title = modelTitle(source.find((m) => m.id === select.value));
}

/** Sélecteur du haut : modèles de texte, ou d'image quand la génération d'images est active. */
export function fillTopModelSelect() {
  if (state.imageMode) fillModelSelect(el.modelSelect, state.selectedImageModel, { kind: "image" });
  else fillModelSelect(el.modelSelect, state.selectedModel);
}

export async function loadModels() {
  if (!state.keyConfigured) return;
  const [text, image] = await Promise.allSettled([api.listModels("text"), isVenice() ? api.listModels("image") : Promise.resolve([])]);
  if (text.status === "fulfilled") {
    state.models = text.value;
    modelPrices.clear();
    for (const m of state.models) if (m.price) modelPrices.set(m.id, m.price);
  } else {
    toast(`Liste des modèles indisponible : ${errMsg(text.reason)}`, true);
  }
  if (image.status === "fulfilled") state.imageModels = image.value;
  if (!state.current) state.selectedModel = defaultModelFor(state.mode);
  state.selectedImageModel ||= state.settings.imageModel || autoModel("image");
  fillTopModelSelect();
}
