//! Recherche sémantique dans les fichiers de référence des projets : les morceaux sont vectorisés
//! par l'API d'embeddings de Venice (modèle privé, sans conservation), et l'index est gardé en
//! local, chiffré comme le reste des données. Seuls les morceaux nouveaux ou modifiés sont envoyés.

use std::collections::HashMap;

use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::storage::{self, Project, Settings};
use crate::textsearch::Chunk;

const BATCH: usize = 64;
const MAGIC: &[u8; 4] = b"VEMB";

type Hash = [u8; 32];

/// Index d'un projet : vecteur (normalisé) de chaque morceau, par empreinte de son contenu.
#[derive(Default)]
struct Index {
    model: String,
    vectors: HashMap<Hash, Vec<f32>>,
}

fn hash(c: &Chunk) -> Hash {
    let mut h = Sha256::new();
    h.update(c.source.as_bytes());
    h.update([0]);
    h.update(c.text.as_bytes());
    h.finalize().into()
}

fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
    v
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

impl Index {
    /// Format binaire : « VEMB », modèle, puis (empreinte, dimension, flottants) par morceau.
    fn encode(&self) -> Vec<u8> {
        let mut out = MAGIC.to_vec();
        out.extend((self.model.len() as u32).to_le_bytes());
        out.extend(self.model.as_bytes());
        for (h, v) in &self.vectors {
            out.extend(h);
            out.extend((v.len() as u32).to_le_bytes());
            v.iter().for_each(|x| out.extend(x.to_le_bytes()));
        }
        out
    }

    fn decode(b: &[u8]) -> Option<Self> {
        let mut pos = 0;
        let mut take = |n: usize| {
            let s = b.get(pos..pos + n)?;
            pos += n;
            Some(s)
        };
        if take(4)? != MAGIC {
            return None;
        }
        let len = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
        let model = String::from_utf8(take(len)?.to_vec()).ok()?;
        let mut vectors = HashMap::new();
        while let Some(h) = take(32) {
            let h: Hash = h.try_into().ok()?;
            let dim = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
            let v = take(dim * 4)?.as_chunks::<4>().0.iter().map(|x| f32::from_le_bytes(*x)).collect();
            vectors.insert(h, v);
        }
        Some(Self { model, vectors })
    }
}

/// Recherche sémantique active et possible (API Venice) ?
pub fn enabled(settings: &Settings) -> bool {
    settings.semantic_search && crate::venice::is_venice(&settings.base_url)
}

/// Similarité de chaque morceau avec la question (même ordre que `chunks`).
/// Met à jour l'index du projet : vectorise les morceaux nouveaux, oublie ceux disparus.
pub async fn scores(app: &AppHandle, settings: &Settings, key: &str, project: &Project, chunks: &[Chunk], query: &str) -> Result<Vec<f32>, String> {
    let model = settings.embedding_model.trim();
    let model = if model.is_empty() { "text-embedding-bge-m3" } else { model };
    let mut index = storage::load_embeddings(app, &project.id)
        .and_then(|b| Index::decode(&b))
        .filter(|i| i.model == model)
        .unwrap_or_else(|| Index { model: model.to_owned(), ..Default::default() });
    let hashes: Vec<Hash> = chunks.iter().map(hash).collect();
    let missing: Vec<usize> = (0..chunks.len()).filter(|&i| !index.vectors.contains_key(&hashes[i])).collect();
    let stale = index.vectors.len() + missing.len() != chunks.len();
    for batch in missing.chunks(BATCH) {
        let texts: Vec<String> = batch.iter().map(|&i| format!("{}\n{}", chunks[i].source, chunks[i].text)).collect();
        let vecs = crate::venice::embed(&settings.base_url, key, model, &texts).await?;
        for (&i, v) in batch.iter().zip(vecs) {
            index.vectors.insert(hashes[i], normalize(v));
        }
    }
    if stale {
        let keep: std::collections::HashSet<_> = hashes.iter().collect();
        index.vectors.retain(|h, _| keep.contains(h));
    }
    if !missing.is_empty() || stale {
        storage::save_embeddings(app, &project.id, &index.encode())?;
    }
    let q = normalize(crate::venice::embed(&settings.base_url, key, model, &[query.to_owned()]).await?.remove(0));
    Ok(hashes.iter().map(|h| index.vectors.get(h).map_or(0.0, |v| dot(v, &q))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_round_trip() {
        let c = Chunk { source: "a.md".into(), text: "texte".into() };
        let mut i = Index { model: "m".into(), ..Default::default() };
        i.vectors.insert(hash(&c), normalize(vec![3.0, 4.0]));
        let back = Index::decode(&i.encode()).unwrap();
        assert_eq!(back.model, "m");
        assert_eq!(back.vectors[&hash(&c)], vec![0.6, 0.8]);
        assert!(Index::decode(b"autre").is_none());
        assert!((dot(&[0.6, 0.8], &[0.6, 0.8]) - 1.0).abs() < 1e-6);
    }
}
