// Versions d'une conversation : modifier un message ou régénérer une réponse crée une branche ;
// les versions précédentes restent consultables (‹ 1/3 ›) sans rien perdre.
import type { Conversation, Message } from "./api";

export interface Branch {
  content: string;
  images?: string[];
  files?: Message["files"];
  /** Messages qui suivaient ce message dans cette version. */
  tail: Message[];
}

const snapshot = (conv: Conversation, idx: number): Branch => {
  const m = conv.messages[idx];
  return { content: m.content, images: m.images, files: m.files, tail: conv.messages.slice(idx + 1) };
};

/** La suite de la conversation change : un résumé couvrant l'ancienne suite n'est plus valable. */
function dropStaleCompaction(conv: Conversation, idx: number) {
  if (conv.compaction && conv.compaction.upto > idx) conv.compaction = undefined;
}

/**
 * Avant de modifier le message utilisateur `idx` ou de régénérer sa réponse : la version actuelle
 * est conservée et une nouvelle version devient la version courante. La suite est retirée.
 */
export function fork(conv: Conversation, idx: number) {
  const m = conv.messages[idx];
  if (!m || m.role !== "user") return;
  const current = snapshot(conv, idx);
  if (!current.tail.length && !m.branches?.length) return;
  if (!m.branches?.length) {
    m.branches = [current];
    m.branch = 0;
  } else {
    m.branches[m.branch ?? 0] = current;
  }
  m.branches.push({ content: m.content, images: m.images, files: m.files, tail: [] });
  m.branch = m.branches.length - 1;
  conv.messages = conv.messages.slice(0, idx + 1);
  dropStaleCompaction(conv, idx);
}

/** Affiche la version `target` du message utilisateur `idx`. */
export function switchBranch(conv: Conversation, idx: number, target: number) {
  const m = conv.messages[idx];
  const branches = m?.branches;
  if (!branches || target < 0 || target >= branches.length || target === m.branch) return;
  branches[m.branch ?? 0] = snapshot(conv, idx);
  const b = branches[target];
  m.content = b.content;
  m.images = b.images;
  m.files = b.files;
  m.branch = target;
  conv.messages = [...conv.messages.slice(0, idx + 1), ...b.tail];
  dropStaleCompaction(conv, idx);
}
