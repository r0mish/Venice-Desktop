//! Fichiers de référence des projets : joints en entier s'ils sont petits, sinon seuls les extraits
//! les plus pertinents pour la question sont envoyés : recherche BM25 locale, éventuellement combinée
//! à la recherche sémantique (voir semantic.rs) par fusion des rangs.

use serde::Serialize;

use crate::storage::Project;
use crate::textsearch::{bm25_rank, chunk, Chunk};

/// En dessous, les fichiers sont joints en entier à chaque message (≈ 17 k tokens).
pub const FULL_CONTEXT_CHARS: usize = 60_000;
/// Taille des extraits joints automatiquement à chaque message.
const EXCERPT_BUDGET: usize = 14_000;
/// Taille des extraits renvoyés par l'outil de recherche.
pub const TOOL_BUDGET: usize = 10_000;
const CHUNK_SIZE: usize = 1_500;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    /// « full » (tout est joint) ou « excerpts » (extraits pertinents).
    pub mode: &'static str,
    pub text: String,
}

pub fn total_chars(p: &Project) -> usize {
    p.files.iter().map(|f| f.text.chars().count()).sum()
}

fn kchars(n: usize) -> String {
    if n < 1000 { format!("{n} car.") } else { format!("{} k car.", n / 1000) }
}

/// Morceaux des fichiers du projet (unités de recherche et d'indexation sémantique).
pub fn chunks(p: &Project) -> Vec<Chunk> {
    p.files.iter().flat_map(|f| chunk(&f.name, &f.text, CHUNK_SIZE)).collect()
}

/// Ordre de pertinence : BM25, fusionné (RRF) avec la similarité sémantique si elle est fournie.
fn ranked(chunks: &[Chunk], query: &str, semantic: Option<&[f32]>) -> Vec<usize> {
    const DEPTH: usize = 40;
    let lexical = bm25_rank(chunks, query, DEPTH);
    let Some(sem) = semantic.filter(|s| s.len() == chunks.len()) else {
        return lexical.into_iter().map(|(i, _)| i).collect();
    };
    let mut by_sim: Vec<usize> = (0..chunks.len()).collect();
    by_sim.sort_by(|&a, &b| sem[b].total_cmp(&sem[a]));
    let mut fused: std::collections::HashMap<usize, f64> = std::collections::HashMap::new();
    for (rank, i) in lexical.iter().map(|(i, _)| *i).enumerate().chain(by_sim.into_iter().take(DEPTH).enumerate()) {
        *fused.entry(i).or_default() += 1.0 / (60.0 + rank as f64);
    }
    let mut order: Vec<(usize, f64)> = fused.into_iter().collect();
    order.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    order.into_iter().map(|(i, _)| i).collect()
}

/// Extraits les plus pertinents pour `query`, dans la limite de `budget` caractères.
/// `semantic` : similarité de chaque morceau de `chunks(p)` avec la question.
pub fn search(p: &Project, query: &str, budget: usize, semantic: Option<&[f32]>) -> String {
    let chunks = chunks(p);
    let mut used = 0;
    let mut out = Vec::new();
    for i in ranked(&chunks, query, semantic) {
        let c = &chunks[i];
        let len = c.text.chars().count();
        if used + len > budget && !out.is_empty() {
            break;
        }
        used += len;
        out.push(format!("<extrait fichier=\"{}\">\n{}\n</extrait>", c.source, c.text.trim()));
    }
    out.join("\n\n")
}

/// Contenu des fichiers de référence à joindre pour la question `query`.
pub fn context(p: &Project, query: &str, semantic: Option<&[f32]>) -> ProjectContext {
    if total_chars(p) <= FULL_CONTEXT_CHARS {
        let text = p.files.iter().map(|f| format!("<fichier nom=\"{}\">\n{}\n</fichier>", f.name, f.text)).collect::<Vec<_>>().join("\n\n");
        return ProjectContext { mode: "full", text };
    }
    let list = p.files.iter().map(|f| format!("- {} ({})", f.name, kchars(f.text.chars().count()))).collect::<Vec<_>>().join("\n");
    let found = search(p, query, EXCERPT_BUDGET, semantic);
    let text = format!(
        "Les fichiers de référence sont trop volumineux pour être joints en entier :\n{list}\n\n{}\
         Utilise l'outil search_project_files pour chercher d'autres passages (plusieurs requêtes si besoin) avant de répondre.",
        if found.is_empty() {
            "Aucun extrait ne correspond directement à la dernière question.\n\n".to_string()
        } else {
            format!("Extraits les plus pertinents pour la dernière question :\n\n{found}\n\n")
        }
    );
    ProjectContext { mode: "excerpts", text }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(files: Vec<(&str, String)>) -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "P", "instructions": "", "createdAt": 0, "updatedAt": 0,
            "files": files.into_iter().map(|(n, t)| serde_json::json!({"name": n, "text": t})).collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    #[test]
    fn small_projects_are_joined_whole_and_large_ones_searched() {
        let small = project(vec![("a.md", "Le mot de passe Wi-Fi invité change chaque mois.".into())]);
        let c = context(&small, "wifi", None);
        assert_eq!(c.mode, "full");
        assert!(c.text.contains("<fichier nom=\"a.md\">"));

        let filler = "Paragraphe sans rapport avec la question, sur la météo et le jardinage.\n".repeat(1200);
        let large = project(vec![
            ("bruit.md", filler.clone()),
            ("infra.md", format!("{filler}\nLe serveur de sauvegarde pbs1 a l'adresse 10.0.0.42.\n{filler}")),
        ]);
        assert!(total_chars(&large) > FULL_CONTEXT_CHARS);
        let c = context(&large, "Quelle est l'adresse du serveur de sauvegarde ?", None);
        assert_eq!(c.mode, "excerpts");
        assert!(c.text.contains("10.0.0.42"), "{}", &c.text[..500.min(c.text.len())]);
        assert!(c.text.chars().count() < EXCERPT_BUDGET + 2_000);
        assert!(c.text.contains("search_project_files"));
    }

    #[test]
    fn semantic_scores_bring_up_paraphrases() {
        // Aucun mot commun avec la question : seule la similarité sémantique trouve le passage.
        let filler = "Paragraphe sans rapport, sur la météo et le jardinage.\n".repeat(1500);
        let p = project(vec![("bruit.md", filler.clone()), ("infra.md", format!("{filler}\nLe NAS est restauré chaque nuit.\n"))]);
        let chunks = chunks(&p);
        let target = chunks.iter().position(|c| c.text.contains("NAS")).unwrap();
        let sem: Vec<f32> = (0..chunks.len()).map(|i| if i == target { 0.9 } else { 0.1 }).collect();
        assert!(!search(&p, "copie de secours", 2_000, None).contains("NAS"));
        assert!(search(&p, "copie de secours", 2_000, Some(&sem)).contains("NAS"));
    }
}
