// Lecture à voix haute des réponses (synthèse vocale de Venice), par morceaux de phrases.
import { api } from "./api";

/** Limite de l'API (4096 caractères), avec une marge. */
const MAX_CHUNK = 3500;

/** Texte lisible : sans blocs de code, balises Markdown ni URL. */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " (bloc de code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\^\d+(?:\s*,\s*\d+)*\^/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/^\|?[\s:|-]+\|?$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Découpe en morceaux de moins de `max` caractères, aux fins de phrase si possible. */
export function chunks(text: string, max = MAX_CHUNK): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"), window.lastIndexOf("! "), window.lastIndexOf("? "));
    const at = cut > max / 3 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

let current: { id: string; audio: HTMLAudioElement | null; stopped: boolean } | null = null;
let onChange: (id: string | null) => void = () => {};

export const speakingId = () => current?.id ?? null;

export function initSpeech(cb: (id: string | null) => void) {
  onChange = cb;
}

export function stopSpeaking() {
  if (!current) return;
  current.stopped = true;
  current.audio?.pause();
  current = null;
  onChange(null);
}

const toUrl = (b64: string) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
};

/** Lit `markdown` ; un second appel pour le même message arrête la lecture. */
export async function speak(id: string, markdown: string) {
  const again = current?.id === id;
  stopSpeaking();
  if (again) return;
  const parts = chunks(speakableText(markdown));
  if (!parts.length) return;
  const me = { id, audio: null as HTMLAudioElement | null, stopped: false };
  current = me;
  onChange(id);
  try {
    // Le morceau suivant est préparé pendant la lecture du précédent.
    let next = api.speak(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      const url = toUrl(await next);
      if (i + 1 < parts.length) {
        next = api.speak(parts[i + 1]);
        next.catch(() => {});
      }
      if (me.stopped) return URL.revokeObjectURL(url);
      me.audio = new Audio(url);
      await new Promise<void>((resolve, reject) => {
        me.audio!.onended = () => resolve();
        me.audio!.onpause = () => resolve();
        me.audio!.onerror = () => reject(new Error("lecture audio impossible"));
        me.audio!.play().catch(reject);
      });
      URL.revokeObjectURL(url);
      if (me.stopped) return;
    }
  } finally {
    if (current === me) {
      current = null;
      onChange(null);
    }
  }
}
