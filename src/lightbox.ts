// Visionneuse d'images : zoom (molette, +/−, clic), déplacement, enregistrement et retouches
// (agrandissement, détourage, modification par une consigne).
import { api } from "./api";
import { $, errMsg } from "./state";

const dlg = $<HTMLDialogElement>("#lightbox");
const stage = $("#lb-stage");
const img = $<HTMLImageElement>("#lb-img");
const zoomLabel = $("#lb-zoom");
const saveBtn = $<HTMLButtonElement>("#lb-save");
const actions = $("#lb-actions");
const status = $("#lb-status");
const openBtn = $<HTMLButtonElement>("#lb-open");
const editForm = $<HTMLFormElement>("#lb-edit");
const editInput = $<HTMLInputElement>("#lb-edit-input");

export type Transform = (op: "upscale2" | "upscale4" | "background" | "edit", src: string, prompt?: string) => Promise<string | null>;
let transform: Transform | null = null;
let openConv: (() => void) | null = null;
let busy = false;

const MAX_SCALE = 8;
/** Échelle courante, échelle « ajustée à la fenêtre » et décalage depuis le centre (px). */
let scale = 1;
let fit = 1;
let x = 0;
let y = 0;
let saveName: string | null = null;
let toast: (msg: string, isError?: boolean) => void = () => {};

function apply() {
  img.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${scale})`;
  zoomLabel.textContent = `${Math.round(scale * 100)} %`;
  stage.classList.toggle("zoomed", scale > fit + 1e-3);
}

function fitToStage() {
  const r = stage.getBoundingClientRect();
  if (!img.naturalWidth || !r.width) return;
  fit = Math.min(1, r.width / img.naturalWidth, r.height / img.naturalHeight);
  scale = fit;
  x = y = 0;
  apply();
}

/** Zoome en gardant fixe le point (cx, cy), relatif au centre de la zone d'affichage. */
function zoomTo(next: number, cx = 0, cy = 0) {
  next = Math.min(MAX_SCALE, Math.max(Math.min(fit, 0.1), next));
  x = cx - ((cx - x) * next) / scale;
  y = cy - ((cy - y) * next) / scale;
  scale = next;
  if (scale <= fit) x = y = 0;
  apply();
}

const fromCenter = (e: MouseEvent) => {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2] as const;
};

stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomTo(scale * Math.exp(-e.deltaY * 0.0015), ...fromCenter(e));
  },
  { passive: false },
);

let drag: { px: number; py: number; moved: boolean } | null = null;
stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  drag = { px: e.clientX, py: e.clientY, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.px;
  const dy = e.clientY - drag.py;
  if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
  drag.px = e.clientX;
  drag.py = e.clientY;
  if (scale > fit) {
    x += dx;
    y += dy;
    apply();
  }
});
stage.addEventListener("pointerup", (e) => {
  const click = drag && !drag.moved;
  drag = null;
  if (!click) return;
  const [cx, cy] = fromCenter(e);
  const r = img.getBoundingClientRect();
  const onImage = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  // Clic sur l'image : zoom avant / retour à l'ajustement ; à côté : fermeture.
  if (scale > fit + 1e-3) zoomTo(fit);
  else if (onImage) zoomTo(Math.max(1, fit * 2.5), cx, cy);
  else dlg.close();
});

/** Applique une retouche et affiche le résultat (ajouté aussi à la conversation). */
async function run(op: Parameters<Transform>[0], prompt?: string) {
  if (!transform || busy) return;
  busy = true;
  dlg.classList.add("busy");
  status.textContent = op === "edit" ? "Modification en cours…" : op === "background" ? "Détourage en cours…" : "Agrandissement en cours…";
  try {
    const result = await transform(op, img.src, prompt);
    if (result) {
      img.src = result;
      status.textContent = "Terminé : résultat ajouté à la conversation";
    } else {
      status.textContent = "Échec (voir la conversation)";
    }
  } finally {
    busy = false;
    dlg.classList.remove("busy");
  }
}

editForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const prompt = editInput.value.trim();
  if (!prompt) return;
  editForm.hidden = true;
  run("edit", prompt);
});

dlg.addEventListener("click", async (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>("[data-lb]")?.dataset.lb;
  switch (action) {
    case "upscale2":
    case "upscale4":
    case "background":
      return run(action);
    case "edit":
      editForm.hidden = false;
      return editInput.focus();
    case "edit-cancel":
      editForm.hidden = true;
      return;
    case "open":
      dlg.close();
      return openConv?.();
    case "in":
      return zoomTo(scale * 1.5);
    case "out":
      return zoomTo(scale / 1.5);
    case "fit":
      return zoomTo(fit);
    case "actual":
      return zoomTo(1);
    case "close":
      return dlg.close();
    case "save":
      if (!saveName) return;
      try {
        if (await api.saveImage(img.src, saveName)) toast("Image enregistrée");
      } catch (err) {
        toast(errMsg(err), true);
      }
  }
});

dlg.addEventListener("keydown", (e) => {
  if (e.target === editInput) return;
  if (e.key === "+" || e.key === "=") zoomTo(scale * 1.5);
  else if (e.key === "-") zoomTo(scale / 1.5);
  else if (e.key === "0") zoomTo(fit);
  else if (e.key === "1") zoomTo(1);
  else return;
  e.preventDefault();
});

window.addEventListener("resize", () => {
  if (dlg.open) fitToStage();
});

export function initLightbox(opts: { toast: typeof toast }) {
  toast = opts.toast;
}

/**
 * Ouvre l'image. `name` (sans extension) active l'enregistrement, `opts.transform` les retouches,
 * `opts.openConv` le bouton « Ouvrir la conversation » (galerie).
 */
export function openLightbox(src: string, name: string | null = null, opts: { transform?: Transform; openConv?: () => void } = {}) {
  saveName = name;
  saveBtn.hidden = !name;
  transform = opts.transform ?? null;
  openConv = opts.openConv ?? null;
  actions.hidden = !transform;
  openBtn.hidden = !openConv;
  editForm.hidden = true;
  editInput.value = "";
  status.textContent = "";
  img.onload = fitToStage;
  img.src = src;
  dlg.showModal();
  if (img.complete) fitToStage();
}
