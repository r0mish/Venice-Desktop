// Galerie : toutes les images générées, toutes conversations confondues.
import { api, type GalleryItem } from "./api";
import { escapeHtml } from "./markdown";
import { $, errMsg } from "./state";
import { openLightbox } from "./lightbox";
import { openConversation } from "./sidebar";

const dlg = $<HTMLDialogElement>("#gallery");
const grid = $("#gallery-grid");
const search = $<HTMLInputElement>("#gallery-search");
let items: GalleryItem[] = [];

const fileName = (g: GalleryItem) => g.prompt.replace(/[^\p{L}\p{N} _-]+/gu, " ").trim().slice(0, 50).replace(/\s+/g, "-") || "image";

function render() {
  const q = search.value.trim().toLowerCase();
  const shown = items.map((g, i) => ({ g, i })).filter(({ g }) => !q || `${g.prompt} ${g.convTitle} ${g.model}`.toLowerCase().includes(q));
  grid.innerHTML = shown.length
    ? shown
        .map(
          ({ g, i }) => `<button type="button" class="gallery-item" data-i="${i}" title="${escapeHtml(g.prompt)}">
            <img src="${g.src}" alt="${escapeHtml(g.prompt.slice(0, 80))}" loading="lazy" />
            <small>${escapeHtml(g.prompt || g.convTitle)}</small>
          </button>`,
        )
        .join("")
    : `<p class="muted small">${items.length ? "Aucune image ne correspond." : "Aucune image générée pour l'instant (bouton « Image » de la zone de saisie)."}</p>`;
}

search.addEventListener("input", render);
$("#gallery-close").addEventListener("click", () => dlg.close());
grid.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
  const g = b && items[Number(b.dataset.i)];
  if (!g) return;
  openLightbox(g.src, fileName(g), {
    openConv: () => {
      dlg.close();
      openConversation(g.convId);
    },
  });
});

export async function openGallery() {
  dlg.showModal();
  grid.innerHTML = '<p class="muted small">Chargement…</p>';
  try {
    items = await api.listGallery();
    render();
  } catch (e) {
    grid.innerHTML = `<p class="small error">${escapeHtml(errMsg(e))}</p>`;
  }
}
