// Alertes de solde bas et de budget mensuel dépassé (une fois par seuil et par session).
import { api } from "./api";
import { aggregate, fmtCost } from "./usage";
import { state } from "./state";
import { isVenice, toast } from "./ui";

const BALANCE_INTERVAL = 10 * 60 * 1000;
let lastBalance = 0;
const warned = new Set<string>();

function warnOnce(key: string, msg: string) {
  if (warned.has(key)) return;
  warned.add(key);
  toast(msg, true);
}

/** Vérifie le budget du mois (estimation locale) et, au plus toutes les 10 min, le solde du compte. */
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
  if (s.balanceAlert == null || !isVenice() || !state.keyConfigured) return;
  if (!force && Date.now() - lastBalance < BALANCE_INTERVAL) return;
  lastBalance = Date.now();
  const b = await api.balance().catch(() => null);
  const usd = b?.balances.usd;
  if (usd == null) return;
  if (usd < s.balanceAlert) {
    warnOnce("balance", `Solde Venice bas : ${usd.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} $ (alerte sous ${s.balanceAlert} $).`);
  } else {
    warned.delete("balance");
  }
}
