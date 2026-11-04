// Utilisation du forfait Venice : jauge dans la barre latérale, détail et relevé dans Réglages → Utilisation.
import { api, type PlanUsage, type UsageAnalytics } from "./api";
import { escapeHtml } from "./markdown";
import { $, errMsg, state } from "./state";
import { isVenice } from "./ui";

/** Actualisation automatique au plus toutes les 10 minutes (après un échange ou au démarrage). */
const REFRESH_MS = 10 * 60 * 1000;
/** Fenêtre du relevé des crédits du forfait : couvre un renouvellement mensuel. */
const LEDGER_DAYS = 40;

let plan: PlanUsage | null = null;
let fetchedAt = 0;
let inflight: Promise<PlanUsage | null> | null = null;

const chip = $<HTMLButtonElement>("#plan-chip");

const fmt = (n: number, digits = 2) => n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: digits });
const usd = (n: number) => `${fmt(n)} $`;
const pct = (used: number, total: number) => Math.min(100, Math.max(0, Math.round((used / total) * 100)));

/** « dans 5 h 12 » jusqu'à la prochaine réinitialisation. */
function untilReset(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

export const currentPlan = () => plan;

/** Lit l'utilisation du forfait (mise en cache 10 min sauf `force`), puis met à jour la jauge. */
export async function refreshPlan(force = false): Promise<PlanUsage | null> {
  if (!isVenice() || !state.keyConfigured) {
    plan = null;
    renderPlanChip();
    return null;
  }
  if (!force && plan && Date.now() - fetchedAt < REFRESH_MS) return plan;
  inflight ??= (async () => {
    try {
      const since = new Date(Date.now() - LEDGER_DAYS * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
      plan = await api.planUsage(since);
      fetchedAt = Date.now();
    } catch {
      // Hors ligne ou clé refusée : la dernière valeur connue reste affichée.
    } finally {
      inflight = null;
    }
    renderPlanChip();
    return plan;
  })();
  return inflight;
}

interface Gauge {
  label: string;
  /** Pourcentage consommé, si le total est connu. */
  used?: number;
  detail: string;
}

/** Jauges du forfait, de la plus parlante à la moins parlante. */
function gauges(p: PlanUsage): Gauge[] {
  const out: Gauge[] = [];
  const reset = untilReset(p.nextEpoch);
  if (p.diem != null) {
    const alloc = p.diemAllocation;
    out.push(
      alloc
        ? { label: "DIEM du jour", used: pct(alloc - p.diem, alloc), detail: `${fmt(alloc - p.diem)} utilisés sur ${fmt(alloc)}${reset ? ` · réinitialisation dans ${reset}` : ""}` }
        : { label: "DIEM du jour", detail: `${fmt(p.diem)} restants${reset ? ` · réinitialisation dans ${reset}` : ""}` },
    );
  }
  const period = p.bundledPeriod;
  if (period?.granted) {
    out.push({
      label: "Crédits du forfait",
      used: pct(period.used, period.granted),
      detail: `${usd(period.used)} utilisés sur ${usd(period.granted)} depuis le ${day(period.since)} · ${usd(p.bundled ?? Math.max(0, period.granted - period.used))} restants`,
    });
  } else if (p.bundled) {
    out.push({
      label: "Crédits du forfait",
      detail: `${usd(p.bundled)} restants${period ? ` · ${usd(period.used)} utilisés depuis le ${day(period.since)}` : ""}`,
    });
  }
  if (p.usd != null && (p.usd !== 0 || !out.length)) out.push({ label: "Solde", detail: usd(p.usd) });
  return out;
}

function bar(used: number | undefined) {
  if (used == null) return "";
  const level = used >= 90 ? " crit" : used >= 75 ? " warn" : "";
  return `<span class="plan-bar${level}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}"><span style="width:${used}%"></span></span>`;
}

/** Jauge compacte de la barre latérale : la première jauge disponible. */
export function renderPlanChip() {
  const g = plan ? gauges(plan)[0] : undefined;
  chip.hidden = !g;
  if (!plan || !g) return;
  const blocked = plan.accessPermitted === false;
  chip.classList.toggle("blocked", blocked);
  const short = g.used != null ? `${g.used} %` : g.detail.split(" · ")[0];
  chip.innerHTML = `<span class="plan-chip-line"><span>${escapeHtml(g.label)}</span><strong>${escapeHtml(blocked ? "bloqué" : short)}</strong></span>${bar(g.used)}`;
  chip.title = [...gauges(plan).map((x) => `${x.label} : ${x.detail}`), blocked ? "La clé ne peut plus consommer (solde ou limite atteint)." : ""].filter(Boolean).join("\n");
}

/** Détail du forfait (Réglages → Utilisation). */
export async function renderPlanPanel(force = false) {
  const box = $("#plan-panel");
  const status = $("#plan-status");
  if (!isVenice()) {
    box.innerHTML = "";
    status.textContent = "Suivi du forfait disponible uniquement avec l'API Venice.";
    return;
  }
  status.textContent = "Lecture du forfait…";
  const p = await refreshPlan(force);
  if (!p) {
    status.textContent = "Forfait indisponible (clé API absente ou serveur injoignable).";
    box.innerHTML = "";
    return;
  }
  const rows = gauges(p).map(
    (g) => `<div class="plan-row"><div class="plan-row-head"><span>${escapeHtml(g.label)}</span>${g.used != null ? `<strong>${g.used} %</strong>` : ""}</div>${bar(g.used)}<span class="muted small">${escapeHtml(g.detail)}</span></div>`,
  );
  const limits = p.rateLimits[state.selectedModel] ?? [];
  const info = [
    p.tier ? `Palier API : ${p.tier}` : "",
    limits.length ? `Limites de ${state.selectedModel} : ${limits.map((l) => `${fmt(l.amount, 0)} ${l.type}`).join(" · ")}` : "",
    p.keyExpiration ? `Clé valable jusqu'au ${day(p.keyExpiration)}` : "",
  ].filter(Boolean);
  box.innerHTML = rows.join("") + (info.length ? `<p class="muted small">${info.map(escapeHtml).join("<br>")}</p>` : "");
  status.className = p.accessPermitted === false || p.adminError ? "small error" : "muted small";
  status.textContent =
    p.accessPermitted === false
      ? "Cette clé ne peut plus consommer : solde épuisé ou limite de la clé atteinte."
      : p.adminError
        ? `Clé ADMIN : ${p.adminError}`
        : `Actualisé à ${new Date(fetchedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}${p.admin ? "" : " · ajoutez une clé ADMIN pour le pourcentage DIEM et les crédits reçus"}`;
}

let analyticsSeq = 0;

/** Relevé facturé par Venice : barres par jour et principaux modèles (clé ADMIN). */
export async function renderAnalytics(lookback: string) {
  const seq = ++analyticsSeq;
  const box = $("#analytics");
  if (!plan?.admin) {
    box.innerHTML = '<p class="muted small">Le relevé facturé nécessite une clé ADMIN (ci-dessus).</p>';
    return;
  }
  box.innerHTML = '<p class="muted small">Lecture du relevé…</p>';
  let a: UsageAnalytics;
  try {
    a = await api.usageAnalytics(lookback);
  } catch (e) {
    if (seq === analyticsSeq) box.innerHTML = `<p class="small error">${escapeHtml(errMsg(e))}</p>`;
    return;
  }
  // Une lecture plus récente (autre période, nouvelle clé) a pris le relais.
  if (seq !== analyticsSeq) return;
  const totalUsd = a.byDate.reduce((t, d) => t + d.USD, 0);
  const totalDiem = a.byDate.reduce((t, d) => t + d.DIEM, 0);
  const max = Math.max(...a.byDate.map((d) => d.USD + d.DIEM), 0);
  const days = a.byDate
    .map((d) => {
      const h = max ? Math.max(2, Math.round(((d.USD + d.DIEM) / max) * 100)) : 0;
      const tip = `${d.date} : ${usd(d.USD)}${d.DIEM ? ` + ${fmt(d.DIEM)} DIEM` : ""}`;
      return `<span class="an-day" title="${escapeHtml(tip)}"><span style="height:${d.USD + d.DIEM ? h : 0}%"></span></span>`;
    })
    .join("");
  const models = a.byModel
    .slice(0, 8)
    .map((m) => `<tr><td>${escapeHtml(m.modelName)}</td><td>${fmt(m.totalUnits, 0)} ${escapeHtml(m.unitType)}</td><td>${usd(m.totalUsd)}</td><td>${m.totalDiem ? fmt(m.totalDiem) : "—"}</td></tr>`)
    .join("");
  box.innerHTML = `
    <p class="small"><strong>${usd(totalUsd)}</strong>${totalDiem ? ` + <strong>${fmt(totalDiem)} DIEM</strong>` : ""} facturés sur ${escapeHtml(a.lookback.replace("d", " jours"))} <span class="muted">(crédits du forfait compris)</span></p>
    <div class="an-days" aria-label="Consommation par jour">${days}</div>
    ${models ? `<table class="usage"><thead><tr><th>Modèle</th><th>Volume</th><th>USD</th><th>DIEM</th></tr></thead><tbody>${models}</tbody></table>` : '<p class="muted small">Aucune consommation sur la période.</p>'}`;
}
