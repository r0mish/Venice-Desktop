// Conversation vocale : écoute → détection de la fin de phrase (silence) → transcription → envoi →
// lecture de la réponse à voix haute → nouvelle écoute, jusqu'à l'arrêt.
import { api } from "./api";
import { el, errMsg, state } from "./state";
import { toast } from "./ui";
import { send } from "./run";
import { speak, stopSpeaking } from "./speech";
import { dictationActive } from "./dictation";

/** Niveau (pic d'amplitude, toutes les 100 ms) au-dessus duquel on considère que l'on parle. */
const MIN_SPEECH_LEVEL = 0.04;
/** Silence qui termine la phrase, et attente maximale avant de parler. */
const END_SILENCE_MS = 1400;
const WAIT_SPEECH_MS = 20000;
const MAX_UTTERANCE_MS = 90000;

let active = false;
let phase: "idle" | "listening" | "thinking" | "speaking" = "idle";

function render() {
  el.voiceBtn.classList.toggle("on", active);
  el.voiceBtn.dataset.phase = phase;
  el.voiceBtn.title = !active
    ? "Conversation vocale : parlez, la réponse est lue à voix haute"
    : phase === "listening"
      ? "À l'écoute… (cliquer ou Échap pour arrêter)"
      : phase === "thinking"
        ? "Réponse en cours…"
        : "Lecture de la réponse…";
}

/**
 * Écoute une phrase : s'arrête après un silence qui suit la parole. Renvoie le texte reconnu,
 * ou null si rien n'a été dit (ou si le mode vocal a été arrêté).
 */
async function listenOnce(): Promise<string | null> {
  let noise = 0;
  let samples = 0;
  let spoke = false;
  let lastSpeech = 0;
  const startedAt = Date.now();
  let done!: (transcribe: boolean) => void;
  const finished = new Promise<boolean>((r) => (done = r));
  await api.dictationStart((level) => {
    if (level < 0) return done(spoke);
    const now = Date.now();
    // Bruit de fond estimé sur la première demi-seconde.
    if (samples < 5) {
      noise = Math.max(noise, level);
      samples++;
      return;
    }
    const threshold = Math.max(MIN_SPEECH_LEVEL, noise * 3);
    if (level > threshold) {
      spoke = true;
      lastSpeech = now;
    }
    if (!active) done(false);
    else if (spoke && now - lastSpeech > END_SILENCE_MS) done(true);
    else if (!spoke && now - startedAt > WAIT_SPEECH_MS) done(false);
    else if (now - startedAt > MAX_UTTERANCE_MS) done(spoke);
  });
  const transcribe = await finished;
  const res = await api.dictationStop(transcribe);
  return transcribe ? (res?.text?.trim() ?? null) : null;
}

const waitIdle = () =>
  new Promise<void>((resolve) => {
    const check = () => (state.busy ? setTimeout(check, 200) : resolve());
    check();
  });

async function loop() {
  while (active) {
    phase = "listening";
    render();
    let text: string | null;
    try {
      text = await listenOnce();
    } catch (e) {
      toast(`Micro indisponible : ${errMsg(e)}`, true);
      break;
    }
    if (!active) break;
    if (!text) continue;
    phase = "thinking";
    render();
    el.input.value = text;
    await send();
    await waitIdle();
    if (!active) break;
    const msgs = state.current?.messages ?? [];
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant" && last.content.trim()) {
      phase = "speaking";
      render();
      await speak(last.id, last.content).catch((e) => toast(`Lecture impossible : ${errMsg(e)}`, true));
    }
  }
  active = false;
  phase = "idle";
  render();
}

export function toggleVoice() {
  if (active) return stopVoice();
  if (dictationActive()) return toast("Terminez d'abord la dictée en cours.", true);
  if (state.mediaMode) return toast("La conversation vocale fonctionne en mode texte.", true);
  active = true;
  toast("Conversation vocale : parlez, la réponse sera lue. Cliquez à nouveau pour arrêter.");
  loop();
}

/** Arrête le mode vocal (Échap) ; renvoie false s'il n'était pas actif. */
export function stopVoice(): boolean {
  if (!active) return false;
  active = false;
  stopSpeaking();
  render();
  return true;
}

export function initVoice() {
  el.voiceBtn.addEventListener("click", toggleVoice);
  render();
}
