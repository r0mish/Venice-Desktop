import { Channel, invoke } from "@tauri-apps/api/core";

export interface Settings {
  baseUrl: string;
  /** Vide = modèle par défaut désigné par Venice. */
  defaultModel: string;
  /** Ancien champ (instruction unique), migré dans systemPrompts. */
  systemPrompt: string;
  /** Instructions système enregistrées, au choix par conversation. */
  systemPrompts: SystemPromptPreset[];
  /** Instructions des nouvelles conversations (id ; vide = aucune). */
  defaultPrompt: string;
  /** Modèles de messages, insérés en tapant « / ». */
  promptTemplates: SystemPromptPreset[];
  /** Alerte quand le solde USD passe sous ce montant. */
  balanceAlert: number | null;
  /** Budget mensuel estimé ($). */
  monthlyBudget: number | null;
  temperature: number | null;
  maxTokens: number | null;
  theme: "system" | "light" | "dark";
  sendOnEnter: boolean;
  /** venice : recherche intégrée à l'API ; brave / google : outil web_search ; searxng : auto-hébergé. */
  webSearchProvider: "venice" | "brave" | "google" | "searxng";
  webSearchMode: "auto" | "on";
  searxngUrl: string;
  webSearchDefault: boolean;
  /** Vide = modèle de code par défaut désigné par Venice. */
  codeModel: string;
  /** Ajouter l'invite système de Venice. */
  veniceSystemPrompt: boolean;
  /** N'afficher que les modèles privés (exécutés par Venice, sans conservation). */
  privateOnly: boolean;
  commandTimeout: number;
  mcpAlwaysAllow: string[];
  maxSteps: number;
  /** Mode d'approbation des nouvelles sessions de code. */
  defaultPermission: PermissionMode;
  autoContinue: boolean;
  autoCompactPercent: number;
  checkUpdates: boolean;
  skippedVersion: string;
  shell: "auto" | "bash" | "pwsh" | "powershell";
  /** Tarifs personnalisés, $ par million de tokens : préfixe de modèle → [entrée, sortie]. */
  prices: Record<string, [number, number]>;
  transcriptionModel: string;
  /** Code langue ISO (« fr »…) ; vide = détection automatique. */
  transcriptionLanguage: string;
  /** Serveur de transcription dédié (vide = API Venice). */
  transcriptionUrl: string;
  /** Termes à favoriser (un par ligne ou séparés par des virgules). */
  transcriptionVocabulary: string;
  /** Transcription de fichiers : segments horodatés. */
  transcriptionTimestamps: boolean;
  /** Voix clonées (identifiant vv_…, nom, modèle associé). */
  clonedVoices: { id: string; name: string; model: string }[];
  /** Modèles vidéo et musique (vide = défaut de Venice). */
  videoModel: string;
  musicModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsSpeed: number;
  /** Vide = modèle d'image par défaut désigné par Venice. */
  imageModel: string;
  imageAspect: string;
  imageNegativePrompt: string;
  /** Floutage des images pour adultes (filtre de Venice). */
  imageSafeMode: boolean;
  imageHideWatermark: boolean;
  /** Modèle de retouche par un texte (vide = défaut de Venice). */
  imageEditModel: string;
  /** Images par génération (1 à 4). */
  imageVariants: number;
  encryptData: boolean;
  /** Recherche sémantique dans les fichiers des projets (API d'embeddings). */
  semanticSearch: boolean;
  /** Modèle d'embeddings (vide = text-embedding-bge-m3). */
  embeddingModel: string;
  /** Raccourci global qui affiche la fenêtre (vide = aucun). */
  globalShortcut: string;
  settingsVersion?: number;
}

export interface ImportReport {
  conversations: number;
  projects: number;
  media: number;
  settings: boolean;
}

export interface SystemPromptPreset {
  id: string;
  name: string;
  text: string;
}

export interface ModelInfo {
  id: string;
  name: string | null;
  description: string | null;
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  /** Niveaux d'effort de raisonnement acceptés (vide = non réglable). */
  reasoningEfforts: string[];
  defaultEffort: string | null;
  /** Chiffrement de bout en bout possible. */
  e2ee: boolean;
  code: boolean;
  maxContextLength: number | null;
  /** private : exécuté par Venice sans conservation ; anonymized : fournisseur tiers, requêtes anonymisées. */
  privacy: "private" | "anonymized" | null;
  uncensored: boolean;
  beta: boolean;
  traits: string[];
  /** $ par million de tokens [entrée, sortie]. */
  price: [number, number] | null;
  /** Modèles d'image. */
  constraints?: ImageConstraints;
  imagePrice?: number;
  /** Modèles vidéo, musique, voix : spécification brute. */
  spec?: Record<string, unknown>;
}

export type MediaMode = "image" | "video" | "music";

/** Attestation de l'enclave vérifiée localement (conversation chiffrée de bout en bout). */
export interface E2eeAttestation {
  model: string;
  nonceBound: boolean;
  keyBound: boolean;
  debug: boolean;
  serverVerified: boolean | null;
  teeProvider: string | null;
}

export interface Character {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  adult: boolean;
  modelId: string | null;
}

export interface ImageConstraints {
  aspectRatios?: string[];
  defaultAspectRatio?: string;
  resolutions?: string[];
  defaultResolution?: string;
  promptCharacterLimit?: number;
  widthHeightDivisor?: number;
}

export interface Citation {
  title: string;
  url: string;
  date?: string;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  negativePrompt: string;
  aspectRatio?: string;
  resolution?: string;
  width?: number;
  height?: number;
  safeMode: boolean;
  hideWatermark: boolean;
  variants?: number;
  seed?: number;
}

export interface GalleryItem {
  convId: string;
  convTitle: string;
  msgId: string;
  prompt: string;
  model: string;
  createdAt: number;
  src: string;
}

export interface Balance {
  canConsume: boolean;
  consumptionCurrency: string | null;
  balances: { diem: number | null; usd: number | null; bundledCredits: number | null; earnedCredits: number | null };
  diemEpochAllocation: number;
}

export interface TextFile {
  name: string;
  text: string;
}

export type ToolStatus = "queued" | "pending" | "running" | "done" | "error" | "denied";

export interface ToolCallRec {
  id: string;
  name: string;
  arguments: string;
  status: ToolStatus;
  result?: string;
  diff?: string;
  /** Chemin absolu hors du dossier de projet (accès système). */
  outside?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  images?: string[];
  files?: TextFile[];
  reasoning?: string;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number };
  error?: string;
  cancelled?: boolean;
  toolCalls?: ToolCallRec[];
  /** Relance envoyée automatiquement par l'application. */
  auto?: boolean;
  /** Sources de la recherche web intégrée de Venice. */
  citations?: Citation[];
  /** Message assistant : images générées (data URL). */
  generated?: string[];
  /** Image floutée par le mode sûr. */
  blurred?: boolean;
  /** Graine de la génération, pour la réutiliser. */
  seed?: number;
  /** Demande de retouche : l'image jointe n'est pas envoyée au modèle de texte. */
  imageOp?: boolean;
  /** Message utilisateur : versions (modifications, régénérations) et version affichée. */
  branches?: { content: string; images?: string[]; files?: TextFile[]; tail: Message[] }[];
  branch?: number;
  /** Réponse chiffrée de bout en bout : attestation vérifiée. */
  e2ee?: E2eeAttestation;
  /** Vidéo ou audio généré, enregistré localement. */
  media?: { id: string; kind: "video" | "audio"; mime: string; size: number };
  /** Réponse d'un second modèle, affichée à côté (comparaison). */
  compare?: { model: string; content: string; reasoning?: string; usage?: Usage; error?: string };
}

export interface Compaction {
  summary: string;
  /** Les messages d'indice < upto sont remplacés par le résumé dans les requêtes. */
  upto: number;
  at: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type Kind = "chat" | "code";
export type PermissionMode = "ask" | "acceptEdits" | "auto";

export interface Conversation {
  id: string;
  title: string;
  kind: Kind;
  model: string;
  createdAt: number;
  updatedAt: number;
  /** Texte des instructions au moment du choix (repli si l'instruction enregistrée est supprimée). */
  systemPrompt: string | null;
  /** Instructions enregistrées choisies ("" = aucune ; absent = ancienne conversation). */
  promptId?: string;
  /** Effort de raisonnement ("" = défaut du modèle, "off" = sans réflexion). */
  reasoningEffort?: string;
  /** Personnage public de Venice. */
  character?: { slug: string; name: string };
  messages: Message[];
  workspace?: string;
  permissionMode?: PermissionMode;
  webSearch?: boolean;
  mcp?: boolean;
  /** Mode Code : fichiers hors du dossier de projet autorisés (avec approbation). */
  systemAccess?: boolean;
  /** Les messages génèrent des images au lieu de texte. */
  imageGen?: boolean;
  /** Second modèle qui répond aussi, pour comparer. */
  compareModel?: string;
  /** Création : image, vidéo ou musique ("" = texte). Remplace imageGen. */
  media?: MediaMode | "";
  compaction?: Compaction;
  /** Consommation hors messages (compactions), par modèle. */
  extraUsage?: Record<string, Usage>;
  projectId?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  kind: Kind;
  workspace: string | null;
  projectId: string | null;
}

export interface ProjectFile {
  name: string;
  text: string;
}

export interface Project {
  id: string;
  name: string;
  instructions: string;
  files: ProjectFile[];
  /** Dossier de travail des sessions de code : chemin local ou `ssh:<hôte>:<chemin>`. */
  workspace?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SearchHit {
  id: string;
  snippet: string | null;
}

export interface ProjectContext {
  mode: "full" | "excerpts";
  text: string;
}

export interface VaultStatus {
  enabled: boolean;
  hasKey: boolean;
  error: string | null;
}

export interface InstructionFile {
  name: string;
  content: string;
  truncated: boolean;
}

export interface KeyStatus {
  configured: boolean;
  source: "keyring" | "env" | null;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "toolCalls"; calls: { id: string; name: string; arguments: string }[] }
  | { type: "citations"; items: Citation[] }
  | { type: "e2ee"; attestation: E2eeAttestation }
  | { type: "retry"; attempt: number; maxAttempts: number; delaySecs: number; reason: string }
  | { type: "done"; finishReason: string | null; cancelled: boolean };

export interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  name?: string;
}

export interface ToolContext {
  workspace?: string;
  web: boolean;
  mcp: boolean;
  system?: boolean;
  /** Projet volumineux : outil search_project_files. */
  project?: string;
}

export type Risk = "read" | "write" | "exec" | "mcp";

export interface ToolDef {
  definition: { type: "function"; function: { name: string; description: string; parameters: unknown } };
  risk: Risk;
}

export interface ToolOutput {
  content: string;
  isError: boolean;
  diff: string | null;
}

export interface McpServerStatus {
  name: string;
  state: "starting" | "ready" | "error" | "disabled";
  error: string | null;
  transport: "stdio" | "http";
  protocol: string | null;
  tools: { exposed: string; name: string; description: string }[];
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  releaseUrl: string;
  assetName: string | null;
  assetUrl: string | null;
  notes: string;
}

export interface SshHost {
  id: string;
  label: string;
  host: string;
  port?: number | null;
  user?: string | null;
  identityFile?: string | null;
  system?: string | null;
  /** "password" : mot de passe et codes 2FA demandés via l'application ; sinon clé ou agent SSH. */
  auth?: "key" | "password" | null;
  /** Mot de passe enregistré dans le trousseau (lecture seule). */
  hasPassword?: boolean;
}

/** Invite d'authentification SSH relayée par l'application (événement `ssh-prompt`). */
export interface SshPrompt {
  id: string;
  hostId: string;
  host: string;
  prompt: string;
  /** Invite de mot de passe (enregistrable), sinon code 2FA, phrase secrète… */
  password: boolean;
  /** Le mot de passe précédent a été refusé. */
  retry: boolean;
}

export interface SshTestResult {
  ok: boolean;
  error: string | null;
  needsTrust: boolean;
  fingerprints: string[];
  system: string | null;
  user: string | null;
  home: string | null;
  git: string | null;
}

export interface GitFile {
  path: string;
  origPath: string | null;
  index: string;
  worktree: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

/** jour → modèle → [entrée, sortie, requêtes] */
export type UsageLog = Record<string, Record<string, [number, number, number]>>;

export const api = {
  keyStatus: () => invoke<KeyStatus>("api_key_status"),
  setKey: (key: string) => invoke<void>("set_api_key", { key }),
  deleteKey: () => invoke<void>("delete_api_key"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  listModels: (kind: "text" | "image" | "inpaint" | "video" | "music" | "tts" | "embedding" = "text") =>
    invoke<ModelInfo[]>("list_models", { kind }),
  listConversations: () => invoke<ConversationSummary[]>("list_conversations"),
  loadConversation: (id: string) => invoke<Conversation>("load_conversation", { id }),
  saveConversation: (conversation: Conversation) => invoke<void>("save_conversation", { conversation }),
  deleteConversation: (id: string) => invoke<void>("delete_conversation", { id }),
  exportConversation: (id: string) => invoke<boolean>("export_conversation", { id }),
  dataDir: () => invoke<string>("data_dir"),
  /** Sauvegarde chiffrée de toutes les données ; null si annulé. */
  exportBackup: (passphrase: string) => invoke<number | null>("export_backup", { passphrase }),
  importBackup: (passphrase: string, withSettings: boolean) => invoke<ImportReport | null>("import_backup", { passphrase, withSettings }),
  cancel: (requestId: string) => invoke<void>("cancel_stream", { requestId }),
  platform: () =>
    invoke<{ os: string; shell: string; shellPath: string; shellGuidance: string; version: string; venice: boolean; nativeSearch: boolean }>(
      "platform_info",
    ),
  recordUsage: (day: string, model: string, promptTokens: number, completionTokens: number) =>
    invoke<void>("record_usage", { day, model, promptTokens, completionTokens }),
  getUsage: () => invoke<UsageLog>("get_usage"),
  checkUpdate: () => invoke<UpdateInfo>("check_update"),

  sshHosts: () => invoke<SshHost[]>("ssh_hosts"),
  sshSaveHost: (host: SshHost) => invoke<SshHost>("ssh_save_host", { host }),
  sshDeleteHost: (id: string) => invoke<void>("ssh_delete_host", { id }),
  sshTest: (host: SshHost, password?: string) => invoke<SshTestResult>("ssh_test", { host, password: password || null }),
  sshSetPassword: (hostId: string, password: string | null) => invoke<void>("ssh_set_password", { hostId, password }),
  sshPromptAnswer: (id: string, answer: string | null, save: boolean) => invoke<void>("ssh_prompt_answer", { id, answer, save }),
  sshTrust: (host: SshHost, password?: string) => invoke<void>("ssh_trust", { host, password: password || null }),
  sshListDirs: (hostId: string, path: string) => invoke<{ path: string; dirs: string[] }>("ssh_list_dirs", { hostId, path }),
  sshOpenWorkspace: (hostId: string, path: string) => invoke<string>("ssh_open_workspace", { hostId, path }),

  gitStatus: (workspace: string) => invoke<GitStatus>("git_status", { workspace }),
  gitDiff: (workspace: string, path: string | null, staged: boolean, untracked: boolean) =>
    invoke<string>("git_diff", { workspace, path, staged, untracked }),
  gitStage: (workspace: string, paths: string[]) => invoke<void>("git_stage", { workspace, paths }),
  gitUnstage: (workspace: string, paths: string[]) => invoke<void>("git_unstage", { workspace, paths }),
  gitDiscard: (workspace: string, tracked: string[], untracked: string[]) => invoke<void>("git_discard", { workspace, tracked, untracked }),
  gitCommit: (workspace: string, message: string) => invoke<string>("git_commit", { workspace, message }),
  gitSync: (workspace: string, action: "push" | "pull" | "fetch") => invoke<string>("git_sync", { workspace, action }),
  gitBranches: (workspace: string) => invoke<string[]>("git_branches", { workspace }),
  gitCheckout: (workspace: string, branch: string, create: boolean) => invoke<void>("git_checkout", { workspace, branch, create }),
  gitLog: (workspace: string, count: number) => invoke<GitCommit[]>("git_log", { workspace, count }),
  gitInit: (workspace: string) => invoke<void>("git_init", { workspace }),

  workspaceInstructions: (workspace: string) => invoke<InstructionFile[]>("workspace_instructions", { workspace }),

  listProjects: () => invoke<Project[]>("list_projects"),
  saveProject: (project: Project) => invoke<void>("save_project", { project }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),

  dictationStart(onLevel: (level: number) => void): Promise<void> {
    const channel = new Channel<number>();
    channel.onmessage = onLevel;
    return invoke<void>("dictation_start", { onLevel: channel });
  },
  dictationStop: (transcribe: boolean) => invoke<{ text: string; note: string | null } | null>("dictation_stop", { transcribe }),

  searchConversations: (query: string) => invoke<SearchHit[]>("search_conversations", { query }),
  projectContext: (id: string, query: string) => invoke<ProjectContext>("project_context", { id, query }),

  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  vaultExportKey: () => invoke<string>("vault_export_key"),
  vaultImportKey: (key: string) => invoke<void>("vault_import_key", { key }),

  updaterSupported: () => invoke<boolean>("updater_supported"),
  installUpdate(onProgress: (p: { done: number; total: number | null }) => void): Promise<void> {
    const channel = new Channel<{ done: number; total: number | null }>();
    channel.onmessage = onProgress;
    return invoke<void>("install_update", { onProgress: channel });
  },

  toolDefinitions: (ctx: ToolContext) => invoke<ToolDef[]>("tool_definitions", { ctx }),
  toolOutside: (ctx: ToolContext, name: string, args: string) =>
    invoke<string | null>("tool_outside", { ctx, name, arguments: args }),
  previewTool: (ctx: ToolContext, name: string, args: string) =>
    invoke<string | null>("preview_tool", { ctx, name, arguments: args }),
  runTool: (requestId: string, ctx: ToolContext, name: string, args: string) =>
    invoke<ToolOutput>("run_tool", { requestId, ctx, name, arguments: args }),

  pickWorkspace: () => invoke<string | null>("pick_workspace"),
  listWorkspaces: () => invoke<string[]>("list_workspaces"),
  forgetWorkspace: (path: string) => invoke<string[]>("forget_workspace", { path }),
  touchWorkspace: (path: string) => invoke<void>("touch_workspace", { path }),

  processDocument: (dataBase64: string) => invoke<{ text: string; pages: number }>("process_document", { dataBase64 }),
  generateImage: (requestId: string, request: ImageRequest) =>
    invoke<{ images: string[]; blurred: boolean; seconds: number | null }>("generate_image", { requestId, request }),
  saveImage: (dataUrl: string, name: string) => invoke<boolean>("save_image", { dataUrl, name }),
  speak: (text: string) => invoke<string>("speak", { text }),
  transformImage: (requestId: string, request: { op: string; image: string; prompt: string; model: string }) =>
    invoke<string>("transform_image", { requestId, request }),
  listGallery: () => invoke<GalleryItem[]>("list_gallery"),
  transcribeFile: (name: string, mime: string, dataBase64: string) => invoke<string>("transcribe_file", { name, mime, dataBase64 }),
  cloneVoice: (name: string, mime: string, dataBase64: string, model: string) =>
    invoke<string>("clone_voice", { name, mime, dataBase64, model }),
  generateMedia(
    requestId: string,
    kind: "video" | "audio",
    request: Record<string, unknown>,
    onProgress: (p: { stage: "quote" | "queued" | "processing"; quote?: number; average?: number; elapsed?: number }) => void,
  ): Promise<{ id: string; mime: string; size: number }> {
    const channel = new Channel<{ stage: "quote" | "queued" | "processing"; quote?: number; average?: number; elapsed?: number }>();
    channel.onmessage = onProgress;
    return invoke("generate_media", { requestId, kind, request, onProgress: channel });
  },
  mediaRead: (id: string) => invoke<string>("media_read", { id }),
  mediaExport: (id: string, name: string, ext: string) => invoke<boolean>("media_export", { id, name, ext }),
  balance: () => invoke<Balance>("account_balance"),
  listCharacters: (search: string) => invoke<Character[]>("list_characters", { search }),

  mcpGetConfig: () => invoke<string>("mcp_get_config"),
  mcpSaveConfig: (text: string) => invoke<void>("mcp_save_config", { text }),
  mcpRestart: () => invoke<void>("mcp_restart"),
  mcpStatus: () => invoke<McpServerStatus[]>("mcp_status"),

  chat(
    requestId: string,
    request: {
      model: string;
      messages: ApiMessage[];
      temperature: number | null;
      maxTokens: number | null;
      tools: ToolDef["definition"][];
      toolChoice?: "auto" | "none";
      /** Recherche web intégrée de Venice. */
      webSearch?: boolean;
      reasoningEffort?: string | null;
      characterSlug?: string | null;
      /** Modèle en enclave : messages chiffrés de bout en bout. */
      e2ee?: boolean;
    },
    onEvent: (e: StreamEvent) => void,
  ): Promise<void> {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("chat_stream", { requestId, request, onEvent: channel });
  },
};
