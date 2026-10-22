mod askpass;
mod audio;
mod backup;
mod e2ee;
mod git;
mod mcp;
mod semantic;
mod shell;
mod ssh;
mod storage;
mod knowledge;
mod target;
mod textsearch;
mod tools;
mod updates;
mod vault;
mod venice;
mod web;
mod workspace;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Notify;

use mcp::{McpManager, ServerStatus};
use venice::{ChatRequest, ModelInfo, StreamEvent};
use storage::{Conversation, ConversationSummary, Settings};
use tools::{ToolContext, ToolDef, ToolOutput};

const KEYRING_SERVICE: &str = "dev.r0mish.venice-desktop";
const KEYRING_USER: &str = "venice-api-key";
const ENV_API_KEY: &str = "VENICE_API_KEY";

/// Dictée vocale en cours.
#[derive(Default)]
struct Dictation(Mutex<Option<audio::Recording>>);

/// Sessions E2EE vérifiées, par modèle (renouvelées toutes les 30 min).
#[derive(Default)]
struct E2eeSessions(Mutex<HashMap<String, Arc<e2ee::Session>>>);

/// Requêtes en cours, annulables depuis l'interface.
#[derive(Default)]
struct Streams(Mutex<HashMap<String, Arc<Notify>>>);

type CmdResult<T> = Result<T, String>;

fn keyring_entry() -> CmdResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

/// Clé API : trousseau du système d'abord, variable d'environnement en repli
/// (utile sur un bureau Linux sans Secret Service).
fn api_key() -> CmdResult<String> {
    if let Ok(key) = keyring_entry().and_then(|e| e.get_password().map_err(|e| e.to_string())) {
        if !key.is_empty() {
            return Ok(key);
        }
    }
    match std::env::var(ENV_API_KEY) {
        Ok(key) if !key.is_empty() => Ok(key),
        _ => Err("Aucune clé API configurée. Ouvrez les réglages pour l'ajouter.".into()),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyStatus {
    configured: bool,
    source: Option<&'static str>,
}

#[tauri::command]
fn api_key_status() -> KeyStatus {
    let in_keyring = keyring_entry()
        .and_then(|e| e.get_password().map_err(|e| e.to_string()))
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    if in_keyring {
        return KeyStatus { configured: true, source: Some("keyring") };
    }
    if std::env::var(ENV_API_KEY).map(|k| !k.is_empty()).unwrap_or(false) {
        return KeyStatus { configured: true, source: Some("env") };
    }
    KeyStatus { configured: false, source: None }
}

#[tauri::command]
fn set_api_key(key: String) -> CmdResult<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Clé vide".into());
    }
    keyring_entry()?
        .set_password(key)
        .map_err(|e| format!("Impossible d'écrire dans le trousseau du système : {e}"))
}

#[tauri::command]
fn delete_api_key() -> CmdResult<()> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn get_settings(app: AppHandle) -> CmdResult<Settings> {
    storage::load_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> CmdResult<()> {
    venice::validate_base_url(&settings.base_url)?;
    if !settings.transcription_url.trim().is_empty() {
        venice::validate_base_url(settings.transcription_url.trim())?;
    }
    if settings.encrypt_data != vault::enabled() {
        let res = if settings.encrypt_data {
            enable_encryption(&app).map(|_| ())
        } else {
            vault::set_enabled(false).and_then(|_| storage::reseal_all(&app).map(|_| ()))
        };
        match res {
            Ok(()) => *vault::LAST_ERROR.lock().unwrap() = None,
            // Trousseau indisponible : les réglages sont enregistrés, l'erreur est affichée.
            Err(e) => *vault::LAST_ERROR.lock().unwrap() = Some(e),
        }
    }
    let shortcut_changed = storage::load_settings(&app).map(|old| old.global_shortcut != settings.global_shortcut).unwrap_or(true);
    storage::save_settings(&app, &settings)?;
    if shortcut_changed {
        apply_shortcut(&app, &settings.global_shortcut)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ raccourci global

/// (Ré)enregistre le raccourci global qui fait apparaître la fenêtre (vide = aucun).
fn apply_shortcut(app: &AppHandle, accel: &str) -> CmdResult<()> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    let accel = accel.trim();
    if accel.is_empty() {
        return Ok(());
    }
    gs.register(accel).map_err(|e| format!("Raccourci « {accel} » indisponible (déjà pris ou non pris en charge) : {e}"))
}

/// Fenêtre affichée au premier plan, nouvelle conversation prête à la saisie.
fn summon(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("quick-chat", ());
    }
}

// ------------------------------------------------------------------ sauvegarde chiffrée

/// Tests de bout en bout (compilation de débogage) : fichier imposé au lieu de la boîte de dialogue native.
fn e2e_file() -> Option<std::path::PathBuf> {
    if cfg!(debug_assertions) {
        std::env::var_os("VENICE_DESKTOP_E2E_FILE").map(Into::into)
    } else {
        None
    }
}

async fn pick_file(app: &AppHandle, save: bool) -> CmdResult<Option<std::path::PathBuf>> {
    if let Some(p) = e2e_file() {
        return Ok(Some(p));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = app.dialog().file().add_filter("Sauvegarde Venice Desktop", &["vdbk"]);
    if save {
        dialog.set_file_name("venice-desktop.vdbk").save_file(move |p| {
            let _ = tx.send(p);
        });
    } else {
        dialog.pick_file(move |p| {
            let _ = tx.send(p);
        });
    }
    match rx.await.map_err(|e| e.to_string())? {
        Some(p) => p.into_path().map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// Exporte toutes les données dans une archive chiffrée par phrase de passe. `None` : annulé.
#[tauri::command]
async fn export_backup(app: AppHandle, passphrase: String) -> CmdResult<Option<usize>> {
    if passphrase.chars().count() < backup::MIN_PASSPHRASE {
        return Err(format!("Phrase de passe trop courte ({} caractères minimum)", backup::MIN_PASSPHRASE));
    }
    let Some(path) = pick_file(&app, true).await? else { return Ok(None) };
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let entries = storage::backup_entries(&handle)?;
        let n = entries.len();
        std::fs::write(&path, backup::seal(&entries, &passphrase)?).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Some(n))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Restaure une sauvegarde ; les données sont rechiffrées avec la clé de cet appareil.
#[tauri::command]
async fn import_backup(app: AppHandle, passphrase: String, with_settings: bool) -> CmdResult<Option<storage::ImportReport>> {
    let Some(path) = pick_file(&app, false).await? else { return Ok(None) };
    let handle = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || -> CmdResult<storage::ImportReport> {
        let data = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let entries = backup::open(&data, &passphrase)?;
        let local = storage::load_settings(&handle)?;
        let report = storage::restore_entries(&handle, entries, with_settings)?;
        if report.settings {
            // Le chiffrement local reste tel quel : il dépend du trousseau de cet appareil.
            let mut s = storage::load_settings(&handle)?;
            s.encrypt_data = local.encrypt_data;
            storage::save_settings(&handle, &s)?;
        }
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())??;
    if report.settings {
        let _ = apply_shortcut(&app, &storage::load_settings(&app)?.global_shortcut);
    }
    Ok(Some(report))
}

/// Active le chiffrement puis chiffre les fichiers existants. Ne crée jamais de nouvelle clé
/// si des données sont déjà chiffrées avec une autre (trousseau perdu) : elles deviendraient irrécupérables.
fn enable_encryption(app: &AppHandle) -> CmdResult<usize> {
    if vault::key(false)?.is_none() && storage::has_sealed_files(app)? {
        return Err("Des données chiffrées existent, mais leur clé est absente du trousseau : restaurez votre clé de récupération (Réglages → Général).".into());
    }
    vault::set_enabled(true)?;
    storage::reseal_all(app)
}

#[tauri::command]
fn vault_status() -> vault::Status {
    vault::status()
}

#[tauri::command]
fn vault_export_key() -> CmdResult<String> {
    vault::export_key()
}

/// Restaure une clé de récupération puis vérifie qu'elle ouvre bien les données existantes.
#[tauri::command]
fn vault_import_key(app: AppHandle, key: String) -> CmdResult<()> {
    vault::import_key(&key)?;
    storage::list_conversations(&app)?;
    if storage::load_settings(&app)?.encrypt_data {
        enable_encryption(&app)?;
        *vault::LAST_ERROR.lock().unwrap() = None;
    }
    Ok(())
}

/// `kind` : « text » (chat, code) ou « image ».
#[tauri::command]
async fn list_models(app: AppHandle, kind: Option<String>) -> CmdResult<Vec<ModelInfo>> {
    let settings = storage::load_settings(&app)?;
    venice::list_models(&settings.base_url, &api_key()?, kind.as_deref().unwrap_or("text")).await
}

#[tauri::command]
fn list_conversations(app: AppHandle) -> CmdResult<Vec<ConversationSummary>> {
    storage::list_conversations(&app)
}

#[tauri::command]
fn load_conversation(app: AppHandle, id: String) -> CmdResult<Conversation> {
    storage::load_conversation(&app, &id)
}

#[tauri::command]
fn save_conversation(app: AppHandle, conversation: Conversation) -> CmdResult<()> {
    storage::save_conversation(&app, &conversation)
}

#[tauri::command]
async fn search_conversations(app: AppHandle, query: String) -> CmdResult<Vec<storage::SearchHit>> {
    tauri::async_runtime::spawn_blocking(move || storage::search_conversations(&app, &query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn delete_conversation(app: AppHandle, id: String) -> CmdResult<()> {
    storage::delete_conversation(&app, &id)
}

#[tauri::command]
async fn export_conversation(app: AppHandle, id: String) -> CmdResult<bool> {
    storage::export_conversation(&app, &id).await
}

#[tauri::command]
fn data_dir(app: AppHandle) -> CmdResult<String> {
    storage::data_dir(&app).map(|p| p.display().to_string())
}

#[tauri::command]
async fn chat_stream(
    app: AppHandle,
    streams: State<'_, Streams>,
    request_id: String,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
) -> CmdResult<()> {
    let settings = storage::load_settings(&app)?;
    let key = api_key()?;
    let cancel = Arc::new(Notify::new());
    streams.0.lock().unwrap().insert(request_id.clone(), cancel.clone());
    // Modèle chiffré de bout en bout : attestation de l'enclave vérifiée avant tout envoi.
    let session = if request.e2ee { Some(e2ee_session(&app, &settings.base_url, &key, &request.model).await?) } else { None };
    if let Some(s) = &session {
        let _ = on_event.send(StreamEvent::E2ee { attestation: s.attestation.clone() });
    }
    let opts = venice::VeniceOptions {
        web_search_mode: if settings.web_search_mode == "on" { "on" } else { "auto" },
        include_system_prompt: settings.venice_system_prompt,
        e2ee: session.as_deref(),
    };
    // Recherche web intégrée de Venice ; les autres fournisseurs passent par l'outil web_search.
    let request = ChatRequest { web_search: request.web_search && tools::native_web_search(&settings), ..request };
    let result = venice::chat_stream(&settings.base_url, &key, request, &opts, &on_event, cancel).await;
    streams.0.lock().unwrap().remove(&request_id);
    result
}

async fn e2ee_session(app: &AppHandle, base: &str, key: &str, model: &str) -> CmdResult<Arc<e2ee::Session>> {
    let sessions = app.state::<E2eeSessions>();
    if let Some(s) = sessions.0.lock().unwrap().get(model).filter(|s| s.fresh(model)) {
        return Ok(s.clone());
    }
    let nonce = e2ee::nonce();
    let v = venice::attestation(base, key, model, &e2ee::nonce_hex(&nonce)).await?;
    let (model_key, attestation) = e2ee::verify_attestation(&v, &nonce, model)?;
    let session = Arc::new(e2ee::Session::new(model_key, attestation));
    sessions.0.lock().unwrap().insert(model.to_owned(), session.clone());
    Ok(session)
}

#[tauri::command]
fn cancel_stream(streams: State<'_, Streams>, request_id: String) {
    if let Some(n) = streams.0.lock().unwrap().get(&request_id) {
        n.notify_one();
    }
}

// ------------------------------------------------------------------ outils

#[tauri::command]
fn tool_definitions(app: AppHandle, mcp: State<'_, Arc<McpManager>>, ctx: ToolContext) -> Vec<ToolDef> {
    let settings = storage::load_settings(&app).unwrap_or_default();
    tools::definitions(&ctx, &mcp, &shell::detect(&settings.shell), tools::native_web_search(&settings))
}

#[tauri::command]
async fn preview_tool(app: AppHandle, ctx: ToolContext, name: String, arguments: String) -> CmdResult<Option<String>> {
    tools::preview(&ctx, &storage::load_workspaces(&app), &storage::load_ssh_hosts(&app), &name, &arguments).await
}

/// Chemin hors du dossier de projet visé par un appel (accès système), pour exiger l'approbation.
#[tauri::command]
fn tool_outside(app: AppHandle, ctx: ToolContext, name: String, arguments: String) -> CmdResult<Option<String>> {
    tools::outside(&ctx, &storage::load_workspaces(&app), &storage::load_ssh_hosts(&app), &name, &arguments)
}

#[tauri::command]
async fn run_tool(
    app: AppHandle,
    streams: State<'_, Streams>,
    mcp: State<'_, Arc<McpManager>>,
    request_id: String,
    ctx: ToolContext,
    name: String,
    arguments: String,
) -> CmdResult<ToolOutput> {
    let settings = storage::load_settings(&app)?;
    let approved = storage::load_workspaces(&app);
    let hosts = storage::load_ssh_hosts(&app);
    let project = ctx.project.as_deref().and_then(|id| storage::load_project(&app, id).ok());
    let cancel = Arc::new(Notify::new());
    streams.0.lock().unwrap().insert(request_id.clone(), cancel.clone());
    let env = tools::RunEnv { app: &app, settings: &settings, api_key: api_key(), approved: &approved, hosts: &hosts, mcp: &mcp, cancel: cancel.clone(), project };
    let out = if name == "run_command" {
        // La commande gère elle-même l'annulation (arrêt du groupe de processus).
        tools::run(&ctx, env, &name, &arguments).await
    } else {
        tokio::select! {
            o = tools::run(&ctx, env, &name, &arguments) => o,
            _ = cancel.notified() => ToolOutput { content: "Annulé par l'utilisateur".into(), is_error: true, diff: None },
        }
    };
    streams.0.lock().unwrap().remove(&request_id);
    Ok(out)
}

// ------------------------------------------------------------------ dossiers de projet

#[tauri::command]
async fn pick_workspace(app: AppHandle) -> CmdResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Choisir le dossier du projet").pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let path = workspace::simplify_path(&path.canonicalize().map_err(|e| e.to_string())?).display().to_string();
    storage::add_workspace(&app, &path)?;
    Ok(Some(path))
}

#[tauri::command]
fn list_workspaces(app: AppHandle) -> Vec<String> {
    storage::load_workspaces(&app)
}

#[tauri::command]
fn forget_workspace(app: AppHandle, path: String) -> CmdResult<Vec<String>> {
    storage::remove_workspace(&app, &path)
}

#[tauri::command]
fn touch_workspace(app: AppHandle, path: String) -> CmdResult<()> {
    // Ne fait que remonter un dossier déjà autorisé en tête de liste.
    if storage::load_workspaces(&app).contains(&workspace::normalize_workspace(&path)) {
        storage::add_workspace(&app, &path)?;
    }
    Ok(())
}

/// Fichiers de consignes (AGENTS.md…) du dossier de projet.
#[tauri::command]
async fn workspace_instructions(app: AppHandle, workspace: String) -> CmdResult<Vec<target::InstructionFile>> {
    git_target(&app, &workspace)?.instruction_files().await
}

// ------------------------------------------------------------------ projets

#[tauri::command]
fn list_projects(app: AppHandle) -> CmdResult<Vec<storage::Project>> {
    storage::list_projects(&app)
}

#[tauri::command]
fn save_project(app: AppHandle, project: storage::Project) -> CmdResult<()> {
    storage::save_project(&app, &project)
}

/// Fichiers de référence à joindre pour une question : en entier, ou extraits pertinents (gros projets).
#[tauri::command]
async fn project_context(app: AppHandle, id: String, query: String) -> CmdResult<knowledge::ProjectContext> {
    let p = storage::load_project(&app, &id)?;
    let settings = storage::load_settings(&app)?;
    // Recherche sémantique (optionnelle) seulement quand les fichiers ne sont pas joints en entier.
    let semantic = if semantic::enabled(&settings) && knowledge::total_chars(&p) > knowledge::FULL_CONTEXT_CHARS {
        match semantic::scores(&app, &settings, &api_key()?, &p, &knowledge::chunks(&p), &query).await {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("recherche sémantique indisponible : {e}");
                None
            }
        }
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || knowledge::context(&p, &query, semantic.as_deref())).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_project(app: AppHandle, id: String) -> CmdResult<()> {
    storage::delete_project(&app, &id)
}

// ------------------------------------------------------------------ dictée vocale

#[tauri::command]
async fn dictation_start(dictation: State<'_, Dictation>, on_level: Channel<f32>) -> CmdResult<()> {
    let old = dictation.0.lock().unwrap().take();
    // L'ouverture du micro peut prendre du temps : hors du thread de l'interface.
    let rec = tauri::async_runtime::spawn_blocking(move || {
        if let Some(old) = old {
            old.finish();
        }
        audio::start(on_level)
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(other) = dictation.0.lock().unwrap().replace(rec) {
        other.finish();
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct Transcript {
    text: String,
    /// Information à afficher (repli sur un autre modèle…).
    note: Option<String>,
}

/// Arrête l'enregistrement ; le transcrit si `transcribe`, sinon l'abandonne.
#[tauri::command]
async fn dictation_stop(app: AppHandle, dictation: State<'_, Dictation>, transcribe: bool) -> CmdResult<Option<Transcript>> {
    let Some(rec) = dictation.0.lock().unwrap().take() else { return Ok(None) };
    let captured = tauri::async_runtime::spawn_blocking(move || rec.finish()).await.map_err(|e| e.to_string())?;
    if !transcribe {
        return Ok(None);
    }
    if captured.seconds < 0.4 {
        return Err("Enregistrement trop court".into());
    }
    if captured.silent {
        return Err("Aucun son capté : vérifiez le micro et l'autorisation d'accès dans les réglages du système.".into());
    }
    let settings = storage::load_settings(&app)?;
    let custom = settings.transcription_url.trim();
    // La clé Venice n'est jamais envoyée à un serveur de transcription tiers.
    let (base, key) = if custom.is_empty() { (settings.base_url.as_str(), api_key()?) } else { (custom, String::new()) };
    let model = if settings.transcription_model.trim().is_empty() { venice::TRANSCRIBE_MODEL } else { settings.transcription_model.trim() };
    let lang = settings.transcription_language.trim();
    // Vocabulaire : invite initiale de Whisper (ignorée par les modèles qui ne la gèrent pas).
    let vocab = settings.vocabulary();
    let prompt = if vocab.is_empty() || (custom.is_empty() && !model.contains("whisper")) { String::new() } else { vocab.join(", ") };
    match venice::transcribe(base, &key, model, lang, &prompt, venice::AudioFile::wav(captured.wav.clone()), false).await {
        Ok(text) => Ok(Some(Transcript { text, note: None })),
        // Modèle refusé (retiré, nom changé…) : repli sur Whisper.
        Err(e) if custom.is_empty() && model != venice::TRANSCRIBE_FALLBACK && venice::is_model_error(&e) => {
            let text = venice::transcribe(base, &key, venice::TRANSCRIBE_FALLBACK, lang, &vocab.join(", "), venice::AudioFile::wav(captured.wav), false).await?;
            Ok(Some(Transcript { text, note: Some(format!("Modèle {model} indisponible ({e}) : transcription faite avec {}.", venice::TRANSCRIBE_FALLBACK)) }))
        }
        Err(e) => Err(e),
    }
}

// ------------------------------------------------------------------ SSH

#[tauri::command]
fn ssh_hosts(app: AppHandle) -> Vec<ssh::SshHost> {
    let mut hosts = storage::load_ssh_hosts(&app);
    for h in hosts.iter_mut().filter(|h| h.uses_password()) {
        h.has_password = askpass::has_password(&h.id);
    }
    hosts
}

#[tauri::command]
fn ssh_save_host(app: AppHandle, mut host: ssh::SshHost) -> CmdResult<ssh::SshHost> {
    host.host = host.host.trim().to_string();
    host.label = if host.label.trim().is_empty() { host.host.clone() } else { host.label.trim().to_string() };
    host.user = host.user.filter(|u| !u.trim().is_empty());
    host.identity_file = host.identity_file.filter(|k| !k.trim().is_empty());
    host.has_password = false;
    ssh::validate(&host)?;
    let mut hosts = storage::load_ssh_hosts(&app);
    if host.id.is_empty() {
        host.id = uuid::Uuid::new_v4().simple().to_string()[..8].to_owned();
    }
    hosts.retain(|h| h.id != host.id);
    hosts.push(host.clone());
    hosts.sort_by_key(|h| h.label.to_lowercase());
    storage::save_ssh_hosts(&app, &hosts)?;
    Ok(host)
}

#[tauri::command]
fn ssh_delete_host(app: AppHandle, id: String) -> CmdResult<()> {
    let mut hosts = storage::load_ssh_hosts(&app);
    hosts.retain(|h| h.id != id);
    storage::save_ssh_hosts(&app, &hosts)?;
    let _ = askpass::forget_password(&id);
    // Les dossiers distants de cet hôte ne sont plus autorisés.
    for ws in storage::load_workspaces(&app) {
        if target::parse_remote(&ws).is_some_and(|(hid, _)| hid == id) {
            storage::remove_workspace(&app, &ws)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn ssh_test(app: AppHandle, mut host: ssh::SshHost, password: Option<String>) -> CmdResult<ssh::TestResult> {
    host.secret = password.filter(|p| !p.is_empty());
    let res = ssh::test(&host).await;
    // Mémorise le système détecté pour informer le modèle.
    if res.ok && !host.id.is_empty() {
        let mut hosts = storage::load_ssh_hosts(&app);
        if let Some(h) = hosts.iter_mut().find(|h| h.id == host.id) {
            h.system = res.system.clone();
            storage::save_ssh_hosts(&app, &hosts)?;
        }
    }
    Ok(res)
}

#[tauri::command]
async fn ssh_trust(mut host: ssh::SshHost, password: Option<String>) -> CmdResult<()> {
    // Rebond ou ssh-keyscan impossible : la clé est enregistrée par une connexion, qui s'authentifie.
    host.secret = password.filter(|p| !p.is_empty());
    ssh::trust(&host).await
}

/// Mot de passe SSH dans le trousseau du système (`None` : l'oublier).
#[tauri::command]
fn ssh_set_password(host_id: String, password: Option<String>) -> CmdResult<()> {
    match password.filter(|p| !p.is_empty()) {
        Some(p) => askpass::save_password(&host_id, &p),
        None => askpass::forget_password(&host_id),
    }
}

/// Réponse de l'utilisateur à une invite SSH (mot de passe, code 2FA) ; `None` : annulée.
#[tauri::command]
fn ssh_prompt_answer(id: String, answer: Option<String>, save: bool) {
    askpass::respond(&id, answer.map(|text| askpass::Answer { text, save }));
}

fn find_host(app: &AppHandle, id: &str) -> CmdResult<ssh::SshHost> {
    storage::load_ssh_hosts(app).into_iter().find(|h| h.id == id).ok_or_else(|| "Serveur SSH inconnu".to_string())
}

#[tauri::command]
async fn ssh_list_dirs(app: AppHandle, host_id: String, path: String) -> CmdResult<ssh::DirListing> {
    ssh::list_dirs(&find_host(&app, &host_id)?, &path).await
}

/// Autorise un dossier distant comme dossier de projet (après vérification de son existence).
#[tauri::command]
async fn ssh_open_workspace(app: AppHandle, host_id: String, path: String) -> CmdResult<String> {
    let host = find_host(&app, &host_id)?;
    let listing = ssh::list_dirs(&host, &path).await?;
    let ws = target::remote_workspace(&host.id, &listing.path);
    storage::add_workspace(&app, &ws)?;
    Ok(ws)
}

// ------------------------------------------------------------------ git

fn git_target(app: &AppHandle, workspace: &str) -> CmdResult<target::Target> {
    target::resolve(workspace, &storage::load_workspaces(app), &storage::load_ssh_hosts(app))
}

#[tauri::command]
async fn git_status(app: AppHandle, workspace: String) -> CmdResult<git::GitStatus> {
    git::status(&git_target(&app, &workspace)?).await
}

#[tauri::command]
async fn git_diff(app: AppHandle, workspace: String, path: Option<String>, staged: bool, untracked: bool) -> CmdResult<String> {
    git::diff(&git_target(&app, &workspace)?, path.as_deref(), staged, untracked).await
}

#[tauri::command]
async fn git_stage(app: AppHandle, workspace: String, paths: Vec<String>) -> CmdResult<()> {
    git::stage(&git_target(&app, &workspace)?, &paths).await
}

#[tauri::command]
async fn git_unstage(app: AppHandle, workspace: String, paths: Vec<String>) -> CmdResult<()> {
    git::unstage(&git_target(&app, &workspace)?, &paths).await
}

#[tauri::command]
async fn git_discard(app: AppHandle, workspace: String, tracked: Vec<String>, untracked: Vec<String>) -> CmdResult<()> {
    git::discard(&git_target(&app, &workspace)?, &tracked, &untracked).await
}

#[tauri::command]
async fn git_commit(app: AppHandle, workspace: String, message: String) -> CmdResult<String> {
    git::commit(&git_target(&app, &workspace)?, &message).await
}

#[tauri::command]
async fn git_sync(app: AppHandle, workspace: String, action: String) -> CmdResult<String> {
    let t = git_target(&app, &workspace)?;
    match action.as_str() {
        "push" => git::push(&t).await,
        "pull" => git::pull(&t).await,
        "fetch" => git::fetch(&t).await.map(|_| String::new()),
        _ => Err("Action inconnue".into()),
    }
}

#[tauri::command]
async fn git_branches(app: AppHandle, workspace: String) -> CmdResult<Vec<String>> {
    git::branches(&git_target(&app, &workspace)?).await
}

#[tauri::command]
async fn git_checkout(app: AppHandle, workspace: String, branch: String, create: bool) -> CmdResult<()> {
    git::checkout(&git_target(&app, &workspace)?, &branch, create).await
}

#[tauri::command]
async fn git_log(app: AppHandle, workspace: String, count: u32) -> CmdResult<Vec<git::Commit>> {
    git::log(&git_target(&app, &workspace)?, count).await
}

#[tauri::command]
async fn git_init(app: AppHandle, workspace: String) -> CmdResult<()> {
    git::init(&git_target(&app, &workspace)?).await
}

// ------------------------------------------------------------------ documents

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentText {
    text: String,
    pages: usize,
}

fn extract_pdf_local(bytes: Vec<u8>) -> CmdResult<(String, usize)> {
    let text = pdf_extract::extract_text_from_mem(&bytes).map_err(|e| e.to_string())?;
    let pages = text.matches('\u{c}').count().max(1);
    Ok((text, pages))
}

/// Convertit un PDF en texte, localement : rien n'est envoyé pour la conversion.
#[tauri::command]
async fn process_document(data_base64: String) -> CmdResult<DocumentText> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("Fichier illisible : {e}"))?;
    if !bytes.starts_with(b"%PDF") {
        return Err("Ce fichier n'est pas un PDF".into());
    }
    let (text, pages) = tokio::task::spawn_blocking(move || extract_pdf_local(bytes))
        .await
        .map_err(|_| "L'extraction du texte a échoué sur ce PDF".to_string())?
        .map_err(|e| format!("Extraction du texte impossible : {e}"))?;
    if text.trim().chars().count() < 20 * pages {
        return Err("PDF sans texte exploitable (document scanné ?). Passez-le d'abord dans un OCR local, par ex. ocrmypdf, ou joignez des captures d'écran à un modèle vision.".into());
    }
    Ok(DocumentText { text, pages })
}

// ------------------------------------------------------------------ images et voix

#[tauri::command]
async fn generate_image(
    app: AppHandle,
    streams: State<'_, Streams>,
    request_id: String,
    request: venice::ImageRequest,
) -> CmdResult<venice::ImageResult> {
    let settings = storage::load_settings(&app)?;
    let cancel = Arc::new(Notify::new());
    streams.0.lock().unwrap().insert(request_id.clone(), cancel.clone());
    let result = venice::generate_image(&settings.base_url, &api_key()?, &request, cancel).await;
    streams.0.lock().unwrap().remove(&request_id);
    result
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageTransform {
    /// « upscale2 », « upscale4 », « background » ou « edit ».
    op: String,
    image: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    model: String,
}

/// Retouche d'une image : agrandissement ×2/×4, détourage, modification par un texte.
#[tauri::command]
async fn transform_image(app: AppHandle, streams: State<'_, Streams>, request_id: String, request: ImageTransform) -> CmdResult<String> {
    let settings = storage::load_settings(&app)?;
    let op = match request.op.as_str() {
        "upscale2" => venice::ImageOp::Upscale { scale: 2 },
        "upscale4" => venice::ImageOp::Upscale { scale: 4 },
        "background" => venice::ImageOp::RemoveBackground,
        "edit" if !request.prompt.trim().is_empty() => venice::ImageOp::Edit { model: &request.model, prompt: request.prompt.trim(), safe_mode: settings.image_safe_mode },
        "edit" => return Err("Décrivez la modification à apporter".into()),
        other => return Err(format!("Retouche inconnue : {other}")),
    };
    let cancel = Arc::new(Notify::new());
    streams.0.lock().unwrap().insert(request_id.clone(), cancel.clone());
    let result = venice::transform_image(&settings.base_url, &api_key()?, &request.image, op, cancel).await;
    streams.0.lock().unwrap().remove(&request_id);
    result
}

/// Toutes les images générées, de la plus récente à la plus ancienne (galerie).
#[tauri::command]
async fn list_gallery(app: AppHandle) -> CmdResult<Vec<storage::GalleryItem>> {
    tauri::async_runtime::spawn_blocking(move || storage::gallery(&app)).await.map_err(|e| e.to_string())?
}

/// Enregistre une image générée (data URL) via la boîte « Enregistrer sous » native.
#[tauri::command]
async fn save_image(app: AppHandle, data_url: String, name: String) -> CmdResult<bool> {
    let (meta, b64) = data_url.split_once(',').ok_or("Image invalide")?;
    let ext = match meta {
        m if m.contains("image/png") => "png",
        m if m.contains("image/jpeg") => "jpg",
        _ => "webp",
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Image", &[ext])
        .set_file_name(format!("{name}.{ext}"))
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(false) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Lecture à voix haute : renvoie l'audio MP3 en base64.
#[tauri::command]
async fn speak(app: AppHandle, text: String) -> CmdResult<String> {
    let settings = storage::load_settings(&app)?;
    if !venice::is_venice(&settings.base_url) {
        return Err("La synthèse vocale nécessite l'API Venice.".into());
    }
    let audio = venice::speech(&settings.base_url, &api_key()?, &settings.tts_model, &settings.tts_voice, settings.tts_speed, &text).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(audio))
}

/// Transcription d'un fichier audio ou vidéo joint (réunion, podcast…).
#[tauri::command]
async fn transcribe_file(app: AppHandle, name: String, mime: String, data_base64: String) -> CmdResult<String> {
    let settings = storage::load_settings(&app)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes()).map_err(|e| format!("Fichier illisible : {e}"))?;
    let custom = settings.transcription_url.trim();
    let (base, key) = if custom.is_empty() { (settings.base_url.as_str(), api_key()?) } else { (custom, String::new()) };
    let model = if settings.transcription_model.trim().is_empty() { venice::TRANSCRIBE_MODEL } else { settings.transcription_model.trim() };
    let mime = if mime.is_empty() { "application/octet-stream".to_string() } else { mime };
    let file = venice::AudioFile { bytes, name, mime };
    venice::transcribe(base, &key, model, settings.transcription_language.trim(), "", file, settings.transcription_timestamps).await
}

/// Clone une voix (échantillon audio) pour la lecture à voix haute.
#[tauri::command]
async fn clone_voice(app: AppHandle, name: String, mime: String, data_base64: String, model: String) -> CmdResult<String> {
    let settings = storage::load_settings(&app)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes()).map_err(|e| format!("Fichier illisible : {e}"))?;
    venice::clone_voice(&settings.base_url, &api_key()?, &model, venice::AudioFile { bytes, name, mime }).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaRef {
    id: String,
    mime: String,
    size: usize,
}

/// Vidéo ou musique : estimation du prix, mise en file, puis suivi jusqu'au résultat, enregistré
/// localement (chiffré si le chiffrement est actif). `on_progress` reçoit les étapes.
#[tauri::command]
async fn generate_media(
    app: AppHandle,
    streams: State<'_, Streams>,
    request_id: String,
    kind: String,
    request: serde_json::Value,
    on_progress: Channel<serde_json::Value>,
) -> CmdResult<MediaRef> {
    let settings = storage::load_settings(&app)?;
    let key = api_key()?;
    let base = settings.base_url.as_str();
    let kind = if kind == "video" { venice::JobKind::Video } else { venice::JobKind::Audio };
    let model = request["model"].as_str().ok_or("Modèle manquant")?.to_owned();
    let cancel = Arc::new(Notify::new());
    streams.0.lock().unwrap().insert(request_id.clone(), cancel.clone());
    let result = async {
        if let Some(q) = venice::quote(base, &key, kind, &request).await {
            let _ = on_progress.send(serde_json::json!({ "stage": "quote", "quote": q }));
        }
        let queue_id = venice::queue(base, &key, kind, &request).await?;
        let _ = on_progress.send(serde_json::json!({ "stage": "queued" }));
        let started = std::time::Instant::now();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(4)) => {}
                _ = cancel.notified() => return Err("Annulé (la génération peut se terminer chez Venice et être facturée)".to_string()),
            }
            if started.elapsed() > std::time::Duration::from_secs(45 * 60) {
                return Err("Délai dépassé (45 min)".into());
            }
            match venice::retrieve(base, &key, kind, &model, &queue_id).await? {
                venice::Poll::Processing { average, elapsed } => {
                    let _ = on_progress.send(serde_json::json!({ "stage": "processing", "average": average, "elapsed": elapsed }));
                }
                venice::Poll::Done { bytes, mime } => {
                    let size = bytes.len();
                    let id = storage::save_media(&app, &bytes)?;
                    return Ok(MediaRef { id, mime, size });
                }
            }
        }
    }
    .await;
    streams.0.lock().unwrap().remove(&request_id);
    result
}

/// Contenu d'un média enregistré (base64), pour la lecture dans l'application.
#[tauri::command]
async fn media_read(app: AppHandle, id: String) -> CmdResult<String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || storage::read_media(&app, &id)).await.map_err(|e| e.to_string())??;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Enregistre un média (déchiffré) via la boîte « Enregistrer sous ».
#[tauri::command]
async fn media_export(app: AppHandle, id: String, name: String, ext: String) -> CmdResult<bool> {
    let bytes = storage::read_media(&app, &id)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let ext: String = ext.chars().filter(char::is_ascii_alphanumeric).take(5).collect();
    app.dialog().file().add_filter("Média", &[ext.as_str()]).set_file_name(format!("{name}.{ext}")).save_file(move |p| {
        let _ = tx.send(p);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(false) };
    std::fs::write(path.into_path().map_err(|e| e.to_string())?, bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn list_characters(app: AppHandle, search: String) -> CmdResult<Vec<venice::Character>> {
    let settings = storage::load_settings(&app)?;
    venice::characters(&settings.base_url, &api_key()?, &search).await
}

#[tauri::command]
async fn account_balance(app: AppHandle) -> CmdResult<serde_json::Value> {
    let settings = storage::load_settings(&app)?;
    venice::balance(&settings.base_url, &api_key()?).await
}

// ------------------------------------------------------------------ MCP

#[tauri::command]
fn mcp_get_config(app: AppHandle) -> String {
    storage::load_mcp_config(&app)
}

#[tauri::command]
async fn mcp_save_config(app: AppHandle, mcp: State<'_, Arc<McpManager>>, text: String) -> CmdResult<()> {
    let cfg = mcp::parse_config(&text)?;
    storage::save_mcp_config(&app, &text)?;
    mcp.inner().restart(cfg).await;
    Ok(())
}

#[tauri::command]
async fn mcp_restart(app: AppHandle, mcp: State<'_, Arc<McpManager>>) -> CmdResult<()> {
    let cfg = mcp::parse_config(&storage::load_mcp_config(&app))?;
    mcp.inner().restart(cfg).await;
    Ok(())
}

#[tauri::command]
fn mcp_status(mcp: State<'_, Arc<McpManager>>) -> Vec<ServerStatus> {
    mcp.status()
}

#[tauri::command]
fn platform_info(app: AppHandle) -> serde_json::Value {
    let settings = storage::load_settings(&app).unwrap_or_default();
    let sh = shell::detect(&settings.shell);
    serde_json::json!({
        "os": std::env::consts::OS,
        "shell": sh.name,
        "shellPath": sh.program.display().to_string(),
        "shellGuidance": shell::guidance(&sh),
        "version": env!("CARGO_PKG_VERSION"),
        // API Venice (images, voix, recherche intégrée) ou serveur compatible OpenAI.
        "venice": venice::is_venice(&settings.base_url),
        "nativeSearch": tools::native_web_search(&settings),
    })
}

#[tauri::command]
fn record_usage(app: AppHandle, day: String, model: String, prompt_tokens: u64, completion_tokens: u64) -> CmdResult<()> {
    storage::record_usage(&app, &day, &model, prompt_tokens, completion_tokens)
}

#[tauri::command]
fn get_usage(app: AppHandle) -> storage::UsageLog {
    storage::load_usage(&app)
}

#[tauri::command]
async fn check_update() -> CmdResult<updates::UpdateInfo> {
    updates::check().await
}

/// Clé publique de signature des mises à jour, fournie au moment de la compilation (CI).
fn updater_pubkey() -> Option<&'static str> {
    option_env!("TAURI_UPDATER_PUBKEY").map(str::trim).filter(|k| !k.is_empty())
}

/// Installation automatique possible ? (build signé ; sous Linux, seulement l'AppImage :
/// les paquets .deb/.rpm se mettent à jour avec le gestionnaire de paquets).
#[tauri::command]
fn updater_supported() -> bool {
    updater_pubkey().is_some() && (!cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some())
}

/// Télécharge la mise à jour, vérifie sa signature, l'installe puis redémarre l'application.
#[tauri::command]
async fn install_update(app: AppHandle, on_progress: Channel<serde_json::Value>) -> CmdResult<()> {
    use tauri_plugin_updater::UpdaterExt;
    if !updater_supported() {
        return Err("Installation automatique indisponible pour ce type d'installation".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Vérification impossible : {e}"))?
        .ok_or("Aucune mise à jour disponible")?;
    let mut done: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                let _ = on_progress.send(serde_json::json!({ "done": done, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|e| format!("Installation impossible : {e}"))?;
    app.restart()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Mode askpass : l'exécutable relaie une invite SSH à l'application (voir `askpass`).
pub fn askpass_main() -> Option<i32> {
    askpass::client_main()
}

pub fn run() {
    #[cfg(unix)]
    mcp::fix_path_env();

    let mut builder = tauri::Builder::default();
    if let Some(pubkey) = updater_pubkey() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(pubkey).build());
    }
    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        summon(app);
                    }
                })
                .build(),
        )
        .manage(Streams::default())
        .manage(E2eeSessions::default())
        .manage(Dictation::default())
        .manage(Arc::new(McpManager::default()))
        .setup(|app| {
            // Chiffrement des données locales : activé avant tout accès aux conversations,
            // puis conversion des fichiers existants (synchrone, pour éviter toute course).
            if storage::load_settings(app.handle()).map(|s| s.encrypt_data).unwrap_or(false) {
                match enable_encryption(app.handle()) {
                    Ok(n) if n > 0 => eprintln!("chiffrement : {n} fichier(s) converti(s)"),
                    Ok(_) => {}
                    Err(e) => *vault::LAST_ERROR.lock().unwrap() = Some(e),
                }
            }
            askpass::start(app.handle().clone());
            if let Err(e) = storage::load_settings(app.handle()).and_then(|s| apply_shortcut(app.handle(), &s.global_shortcut)) {
                eprintln!("{e}");
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mgr = handle.state::<Arc<McpManager>>().inner().clone();
                match mcp::parse_config(&storage::load_mcp_config(&handle)) {
                    Ok(cfg) => mgr.restart(cfg).await,
                    Err(e) => eprintln!("mcp.json invalide : {e}"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_key_status,
            vault_status,
            vault_export_key,
            vault_import_key,
            set_api_key,
            delete_api_key,
            get_settings,
            save_settings,
            list_models,
            list_conversations,
            load_conversation,
            save_conversation,
            delete_conversation,
            search_conversations,
            export_conversation,
            data_dir,
            chat_stream,
            export_backup,
            import_backup,
            cancel_stream,
            tool_definitions,
            preview_tool,
            tool_outside,
            run_tool,
            pick_workspace,
            list_workspaces,
            forget_workspace,
            touch_workspace,
            process_document,
            generate_image,
            save_image,
            speak,
            account_balance,
            list_characters,
            transcribe_file,
            clone_voice,
            generate_media,
            media_read,
            media_export,
            transform_image,
            list_gallery,
            mcp_get_config,
            mcp_save_config,
            mcp_restart,
            mcp_status,
            platform_info,
            record_usage,
            get_usage,
            check_update,
            updater_supported,
            install_update,
            ssh_hosts,
            ssh_save_host,
            ssh_delete_host,
            ssh_test,
            ssh_trust,
            ssh_list_dirs,
            ssh_open_workspace,
            ssh_set_password,
            ssh_prompt_answer,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_sync,
            git_branches,
            git_checkout,
            git_log,
            git_init,
            workspace_instructions,
            list_projects,
            save_project,
            delete_project,
            project_context,
            dictation_start,
            dictation_stop,
        ])
        .build(tauri::generate_context!())
        .expect("erreur au lancement de l'application");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Arrêt propre des serveurs MCP (processus enfants).
            let mgr = handle.state::<Arc<McpManager>>().inner().clone();
            tauri::async_runtime::block_on(mgr.shutdown());
        }
    });
}

#[cfg(test)]
mod tests {
    /// PDF minimal d'une page contenant `text` (police standard Helvetica).
    pub fn tiny_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 11 Tf 40 760 Td ({text}) Tj ET");
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_string(),
        ];
        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (i, o) in objs.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{o}\nendobj\n", i + 1));
        }
        let xref = out.len();
        out.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1));
        for o in offsets {
            out.push_str(&format!("{o:010} 00000 n \n"));
        }
        out.push_str(&format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1));
        out.into_bytes()
    }

    #[test]
    fn local_pdf_extraction() {
        let (text, pages) = super::extract_pdf_local(tiny_pdf("Rapport annuel 2026")).unwrap();
        assert!(text.contains("Rapport annuel 2026"), "{text:?}");
        assert_eq!(pages, 1);
    }
}
