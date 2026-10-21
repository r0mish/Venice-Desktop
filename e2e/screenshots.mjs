// Captures d'écran du README : l'application réelle contre le faux serveur Venice.
//
//   npx tauri build --debug --no-bundle
//   E2E_IMAGE=image.b64 xvfb-run -a node e2e/screenshots.mjs     (image facultative, en base64)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idle, launch, send, setValue } from "./harness.mjs";

let workspace;
const app = await launch(({ root, data }) => {
  workspace = join(root, "homelab");
  mkdirSync(join(workspace, "notes"), { recursive: true });
  writeFileSync(join(data, "workspaces.json"), JSON.stringify([workspace]));
  writeFileSync(join(workspace, "AGENTS.md"), "# Homelab\n\nScripts d'administration Proxmox.\n");
});
const { d } = app;
const shot = async (name) => writeFileSync(`docs/${name}.png`, await d.screenshot());

try {
  await d.waitFor(() => document.querySelectorAll("#model-select option").length > 1, { message: "modèles" });

  await d.click("#web-toggle");
  await send(d, "CHERCHE : quel temps fera-t-il demain à Paris ?");
  await d.waitText("#messages", "parapluie");
  await idle(d);
  await d.exec(() => (document.querySelector(".sources").open = true));
  await shot("screenshot-chat");

  await d.click("#new-chat");
  await d.click("#web-toggle");
  await d.click("#img-toggle");
  await setValue(d, "#img-aspect", "16:9");
  await send(d, "Coucher de soleil sur la lagune de Venise, gondole en silhouette, style affiche");
  await d.waitFor(() => document.querySelector(".gen-image img")?.naturalWidth > 1, { message: "image décodée" });
  await idle(d);
  await new Promise((r) => setTimeout(r, 500));
  await shot("screenshot-image");
  await d.click("#img-toggle");

  await d.click('.mode-tabs [data-mode="code"]');
  await d.click(".welcome [data-ws]");
  await setValue(d, "#perm-select", "ask");
  await send(d, "ÉCRIS une note sur la sauvegarde des VM");
  await d.waitVisible('[data-approve="allow"]');
  await shot("screenshot-code");
  await d.click('[data-approve="allow"]');
  await idle(d);
} finally {
  await app.close();
}
