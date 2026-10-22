//! Client minimal pour l'API Venice.ai (compatible OpenAI, donc aussi avec les serveurs
//! « OpenAI-like » auto-hébergés : vLLM, Ollama, llama.cpp…).

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::sync::Notify;

pub const DEFAULT_BASE_URL: &str = "https://api.venice.ai/api/v1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
    /// Appels d'outils d'un message assistant : `[{id, name, arguments}]`.
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    /// Pour un message `tool` : l'appel auquel il répond.
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// JSON encodé en chaîne, tel que renvoyé par le modèle.
    pub arguments: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    /// Définitions d'outils au format OpenAI (`[{type: "function", function: {...}}]`).
    #[serde(default)]
    pub tools: Vec<Value>,
    /// « auto » par défaut ; « none » pour interdire les appels (résumé de contexte).
    pub tool_choice: Option<String>,
    /// Recherche web intégrée de Venice demandée pour cette requête.
    #[serde(default)]
    pub web_search: bool,
    /// Effort de raisonnement (« low », « high »…) ; « off » désactive la réflexion.
    pub reasoning_effort: Option<String>,
    /// Personnage public de Venice (`character_slug`).
    pub character_slug: Option<String>,
}

/// Options propres à Venice (`venice_parameters`), tirées des réglages.
pub struct VeniceOptions<'a> {
    /// « auto » ou « on » : recherche web intégrée (si `ChatRequest::web_search`).
    pub web_search_mode: &'a str,
    /// Ajouter l'invite système de Venice à la nôtre.
    pub include_system_prompt: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Citation {
    pub title: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Delta { text: String },
    Reasoning { text: String },
    #[serde(rename_all = "camelCase")]
    Usage { prompt_tokens: u64, completion_tokens: u64 },
    ToolCalls { calls: Vec<ToolCall> },
    /// Sources de la recherche web intégrée (premier morceau du flux).
    Citations { items: Vec<Citation> },
    /// Nouvel essai après une erreur temporaire (429, 5xx, réseau).
    #[serde(rename_all = "camelCase")]
    Retry { attempt: u32, max_attempts: u32, delay_secs: u64, reason: String },
    #[serde(rename_all = "camelCase")]
    Done { finish_reason: Option<String>, cancelled: bool },
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub vision: bool,
    /// Appels d'outils (agent de code, MCP, recherche par outil).
    pub tools: bool,
    pub reasoning: bool,
    /// Niveaux d'effort de raisonnement acceptés (vide = non réglable).
    pub reasoning_efforts: Vec<String>,
    pub default_effort: Option<String>,
    /// Chiffrement de bout en bout possible (TEE attesté).
    pub e2ee: bool,
    pub code: bool,
    pub max_context_length: Option<u64>,
    /// « private » (aucune conservation chez Venice) ou « anonymized » (fournisseur tiers).
    pub privacy: Option<String>,
    pub uncensored: bool,
    pub beta: bool,
    /// Rôles attribués par Venice : « default », « fastest », « default_code »…
    pub traits: Vec<String>,
    /// $ par million de tokens [entrée, sortie].
    pub price: Option<[f64; 2]>,
    /// Modèles d'image : contraintes (formats, résolutions, longueur du prompt…), telles quelles.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<Value>,
    /// Modèles d'image : prix d'une génération en $.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_price: Option<f64>,
    /// Modèles vidéo, musique, voix : spécification brute (durées, voix, formats…).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec: Option<Value>,
}

/// Délai max avant les en-têtes de réponse, puis entre deux morceaux du flux.
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(180);
const STALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ATTEMPTS: u32 = 5;

fn is_retryable(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504 | 529)
}

pub fn validate_base_url(url: &str) -> Result<(), String> {
    let u = reqwest::Url::parse(url).map_err(|e| format!("URL invalide : {e}"))?;
    match u.scheme() {
        "https" => Ok(()),
        // HTTP en clair toléré uniquement pour un serveur local.
        "http" if matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) => Ok(()),
        _ => Err("L'URL doit être en HTTPS (HTTP accepté seulement pour localhost)".into()),
    }
}

/// L'API officielle de Venice (paramètres `venice_parameters`, recherche, images, voix…).
pub fn is_venice(base: &str) -> bool {
    let Some(host) = reqwest::Url::parse(base).ok().and_then(|u| u.host_str().map(str::to_owned)) else { return false };
    // Tests de bout en bout (builds de développement uniquement) : faux serveur Venice local.
    #[cfg(debug_assertions)]
    if std::env::var("VENICE_DESKTOP_E2E_HOST").is_ok_and(|h| h == host) {
        return true;
    }
    host == "venice.ai" || host.ends_with(".venice.ai")
}

/// `base` contient le préfixe de version (`…/api/v1`, `…/v1`) ; à défaut, on ajoute `/v1`.
fn endpoint(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let has_path = reqwest::Url::parse(base).map(|u| !u.path().trim_matches('/').is_empty()).unwrap_or(true);
    if has_path {
        format!("{base}/{path}")
    } else {
        format!("{base}/v1/{path}")
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("venice-desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

async fn api_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("error"))
                .or_else(|| v.get("message"))
                .or_else(|| v.get("detail"))
                .map(|m| m.as_str().map(str::to_owned).unwrap_or_else(|| m.to_string()))
        })
        .unwrap_or(body);
    match status.as_u16() {
        401 => format!("Clé API refusée (401). Vérifiez-la dans les réglages. {detail}"),
        402 => format!("Solde insuffisant (402) : rechargez votre compte Venice. {detail}"),
        429 => format!("Limite de requêtes atteinte (429). {detail}"),
        _ => format!("Erreur API {status} : {detail}"),
    }
}

fn price(v: &Value) -> Option<f64> {
    v["usd"].as_f64()
}

fn model_info(m: &Value) -> Option<ModelInfo> {
    let spec = &m["model_spec"];
    let caps = &spec["capabilities"];
    // Capacités inconnues (serveur tiers) ; un modèle d'image n'a ni vision ni outils.
    let known = caps.is_object() || m["type"].as_str().is_some_and(|t| t != "text");
    Some(ModelInfo {
        id: m["id"].as_str()?.to_owned(),
        name: spec["name"].as_str().map(str::to_owned),
        description: spec["description"].as_str().map(str::to_owned),
        // Inconnu (serveur tiers) => on n'empêche ni les images ni les outils.
        vision: caps["supportsVision"].as_bool().unwrap_or(!known),
        tools: caps["supportsFunctionCalling"].as_bool().unwrap_or(!known),
        reasoning: caps["supportsReasoning"].as_bool().unwrap_or(false),
        reasoning_efforts: if caps["supportsReasoningEffort"].as_bool().unwrap_or(false) {
            caps["reasoningEffortOptions"].as_array().into_iter().flatten().filter_map(|e| e.as_str().map(str::to_owned)).collect()
        } else {
            Vec::new()
        },
        default_effort: caps["defaultReasoningEffort"].as_str().map(str::to_owned),
        e2ee: caps["supportsE2EE"].as_bool().unwrap_or(false),
        code: caps["optimizedForCode"].as_bool().unwrap_or(false),
        max_context_length: spec["availableContextTokens"].as_u64().or_else(|| m["context_length"].as_u64()),
        privacy: spec["privacy"].as_str().map(str::to_owned),
        uncensored: spec["uncensored"].as_bool().unwrap_or(false)
            || spec["traits"].as_array().into_iter().flatten().any(|t| t.as_str().is_some_and(|t| t.contains("uncensored"))),
        beta: spec["beta"].as_bool().unwrap_or(false) || spec["betaModel"].as_bool().unwrap_or(false),
        traits: spec["traits"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(str::to_owned)).collect(),
        price: price(&spec["pricing"]["input"]).zip(price(&spec["pricing"]["output"])).map(|(i, o)| [i, o]),
        constraints: spec.get("constraints").filter(|c| c.is_object()).cloned(),
        image_price: price(&spec["pricing"]["generation"]),
        spec: (m["type"].as_str().is_some_and(|t| t != "text" && t != "image") && spec.is_object()).then(|| spec.clone()),
    })
}

/// Modèles de texte (`kind` = « text ») ou d'image (« image »).
pub async fn list_models(base: &str, key: &str, kind: &str) -> Result<Vec<ModelInfo>, String> {
    let mut req = client()?.get(endpoint(base, "models")).bearer_auth(key).timeout(Duration::from_secs(30));
    if is_venice(base) {
        req = req.query(&[("type", kind)]);
    } else if kind != "text" {
        return Ok(Vec::new());
    }
    let resp = req.send().await.map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut models: Vec<ModelInfo> = body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["type"].as_str().is_none_or(|t| t == kind))
        .filter(|m| !m["model_spec"]["offline"].as_bool().unwrap_or(false))
        .filter_map(model_info)
        .collect();
    models.sort_by(|a, b| {
        let rank = |m: &ModelInfo| if m.traits.iter().any(|t| t == "default") { 0 } else { 1 };
        rank(a).cmp(&rank(b)).then(a.id.cmp(&b.id))
    });
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

fn to_api_message(m: &ChatMessage) -> Value {
    if m.role == "tool" {
        return json!({
            "role": "tool",
            "content": m.content,
            "tool_call_id": m.tool_call_id,
            "name": m.name,
        });
    }
    if !m.tool_calls.is_empty() {
        let calls: Vec<Value> = m
            .tool_calls
            .iter()
            .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.arguments } }))
            .collect();
        return json!({ "role": "assistant", "content": m.content, "tool_calls": calls });
    }
    if m.images.is_empty() {
        return json!({ "role": m.role, "content": m.content });
    }
    let mut parts = Vec::new();
    // Venice refuse un bloc texte vide.
    if !m.content.is_empty() {
        parts.push(json!({ "type": "text", "text": m.content }));
    }
    parts.extend(
        m.images
            .iter()
            .map(|url| json!({ "type": "image_url", "image_url": { "url": url } })),
    );
    json!({ "role": m.role, "content": parts })
}

pub fn build_body(req: &ChatRequest, base: &str, opts: &VeniceOptions) -> Value {
    let mut body = json!({
        "model": req.model,
        "messages": req.messages.iter().map(to_api_message).collect::<Vec<_>>(),
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = req.max_tokens.filter(|m| *m > 0) {
        body["max_tokens"] = json!(m);
    }
    if !req.tools.is_empty() {
        body["tools"] = json!(req.tools);
        body["tool_choice"] = json!(req.tool_choice.as_deref().unwrap_or("auto"));
    }
    if is_venice(base) {
        let web = req.web_search && req.tool_choice.as_deref() != Some("none");
        body["venice_parameters"] = json!({
            "include_venice_system_prompt": opts.include_system_prompt,
            "enable_web_search": if web { opts.web_search_mode } else { "off" },
            "enable_web_citations": web,
        });
        if req.reasoning_effort.as_deref() == Some("off") {
            body["venice_parameters"]["disable_thinking"] = json!(true);
        }
        if let Some(slug) = req.character_slug.as_deref().filter(|s| !s.is_empty()) {
            body["venice_parameters"]["character_slug"] = json!(slug);
        }
    }
    if let Some(effort) = req.reasoning_effort.as_deref().filter(|e| !e.is_empty() && *e != "off") {
        body["reasoning_effort"] = json!(effort);
    }
    body
}

/// Sépare le raisonnement `<think>…</think>` du texte, morceau par morceau
/// (les balises peuvent être coupées entre deux morceaux du flux).
#[derive(Default)]
struct ThinkSplitter {
    in_think: bool,
    pending: String,
    /// Le texte a commencé : une balise `<think>` n'est reconnue qu'en tête de réponse.
    started: bool,
}

impl ThinkSplitter {
    /// Renvoie (texte, raisonnement).
    fn push(&mut self, chunk: &str) -> (String, String) {
        const OPEN: &str = "<think>";
        const CLOSE: &str = "</think>";
        self.pending.push_str(chunk);
        let (mut text, mut think) = (String::new(), String::new());
        loop {
            if self.started && !self.in_think {
                text.push_str(&std::mem::take(&mut self.pending));
                break;
            }
            if self.in_think {
                if let Some(pos) = self.pending.find(CLOSE) {
                    think.push_str(&self.pending[..pos]);
                    // Les modèles insèrent souvent des sauts de ligne après </think>.
                    self.pending = self.pending[pos + CLOSE.len()..].trim_start().to_string();
                    self.in_think = false;
                    self.started = true;
                    continue;
                }
                // Fin éventuelle d'une balise coupée : on la garde pour le morceau suivant.
                let keep = (1..CLOSE.len()).rev().find(|&n| self.pending.ends_with(&CLOSE[..n])).unwrap_or(0);
                let cut = self.pending.len() - keep;
                think.extend(self.pending.drain(..cut));
                break;
            }
            let trimmed = self.pending.trim_start();
            if trimmed.starts_with(OPEN) {
                let end = self.pending.len() - trimmed.len() + OPEN.len();
                self.pending.drain(..end);
                self.in_think = true;
                continue;
            }
            if OPEN.starts_with(trimmed) {
                // Début possible d'une balise (ou espaces seulement) : on attend la suite.
                break;
            }
            self.started = true;
        }
        (text, think)
    }

    fn finish(&mut self) -> (String, String) {
        let rest = std::mem::take(&mut self.pending);
        if self.in_think { (String::new(), rest) } else { (rest, String::new()) }
    }
}

fn emit_text((text, think): (String, String), on_event: &Channel<StreamEvent>) {
    if !think.is_empty() {
        let _ = on_event.send(StreamEvent::Reasoning { text: think });
    }
    if !text.is_empty() {
        let _ = on_event.send(StreamEvent::Delta { text });
    }
}

/// `delta.content` est une chaîne, ou (certains serveurs) une liste de blocs `text` / `thinking`.
fn emit_content(content: &Value, splitter: &mut ThinkSplitter, on_event: &Channel<StreamEvent>) {
    match content {
        Value::String(s) if !s.is_empty() => {
            let out = splitter.push(s);
            emit_text(out, on_event);
        }
        Value::Array(chunks) => {
            for c in chunks {
                match c["type"].as_str() {
                    Some("text") => {
                        if let Some(t) = c["text"].as_str() {
                            let out = splitter.push(t);
                            emit_text(out, on_event);
                        }
                    }
                    Some("thinking") => {
                        let t = match &c["thinking"] {
                            Value::String(s) => s.clone(),
                            Value::Array(a) => a.iter().filter_map(|t| t["text"].as_str()).collect(),
                            _ => String::new(),
                        };
                        if !t.is_empty() {
                            let _ = on_event.send(StreamEvent::Reasoning { text: t });
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

pub fn citations(v: &Value) -> Vec<Citation> {
    v.pointer("/venice_parameters/web_search_citations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            Some(Citation {
                url: c["url"].as_str()?.to_owned(),
                title: c["title"].as_str().filter(|t| !t.is_empty()).or_else(|| c["url"].as_str())?.to_owned(),
                date: c["date"].as_str().filter(|d| !d.is_empty()).map(str::to_owned),
            })
        })
        .collect()
}

pub async fn chat_stream(
    base: &str,
    key: &str,
    req: ChatRequest,
    opts: &VeniceOptions<'_>,
    on_event: &Channel<StreamEvent>,
    cancel: Arc<Notify>,
) -> Result<(), String> {
    let body = build_body(&req, base, opts);
    let client = client()?;
    let mut attempt = 0;
    let resp = loop {
        attempt += 1;
        let send = client
            .post(endpoint(base, "chat/completions"))
            .bearer_auth(key)
            .header("Accept", "text/event-stream")
            .json(&body)
            .send();
        let outcome = tokio::select! {
            r = tokio::time::timeout(FIRST_BYTE_TIMEOUT, send) => r,
            _ = cancel.notified() => {
                let _ = on_event.send(StreamEvent::Done { finish_reason: None, cancelled: true });
                return Ok(());
            }
        };
        // Erreur temporaire : on réessaie avec une attente croissante.
        let (reason, retry_after) = match outcome {
            Ok(Ok(r)) if r.status().is_success() => break r,
            Ok(Ok(r)) if is_retryable(r.status()) && attempt < MAX_ATTEMPTS => {
                let ra = r
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse::<u64>().ok());
                let status = r.status();
                (if status.as_u16() == 429 { "limite de requêtes atteinte (429)".to_string() } else { format!("serveur indisponible ({status})") }, ra)
            }
            Ok(Ok(r)) => return Err(api_error(r).await),
            Ok(Err(e)) if attempt < MAX_ATTEMPTS && (e.is_connect() || e.is_timeout() || e.is_request()) => (format!("connexion impossible : {e}"), None),
            Ok(Err(e)) => return Err(format!("Connexion impossible : {e}")),
            Err(_) if attempt < MAX_ATTEMPTS => ("pas de réponse du serveur".to_string(), None),
            Err(_) => return Err(format!("Le serveur ne répond pas (délai de {} s dépassé)", FIRST_BYTE_TIMEOUT.as_secs())),
        };
        let delay = retry_after.unwrap_or(2u64.pow(attempt)).clamp(1, 60);
        let _ = on_event.send(StreamEvent::Retry { attempt, max_attempts: MAX_ATTEMPTS, delay_secs: delay, reason });
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
            _ = cancel.notified() => {
                let _ = on_event.send(StreamEvent::Done { finish_reason: None, cancelled: true });
                return Ok(());
            }
        }
    };

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut finish_reason: Option<String> = None;
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut splitter = ThinkSplitter::default();
    let mut cited = false;
    let flush = |calls: &mut Vec<ToolCall>, splitter: &mut ThinkSplitter| {
        let rest = splitter.finish();
        emit_text(rest, on_event);
        if !calls.is_empty() {
            for c in calls.iter_mut() {
                if c.id.is_empty() {
                    c.id = format!("call_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
                }
                if c.arguments.trim().is_empty() {
                    c.arguments = "{}".into();
                }
            }
            let _ = on_event.send(StreamEvent::ToolCalls { calls: std::mem::take(calls) });
        }
    };

    loop {
        let chunk = tokio::select! {
            c = tokio::time::timeout(STALL_TIMEOUT, stream.next()) => c.map_err(|_| {
                format!("Le flux s'est interrompu : aucune donnée reçue depuis {} s. Cliquez sur « Continuer » pour reprendre.", STALL_TIMEOUT.as_secs())
            })?,
            _ = cancel.notified() => {
                let _ = on_event.send(StreamEvent::Done { finish_reason: None, cancelled: true });
                return Ok(());
            }
        };
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk.map_err(|e| format!("Flux interrompu : {e}"))?);

        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                flush(&mut calls, &mut splitter);
                let _ = on_event.send(StreamEvent::Done { finish_reason, cancelled: false });
                return Ok(());
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                return Err(format!("Erreur API : {}", err["message"].as_str().or(err.as_str()).unwrap_or(&err.to_string())));
            }
            if !cited {
                let items = citations(&v);
                if !items.is_empty() {
                    cited = true;
                    let _ = on_event.send(StreamEvent::Citations { items });
                }
            }
            let choice = &v["choices"][0];
            let delta = &choice["delta"];
            for key in ["reasoning_content", "reasoning"] {
                if let Some(r) = delta[key].as_str().filter(|r| !r.is_empty()) {
                    let _ = on_event.send(StreamEvent::Reasoning { text: r.to_owned() });
                    break;
                }
            }
            emit_content(&delta["content"], &mut splitter, on_event);
            for (pos, tc) in delta["tool_calls"].as_array().into_iter().flatten().enumerate() {
                let idx = tc["index"].as_u64().map(|i| i as usize).unwrap_or(pos);
                if calls.len() <= idx {
                    calls.resize_with(idx + 1, ToolCall::default);
                }
                let c = &mut calls[idx];
                if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty() && *s != "null") {
                    c.id = id.to_owned();
                }
                if let Some(n) = tc["function"]["name"].as_str() {
                    c.name.push_str(n);
                }
                match &tc["function"]["arguments"] {
                    Value::String(a) => c.arguments.push_str(a),
                    Value::Null => {}
                    other => c.arguments.push_str(&other.to_string()),
                }
            }
            if let Some(fr) = choice["finish_reason"].as_str() {
                finish_reason = Some(fr.to_owned());
            }
            if let (Some(p), Some(c)) = (
                v["usage"]["prompt_tokens"].as_u64(),
                v["usage"]["completion_tokens"].as_u64(),
            ) {
                let _ = on_event.send(StreamEvent::Usage { prompt_tokens: p, completion_tokens: c });
            }
        }
    }

    flush(&mut calls, &mut splitter);
    let _ = on_event.send(StreamEvent::Done { finish_reason, cancelled: false });
    Ok(())
}

/// Recherche web directe (`/augment/search`) : Brave avec conservation zéro, ou Google anonymisé.
pub async fn web_search(base: &str, key: &str, provider: &str, query: &str) -> Result<String, String> {
    if !is_venice(base) {
        return Err("La recherche web de Venice nécessite l'API Venice : choisissez SearXNG dans Réglages → Outils.".into());
    }
    let resp = client()?
        .post(endpoint(base, "augment/search"))
        .bearer_auth(key)
        .json(&json!({ "query": query, "limit": 8, "search_provider": provider }))
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut out = String::new();
    for (i, r) in v["results"].as_array().into_iter().flatten().enumerate() {
        let date = r["date"].as_str().filter(|d| !d.is_empty()).map(|d| format!(" ({d})")).unwrap_or_default();
        out.push_str(&format!(
            "[{}] {}{date}\n{}\n{}\n\n",
            i + 1,
            r["title"].as_str().unwrap_or_default(),
            r["url"].as_str().unwrap_or_default(),
            r["content"].as_str().unwrap_or_default().trim()
        ));
    }
    if out.is_empty() {
        return Err("La recherche web n'a renvoyé aucun résultat".into());
    }
    Ok(out)
}

/// Transcription audio (Venice, ou tout serveur compatible `/v1/audio/transcriptions`).
/// Modèle par défaut (Parakeet, multilingue) et repli (Whisper) si le premier est refusé.
pub const TRANSCRIBE_MODEL: &str = "nvidia/parakeet-tdt-0.6b-v3";
pub const TRANSCRIBE_FALLBACK: &str = "openai/whisper-large-v3";

/// Erreur liée au nom du modèle (inconnu, non disponible pour ce compte…).
pub fn is_model_error(e: &str) -> bool {
    let l = e.to_lowercase();
    (l.contains("erreur api 400") || l.contains("erreur api 404") || l.contains("erreur api 422")) && l.contains("model")
}

/// Fichier audio à transcrire : contenu, nom et type MIME.
pub struct AudioFile {
    pub bytes: Vec<u8>,
    pub name: String,
    pub mime: String,
}

impl AudioFile {
    pub fn wav(bytes: Vec<u8>) -> Self {
        Self { bytes, name: "dictee.wav".into(), mime: "audio/wav".into() }
    }
}

/// `prompt` : vocabulaire à favoriser (Whisper et serveurs compatibles ; ignoré sinon).
/// `timestamps` : texte découpé en segments horodatés « [mm:ss] … ».
pub async fn transcribe(base: &str, key: &str, model: &str, language: &str, prompt: &str, file: AudioFile, timestamps: bool) -> Result<String, String> {
    let part = reqwest::multipart::Part::bytes(file.bytes)
        .file_name(file.name)
        .mime_str(&file.mime)
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_owned())
        .text("response_format", "json")
        .part("file", part);
    if !language.is_empty() {
        form = form.text("language", language.to_owned());
    }
    if !prompt.is_empty() {
        form = form.text("prompt", prompt.to_owned());
    }
    if timestamps {
        form = form.text("timestamps", "true");
    }
    let mut req = client()?.post(endpoint(base, "audio/transcriptions")).multipart(form).timeout(Duration::from_secs(900));
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    if timestamps {
        if let Some(text) = timestamped(&v) {
            return Ok(text);
        }
    }
    v["text"].as_str().map(|t| t.trim().to_owned()).ok_or_else(|| "Réponse de transcription invalide".into())
}

/// Segments horodatés d'une transcription (`timestamps.segment` de Venice, `segments` de Whisper).
fn timestamped(v: &Value) -> Option<String> {
    let segs = v.pointer("/timestamps/segment").or_else(|| v.get("segments"))?.as_array()?;
    let lines: Vec<String> = segs
        .iter()
        .filter_map(|s| {
            let t = s["start"].as_f64()? as u64;
            let text = s["text"].as_str()?.trim();
            (!text.is_empty()).then(|| format!("[{:02}:{:02}] {text}", t / 60, t % 60))
        })
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// Clone une voix à partir d'un échantillon : renvoie l'identifiant (`vv_…`) à utiliser avec `model`.
pub async fn clone_voice(base: &str, key: &str, model: &str, file: AudioFile) -> Result<String, String> {
    if !is_venice(base) {
        return Err("Le clonage de voix nécessite l'API Venice.".into());
    }
    let part = reqwest::multipart::Part::bytes(file.bytes).file_name(file.name).mime_str(&file.mime).map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().text("model", model.to_owned()).part("file", part);
    let resp = client()?
        .post(endpoint(base, "audio/voices"))
        .bearer_auth(key)
        .multipart(form)
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    v["id"].as_str().map(str::to_owned).ok_or_else(|| "Réponse de clonage invalide".into())
}

/// Générations longues en file d'attente : vidéo (`video/…`) ou audio/musique (`audio/…`).
#[derive(Clone, Copy)]
pub enum JobKind {
    Video,
    Audio,
}

impl JobKind {
    fn prefix(self) -> &'static str {
        match self {
            JobKind::Video => "video",
            JobKind::Audio => "audio",
        }
    }
}

pub enum Poll {
    Processing { average: f64, elapsed: f64 },
    Done { bytes: Vec<u8>, mime: String },
}

/// Prix estimé en $ (None si l'API ne sait pas l'estimer).
pub async fn quote(base: &str, key: &str, kind: JobKind, body: &Value) -> Option<f64> {
    let resp = client().ok()?.post(endpoint(base, &format!("{}/quote", kind.prefix()))).bearer_auth(key).json(body).timeout(Duration::from_secs(30)).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Value>().await.ok()?["quote"].as_f64()
}

pub async fn queue(base: &str, key: &str, kind: JobKind, body: &Value) -> Result<String, String> {
    if !is_venice(base) {
        return Err("Les générations vidéo et audio nécessitent l'API Venice.".into());
    }
    let resp = client()?
        .post(endpoint(base, &format!("{}/queue", kind.prefix())))
        .bearer_auth(key)
        .json(body)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    v["queue_id"].as_str().map(str::to_owned).ok_or_else(|| "Réponse de mise en file invalide".into())
}

/// État d'une génération ; le média est supprimé des serveurs de Venice une fois récupéré.
pub async fn retrieve(base: &str, key: &str, kind: JobKind, model: &str, queue_id: &str) -> Result<Poll, String> {
    let resp = client()?
        .post(endpoint(base, &format!("{}/retrieve", kind.prefix())))
        .bearer_auth(key)
        .json(&json!({ "model": model, "queue_id": queue_id, "delete_media_on_completion": true }))
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let mime = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    if mime.starts_with("application/json") {
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        return match v["status"].as_str() {
            Some("PROCESSING") | Some("QUEUED") | None => Ok(Poll::Processing {
                average: v["average_execution_time"].as_f64().unwrap_or(0.0),
                elapsed: v["execution_duration"].as_f64().unwrap_or(0.0),
            }),
            Some(other) => Err(format!("Génération en échec ({other})")),
        };
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    Ok(Poll::Done { bytes, mime: if mime.is_empty() { "application/octet-stream".into() } else { mime } })
}

/// Synthèse vocale : renvoie l'audio MP3.
pub async fn speech(base: &str, key: &str, model: &str, voice: &str, speed: f32, text: &str) -> Result<Vec<u8>, String> {
    let mut body = json!({ "model": model, "input": text, "response_format": "mp3", "speed": speed.clamp(0.25, 4.0) });
    if !voice.is_empty() {
        body["voice"] = json!(voice);
    }
    let resp = client()?
        .post(endpoint(base, "audio/speech"))
        .bearer_auth(key)
        .json(&body)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    Ok(resp.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRequest {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    /// Modèles à format imposé (« 16:9 »…) ; sinon `width` × `height`.
    pub aspect_ratio: Option<String>,
    pub resolution: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub variants: Option<u32>,
    pub seed: Option<u64>,
    #[serde(default = "yes")]
    pub safe_mode: bool,
    #[serde(default = "yes")]
    pub hide_watermark: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResult {
    /// Images en data URL (WebP).
    pub images: Vec<String>,
    /// L'image a été floutée par le filtre de contenu (mode sûr).
    pub blurred: bool,
    pub seconds: Option<f64>,
}

pub fn image_body(r: &ImageRequest) -> Value {
    let mut body = json!({
        "model": r.model,
        "prompt": r.prompt,
        "format": "webp",
        "safe_mode": r.safe_mode,
        "hide_watermark": r.hide_watermark,
    });
    if !r.negative_prompt.trim().is_empty() {
        body["negative_prompt"] = json!(r.negative_prompt.trim());
    }
    if let Some(a) = &r.aspect_ratio {
        body["aspect_ratio"] = json!(a);
    }
    if let Some(res) = &r.resolution {
        body["resolution"] = json!(res);
    }
    if let (Some(w), Some(h)) = (r.width, r.height) {
        body["width"] = json!(w);
        body["height"] = json!(h);
    }
    if let Some(n) = r.variants.filter(|n| *n > 1) {
        body["variants"] = json!(n.min(4));
    }
    if let Some(s) = r.seed {
        body["seed"] = json!(s);
    }
    body
}

pub async fn generate_image(base: &str, key: &str, r: &ImageRequest, cancel: Arc<Notify>) -> Result<ImageResult, String> {
    if !is_venice(base) {
        return Err("La génération d'images nécessite l'API Venice.".into());
    }
    let send = client()?
        .post(endpoint(base, "image/generate"))
        .bearer_auth(key)
        .json(&image_body(r))
        .timeout(Duration::from_secs(300))
        .send();
    let resp = tokio::select! {
        r = send => r.map_err(|e| format!("Connexion impossible : {e}"))?,
        _ = cancel.notified() => return Err("Annulé".into()),
    };
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let blurred = resp.headers().get("x-venice-is-blurred").and_then(|v| v.to_str().ok()) == Some("true");
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let images: Vec<String> = v["images"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|b64| if b64.starts_with("data:") { b64.to_owned() } else { format!("data:image/webp;base64,{b64}") })
        .collect();
    if images.is_empty() {
        let n = v["content_policy_violation_count"].as_u64().unwrap_or(0);
        return Err(if n > 0 { "Image refusée par la politique de contenu du fournisseur.".into() } else { "Aucune image renvoyée".into() });
    }
    Ok(ImageResult { images, blurred, seconds: v["timing"]["total"].as_f64().map(|ms| ms / 1000.0) })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub adult: bool,
    pub model_id: Option<String>,
}

/// Personnages publics de Venice (recherche par nom, description ou étiquette).
pub async fn characters(base: &str, key: &str, search: &str) -> Result<Vec<Character>, String> {
    if !is_venice(base) {
        return Err("Les personnages nécessitent l'API Venice".into());
    }
    let mut query = vec![("limit", "60".to_string()), ("sortBy", "imports".to_string())];
    if !search.trim().is_empty() {
        query.push(("search", search.trim().chars().take(200).collect()));
    }
    let resp = client()?
        .get(endpoint(base, "characters"))
        .bearer_auth(key)
        .query(&query)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            Some(Character {
                slug: c["slug"].as_str()?.to_owned(),
                name: c["name"].as_str().unwrap_or_default().to_owned(),
                description: c["description"].as_str().unwrap_or_default().chars().take(300).collect(),
                tags: c["tags"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(str::to_owned)).take(6).collect(),
                adult: c["adult"].as_bool().unwrap_or(false),
                model_id: c["modelId"].as_str().map(str::to_owned),
            })
        })
        .collect())
}

/// Base64 d'une data URL (ou de la chaîne telle quelle).
fn base64_of(data_url: &str) -> &str {
    data_url.split_once(',').map_or(data_url, |(_, b)| b)
}

/// Réponse binaire d'image → data URL, avec le type renvoyé par l'API.
async fn image_response(resp: reqwest::Response) -> Result<String, String> {
    use base64::Engine;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|m| m.starts_with("image/"))
        .unwrap_or("image/png")
        .to_owned();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// Retouches d'une image existante : agrandissement, détourage, modification par un texte.
pub enum ImageOp<'a> {
    Upscale { scale: u32 },
    RemoveBackground,
    Edit { model: &'a str, prompt: &'a str, safe_mode: bool },
}

pub async fn transform_image(base: &str, key: &str, data_url: &str, op: ImageOp<'_>, cancel: Arc<Notify>) -> Result<String, String> {
    if !is_venice(base) {
        return Err("Les retouches d'image nécessitent l'API Venice.".into());
    }
    let image = base64_of(data_url);
    let (path, body) = match op {
        ImageOp::Upscale { scale } => ("image/upscale", json!({ "image": image, "scale": if scale >= 4 { 4 } else { 2 } })),
        ImageOp::RemoveBackground => ("image/background-remove", json!({ "image": image })),
        ImageOp::Edit { model, prompt, safe_mode } => (
            "image/edit",
            json!({ "image": image, "prompt": prompt, "model": model, "safe_mode": safe_mode, "output_format": "png" }),
        ),
    };
    let send = client()?.post(endpoint(base, path)).bearer_auth(key).json(&body).timeout(Duration::from_secs(300)).send();
    let resp = tokio::select! {
        r = send => r.map_err(|e| format!("Connexion impossible : {e}"))?,
        _ = cancel.notified() => return Err("Annulé".into()),
    };
    image_response(resp).await
}

/// Solde du compte (USD, DIEM, crédits).
pub async fn balance(base: &str, key: &str) -> Result<Value, String> {
    if !is_venice(base) {
        return Err("Solde disponible uniquement avec l'API Venice".into());
    }
    let resp = client()?
        .get(endpoint(base, "billing/balance"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Connexion impossible : {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    resp.json().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_normalises_base() {
        assert_eq!(endpoint("https://api.venice.ai/api/v1", "models"), "https://api.venice.ai/api/v1/models");
        assert_eq!(endpoint("https://api.venice.ai/api/v1/", "models"), "https://api.venice.ai/api/v1/models");
        assert_eq!(endpoint("http://localhost:8000/v1", "models"), "http://localhost:8000/v1/models");
        assert_eq!(endpoint("http://localhost:11434", "models"), "http://localhost:11434/v1/models");
    }

    #[test]
    fn base_url_validation() {
        assert!(validate_base_url(DEFAULT_BASE_URL).is_ok());
        assert!(validate_base_url("http://localhost:11434").is_ok());
        assert!(validate_base_url("http://192.168.1.10:8000").is_err());
        assert!(validate_base_url("ftp://x").is_err());
        assert!(is_venice(DEFAULT_BASE_URL));
        assert!(!is_venice("https://venice.ai.example.org/v1"));
        assert!(!is_venice("http://localhost:8000"));
    }

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage { role: role.into(), content: content.into(), images: vec![], tool_calls: vec![], tool_call_id: None, name: None }
    }

    #[test]
    fn image_message_uses_content_parts() {
        let mut m = msg("user", "décris");
        m.images = vec!["data:image/png;base64,AAA".into()];
        let v = to_api_message(&m);
        assert_eq!(v["content"][0]["type"], "text");
        assert_eq!(v["content"][1]["image_url"]["url"], "data:image/png;base64,AAA");
        m.content.clear();
        assert_eq!(to_api_message(&m)["content"][0]["type"], "image_url");
    }

    #[test]
    fn tool_messages_round_trip() {
        let mut a = msg("assistant", "");
        a.tool_calls = vec![ToolCall { id: "call_1".into(), name: "read_file".into(), arguments: "{\"path\":\"a\"}".into() }];
        assert_eq!(to_api_message(&a)["tool_calls"][0]["function"]["name"], "read_file");
        let mut t = msg("tool", "ok");
        t.tool_call_id = Some("call_1".into());
        t.name = Some("read_file".into());
        assert_eq!(to_api_message(&t)["tool_call_id"], "call_1");
    }

    #[test]
    fn venice_parameters_only_for_venice() {
        let mut req = ChatRequest {
            model: "m".into(),
            messages: vec![msg("user", "salut")],
            temperature: None,
            max_tokens: Some(0),
            tools: vec![],
            tool_choice: None,
            web_search: true,
            reasoning_effort: None,
            character_slug: None,
        };
        let opts = VeniceOptions { web_search_mode: "auto", include_system_prompt: false };
        let b = build_body(&req, DEFAULT_BASE_URL, &opts);
        assert_eq!(b["venice_parameters"]["enable_web_search"], "auto");
        assert_eq!(b["venice_parameters"]["enable_web_citations"], true);
        assert_eq!(b["venice_parameters"]["include_venice_system_prompt"], false);
        assert_eq!(b["stream_options"]["include_usage"], true);
        assert!(b.get("max_tokens").is_none());
        assert!(build_body(&req, "http://localhost:8000/v1", &opts).get("venice_parameters").is_none());
        req.web_search = false;
        assert_eq!(build_body(&req, DEFAULT_BASE_URL, &opts)["venice_parameters"]["enable_web_search"], "off");
        // Effort de raisonnement, réflexion désactivée, personnage.
        req.reasoning_effort = Some("high".into());
        req.character_slug = Some("alan-watts".into());
        let b = build_body(&req, DEFAULT_BASE_URL, &opts);
        assert_eq!(b["reasoning_effort"], "high");
        assert_eq!(b["venice_parameters"]["character_slug"], "alan-watts");
        assert!(b["venice_parameters"].get("disable_thinking").is_none());
        req.reasoning_effort = Some("off".into());
        let b = build_body(&req, DEFAULT_BASE_URL, &opts);
        assert_eq!(b["venice_parameters"]["disable_thinking"], true);
        assert!(b.get("reasoning_effort").is_none());
        // Serveur tiers : l'effort passe (paramètre OpenAI), pas le reste.
        req.reasoning_effort = Some("low".into());
        assert_eq!(build_body(&req, "http://localhost:8000/v1", &opts)["reasoning_effort"], "low");
    }

    fn split(chunks: &[&str]) -> (String, String) {
        let mut s = ThinkSplitter::default();
        let (mut text, mut think) = (String::new(), String::new());
        for c in chunks {
            let (t, k) = s.push(c);
            text += &t;
            think += &k;
        }
        let (t, k) = s.finish();
        (text + &t, think + &k)
    }

    #[test]
    fn think_tags_are_split_across_chunks() {
        assert_eq!(split(&["<thi", "nk>je réfléchis", "</th", "ink>\n\nRéponse"]), ("Réponse".into(), "je réfléchis".into()));
        assert_eq!(split(&["Bonjour ", "<think> n'est pas", " un raisonnement ici"]), ("Bonjour <think> n'est pas un raisonnement ici".into(), String::new()));
        assert_eq!(split(&["a < b", " et c"]), ("a < b et c".into(), String::new()));
        assert_eq!(split(&["\n", "<think>x</think>y"]), ("y".into(), "x".into()));
    }

    #[test]
    fn citations_are_parsed() {
        let v = json!({ "venice_parameters": { "web_search_citations": [
            { "title": "Titre", "url": "https://a.example", "date": "2026-10-01", "content": "…" },
            { "title": "", "url": "https://b.example" },
            { "title": "sans url" }
        ] } });
        let c = citations(&v);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].date.as_deref(), Some("2026-10-01"));
        assert_eq!(c[1].title, "https://b.example");
    }

    #[test]
    fn models_are_parsed() {
        let m = json!({
            "id": "venice-uncensored-1-2", "type": "text", "context_length": 32000,
            "model_spec": {
                "name": "Venice Uncensored", "availableContextTokens": 32768, "privacy": "private",
                "traits": ["most_uncensored"],
                "capabilities": { "supportsVision": false, "supportsFunctionCalling": true, "optimizedForCode": false, "supportsReasoning": false },
                "pricing": { "input": { "usd": 0.2, "diem": 0.2 }, "output": { "usd": 0.9, "diem": 0.9 } }
            }
        });
        let i = model_info(&m).unwrap();
        assert_eq!(i.max_context_length, Some(32768));
        assert_eq!(i.price, Some([0.2, 0.9]));
        assert!(i.uncensored && i.tools && !i.vision);
        assert_eq!(i.privacy.as_deref(), Some("private"));
        // Serveur tiers sans métadonnées : rien n'est bloqué.
        let o = model_info(&json!({ "id": "llama3" })).unwrap();
        assert!(o.vision && o.tools && o.price.is_none());
        let img = model_info(&json!({ "id": "flux", "type": "image", "model_spec": { "pricing": { "generation": { "usd": 0.01 } } } })).unwrap();
        assert!(!img.vision && !img.tools);
        assert_eq!(img.image_price, Some(0.01));
    }

    #[test]
    fn transcript_segments_are_timestamped() {
        let v = json!({ "text": "a b", "timestamps": { "segment": [
            { "text": " Bonjour ", "start": 0.4, "end": 2.0 },
            { "text": "suite", "start": 75.2, "end": 77.0 }
        ] } });
        assert_eq!(timestamped(&v).unwrap(), "[00:00] Bonjour\n[01:15] suite");
        assert!(timestamped(&json!({ "text": "x" })).is_none());
    }

    #[test]
    fn data_url_payload() {
        assert_eq!(base64_of("data:image/webp;base64,QUJD"), "QUJD");
        assert_eq!(base64_of("QUJD"), "QUJD");
    }

    #[test]
    fn image_body_uses_model_format() {
        let r: ImageRequest = serde_json::from_value(json!({ "model": "flux", "prompt": "un chat", "width": 1024, "height": 768, "variants": 9 })).unwrap();
        let b = image_body(&r);
        assert_eq!(b["width"], 1024);
        assert_eq!(b["variants"], 4);
        assert_eq!(b["safe_mode"], true);
        assert!(b.get("aspect_ratio").is_none());
    }
}
