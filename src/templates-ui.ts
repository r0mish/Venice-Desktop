// Modèles de messages : « / » en début de saisie ouvre la liste, Entrée ou Tab insère le texte.
import { escapeHtml } from "./markdown";
import { el, state } from "./state";
import { autoGrow } from "./ui";

let matches: { name: string; text: string }[] = [];
let active = 0;

const isOpen = () => !el.slashMenu.hidden;

function close() {
  el.slashMenu.hidden = true;
  matches = [];
}

function render() {
  el.slashMenu.innerHTML =
    `<div class="group">Modèles de messages</div>` +
    matches
      .map(
        (t, i) => `<button type="button" class="ws-menu-item${i === active ? " current" : ""}" data-i="${i}">
          <span>/${escapeHtml(t.name)}</span><small>${escapeHtml(t.text.replace(/\s+/g, " ").slice(0, 90))}</small></button>`,
      )
      .join("");
  el.slashMenu.hidden = false;
}

/** Remplace la commande « /nom » par le texte du modèle. */
function apply(i: number) {
  const t = matches[i];
  if (!t) return;
  el.input.value = t.text;
  close();
  autoGrow(el.input);
  el.input.focus();
  el.input.setSelectionRange(t.text.length, t.text.length);
}

function update() {
  const m = el.input.value.match(/^\/(\S*)$/);
  const templates = state.settings?.promptTemplates ?? [];
  if (!m || !templates.length) return close();
  const q = m[1].toLowerCase();
  matches = templates.filter((t) => t.name.toLowerCase().includes(q));
  if (!matches.length) return close();
  active = Math.min(active, matches.length - 1);
  render();
}

export function initTemplates() {
  el.input.addEventListener("input", () => {
    active = 0;
    update();
  });
  // Phase de capture : passe avant l'envoi par Entrée.
  el.composer.addEventListener(
    "keydown",
    (e) => {
      if (!isOpen() || e.target !== el.input) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        active = (active + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        render();
      } else if (e.key === "Enter" || e.key === "Tab") {
        apply(active);
      } else if (e.key === "Escape") {
        close();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  el.slashMenu.addEventListener("mousedown", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (!b) return;
    e.preventDefault();
    apply(Number(b.dataset.i));
  });
  el.input.addEventListener("blur", () => setTimeout(close, 150));
}
