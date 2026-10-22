// Fenêtre des réglages : clé API, modèles, outils, MCP, chiffrement, consommation.
import { api, type Settings, type SystemPromptPreset } from "./api";
import { aggregate, fmtCost, fmtTokens } from "./usage";
import { escapeHtml } from "./markdown";
import { loadProjects } from "./projects-ui";
import { $, defaultModelFor, el, errMsg, state, uid } from "./state";
import { applyTheme, autoModel, copy, fillModelSelect, fillTopModelSelect, loadModels, toast } from "./ui";
import { refreshConvs, renderSidebar } from "./sidebar";
import { renderChrome } from "./chrome";
import { renderWelcome } from "./thread";

// ---------------------------------------------------------------- réglages

const s = {
  apiKey: $<HTMLInputElement>("#api-key"),
  keyStatus: $("#key-status"),
  model: $<HTMLSelectElement>("#s-model"),
  prompts: $("#s-prompts"),
  temp: $<HTMLInputElement>("#s-temp"),
  max: $<HTMLInputElement>("#s-max"),
  theme: $<HTMLSelectElement>("#s-theme"),
  enter: $<HTMLInputElement>("#s-enter"),
  base: $<HTMLInputElement>("#s-base"),
  webProvider: $<HTMLSelectElement>("#s-web-provider"),
  webMode: $<HTMLSelectElement>("#s-web-mode"),
  webModeWrap: $("#s-web-mode-wrap"),
  searx: $<HTMLInputElement>("#s-searx"),
  searxWrap: $("#s-searx-wrap"),
  webDefault: $<HTMLInputElement>("#s-web-default"),
  codeModel: $<HTMLSelectElement>("#s-code-model"),
  privateOnly: $<HTMLInputElement>("#s-private-only"),
  venicePrompt: $<HTMLInputElement>("#s-venice-prompt"),
  imageModel: $<HTMLSelectElement>("#s-image-model"),
  imageAspect: $<HTMLSelectElement>("#s-image-aspect"),
  imageNegative: $<HTMLInputElement>("#s-image-negative"),
  imageSafe: $<HTMLInputElement>("#s-image-safe"),
  imageWatermark: $<HTMLInputElement>("#s-image-watermark"),
  imageEditModel: $<HTMLSelectElement>("#s-image-edit-model"),
  imageVariants: $<HTMLSelectElement>("#s-image-variants"),
  ttsModel: $<HTMLInputElement>("#s-tts-model"),
  ttsVoice: $<HTMLInputElement>("#s-tts-voice"),
  ttsSpeed: $<HTMLInputElement>("#s-tts-speed"),
  balance: $("#balance"),
  balanceAlert: $<HTMLInputElement>("#s-balance-alert"),
  budget: $<HTMLInputElement>("#s-budget"),
  timeout: $<HTMLInputElement>("#s-timeout"),
  mcp: $<HTMLTextAreaElement>("#s-mcp"),
  mcpStatus: $("#mcp-status"),
  mcpAllowed: $("#mcp-allowed"),
  wsList: $("#ws-list"),
  error: $("#settings-error"),
  updates: $<HTMLInputElement>("#s-updates"),
  updateStatus: $("#update-status"),
  maxSteps: $<HTMLInputElement>("#s-max-steps"),
  permission: $<HTMLSelectElement>("#s-permission"),
  compact: $<HTMLInputElement>("#s-compact"),
  autoContinue: $<HTMLInputElement>("#s-auto-continue"),
  usagePeriod: $<HTMLSelectElement>("#usage-period"),
  usageTotal: $("#usage-total"),
  usageTable: $("#usage-table"),
  prices: $<HTMLTextAreaElement>("#s-prices"),
  shell: $<HTMLSelectElement>("#s-shell"),
  shellWrap: $("#s-shell-wrap"),
  shellInfo: $("#s-shell-info"),
  sttModel: $<HTMLInputElement>("#s-stt-model"),
  sttLang: $<HTMLSelectElement>("#s-stt-lang"),
  sttUrl: $<HTMLInputElement>("#s-stt-url"),
  sttVocab: $<HTMLTextAreaElement>("#s-stt-vocab"),
  encrypt: $<HTMLInputElement>("#s-encrypt"),
  vaultStatus: $("#vault-status"),
  vaultKeyRow: $("#vault-key-row"),
  vaultKey: $<HTMLInputElement>("#vault-key"),
  vaultKeyAction: $<HTMLButtonElement>("#vault-key-action"),
};

// ---------------------------------------------------------------- instructions système, modèles de messages

/** Liste éditable (nom + texte), copie de travail enregistrée avec les réglages. */
function presetEditor(box: HTMLElement, addBtn: HTMLElement, opts: { withDefault: boolean; namePh: string; textPh: string; empty: string }) {
  let items: SystemPromptPreset[] = [];
  let def = "";
  const render = () => {
    box.innerHTML = items.length
      ? items
          .map(
            (p, i) => `<div class="prompt-row" data-i="${i}">
            <div class="row">
              <input data-f="name" value="${escapeHtml(p.name)}" placeholder="${escapeHtml(opts.namePh)}" spellcheck="false" />
              ${opts.withDefault ? `<label class="check"><input type="checkbox" data-f="default"${p.id === def ? " checked" : ""} /> par défaut</label>` : ""}
              <button type="button" class="btn-ghost sm danger" data-del title="Supprimer">Supprimer</button>
            </div>
            <textarea data-f="text" rows="3" placeholder="${escapeHtml(opts.textPh)}">${escapeHtml(p.text)}</textarea>
          </div>`,
          )
          .join("")
      : `<p class="muted small">${escapeHtml(opts.empty)}</p>`;
  };
  const row = (t: EventTarget | null) => Number((t as HTMLElement).closest<HTMLElement>(".prompt-row")?.dataset.i);
  box.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement | HTMLTextAreaElement;
    const p = items[row(t)];
    if (!p) return;
    if (t.dataset.f === "name") p.name = t.value;
    else if (t.dataset.f === "text") p.text = t.value;
  });
  box.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.f !== "default") return;
    const p = items[row(t)];
    def = t.checked && p ? p.id : "";
    render();
  });
  box.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("[data-del]")) return;
    const [removed] = items.splice(row(e.target), 1);
    if (removed?.id === def) def = "";
    render();
  });
  addBtn.addEventListener("click", () => {
    items.push({ id: uid().slice(0, 8), name: "", text: "" });
    render();
    box.querySelector<HTMLInputElement>(".prompt-row:last-child [data-f=name]")?.focus();
  });
  return {
    set(list: SystemPromptPreset[], defaultId = "") {
      items = list.map((p) => ({ ...p }));
      def = defaultId;
      render();
    },
    get() {
      const list = items.filter((p) => p.name.trim() || p.text.trim()).map((p) => ({ ...p, name: p.name.trim() || "Sans nom" }));
      return { list, def: list.some((p) => p.id === def) ? def : "" };
    },
  };
}

const promptEditor = presetEditor(s.prompts, $("#s-prompt-add"), {
  withDefault: true,
  namePh: "Nom (ex. : Admin Linux, Traducteur…)",
  textPh: "Ex. : Tu es un administrateur système Linux expérimenté. Réponds en français, avec des commandes prêtes à copier.",
  empty: "Aucune instruction enregistrée.",
});
const templateEditor = presetEditor($("#s-templates"), $("#s-template-add"), {
  withDefault: false,
  namePh: "Nom court (ex. : resume, mail, revue)",
  textPh: "Ex. : Résume le texte suivant en 5 points clés :",
  empty: "Aucun modèle de message.",
});

function renderShellInfo() {
  const p = state.platform;
  s.shellWrap.hidden = p.os !== "windows";
  s.shellInfo.innerHTML = `Shell utilisé par l'agent : <strong>${escapeHtml(p.shell)}</strong>${p.shellPath ? ` — <code>${escapeHtml(p.shellPath)}</code>` : ""}${
    p.os === "windows" && !/bash/i.test(p.shell)
      ? '<br>Conseil : installez <a href="https://git-scm.com/download/win" data-external>Git pour Windows</a> pour que l\'agent dispose de bash, la syntaxe que les modèles maîtrisent le mieux.'
      : ""
  }`;
}

const pricesToText = (p: Settings["prices"]) =>
  Object.entries(p)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, [i, o]]) => `${k} = ${i} / ${o}`)
    .join("\n");

function parsePrices(text: string): Settings["prices"] {
  const out: Settings["prices"] = {};
  for (const [n, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([\w.:-]+)\s*=\s*([\d.,]+)\s*\/\s*([\d.,]+)$/);
    if (!m) throw new Error(`Tarifs, ligne ${n + 1} : format attendu « préfixe = entrée / sortie »`);
    out[m[1]] = [Number(m[2].replace(",", ".")), Number(m[3].replace(",", "."))];
  }
  return out;
}

async function renderUsageTab() {
  const log = await api.getUsage().catch(() => ({}));
  const { rows, total, unknown } = aggregate(log, Number(s.usagePeriod.value), state.settings);
  s.usageTotal.textContent = rows.length ? `Total estimé : ${fmtCost(total)}${unknown ? " (+ modèles sans tarif)" : ""}` : "";
  s.usageTable.innerHTML = rows.length
    ? `<table class="usage"><thead><tr><th>Modèle</th><th>Requêtes</th><th>Entrée</th><th>Sortie</th><th>Coût estimé</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td><code>${escapeHtml(r.model)}</code></td><td>${r.requests}</td><td>${fmtTokens(r.prompt)}</td><td>${fmtTokens(r.completion)}</td><td>${r.cost === null ? "tarif inconnu" : fmtCost(r.cost)}</td></tr>`)
        .join("")}</tbody></table>`
    : '<p class="muted small">Aucune consommation enregistrée sur cette période.</p>';
}
s.usagePeriod.addEventListener("change", renderUsageTab);

const MCP_EXAMPLE = `{
  "mcpServers": {
    "fichiers": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/chemin/vers/dossier"]
    },
    "serveur-distant": {
      "url": "https://mcp.example.org/mcp",
      "headers": { "Authorization": "Bearer VOTRE_JETON" },
      "disabled": true
    }
  }
}
`;

export async function refreshKeyStatus() {
  const st = await api.keyStatus();
  state.keyConfigured = st.configured;
  s.keyStatus.textContent = !st.configured
    ? "Aucune clé configurée."
    : st.source === "keyring"
      ? "✓ Clé enregistrée dans le trousseau du système."
      : "✓ Clé lue depuis la variable d'environnement VENICE_API_KEY.";
}

function showTab(tab: string) {
  document.querySelectorAll<HTMLElement>(".settings-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>("#settings .tab").forEach((t) => (t.hidden = t.dataset.tab !== tab));
}
document.querySelector(".settings-tabs")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
  if (b) showTab(b.dataset.tab!);
});

const STATE_LABEL = { starting: "démarrage…", ready: "connecté", error: "erreur", disabled: "désactivé" };

function renderMcpStatus() {
  s.mcpStatus.innerHTML = state.mcp
    .map(
      (m) => `<div class="mcp-server" data-state="${m.state}">
        <div class="row"><span class="dot"></span><strong>${escapeHtml(m.name)}</strong>
          <span class="muted small">${m.transport}${m.protocol ? ` · ${escapeHtml(m.protocol)}` : ""} · ${STATE_LABEL[m.state]}${m.state === "ready" ? ` · ${m.tools.length} outils` : ""}</span></div>
        ${m.error ? `<pre class="small">${escapeHtml(m.error)}</pre>` : ""}
        ${m.tools.length ? `<details><summary class="small">Outils</summary><ul class="small">${m.tools.map((t) => `<li><code>${escapeHtml(t.name)}</code> ${escapeHtml(t.description.slice(0, 140))}</li>`).join("")}</ul></details>` : ""}
      </div>`,
    )
    .join("");
  const allowed = state.settings.mcpAlwaysAllow;
  s.mcpAllowed.innerHTML = allowed.length
    ? allowed.map((n) => `<span class="chip">${escapeHtml(n)}<button type="button" data-unallow="${escapeHtml(n)}" title="Retirer">×</button></span>`).join("")
    : '<p class="muted small">Aucun. Utilisez « Toujours autoriser » lors d\'une demande d\'approbation.</p>';
}

s.mcpAllowed.addEventListener("click", (e) => {
  const n = (e.target as HTMLElement).dataset.unallow;
  if (!n) return;
  state.settings.mcpAlwaysAllow = state.settings.mcpAlwaysAllow.filter((x) => x !== n);
  api.saveSettings(state.settings).catch((err) => toast(errMsg(err), true));
  renderMcpStatus();
});

let mcpPoll = 0;
export async function pollMcp() {
  clearTimeout(mcpPoll);
  try {
    state.mcp = await api.mcpStatus();
  } catch {
    return;
  }
  if (el.settings.open) renderMcpStatus();
  renderChrome();
  if (state.mcp.some((m) => m.state === "starting")) mcpPoll = window.setTimeout(pollMcp, 800);
}

$("#mcp-apply").addEventListener("click", async () => {
  s.error.hidden = true;
  try {
    await api.mcpSaveConfig(s.mcp.value);
    toast("Configuration MCP appliquée");
    pollMcp();
  } catch (e) {
    s.error.textContent = errMsg(e);
    s.error.hidden = false;
  }
});
$("#mcp-example").addEventListener("click", () => {
  s.mcp.value = MCP_EXAMPLE;
});

function renderWsList() {
  s.wsList.innerHTML = state.workspaces.length
    ? state.workspaces.map((w) => `<div class="ws-row"><code>${escapeHtml(w)}</code><button type="button" class="btn-ghost sm danger" data-forget="${escapeHtml(w)}">Retirer</button></div>`).join("")
    : '<p class="muted small">Aucun dossier.</p>';
}
s.wsList.addEventListener("click", async (e) => {
  const w = (e.target as HTMLElement).dataset.forget;
  if (!w) return;
  state.workspaces = await api.forgetWorkspace(w);
  if (state.draft.workspace === w) state.draft.workspace = undefined;
  renderWsList();
});

function renderWebProvider() {
  s.searxWrap.hidden = s.webProvider.value !== "searxng";
  s.webModeWrap.hidden = s.webProvider.value !== "venice";
}
s.webProvider.addEventListener("change", renderWebProvider);

const money = (n: number, unit: string) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} ${unit}`;

$("#balance-refresh").addEventListener("click", async () => {
  s.balance.textContent = "…";
  try {
    const b = await api.balance();
    const parts = [
      b.balances.usd != null ? money(b.balances.usd, "$") : "",
      b.balances.diem != null ? `${money(b.balances.diem, "DIEM")}${b.diemEpochAllocation ? ` sur ${money(b.diemEpochAllocation, "")}` : ""}` : "",
      b.balances.bundledCredits ? money(b.balances.bundledCredits, "crédits inclus") : "",
      b.balances.earnedCredits ? money(b.balances.earnedCredits, "crédits gagnés") : "",
    ].filter(Boolean);
    s.balance.className = b.canConsume ? "muted small" : "small error";
    s.balance.textContent = `${parts.join(" · ") || "Aucun solde"}${b.consumptionCurrency ? ` — consommation en ${b.consumptionCurrency}` : ""}${b.canConsume ? "" : " — solde insuffisant"}`;
  } catch (e) {
    s.balance.className = "small error";
    s.balance.textContent = errMsg(e);
  }
});

async function renderVaultStatus() {
  const v = await api.vaultStatus().catch(() => null);
  if (!v) return;
  s.vaultStatus.className = v.error ? "small error" : "muted small";
  s.vaultStatus.textContent = v.error
    ? `⚠ Chiffrement inactif : ${v.error}`
    : v.enabled
      ? "✓ Données chiffrées sur cet appareil."
      : v.hasKey
        ? "Chiffrement désactivé (les données sont en clair sur le disque)."
        : "Chiffrement désactivé.";
}

let vaultMode: "copy" | "restore" = "copy";
$("#vault-show").addEventListener("click", async () => {
  try {
    s.vaultKey.value = await api.vaultExportKey();
    s.vaultKey.readOnly = true;
    vaultMode = "copy";
    s.vaultKeyAction.textContent = "Copier";
    s.vaultKeyRow.hidden = false;
    s.vaultKey.select();
  } catch (e) {
    toast(errMsg(e), true);
  }
});
$("#vault-restore").addEventListener("click", () => {
  s.vaultKey.value = "";
  s.vaultKey.readOnly = false;
  s.vaultKey.placeholder = "Collez la clé de récupération";
  vaultMode = "restore";
  s.vaultKeyAction.textContent = "Restaurer";
  s.vaultKeyRow.hidden = false;
  s.vaultKey.focus();
});
s.vaultKeyAction.addEventListener("click", async () => {
  if (vaultMode === "copy") return copy(s.vaultKey.value, s.vaultKeyAction);
  try {
    await api.vaultImportKey(s.vaultKey.value);
    s.vaultKeyRow.hidden = true;
    toast("Clé restaurée");
    await refreshConvs();
    await loadProjects();
    renderSidebar();
    renderVaultStatus();
  } catch (e) {
    toast(errMsg(e), true);
  }
});

export async function openSettings(tab = "general") {
  const st = state.settings;
  await refreshKeyStatus();
  s.apiKey.value = "";
  fillModelSelect(s.model, st.defaultModel, { auto: true });
  fillModelSelect(s.codeModel, st.codeModel, { auto: true });
  fillModelSelect(s.imageModel, st.imageModel, { auto: true, kind: "image" });
  fillModelSelect(s.imageEditModel, st.imageEditModel ?? "", { auto: true, kind: "edit" });
  s.imageVariants.value = String(st.imageVariants || 1);
  promptEditor.set(st.systemPrompts ?? [], st.defaultPrompt ?? "");
  templateEditor.set(st.promptTemplates ?? []);
  s.balanceAlert.value = st.balanceAlert?.toString() ?? "";
  s.budget.value = st.monthlyBudget?.toString() ?? "";
  s.temp.value = st.temperature?.toString() ?? "";
  s.max.value = st.maxTokens?.toString() ?? "";
  s.theme.value = st.theme;
  s.enter.checked = st.sendOnEnter;
  s.base.value = st.baseUrl;
  s.webProvider.value = st.webSearchProvider;
  s.webMode.value = st.webSearchMode ?? "auto";
  s.searx.value = st.searxngUrl;
  renderWebProvider();
  s.webDefault.checked = st.webSearchDefault;
  s.privateOnly.checked = st.privateOnly;
  s.venicePrompt.checked = st.veniceSystemPrompt;
  s.imageAspect.value = st.imageAspect || "1:1";
  s.imageNegative.value = st.imageNegativePrompt ?? "";
  s.imageSafe.checked = st.imageSafeMode !== false;
  s.imageWatermark.checked = st.imageHideWatermark !== false;
  s.ttsModel.value = st.ttsModel ?? "";
  s.ttsVoice.value = st.ttsVoice ?? "";
  s.ttsSpeed.value = String(st.ttsSpeed ?? 1);
  s.balance.textContent = "";
  s.timeout.value = String(st.commandTimeout);
  s.maxSteps.value = String(st.maxSteps);
  s.permission.value = st.defaultPermission ?? "auto";
  s.compact.value = String(st.autoCompactPercent);
  s.autoContinue.checked = st.autoContinue;
  s.updates.checked = st.checkUpdates;
  s.prices.value = pricesToText(st.prices ?? {});
  s.shell.value = st.shell ?? "auto";
  s.sttModel.value = st.transcriptionModel ?? "";
  s.sttLang.value = st.transcriptionLanguage ?? "fr";
  s.sttUrl.value = st.transcriptionUrl ?? "";
  s.sttVocab.value = st.transcriptionVocabulary ?? "";
  s.encrypt.checked = st.encryptData !== false;
  s.vaultKeyRow.hidden = true;
  renderVaultStatus();
  renderShellInfo();
  if (!s.updateStatus.textContent) s.updateStatus.textContent = `Version installée : ${state.platform.version}`;
  renderUsageTab();
  s.mcp.value = await api.mcpGetConfig().catch(() => "");
  s.error.hidden = true;
  $("#data-dir").textContent = await api.dataDir().catch(() => "?");
  state.workspaces = await api.listWorkspaces().catch(() => state.workspaces);
  renderWsList();
  renderMcpStatus();
  showTab(tab);
  el.settings.showModal();
  pollMcp();
}

$("#save-key").addEventListener("click", async () => {
  try {
    await api.setKey(s.apiKey.value);
    s.apiKey.value = "";
    await refreshKeyStatus();
    await loadModels();
    fillModelSelect(s.model, s.model.value, { auto: true });
    fillModelSelect(s.codeModel, s.codeModel.value, { auto: true });
    fillModelSelect(s.imageModel, s.imageModel.value, { auto: true, kind: "image" });
    if (!state.current) renderWelcome();
    toast("Clé API enregistrée");
  } catch (e) {
    s.error.textContent = errMsg(e);
    s.error.hidden = false;
  }
});

$("#delete-key").addEventListener("click", async () => {
  await api.deleteKey().catch((e) => toast(errMsg(e), true));
  await refreshKeyStatus();
  if (!state.current) renderWelcome();
});

$("#settings-cancel").addEventListener("click", () => el.settings.close());
s.theme.addEventListener("change", () => applyTheme(s.theme.value as Settings["theme"]));
el.settings.addEventListener("close", () => applyTheme(state.settings.theme));

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const next: Settings = {
    ...state.settings,
    baseUrl: s.base.value.trim() || "https://api.venice.ai/api/v1",
    defaultModel: s.model.value,
    systemPrompt: "",
    systemPrompts: promptEditor.get().list,
    defaultPrompt: promptEditor.get().def,
    promptTemplates: templateEditor.get().list,
    balanceAlert: num(s.balanceAlert.value),
    monthlyBudget: num(s.budget.value) || null,
    temperature: num(s.temp.value),
    maxTokens: num(s.max.value),
    theme: s.theme.value as Settings["theme"],
    sendOnEnter: s.enter.checked,
    webSearchProvider: s.webProvider.value as Settings["webSearchProvider"],
    webSearchMode: s.webMode.value as Settings["webSearchMode"],
    searxngUrl: s.searx.value.trim(),
    webSearchDefault: s.webDefault.checked,
    codeModel: s.codeModel.value,
    privateOnly: s.privateOnly.checked,
    veniceSystemPrompt: s.venicePrompt.checked,
    imageModel: s.imageModel.value,
    imageAspect: s.imageAspect.value,
    imageNegativePrompt: s.imageNegative.value.trim(),
    imageSafeMode: s.imageSafe.checked,
    imageHideWatermark: s.imageWatermark.checked,
    imageEditModel: s.imageEditModel.value,
    imageVariants: Number(s.imageVariants.value) || 1,
    ttsModel: s.ttsModel.value.trim() || "tts-kokoro",
    ttsVoice: s.ttsVoice.value.trim(),
    ttsSpeed: Math.min(2, Math.max(0.5, Number(s.ttsSpeed.value) || 1)),
    commandTimeout: Math.max(5, Number(s.timeout.value) || 120),
    maxSteps: Math.max(5, Number(s.maxSteps.value) || 100),
    defaultPermission: s.permission.value as Settings["defaultPermission"],
    autoCompactPercent: Math.min(95, Math.max(0, Number(s.compact.value) || 0)),
    autoContinue: s.autoContinue.checked,
    checkUpdates: s.updates.checked,
    prices: state.settings.prices,
    shell: s.shell.value as Settings["shell"],
    transcriptionModel: s.sttModel.value.trim() || "nvidia/parakeet-tdt-0.6b-v3",
    transcriptionLanguage: s.sttLang.value,
    transcriptionUrl: s.sttUrl.value.trim(),
    transcriptionVocabulary: s.sttVocab.value,
    encryptData: s.encrypt.checked,
  };
  try {
    next.prices = parsePrices(s.prices.value);
  } catch (err) {
    s.error.textContent = errMsg(err);
    s.error.hidden = false;
    return showTab("usage");
  }
  if (next.webSearchProvider === "searxng" && !/^https?:\/\//.test(next.searxngUrl)) {
    s.error.textContent = "Indiquez l'URL de votre instance SearXNG (onglet Outils).";
    s.error.hidden = false;
    return;
  }
  try {
    const baseChanged = next.baseUrl !== state.settings.baseUrl;
    await api.saveSettings(next);
    if (next.encryptData !== state.settings.encryptData || next.encryptData) {
      const v = await api.vaultStatus().catch(() => null);
      if (v?.error && next.encryptData) toast(`Chiffrement inactif : ${v.error}`, true);
      else if (next.encryptData !== state.settings.encryptData) toast(next.encryptData ? "Données chiffrées" : "Chiffrement désactivé : données déchiffrées");
    }
    const platformChanged = ["shell", "baseUrl", "webSearchProvider"].some((k) => next[k as keyof Settings] !== state.settings[k as keyof Settings]);
    const prev = state.settings;
    state.settings = next;
    if (platformChanged) state.platform = await api.platform().catch(() => state.platform);
    applyTheme(next.theme);
    if (!state.current) {
      state.selectedModel = defaultModelFor(state.mode);
      state.draft.webSearch = next.webSearchDefault;
      state.draft.permissionMode = next.defaultPermission;
      state.draft.promptId = next.defaultPrompt;
    }
    if (next.imageModel !== prev.imageModel) state.selectedImageModel = next.imageModel || autoModel("image");
    el.settings.close();
    if (baseChanged) await loadModels();
    else fillTopModelSelect();
    renderChrome();
  } catch (err) {
    s.error.textContent = errMsg(err);
    s.error.hidden = false;
  }
});

