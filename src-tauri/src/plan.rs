//! Utilisation du forfait Venice : DIEM du jour, crédits inclus à l'abonnement, solde USD,
//! limites de débit. La clé d'inférence suffit pour les soldes ; une clé ADMIN facultative
//! donne l'allocation DIEM, les crédits reçus et le relevé facturé (endpoints /billing).

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BundledPeriod {
    /// Montant du dernier versement de crédits (renouvellement du forfait), s'il est dans la fenêtre lue.
    pub granted: Option<f64>,
    /// Date de ce versement, ou début de la fenêtre lue.
    pub since: String,
    /// Crédits consommés depuis.
    pub used: f64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    /// La clé peut-elle consommer (solde, limites de la clé, état du compte) ?
    pub access_permitted: Option<bool>,
    pub tier: Option<String>,
    /// Réinitialisation des DIEM et des limites journalières (minuit UTC).
    pub next_epoch: Option<String>,
    pub key_expiration: Option<String>,
    pub usd: Option<f64>,
    pub diem: Option<f64>,
    pub bundled: Option<f64>,
    /// Allocation DIEM du jour (clé ADMIN).
    pub diem_allocation: Option<f64>,
    /// Crédits du forfait consommés depuis le dernier renouvellement (clé ADMIN).
    pub bundled_period: Option<BundledPeriod>,
    /// Limites de débit par modèle : identifiant → [(type, valeur)].
    pub rate_limits: Value,
    pub admin: bool,
    pub admin_error: Option<String>,
}

/// Lecture de `GET /api_keys/rate_limits` (champ `data`).
pub fn from_rate_limits(d: &Value) -> PlanUsage {
    let num = |k: &str| d["balances"][k].as_f64();
    let limits: serde_json::Map<String, Value> = d["rateLimits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| Some((m["apiModelId"].as_str()?.to_owned(), m["rateLimits"].clone())))
        .collect();
    PlanUsage {
        access_permitted: d["accessPermitted"].as_bool(),
        tier: d["apiTier"]["id"].as_str().map(str::to_owned),
        next_epoch: d["nextEpochBegins"].as_str().map(str::to_owned),
        key_expiration: d["keyExpiration"].as_str().map(str::to_owned),
        usd: num("USD"),
        diem: num("DIEM"),
        bundled: num("BUNDLED_CREDITS"),
        rate_limits: Value::Object(limits),
        ..Default::default()
    }
}

/// Crédits du forfait depuis le dernier versement (écriture positive) du relevé BUNDLED_CREDITS,
/// sinon depuis le début de la fenêtre lue. Les écritures sont dans l'ordre chronologique.
pub fn bundled_period(entries: &[Value], window_start: &str) -> BundledPeriod {
    let amount = |e: &Value| e["amount"].as_f64().unwrap_or(0.0);
    let grant = entries.iter().rposition(|e| amount(e) > 0.0);
    let after = grant.map_or(0, |i| i + 1);
    BundledPeriod {
        granted: grant.map(|i| amount(&entries[i])),
        since: grant
            .and_then(|i| entries[i]["timestamp"].as_str())
            .unwrap_or(window_start)
            .to_owned(),
        used: entries[after..].iter().map(amount).filter(|a| *a < 0.0).map(|a| -a).sum(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_rate_limits() {
        let d = json!({
            "accessPermitted": true, "apiTier": { "id": "paid", "isCharged": true },
            "balances": { "USD": 1.5, "DIEM": 4.25, "BUNDLED_CREDITS": 7 },
            "keyExpiration": null, "nextEpochBegins": "2026-11-05T00:00:00.000Z",
            "rateLimits": [{ "apiModelId": "glm", "rateLimits": [{ "type": "RPM", "amount": 50 }] }],
        });
        let p = from_rate_limits(&d);
        assert_eq!((p.usd, p.diem, p.bundled), (Some(1.5), Some(4.25), Some(7.0)));
        assert_eq!(p.tier.as_deref(), Some("paid"));
        assert_eq!(p.rate_limits["glm"][0]["amount"], 50);
        assert!(p.key_expiration.is_none());
    }

    #[test]
    fn bundled_credits_since_last_grant() {
        let e = |t: &str, a: f64| json!({ "timestamp": t, "amount": a });
        let rows = vec![e("2026-10-01T00:00:00Z", -0.5), e("2026-10-05T00:00:00Z", 10.0), e("2026-10-06T00:00:00Z", -1.25), e("2026-10-07T00:00:00Z", -0.25)];
        let p = bundled_period(&rows, "2026-09-25T00:00:00Z");
        assert_eq!(p, BundledPeriod { granted: Some(10.0), since: "2026-10-05T00:00:00Z".into(), used: 1.5 });
        let p = bundled_period(&rows[..1], "2026-09-25T00:00:00Z");
        assert_eq!(p, BundledPeriod { granted: None, since: "2026-09-25T00:00:00Z".into(), used: 0.5 });
    }
}
