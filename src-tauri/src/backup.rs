//! Sauvegarde chiffrée de toutes les données (conversations, projets, médias, réglages) pour
//! changer d'ordinateur : archive protégée par une phrase de passe, indépendante du trousseau.
//!
//! Format : « VDBK » ‖ version ‖ sel (16 o) ‖ nonce (24 o) ‖ XChaCha20-Poly1305(archive),
//! clé dérivée par Argon2id (64 Mio, 3 passes) ; l'en-tête est authentifié avec le contenu.
//! Archive : suite de (longueur du chemin u32, chemin, longueur u64, octets), petit-boutiste.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};

type R<T> = Result<T, String>;

const MAGIC: &[u8; 4] = b"VDBK";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 4 + 1 + SALT_LEN;
pub const MIN_PASSPHRASE: usize = 12;

pub type Entry = (String, Vec<u8>);

fn derive(pass: &str, salt: &[u8]) -> R<[u8; 32]> {
    let params = Params::new(64 * 1024, 3, 1, Some(32)).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(pass.as_bytes(), salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

fn pack(entries: &[Entry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(entries.iter().map(|(p, d)| 12 + p.len() + d.len()).sum());
    for (path, data) in entries {
        out.extend((path.len() as u32).to_le_bytes());
        out.extend(path.as_bytes());
        out.extend((data.len() as u64).to_le_bytes());
        out.extend(data);
    }
    out
}

fn unpack(mut b: &[u8]) -> R<Vec<Entry>> {
    let bad = || "archive de sauvegarde corrompue".to_string();
    let take = |n: usize, b: &mut &[u8]| -> R<Vec<u8>> {
        if b.len() < n {
            return Err(bad());
        }
        let (h, t) = b.split_at(n);
        *b = t;
        Ok(h.to_vec())
    };
    let mut out = Vec::new();
    while !b.is_empty() {
        let len = u32::from_le_bytes(take(4, &mut b)?.try_into().unwrap()) as usize;
        let path = String::from_utf8(take(len, &mut b)?).map_err(|_| bad())?;
        let len = u64::from_le_bytes(take(8, &mut b)?.try_into().unwrap()) as usize;
        out.push((path, take(len, &mut b)?));
    }
    Ok(out)
}

pub fn seal(entries: &[Entry], pass: &str) -> R<Vec<u8>> {
    if pass.chars().count() < MIN_PASSPHRASE {
        return Err(format!("Phrase de passe trop courte ({MIN_PASSPHRASE} caractères minimum)"));
    }
    let mut salt = [0u8; SALT_LEN];
    chacha20poly1305::aead::rand_core::RngCore::fill_bytes(&mut OsRng, &mut salt);
    let mut out = MAGIC.to_vec();
    out.push(VERSION);
    out.extend(salt);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&derive(pass, &salt)?));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, Payload { msg: &pack(entries), aad: &out })
        .map_err(|_| "chiffrement de la sauvegarde impossible".to_string())?;
    out.extend(nonce);
    out.extend(ct);
    Ok(out)
}

pub fn open(data: &[u8], pass: &str) -> R<Vec<Entry>> {
    if data.len() < HEADER_LEN + NONCE_LEN + 16 || &data[..4] != MAGIC {
        return Err("Ce fichier n'est pas une sauvegarde Venice Desktop".into());
    }
    if data[4] != VERSION {
        return Err("Sauvegarde d'une version plus récente de Venice Desktop".into());
    }
    let (header, rest) = data.split_at(HEADER_LEN);
    let (nonce, ct) = rest.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&derive(pass, &header[5..])?));
    let plain = cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: header })
        .map_err(|_| "Phrase de passe incorrecte ou sauvegarde altérée".to_string())?;
    unpack(&plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_wrong_passphrase() {
        let entries = vec![("conversations/a.json".to_string(), b"{}".to_vec()), ("media/b.bin".to_string(), vec![0, 1, 2, 255])];
        let pass = "cheval agrafe batterie";
        let sealed = seal(&entries, pass).unwrap();
        assert!(!sealed.windows(2).any(|w| w == b"{}"), "contenu en clair dans l'archive");
        assert_eq!(open(&sealed, pass).unwrap(), entries);
        assert!(open(&sealed, "autre phrase de passe").unwrap_err().contains("incorrecte"));
        let mut tampered = sealed.clone();
        tampered[6] ^= 1; // sel modifié : en-tête authentifié
        assert!(open(&tampered, pass).is_err());
        assert!(seal(&entries, "court").is_err());
        assert!(open(b"pas une sauvegarde", pass).is_err());
    }
}
