// Personnages publics de Venice : recherche et choix pour la conversation.
import { api, type Character } from "./api";
import { escapeHtml } from "./markdown";
import { $, errMsg } from "./state";

const dlg = $<HTMLDialogElement>("#char-dialog");
const search = $<HTMLInputElement>("#char-search");
const list = $("#char-list");

let results: Character[] = [];
let onPick: (c: { slug: string; name: string }) => void = () => {};
let timer = 0;
let seq = 0;

async function load() {
  const mine = ++seq;
  list.innerHTML = '<p class="muted small">Chargement…</p>';
  try {
    const found = await api.listCharacters(search.value);
    if (mine !== seq) return;
    results = found;
    list.innerHTML = results.length
      ? results
          .map(
            (c, i) => `<button type="button" class="char-item" data-i="${i}">
              <strong>${escapeHtml(c.name)}${c.adult ? ' <span class="badge">adulte</span>' : ""}</strong>
              <small>${escapeHtml(c.description)}</small>
              ${c.tags.length ? `<span class="char-tags">${c.tags.map((t) => `#${escapeHtml(t)}`).join(" ")}</span>` : ""}
            </button>`,
          )
          .join("")
      : '<p class="muted small">Aucun personnage trouvé.</p>';
  } catch (e) {
    if (mine === seq) list.innerHTML = `<p class="small error">${escapeHtml(errMsg(e))}</p>`;
  }
}

search.addEventListener("input", () => {
  clearTimeout(timer);
  timer = window.setTimeout(load, 300);
});
list.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
  const c = item && results[Number(item.dataset.i)];
  if (!c) return;
  dlg.close();
  onPick({ slug: c.slug, name: c.name });
});
$("#char-cancel").addEventListener("click", () => dlg.close());

/** Ouvre la recherche de personnages ; `pick` reçoit le personnage choisi. */
export function openCharacterDialog(pick: typeof onPick) {
  onPick = pick;
  dlg.showModal();
  search.focus();
  if (!results.length) load();
}
