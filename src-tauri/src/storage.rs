//! Stockage local en JSON, sans base de données ni service tiers.
//!   <config>/settings.json
//!   <data>/conversations/<id>.json + index.json

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

type R<T> = Result<T, String>;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub base_url: String,
    pub default_model: String,
    /// Ancien champ (instruction unique), repris dans `system_prompts` à la migration.
    pub system_prompt: String,
    /// Instructions système enregistrées, au choix par conversation.
    pub system_prompts: Vec<SystemPrompt>,
    /// Instructions des nouvelles conversations (id ; vide = aucune).
    pub default_prompt: String,
    /// Modèles de messages, insérés en tapant « / » dans la zone de saisie.
    pub prompt_templates: Vec<SystemPrompt>,
    /// Alerte quand le solde USD descend sous ce montant (None = pas d'alerte).
    pub balance_alert: Option<f64>,
    /// Budget mensuel estimé, en $ (None = pas de budget).
    pub monthly_budget: Option<f64>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub theme: String,
    pub send_on_enter: bool,
    /// « venice » (recherche intégrée de l'API), « brave » / « google » (outil web_search via
    /// /augment/search) ou « searxng » (instance auto-hébergée).
    pub web_search_provider: String,
    /// Recherche intégrée : « auto » (le modèle décide) ou « on » (à chaque message).
    pub web_search_mode: String,
    pub searxng_url: String,
    /// Recherche web activée par défaut dans les nouvelles conversations.
    pub web_search_default: bool,
    /// Vide = modèle par défaut désigné par Venice.
    pub code_model: String,
    /// Ajoute l'invite système de Venice aux nôtres (désactivé : comportement prévisible de l'agent).
    pub venice_system_prompt: bool,
    /// N'afficher que les modèles « privés » (exécutés par Venice, sans conservation des données).
    pub private_only: bool,
    /// Délai max d'une commande du mode Code, en secondes.
    pub command_timeout: u64,
    /// Outils MCP exécutés sans demander (noms exposés).
    pub mcp_always_allow: Vec<String>,
    /// Nombre max d'étapes (appels au modèle) d'un tour de l'agent de code.
    pub max_steps: u32,
    /// Mode d'approbation des nouvelles sessions de code : "ask", "acceptEdits" ou "auto".
    pub default_permission: String,
    /// Relance l'agent s'il s'arrête en annonçant une action sans l'exécuter.
    pub auto_continue: bool,
    /// Résume automatiquement l'historique au-delà de ce pourcentage du contexte (0 = jamais).
    pub auto_compact_percent: u32,
    pub check_updates: bool,
    pub skipped_version: String,
    /// Shell de l'agent : « auto », « bash » (Git Bash), « pwsh » ou « powershell » (Windows).
    pub shell: String,
    /// Tarifs personnalisés en $ par million de tokens : « préfixe de modèle » → [entrée, sortie].
    /// Par défaut, les tarifs publiés par l'API (liste des modèles) sont utilisés.
    pub prices: std::collections::BTreeMap<String, [f64; 2]>,
    /// Dictée vocale : modèle de transcription, langue (vide = détection) et serveur dédié (vide = API Venice).
    pub transcription_model: String,
    pub transcription_language: String,
    pub transcription_url: String,
    /// Termes à favoriser par la transcription (un par ligne ou séparés par des virgules).
    pub transcription_vocabulary: String,
    /// Lecture à voix haute : modèle, voix et vitesse.
    pub tts_model: String,
    pub tts_voice: String,
    pub tts_speed: f32,
    /// Génération d'images : modèle (vide = défaut de Venice), format, filtre de contenu.
    pub image_model: String,
    pub image_aspect: String,
    pub image_negative_prompt: String,
    pub image_safe_mode: bool,
    pub image_hide_watermark: bool,
    /// Modèle de retouche par un texte (vide = défaut de Venice).
    pub image_edit_model: String,
    /// Nombre d'images par génération (1 à 4).
    pub image_variants: u32,
    /// Chiffrement des conversations, projets et mcp.json (clé dans le trousseau du système).
    pub encrypt_data: bool,
    /// Version du format des réglages, pour les migrations (absent = 0).
    #[serde(default)]
    pub settings_version: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SystemPrompt {
    pub id: String,
    pub name: String,
    pub text: String,
}

/// Version courante du format des réglages.
const SETTINGS_VERSION: u32 = 1;

/// Mises à niveau des réglages d'anciennes versions.
fn migrate_settings(s: &mut Settings) {
    if !s.system_prompt.trim().is_empty() && s.system_prompts.is_empty() {
        s.system_prompts.push(SystemPrompt { id: "defaut".into(), name: "Instructions".into(), text: std::mem::take(&mut s.system_prompt) });
        s.default_prompt = "defaut".into();
    }
    if s.transcription_model.trim().is_empty() {
        s.transcription_model = crate::venice::TRANSCRIBE_MODEL.into();
    }
    s.settings_version = SETTINGS_VERSION;
}

impl Settings {
    pub fn vocabulary(&self) -> Vec<String> {
        self.transcription_vocabulary
            .split([',', '\n', ';'])
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .take(100)
            .collect()
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: crate::venice::DEFAULT_BASE_URL.into(),
            default_model: String::new(),
            system_prompt: String::new(),
            system_prompts: Vec::new(),
            default_prompt: String::new(),
            prompt_templates: Vec::new(),
            balance_alert: None,
            monthly_budget: None,
            temperature: None,
            max_tokens: None,
            theme: "system".into(),
            send_on_enter: true,
            web_search_provider: "venice".into(),
            web_search_mode: "auto".into(),
            searxng_url: String::new(),
            web_search_default: false,
            code_model: String::new(),
            venice_system_prompt: false,
            private_only: true,
            command_timeout: 120,
            mcp_always_allow: Vec::new(),
            max_steps: 100,
            default_permission: "auto".into(),
            auto_continue: true,
            auto_compact_percent: 80,
            check_updates: true,
            skipped_version: String::new(),
            shell: "auto".into(),
            prices: Default::default(),
            transcription_model: crate::venice::TRANSCRIBE_MODEL.into(),
            transcription_language: "fr".into(),
            transcription_url: String::new(),
            transcription_vocabulary: String::new(),
            tts_model: "tts-kokoro".into(),
            tts_voice: "ff_siwis".into(),
            tts_speed: 1.0,
            image_model: String::new(),
            image_aspect: "1:1".into(),
            image_negative_prompt: String::new(),
            image_safe_mode: true,
            image_hide_watermark: true,
            image_edit_model: String::new(),
            image_variants: 1,
            encrypt_data: true,
            settings_version: SETTINGS_VERSION,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub content: String,
    /// Champs propres à l'interface (id, images, raisonnement, usage…), conservés tels quels.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// « chat » ou « code ».
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub messages: Vec<Message>,
    /// Champs propres à l'interface (dossier de projet, mode d'approbation, outils…).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_kind() -> String {
    "chat".into()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
}

impl From<&Conversation> for ConversationSummary {
    fn from(c: &Conversation) -> Self {
        Self {
            id: c.id.clone(),
            title: c.title.clone(),
            updated_at: c.updated_at,
            kind: c.kind.clone(),
            workspace: c.extra.get("workspace").and_then(Value::as_str).map(str::to_owned),
            project_id: c.extra.get("projectId").and_then(Value::as_str).map(str::to_owned),
        }
    }
}

fn ensure_dir(p: PathBuf) -> R<PathBuf> {
    fs::create_dir_all(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(p)
}

pub fn data_dir(app: &AppHandle) -> R<PathBuf> {
    ensure_dir(app.path().app_data_dir().map_err(|e| e.to_string())?)
}

fn conv_dir(app: &AppHandle) -> R<PathBuf> {
    ensure_dir(data_dir(app)?.join("conversations"))
}

fn settings_path(app: &AppHandle) -> R<PathBuf> {
    Ok(ensure_dir(app.path().app_config_dir().map_err(|e| e.to_string())?)?.join("settings.json"))
}

/// Écriture atomique (fichier temporaire + rename) pour ne jamais corrompre l'historique.
fn write_atomic(path: &Path, bytes: &[u8]) -> R<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn write_json<T: Serialize>(path: &Path, v: &T) -> R<()> {
    write_atomic(path, &serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?)
}

/// Données personnelles : chiffrées sur disque si le chiffrement est actif.
fn write_secret(path: &Path, plain: &[u8]) -> R<()> {
    write_atomic(path, &crate::vault::encode(plain)?)
}

fn write_secret_json<T: Serialize>(path: &Path, v: &T) -> R<()> {
    write_secret(path, &serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?)
}

fn read_secret(path: &Path) -> R<Vec<u8>> {
    crate::vault::decode(fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)
}

/// Fichiers contenant des données personnelles.
fn secret_files(app: &AppHandle) -> R<Vec<PathBuf>> {
    let mut out = Vec::new();
    for dir in [conv_dir(app)?, projects_dir(app)?] {
        for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) == Some("json") {
                out.push(e.path());
            }
        }
    }
    let mcp = mcp_path(app)?;
    if mcp.exists() {
        out.push(mcp);
    }
    Ok(out)
}

/// Existe-t-il des fichiers déjà chiffrés ?
pub fn has_sealed_files(app: &AppHandle) -> R<bool> {
    for p in secret_files(app)? {
        let mut head = [0u8; 8];
        let n = fs::File::open(&p).and_then(|mut f| std::io::Read::read(&mut f, &mut head)).unwrap_or(0);
        if crate::vault::is_sealed(&head[..n]) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// (Dé)chiffre les fichiers existants selon l'état du chiffrement. Renvoie le nombre de fichiers convertis.
pub fn reseal_all(app: &AppHandle) -> R<usize> {
    let want = crate::vault::enabled();
    let mut n = 0;
    for p in secret_files(app)? {
        let raw = fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        if crate::vault::is_sealed(&raw) == want {
            continue;
        }
        let plain = crate::vault::decode(raw)?;
        write_secret(&p, &plain)?;
        n += 1;
    }
    Ok(n)
}

/// Les identifiants servent de nom de fichier : on refuse tout ce qui n'est pas [A-Za-z0-9-].
fn check_id(id: &str) -> R<()> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("Identifiant de conversation invalide".into())
    }
}

pub fn load_settings(app: &AppHandle) -> R<Settings> {
    let path = settings_path(app)?;
    match fs::read(&path) {
        Ok(bytes) => {
            let mut s: Settings = serde_json::from_slice(&bytes).unwrap_or_default();
            migrate_settings(&mut s);
            Ok(s)
        }
        Err(_) => Ok(Settings::default()),
    }
}

pub fn save_settings(app: &AppHandle, s: &Settings) -> R<()> {
    write_json(&settings_path(app)?, s)
}

fn index_path(app: &AppHandle) -> R<PathBuf> {
    Ok(conv_dir(app)?.join("index.json"))
}

fn rebuild_index(app: &AppHandle) -> R<Vec<ConversationSummary>> {
    let dir = conv_dir(app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") || p.ends_with("index.json") {
            continue;
        }
        // Fichier chiffré illisible (clé absente) : on s'arrête sans réécrire l'index,
        // sinon les conversations disparaîtraient de la liste une fois la clé restaurée.
        let bytes = read_secret(&p)?;
        if let Ok(c) = serde_json::from_slice::<Conversation>(&bytes) {
            out.push(ConversationSummary::from(&c));
        }
    }
    write_secret_json(&index_path(app)?, &out)?;
    Ok(out)
}

fn read_index(app: &AppHandle) -> R<Vec<ConversationSummary>> {
    let path = index_path(app)?;
    match fs::read(&path) {
        // Index absent : reconstruction. Index chiffré illisible : erreur (jamais de réécriture).
        Err(_) => rebuild_index(app),
        Ok(raw) => match serde_json::from_slice(&crate::vault::decode(raw)?) {
            Ok(idx) => Ok(idx),
            Err(_) => rebuild_index(app),
        },
    }
}

pub fn list_conversations(app: &AppHandle) -> R<Vec<ConversationSummary>> {
    let mut idx = read_index(app)?;
    idx.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(idx)
}

pub fn load_conversation(app: &AppHandle, id: &str) -> R<Conversation> {
    check_id(id)?;
    let bytes = read_secret(&conv_dir(app)?.join(format!("{id}.json")))?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryItem {
    pub conv_id: String,
    pub conv_title: String,
    pub msg_id: String,
    /// Description de l'image (message de l'utilisateur qui la précède).
    pub prompt: String,
    pub model: String,
    pub created_at: i64,
    pub src: String,
}

/// Images générées de toutes les conversations, les plus récentes d'abord.
pub fn gallery(app: &AppHandle) -> R<Vec<GalleryItem>> {
    let mut out = Vec::new();
    for summary in list_conversations(app)? {
        let Ok(c) = load_conversation(app, &summary.id) else { continue };
        for (i, m) in c.messages.iter().enumerate() {
            let Some(images) = m.extra.get("generated").and_then(Value::as_array) else { continue };
            let prompt = c.messages[..i].iter().rev().find(|p| p.role == "user").map(|p| p.content.clone()).unwrap_or_default();
            for src in images.iter().filter_map(Value::as_str) {
                out.push(GalleryItem {
                    conv_id: c.id.clone(),
                    conv_title: c.title.clone(),
                    msg_id: m.extra.get("id").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    prompt: prompt.clone(),
                    model: m.extra.get("model").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    created_at: m.extra.get("createdAt").and_then(Value::as_i64).unwrap_or(c.updated_at),
                    src: src.to_owned(),
                });
            }
        }
    }
    out.sort_by_key(|g| std::cmp::Reverse(g.created_at));
    Ok(out)
}

pub fn save_conversation(app: &AppHandle, c: &Conversation) -> R<()> {
    check_id(&c.id)?;
    write_secret_json(&conv_dir(app)?.join(format!("{}.json", c.id)), c)?;
    let mut idx = read_index(app)?;
    idx.retain(|s| s.id != c.id);
    idx.push(c.into());
    write_secret_json(&index_path(app)?, &idx)
}

#[derive(Serialize)]
pub struct SearchHit {
    pub id: String,
    /// Extrait du message trouvé (absent si seul le titre correspond).
    pub snippet: Option<String>,
}

/// Recherche plein texte dans toutes les conversations (titres et messages), déchiffrées en mémoire uniquement.
pub fn search_conversations(app: &AppHandle, query: &str) -> R<Vec<SearchHit>> {
    use crate::textsearch::{fold, snippet};
    let q: Vec<char> = fold(query.trim());
    if q.len() < 2 {
        return Ok(Vec::new());
    }
    let contains = |s: &str| fold(s).windows(q.len()).any(|w| w == q.as_slice());
    let mut hits = Vec::new();
    for e in fs::read_dir(conv_dir(app)?).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") || p.ends_with("index.json") {
            continue;
        }
        let Some(c) = read_secret(&p).ok().and_then(|b| serde_json::from_slice::<Conversation>(&b).ok()) else { continue };
        let found = c.messages.iter().find_map(|m| snippet(&m.content, query, 60));
        if found.is_some() || contains(&c.title) {
            hits.push(SearchHit { id: c.id, snippet: found });
        }
        if hits.len() >= 200 {
            break;
        }
    }
    Ok(hits)
}

pub fn delete_conversation(app: &AppHandle, id: &str) -> R<()> {
    check_id(id)?;
    let path = conv_dir(app)?.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let mut idx = read_index(app)?;
    idx.retain(|s| s.id != id);
    write_secret_json(&index_path(app)?, &idx)
}

fn workspaces_path(app: &AppHandle) -> R<PathBuf> {
    Ok(data_dir(app)?.join("workspaces.json"))
}

/// Dossiers de projet autorisés : uniquement ceux choisis via la boîte de dialogue native.
pub fn load_workspaces(app: &AppHandle) -> Vec<String> {
    let raw: Vec<String> = workspaces_path(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // Les anciennes versions enregistraient `\\?\C:\…` sous Windows.
    let mut out: Vec<String> = Vec::new();
    for ws in raw.iter().map(|w| crate::workspace::normalize_workspace(w)) {
        if !out.contains(&ws) {
            out.push(ws);
        }
    }
    out
}

pub fn add_workspace(app: &AppHandle, path: &str) -> R<Vec<String>> {
    let path = &crate::workspace::normalize_workspace(path);
    let mut list = load_workspaces(app);
    list.retain(|p| p != path);
    list.insert(0, path.to_owned());
    list.truncate(30);
    write_json(&workspaces_path(app)?, &list)?;
    Ok(list)
}

pub fn remove_workspace(app: &AppHandle, path: &str) -> R<Vec<String>> {
    let path = &crate::workspace::normalize_workspace(path);
    let mut list = load_workspaces(app);
    list.retain(|p| p != path);
    write_json(&workspaces_path(app)?, &list)?;
    Ok(list)
}

/// Consommation agrégée par jour et par modèle : `{"2026-10-12": {"modèle": [entrée, sortie, requêtes]}}`.
pub type UsageLog = std::collections::BTreeMap<String, std::collections::BTreeMap<String, [u64; 3]>>;

fn usage_path(app: &AppHandle) -> R<PathBuf> {
    Ok(data_dir(app)?.join("usage.json"))
}

pub fn load_usage(app: &AppHandle) -> UsageLog {
    usage_path(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn record_usage(app: &AppHandle, day: &str, model: &str, prompt: u64, completion: u64) -> R<()> {
    let mut log = load_usage(app);
    let e = log.entry(day.to_owned()).or_default().entry(model.to_owned()).or_insert([0, 0, 0]);
    e[0] += prompt;
    e[1] += completion;
    e[2] += 1;
    write_json(&usage_path(app)?, &log)
}

/// Projet : conversations regroupées partageant des consignes et des fichiers de référence.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub files: Vec<ProjectFile>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub name: String,
    pub text: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Taille maximale du texte d'un projet (consignes + fichiers), injecté dans chaque requête.
/// Au-delà de knowledge::FULL_CONTEXT_CHARS, seuls des extraits pertinents sont envoyés au modèle.
pub const MAX_PROJECT_CHARS: usize = 10_000_000;

fn projects_dir(app: &AppHandle) -> R<PathBuf> {
    ensure_dir(data_dir(app)?.join("projects"))
}

pub fn list_projects(app: &AppHandle) -> R<Vec<Project>> {
    let mut out: Vec<Project> = fs::read_dir(projects_dir(app)?)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| read_secret(&e.path()).ok().and_then(|b| serde_json::from_slice(&b).ok()))
        .collect();
    out.sort_by_key(|p: &Project| p.name.to_lowercase());
    Ok(out)
}

pub fn load_project(app: &AppHandle, id: &str) -> R<Project> {
    check_id(id)?;
    let b = read_secret(&projects_dir(app)?.join(format!("{id}.json")))?;
    serde_json::from_slice(&b).map_err(|e| e.to_string())
}

pub fn save_project(app: &AppHandle, p: &Project) -> R<()> {
    check_id(&p.id)?;
    if p.name.trim().is_empty() {
        return Err("Le projet doit avoir un nom".into());
    }
    let size = p.instructions.chars().count() + p.files.iter().map(|f| f.text.chars().count()).sum::<usize>();
    if size > MAX_PROJECT_CHARS {
        return Err(format!("Projet trop volumineux ({size} caractères, max {MAX_PROJECT_CHARS})"));
    }
    write_secret_json(&projects_dir(app)?.join(format!("{}.json", p.id)), p)
}

pub fn delete_project(app: &AppHandle, id: &str) -> R<()> {
    check_id(id)?;
    let path = projects_dir(app)?.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ssh_hosts_path(app: &AppHandle) -> R<PathBuf> {
    Ok(ensure_dir(app.path().app_config_dir().map_err(|e| e.to_string())?)?.join("ssh_hosts.json"))
}

pub fn load_ssh_hosts(app: &AppHandle) -> Vec<crate::ssh::SshHost> {
    ssh_hosts_path(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save_ssh_hosts(app: &AppHandle, hosts: &[crate::ssh::SshHost]) -> R<()> {
    write_json(&ssh_hosts_path(app)?, &hosts)
}

fn mcp_path(app: &AppHandle) -> R<PathBuf> {
    Ok(ensure_dir(app.path().app_config_dir().map_err(|e| e.to_string())?)?.join("mcp.json"))
}

pub fn load_mcp_config(app: &AppHandle) -> String {
    mcp_path(app)
        .ok()
        .and_then(|p| read_secret(&p).ok())
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| "{\n  \"mcpServers\": {}\n}\n".into())
}

pub fn save_mcp_config(app: &AppHandle, text: &str) -> R<()> {
    write_secret(&mcp_path(app)?, text.as_bytes())
}

fn to_markdown(c: &Conversation) -> String {
    let mut md = format!("# {}\n\n", c.title);
    if !c.model.is_empty() {
        md.push_str(&format!("_Modèle : {}_\n\n", c.model));
    }
    for m in &c.messages {
        let who = match m.role.as_str() {
            "user" => "Vous".to_string(),
            "assistant" => match m.extra.get("model").and_then(Value::as_str) {
                Some(model) => format!("Venice ({model})"),
                None => "Venice".into(),
            },
            other => other.to_string(),
        };
        if m.role == "assistant" && m.content.trim().is_empty() && m.extra.contains_key("toolCalls") {
            // Tour purement « outils » : on le résume sous le message précédent.
        } else {
            md.push_str(&format!("## {who}\n\n{}\n\n", m.content.trim()));
        }
        for tc in m.extra.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
            md.push_str(&format!(
                "> 🔧 `{}` {}\n\n",
                tc["name"].as_str().unwrap_or("?"),
                tc["arguments"].as_str().unwrap_or("").chars().take(200).collect::<String>()
            ));
        }
        let images = m.extra.get("images").and_then(Value::as_array).map_or(0, Vec::len);
        if images > 0 {
            md.push_str(&format!("_[{images} image(s) jointe(s)]_\n\n"));
        }
        let generated = m.extra.get("generated").and_then(Value::as_array).map_or(0, Vec::len);
        if generated > 0 {
            md.push_str(&format!("_[{generated} image(s) générée(s)]_\n\n"));
        }
        let sources = m.extra.get("citations").and_then(Value::as_array).cloned().unwrap_or_default();
        if !sources.is_empty() {
            md.push_str("Sources :\n\n");
            for (i, c) in sources.iter().enumerate() {
                md.push_str(&format!("{}. [{}]({})\n", i + 1, c["title"].as_str().unwrap_or("source"), c["url"].as_str().unwrap_or("")));
            }
            md.push('\n');
        }
    }
    md
}

fn safe_filename(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    let s = s.trim();
    if s.is_empty() { "conversation".into() } else { s.to_string() }
}

/// Ouvre une boîte « Enregistrer sous » native et écrit la conversation en Markdown.
/// Le chemin n'est jamais fourni par la WebView.
pub async fn export_conversation(app: &AppHandle, id: &str) -> R<bool> {
    let conv = load_conversation(app, id)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name(format!("{}.md", safe_filename(&conv.title)))
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    fs::write(&path, to_markdown(&conv)).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_settings_get_defaults() {
        let mut s: Settings = serde_json::from_str(r#"{"transcriptionModel":"","transcriptionVocabulary":"Proxmox, fail2ban\nZFS"}"#).unwrap();
        assert_eq!(s.settings_version, 0);
        migrate_settings(&mut s);
        assert_eq!(s.transcription_model, crate::venice::TRANSCRIBE_MODEL);
        assert_eq!(s.vocabulary(), ["Proxmox", "fail2ban", "ZFS"]);
        // Choix explicite conservé.
        s.transcription_model = "openai/whisper-large-v3".into();
        migrate_settings(&mut s);
        assert_eq!(s.transcription_model, "openai/whisper-large-v3");
        // Valeurs par défaut respectueuses de la vie privée.
        assert!(s.encrypt_data && s.private_only && s.image_safe_mode && !s.venice_system_prompt);
        assert_eq!(s.base_url, crate::venice::DEFAULT_BASE_URL);
        assert_eq!(s.default_permission, "auto");
    }

    #[test]
    fn single_system_prompt_becomes_a_preset() {
        let mut s: Settings = serde_json::from_str(r#"{"systemPrompt":"Réponds en français."}"#).unwrap();
        migrate_settings(&mut s);
        assert_eq!(s.system_prompts, [SystemPrompt { id: "defaut".into(), name: "Instructions".into(), text: "Réponds en français.".into() }]);
        assert_eq!(s.default_prompt, "defaut");
        assert!(s.system_prompt.is_empty());
        migrate_settings(&mut s);
        assert_eq!(s.system_prompts.len(), 1);
    }

    #[test]
    fn ids_cannot_escape_directory() {
        assert!(check_id("2f1c-abc").is_ok());
        assert!(check_id("../etc/passwd").is_err());
        assert!(check_id("a/b").is_err());
        assert!(check_id("").is_err());
    }

    #[test]
    fn unknown_message_fields_round_trip() {
        let raw = r#"{"role":"assistant","content":"ok","model":"m","reasoning":"r"}"#;
        let m: Message = serde_json::from_str(raw).unwrap();
        let back = serde_json::to_value(&m).unwrap();
        assert_eq!(back["reasoning"], "r");
        assert_eq!(back["model"], "m");
    }
}
