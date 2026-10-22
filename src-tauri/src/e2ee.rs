//! Chiffrement de bout en bout (E2EE) avec les modèles Venice exécutés en enclave (TEE Intel TDX).
//!
//! 1. Attestation : l'enclave renvoie un « quote » TDX dont le REPORTDATA lie notre nonce
//!    (octets 32-63) et l'adresse Ethereum de sa clé publique (octets 0-19). On vérifie ces
//!    liaisons localement, l'absence de mode debug et les résultats de vérification de Venice.
//!    (La chaîne de certificats Intel n'est pas revérifiée localement : niveau « liaison ».)
//! 2. Chaque message est chiffré pour la clé de l'enclave : ECDH secp256k1 (clé éphémère du
//!    client), HKDF-SHA256 (info « ecdsa_encryption »), AES-256-GCM ;
//!    format hex(clé publique client 65 o ‖ IV 12 o ‖ chiffré+tag).
//! 3. Les réponses arrivent chiffrées de la même façon vers notre clé publique, morceau par morceau.

use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{PublicKey, SecretKey};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sha3::Keccak256;

const HKDF_INFO: &[u8] = b"ecdsa_encryption";
/// Taille minimale d'un morceau chiffré : 65 + 12 + 16 octets, en hexadécimal.
const MIN_CIPHER_HEX: usize = 2 * (65 + 12 + 16);
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);

type R<T> = Result<T, String>;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> R<Vec<u8>> {
    let s = s.trim().trim_start_matches("0x");
    if !s.len().is_multiple_of(2) {
        return Err("hexadécimal de longueur impaire".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| "caractère hexadécimal invalide".to_string()))
        .collect()
}

fn public_key(hex_key: &str) -> R<PublicKey> {
    let mut bytes = unhex(hex_key)?;
    if bytes.len() == 64 {
        bytes.insert(0, 0x04);
    }
    PublicKey::from_sec1_bytes(&bytes).map_err(|_| "clé publique secp256k1 invalide".to_string())
}

/// Clé AES dérivée de l'ECDH entre notre clé secrète et une clé publique.
fn derive_key(secret: &SecretKey, peer: &PublicKey) -> R<Aes256Gcm> {
    let shared = k256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), peer.as_affine());
    let mut okm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&[]), shared.raw_secret_bytes())
        .expand(HKDF_INFO, &mut okm)
        .map_err(|_| "dérivation de clé impossible".to_string())?;
    Aes256Gcm::new_from_slice(&okm).map_err(|e| e.to_string())
}

fn uncompressed(pk: &PublicKey) -> Vec<u8> {
    pk.to_encoded_point(false).as_bytes().to_vec()
}

/// Adresse Ethereum d'une clé publique : 20 derniers octets du Keccak-256 des 64 octets X‖Y.
fn eth_address(pk: &PublicKey) -> [u8; 20] {
    let hash = Keccak256::digest(&uncompressed(pk)[1..]);
    hash[12..].try_into().expect("20 octets")
}

/// Chiffre `plain` pour `peer` avec la clé éphémère `secret`.
pub fn encrypt_for(secret: &SecretKey, peer: &PublicKey, plain: &str) -> R<String> {
    let cipher = derive_key(secret, peer)?;
    let iv: [u8; 12] = rand_bytes();
    let ct = cipher.encrypt(Nonce::from_slice(&iv), plain.as_bytes()).map_err(|_| "chiffrement impossible".to_string())?;
    let mut out = uncompressed(&secret.public_key());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    Ok(hex(&out))
}

/// Déchiffre un morceau reçu : clé publique éphémère de l'émetteur ‖ IV ‖ chiffré.
pub fn decrypt_with(secret: &SecretKey, chunk: &str) -> R<String> {
    let raw = unhex(chunk)?;
    if raw.len() < 65 + 12 + 16 || raw[0] != 0x04 {
        return Err("morceau chiffré invalide".into());
    }
    let peer = PublicKey::from_sec1_bytes(&raw[..65]).map_err(|_| "clé éphémère invalide".to_string())?;
    let plain = derive_key(secret, &peer)?
        .decrypt(Nonce::from_slice(&raw[65..77]), &raw[77..])
        .map_err(|_| "déchiffrement impossible (session expirée ?)".to_string())?;
    String::from_utf8(plain).map_err(|_| "texte déchiffré invalide".to_string())
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    use aes_gcm::aead::rand_core::RngCore;
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

/// Morceau de réponse : chiffré (hex long), ou espacement laissé en clair par Venice.
pub fn looks_encrypted(s: &str) -> bool {
    s.len() >= MIN_CIPHER_HEX && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// ------------------------------------------------------------------ attestation

/// Résultat de la vérification locale de l'attestation.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attestation {
    pub model: String,
    pub nonce_bound: bool,
    pub key_bound: bool,
    pub debug: bool,
    /// Vérification complète (chaîne Intel, GPU NVIDIA) annoncée par Venice.
    pub server_verified: Option<bool>,
    pub tee_provider: Option<String>,
}

const TDX_BODY: usize = 48;
const TD_ATTRIBUTES: usize = TDX_BODY + 120;
const REPORT_DATA: usize = TDX_BODY + 520;

fn decode_quote(q: &str) -> R<Vec<u8>> {
    use base64::Engine;
    let q = q.trim().trim_start_matches("0x");
    if q.len().is_multiple_of(2) && q.bytes().all(|b| b.is_ascii_hexdigit()) {
        return unhex(q);
    }
    // Base64 standard ou « URL-safe », avec ou sans remplissage.
    let normalized: String = q
        .trim_end_matches('=')
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(normalized)
        .map_err(|_| "quote TDX ni hexadécimal ni base64".to_string())
}

/// Vérifie l'attestation et renvoie la clé publique de l'enclave.
pub fn verify_attestation(v: &Value, nonce: &[u8; 32], model: &str) -> R<(PublicKey, Attestation)> {
    let mut errors = Vec::new();
    if let Some(n) = v["nonce"].as_str() {
        if n.trim_start_matches("0x").to_lowercase() != hex(nonce) {
            errors.push("nonce de la réponse différent du nonce envoyé".to_string());
        }
    }
    if v["model"].as_str().is_some_and(|m| m != model) {
        errors.push(format!("attestation d'un autre modèle ({})", v["model"].as_str().unwrap_or_default()));
    }
    if v["verified"].as_bool() == Some(false) {
        errors.push("Venice signale l'échec de sa vérification de l'enclave".into());
    }
    let sv = &v["server_verification"];
    for (path, what) in [
        ("/tdx/valid", "vérification TDX"),
        ("/tdx/signatureValid", "signature du quote TDX"),
        ("/tdx/certificateChainValid", "chaîne de certificats TDX"),
        ("/tdx/attestationKeyMatch", "clé d'attestation TDX"),
        ("/nvidia/valid", "attestation GPU NVIDIA"),
    ] {
        if sv.pointer(path).and_then(Value::as_bool) == Some(false) {
            errors.push(format!("Venice signale un échec : {what}"));
        }
    }
    let key_hex = v["signing_key"].as_str().or(v["signing_public_key"].as_str()).ok_or("aucune clé de l'enclave dans l'attestation")?;
    let model_key = public_key(key_hex)?;
    let quote = decode_quote(v["intel_quote"].as_str().ok_or("aucun quote TDX dans l'attestation")?)?;
    if quote.len() < REPORT_DATA + 64 {
        return Err("quote TDX trop court".into());
    }
    if u32::from_le_bytes(quote[4..8].try_into().unwrap()) != 0x81 {
        return Err("le quote n'est pas un quote Intel TDX".into());
    }
    let debug = quote[TD_ATTRIBUTES] & 1 != 0;
    if debug {
        errors.push("l'enclave tourne en mode DEBUG : elle n'est pas digne de confiance".into());
    }
    let report = &quote[REPORT_DATA..REPORT_DATA + 64];
    let nonce_bound = report[32..64] == nonce[..] || report[32..64] == Sha256::digest(nonce)[..];
    if !nonce_bound {
        errors.push("notre nonce n'apparaît pas dans le REPORTDATA (attestation rejouée ?)".into());
    }
    let key_bound = report[..20] == eth_address(&model_key);
    if !key_bound {
        errors.push("la clé de l'enclave n'est pas liée au quote TDX".into());
    }
    if !errors.is_empty() {
        return Err(format!("Attestation de l'enclave refusée : {}", errors.join(" ; ")));
    }
    Ok((
        model_key,
        Attestation {
            model: model.to_owned(),
            nonce_bound,
            key_bound,
            debug,
            server_verified: v["verified"].as_bool(),
            tee_provider: v["tee_provider"].as_str().map(str::to_owned),
        },
    ))
}

// ------------------------------------------------------------------ session

/// Clé éphémère du client et clé vérifiée de l'enclave, pour un modèle.
pub struct Session {
    pub secret: SecretKey,
    pub model_key: PublicKey,
    pub attestation: Attestation,
    created: Instant,
}

impl Session {
    pub fn new(model_key: PublicKey, attestation: Attestation) -> Self {
        Self { secret: SecretKey::random(&mut OsRng), model_key, attestation, created: Instant::now() }
    }

    pub fn fresh(&self, model: &str) -> bool {
        self.attestation.model == model && self.created.elapsed() < SESSION_TTL
    }

    pub fn client_pub_hex(&self) -> String {
        hex(&uncompressed(&self.secret.public_key()))
    }

    pub fn model_pub_hex(&self) -> String {
        hex(&uncompressed(&self.model_key))
    }

    pub fn encrypt(&self, plain: &str) -> R<String> {
        encrypt_for(&self.secret, &self.model_key, plain)
    }

    /// Morceau de réponse : déchiffré, ou espacement en clair accepté tel quel.
    pub fn decrypt(&self, chunk: &str) -> R<String> {
        if chunk.trim().is_empty() {
            return Ok(chunk.to_owned());
        }
        if !looks_encrypted(chunk) {
            return Err("réponse non chiffrée reçue d'un modèle E2EE : abandon".into());
        }
        decrypt_with(&self.secret, chunk)
    }
}

/// Nonce aléatoire de 32 octets pour l'attestation.
pub fn nonce() -> [u8; 32] {
    rand_bytes()
}

pub fn nonce_hex(n: &[u8; 32]) -> String {
    hex(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_and_response_round_trip() {
        // L'enclave (côté serveur) et le client ont chacun leur paire de clés.
        let enclave = SecretKey::random(&mut OsRng);
        let client = SecretKey::random(&mut OsRng);
        // Requête : chiffrée pour l'enclave, préfixée de la clé publique du client.
        let req = encrypt_for(&client, &enclave.public_key(), "Bonjour l'enclave").unwrap();
        assert!(looks_encrypted(&req));
        assert_eq!(&req[..130], hex(&uncompressed(&client.public_key())));
        assert_eq!(decrypt_with(&enclave, &req).unwrap(), "Bonjour l'enclave");
        // Réponse : chiffrée pour le client avec une clé éphémère de l'enclave.
        let eph = SecretKey::random(&mut OsRng);
        let resp = encrypt_for(&eph, &client.public_key(), "Réponse ✓").unwrap();
        assert_eq!(decrypt_with(&client, &resp).unwrap(), "Réponse ✓");
        // Un tiers ne peut pas déchiffrer.
        let other = SecretKey::random(&mut OsRng);
        assert!(decrypt_with(&other, &resp).is_err());
    }

    /// Quote TDX minimal : en-tête (type 0x81), attributs, REPORTDATA.
    fn fake_quote(report: &[u8; 64], debug: bool) -> String {
        let mut q = vec![0u8; REPORT_DATA + 64 + 16];
        q[4..8].copy_from_slice(&0x81u32.to_le_bytes());
        q[TD_ATTRIBUTES] = debug as u8;
        q[REPORT_DATA..REPORT_DATA + 64].copy_from_slice(report);
        hex(&q)
    }

    #[test]
    fn attestation_binding_is_checked() {
        let enclave = SecretKey::random(&mut OsRng);
        let n = nonce();
        let mut report = [0u8; 64];
        report[..20].copy_from_slice(&eth_address(&enclave.public_key()));
        report[32..].copy_from_slice(&Sha256::digest(n));
        let key = hex(&uncompressed(&enclave.public_key()));
        let ok = json!({ "nonce": hex(&n), "model": "e2ee-m", "signing_key": key, "intel_quote": fake_quote(&report, false), "verified": true });
        let (pk, a) = verify_attestation(&ok, &n, "e2ee-m").unwrap();
        assert_eq!(pk, enclave.public_key());
        assert!(a.nonce_bound && a.key_bound && !a.debug);
        // Mode debug, autre nonce, autre clé, autre modèle : refusés.
        let debug = json!({ "signing_key": key, "intel_quote": fake_quote(&report, true) });
        assert!(verify_attestation(&debug, &n, "e2ee-m").unwrap_err().contains("DEBUG"));
        assert!(verify_attestation(&ok, &nonce(), "e2ee-m").is_err());
        let other = hex(&uncompressed(&SecretKey::random(&mut OsRng).public_key()));
        let wrong_key = json!({ "signing_key": other, "intel_quote": fake_quote(&report, false) });
        assert!(verify_attestation(&wrong_key, &n, "e2ee-m").unwrap_err().contains("liée"));
        assert!(verify_attestation(&ok, &n, "autre").is_err());
        let failed = json!({ "signing_key": key, "intel_quote": fake_quote(&report, false), "server_verification": { "tdx": { "valid": false } } });
        assert!(verify_attestation(&failed, &n, "e2ee-m").is_err());
    }

    #[test]
    fn plaintext_chunks() {
        let s = Session::new(SecretKey::random(&mut OsRng).public_key(), Attestation {
            model: "m".into(),
            nonce_bound: true,
            key_bound: true,
            debug: false,
            server_verified: None,
            tee_provider: None,
        });
        assert_eq!(s.decrypt("\n\n").unwrap(), "\n\n");
        assert!(s.decrypt("texte en clair").is_err());
        assert!(s.fresh("m") && !s.fresh("autre"));
    }
}

