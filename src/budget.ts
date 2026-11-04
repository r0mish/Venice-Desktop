// Alertes de solde bas et de budget mensuel dépassé (une fois par seuil et par session).
import { api } from "./api";
import { refreshPlan } from "./plan";
import { aggregate, fmtCost } from "./usage";
import { state } from "./state";
import { toast } from "./ui";

const warned = new Set<string>();

function warnOnce(key: string, msg: string) {
  if (warned.has(key)) return;
  warned.add(key);
  toast(msg, true);
}

/** Vérifie le budget du mois (estimation locale) et, au plus toutes les 10 min, le forfait et le solde. */
export async function checkBudget(force = false) {
  const s = state.settings;
  if (!s) return;
  if (s.monthlyBudget) {
    const log = await api.getUsage().catch(() => ({}));
    const spent = aggregate(log, new Date().getDate(), s).total;
    if (spent >= s.monthlyBudget) {
      warnOnce("budget-100", `Budget mensuel dépassé : ${fmtCost(spent)} sur ${s.monthlyBudget} $ (estimation).`);
    } else if (spent >= s.monthlyBudget * 0.8) {
      warnOnce("budget-80", `80 % du budget mensuel atteint : ${fmtCost(spent)} sur ${s.monthlyBudget} $ (estimation).`);
    }
  }
  // Forfait relu au plus toutes les 10 minutes : jauge de la barre latérale et alerte de solde.
  const p = await refreshPlan(force);
  if (s.balanceAlert == null || !p || (p.usd == null && p.bundled == null)) return;
  const spendable = (p.usd ?? 0) + (p.bundled ?? 0);
  if (spendable < s.balanceAlert) {
    warnOnce("balance", `Solde Venice bas : ${spendable.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} $ (alerte sous ${s.balanceAlert} $).`);
  } else {
    warned.delete("balance");
  }
}
