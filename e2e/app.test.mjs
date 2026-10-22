// Tests de bout en bout : l'application réelle (Rust + WebView) pilotée par tauri-driver,
// contre un faux serveur Venice. Données isolées dans un dossier temporaire.
//
//   npx tauri build --debug --no-bundle
//   xvfb-run -a npm run test:e2e        (Linux, avec tauri-driver et WebKitWebDriver)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requests } from "./mock-venice.mjs";
import { idle, launch, send as sendTo, setValue, step as stepOf } from "./harness.mjs";

let app;
let d;
let workspace;

before(async () => {
  app = await launch(({ root, data }) => {
    workspace = join(root, "projet");
    mkdirSync(join(workspace, "notes"), { recursive: true });
    // Dossier de projet déjà autorisé (la boîte de dialogue native n'est pas pilotable).
    writeFileSync(join(data, "workspaces.json"), JSON.stringify([workspace]));
    writeFileSync(join(workspace, "AGENTS.md"), "# Consignes\n\nToujours respecter RÈGLE-E2E-42.\n");
    // Gros projet (au-delà du seuil des fichiers joints en entier) : seule la recherche
    // sémantique trouve le passage, qui n'a aucun mot commun avec la question.
    const filler = "Paragraphe sans rapport, sur la météo et le jardinage.\n".repeat(1500);
    mkdirSync(join(data, "projects"), { recursive: true });
    writeFileSync(
      join(data, "projects", "proj-semantique.json"),
      JSON.stringify({
        id: "proj-semantique",
        name: "Gros projet",
        instructions: "",
        createdAt: 0,
        updatedAt: 0,
        files: [{ name: "bruit.md", text: filler }, { name: "infra.md", text: `${filler}\nLe NAS est restauré chaque nuit.\n${filler}` }],
      }),
    );
  });
  d = app.d;
});

after(() => app?.close());

const step = (t, name, fn) => stepOf(t, d, name, fn);
const send = (text) => sendTo(d, text);

test("application de bout en bout", async (t) => {
  await step(t, "démarrage et liste des modèles", async () => {
    await d.waitVisible(".welcome h2");
    await d.waitFor(() => [...document.querySelectorAll("#model-select option")].some((o) => o.value === "modele-e2e-vision"), {
      message: "modèle du faux serveur dans la liste",
    });
    // Modèles « anonymisés » (fournisseurs tiers) masqués par défaut.
    assert.ok(!(await d.exec(() => [...document.querySelectorAll("#model-select option")].some((o) => o.value === "modele-tiers-e2e"))));
    assert.equal(await d.exec(() => document.querySelector("#model-select").value), "zai-org-glm-5-1");
  });

  await step(t, "conversation en streaming", async () => {
    await send("Bonjour depuis le test");
    await d.waitText("#messages", "pamplemousse");
    await idle(d);
    const req = requests.at(-1);
    assert.equal(req.auth, "Bearer cle-e2e");
    assert.equal(req.model, "zai-org-glm-5-1");
    assert.ok(req.stream, "requête en streaming");
    assert.equal(req.venice_parameters.include_venice_system_prompt, false, "invite système de Venice désactivée par défaut");
    assert.equal(req.venice_parameters.enable_web_search, "off");
    assert.deepEqual(req.stream_options, { include_usage: true });
    await d.waitText("#conv-list", "Bonjour depuis le test");
    await d.waitText("#activity", "Terminé");
  });

  await step(t, "modèle E2EE : attestation, messages chiffrés de bout en bout", async () => {
    await d.click("#new-chat");
    await setValue(d, "#model-select", "enclave-e2e");
    await send("Secret pour l'enclave");
    await d.waitText("#messages", "[enclave-e2e]");
    await idle(d);
    const att = requests.findLast((r) => r.path === "/v1/tee/attestation");
    assert.equal(att?.model, "enclave-e2e");
    const req = requests.at(-1);
    assert.equal(req.venice_parameters.enable_e2ee, true);
    assert.ok(!req.tools?.length, "aucun outil envoyé à l'enclave");
    assert.ok(!JSON.stringify(req.messages).includes("Secret"), "aucun texte en clair sur le réseau");
    assert.equal(req.decrypted.at(-1).content, "Secret pour l'enclave");
    await d.waitText(".msg.assistant:last-child", "chiffré de bout en bout");
    await d.waitText(".msg.assistant:last-child", "pamplemousse");
  });

  await step(t, "recherche web intégrée : sources citées", async () => {
    await d.click("#new-chat");
    await d.click("#web-toggle");
    await send("CHERCHE la météo de demain à Paris");
    await d.waitText("#messages", "temps pluvieux");
    await idle(d);
    const req = requests.at(-1);
    assert.equal(req.venice_parameters.enable_web_search, "auto");
    assert.equal(req.venice_parameters.enable_web_citations, true);
    assert.ok(!req.tools?.some((t) => t.function.name === "web_search"), "pas d'outil web_search avec la recherche intégrée");
    await d.waitText(".sources summary", "2 sources");
    const links = await d.exec(() => [...document.querySelectorAll(".msg.assistant .md a")].map((a) => [a.textContent, a.getAttribute("href")]));
    assert.deepEqual(links, [
      ["[1]", "https://meteofrance.example/paris"],
      ["[1]", "https://meteofrance.example/paris"],
      ["[2]", "https://infoclimat.example/paris"],
    ]);
    await d.click("#web-toggle");
  });

  await step(t, "génération d'image", async () => {
    await d.click("#new-chat");
    await d.waitVisible("#img-toggle");
    await d.click("#img-toggle");
    await d.waitFor(() => document.querySelector("#model-select").value === "image-e2e", { message: "modèle d'image par défaut" });
    await setValue(d, "#img-aspect", "16:9");
    await send("Un chat roux sur un toit de Venise");
    await d.waitVisible(".gen-image img");
    await idle(d);
    // Visionneuse : zoom puis fermeture.
    await d.click(".gen-image img");
    await d.waitFor(() => document.querySelector("#lightbox").open, { message: "visionneuse ouverte" });
    await d.click('#lightbox [data-lb="in"]');
    await d.waitFor(() => document.querySelector("#lb-zoom").textContent !== "100 %", { message: "zoom appliqué" });
    await d.click('#lightbox [data-lb="close"]');
    await d.waitFor(() => !document.querySelector("#lightbox").open, { message: "visionneuse fermée" });
    let req = requests.at(-1);
    assert.equal(req.path, "/v1/image/generate");
    assert.equal(req.prompt, "Un chat roux sur un toit de Venise");
    assert.deepEqual([req.width, req.height, req.safe_mode, req.format], [1280, 720, true, "webp"]);
    // Modèle à formats imposés : aspect_ratio au lieu de width/height.
    await setValue(d, "#model-select", "image-format-e2e");
    await d.waitFor(() => [...document.querySelectorAll("#img-aspect option")].length === 2, { message: "formats du modèle" });
    await setValue(d, "#img-aspect", "16:9");
    await d.click('.msg.assistant [data-act="retry"]');
    await d.waitFor(() => document.querySelectorAll(".gen-image img").length === 1 && !document.querySelector("#app").classList.contains("is-streaming"), { message: "nouvelle image" });
    req = requests.at(-1);
    assert.equal(req.model, "image-format-e2e");
    assert.equal(req.aspect_ratio, "16:9");
    assert.equal(req.width, undefined);
    // Variantes et graine réutilisée.
    const seed = requests.at(-1).seed;
    assert.ok(Number.isInteger(seed), "graine envoyée");
    await setValue(d, "#model-select", "image-e2e");
    await setValue(d, "#img-variants", "2");
    await send("Deux variantes d'un phare");
    await d.waitFor(() => document.querySelectorAll(".msg.assistant:last-child .gen-image img").length === 2, { message: "deux variantes" });
    await idle(d);
    assert.equal(requests.at(-1).variants, 2);
    await d.click('.msg.assistant:last-child [data-act="seed"]');
    await d.waitVisible("#seed-chip");
    const kept = requests.at(-1).seed;
    const count = await d.exec(() => document.querySelectorAll(".msg.assistant").length);
    await send("Même graine, autre lumière");
    await d.waitFor((n) => document.querySelectorAll(".msg.assistant").length === n + 1 && !document.querySelector("#app").classList.contains("is-streaming"), { message: "image avec la graine", args: [count] });
    assert.equal(requests.at(-1).seed, kept);
    await d.click("#seed-chip");
    await d.waitFor(() => document.querySelector("#seed-chip").hidden, { message: "graine libérée" });
    await setValue(d, "#img-variants", "1");
    // Retouches depuis la visionneuse.
    const before = await d.exec(() => document.querySelectorAll(".msg.assistant").length);
    await d.click(".msg.assistant:last-child .gen-image img");
    await d.waitFor(() => document.querySelector("#lightbox").open, { message: "visionneuse" });
    await d.click('#lightbox [data-lb="upscale2"]');
    await d.waitText("#lb-status", "Terminé");
    assert.equal(requests.at(-1).path, "/v1/image/upscale");
    assert.equal(requests.at(-1).scale, 2);
    await d.click('#lightbox [data-lb="background"]');
    await d.waitText("#lb-status", "Terminé");
    assert.equal(requests.at(-1).path, "/v1/image/background-remove");
    await d.click('#lightbox [data-lb="edit"]');
    await d.type("#lb-edit-input", "ajoute une lune");
    await d.click("#lb-edit button[type=submit]");
    await d.waitText("#lb-status", "Terminé");
    assert.equal(requests.at(-1).path, "/v1/image/edit");
    assert.equal(requests.at(-1).prompt, "ajoute une lune");
    assert.equal(requests.at(-1).model, "edit-e2e");
    await d.click('#lightbox [data-lb="close"]');
    assert.equal(await d.exec(() => document.querySelectorAll(".msg.assistant").length), before + 3);
    // Galerie.
    await d.click("#open-gallery");
    await d.waitFor(() => document.querySelectorAll("#gallery-grid .gallery-item").length >= 6, { message: "images dans la galerie" });
    await d.type("#gallery-search", "phare");
    await d.waitFor(() => document.querySelectorAll("#gallery-grid .gallery-item").length === 2, { message: "filtre de la galerie" });
    await d.click("#gallery-grid .gallery-item");
    await d.waitVisible("#lb-open");
    assert.equal(await d.exec(() => document.querySelector("#lb-actions").hidden), true);
    await d.click("#lb-open");
    await d.waitFor(() => !document.querySelector("#gallery").open && !document.querySelector("#lightbox").open, { message: "retour à la conversation" });
    await d.click("#img-toggle");
    await d.waitFor(() => document.querySelector("#model-select").value === "zai-org-glm-5-1", { message: "retour aux modèles de texte" });
  });

  await step(t, "vidéo et musique", async () => {
    await d.click("#new-chat");
    await d.waitVisible("#vid-toggle");
    await d.click("#vid-toggle");
    await d.waitFor(() => document.querySelector("#model-select").value === "video-e2e", { message: "modèle vidéo" });
    await setValue(d, '#media-opts [data-opt="duration"]', "10s");
    await send("Un drone survole Venise au lever du soleil");
    await d.waitVisible(".gen-media video", 30000);
    await idle(d);
    let q = requests.filter((r) => r.path === "/v1/video/queue").at(-1);
    assert.deepEqual([q.model, q.duration, q.aspect_ratio, q.resolution, q.audio], ["video-e2e", "10s", "16:9", "720p", true]);
    await d.waitText("#activity", "0,250");
    await d.click("#music-toggle");
    await d.waitFor(() => document.querySelector("#model-select").value === "music-e2e", { message: "modèle de musique" });
    await d.click('#media-opts [data-opt-toggle="instrumental"]');
    await setValue(d, "#input", "Jazz calme au piano\nParoles :\nla la la", "input");
    await d.click("#send-btn");
    await d.waitVisible(".gen-media audio", 30000);
    await idle(d);
    q = requests.filter((r) => r.path === "/v1/audio/queue").at(-1);
    assert.deepEqual([q.prompt, q.lyrics_prompt, q.force_instrumental, q.duration_seconds], ["Jazz calme au piano", "la la la", true, 30]);
    await d.click("#music-toggle");
    await d.waitFor(() => document.querySelector("#model-select").value === "zai-org-glm-5-1", { message: "retour au texte" });
  });

  await step(t, "transcription d'un fichier audio et clonage de voix", async () => {
    await d.click("#new-chat");
    // Dépôt d'un fichier audio : transcrit puis joint comme texte.
    await d.exec(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(4096)], "memo-e2e.mp3", { type: "audio/mpeg" }));
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
    });
    await d.waitText("#attachments", "memo-e2e.mp3 (transcription)");
    await send("Résume ce mémo");
    await idle(d);
    const sent = requests.filter((r) => r.messages).at(-1).messages.at(-1).content;
    assert.ok(sent.includes("Transcription simulée du mémo"), sent);
    // Clonage de voix depuis les réglages.
    await d.click("#open-settings");
    await d.click('.settings-tabs [data-tab="tools"]');
    await d.type("#s-clone-name", "Voix test");
    await d.exec(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(8192)], "voix.wav", { type: "audio/wav" }));
      const input = document.querySelector("#s-clone-file");
      input.files = dt.files;
      input.dispatchEvent(new Event("change"));
    });
    await d.waitText("#s-clone-status", "Voix test");
    assert.equal(await d.exec(() => document.querySelector("#s-tts-voice").value), "vv_e2e123");
    assert.equal(requests.filter((r) => r.path === "/v1/audio/voices").at(-1).model, "tts-chatterbox-hd");
    await d.click("#settings-cancel");
  });

  await step(t, "plusieurs instructions système au choix", async () => {
    await d.click("#open-settings");
    await d.waitFor(() => document.querySelector("#settings").open, { message: "réglages ouverts" });
    for (const [name, text] of [["Admin", "Tu es admin. MARQUEUR-ADMIN"], ["Traducteur", "Tu traduis. MARQUEUR-TRAD"]]) {
      await d.click("#s-prompt-add");
      await d.type(".prompt-row:last-child [data-f=name]", name);
      await d.type(".prompt-row:last-child [data-f=text]", text);
    }
    await d.click(".prompt-row:last-child [data-f=default]");
    await d.click("#settings-save");
    await d.waitFor(() => !document.querySelector("#settings").open, { message: "réglages enregistrés" });
    await d.click("#new-chat");
    await d.waitFor(() => !document.querySelector("#prompt-select").hidden, { message: "menu des instructions" });
    assert.equal(await d.exec(() => document.querySelector("#prompt-select").selectedOptions[0].textContent), "Traducteur");
    await send("INSTRUCTIONS : lesquelles ?");
    await d.waitText("#messages", "Instructions reçues : MARQUEUR-TRAD");
    await idle(d);
    const admin = await d.exec(() => [...document.querySelectorAll("#prompt-select option")].find((o) => o.textContent === "Admin").value);
    await setValue(d, "#prompt-select", admin);
    await send("INSTRUCTIONS : et maintenant ?");
    await d.waitText("#messages", "Instructions reçues : MARQUEUR-ADMIN");
    await idle(d);
  });

  await step(t, "effort de raisonnement et personnage Venice", async () => {
    await d.click("#new-chat");
    await setValue(d, "#prompt-select", "");
    await d.waitVisible("#effort-select");
    await setValue(d, "#effort-select", "high");
    await send("Question avec effort élevé");
    await d.waitText("#messages", "pamplemousse");
    await idle(d);
    assert.equal(requests.at(-1).reasoning_effort, "high");
    await setValue(d, "#effort-select", "off");
    await send("Question sans réflexion");
    await idle(d);
    assert.equal(requests.at(-1).venice_parameters.disable_thinking, true);
    assert.equal(requests.at(-1).reasoning_effort, undefined);
    await setValue(d, "#prompt-select", "__char");
    await d.waitFor(() => document.querySelector("#char-dialog").open, { message: "recherche de personnages" });
    await d.type("#char-search", "coach");
    await d.waitText("#char-list", "Coach E2E");
    await d.waitFor(() => document.querySelectorAll("#char-list .char-item").length === 1, { message: "filtrage" });
    await d.click("#char-list .char-item");
    await d.waitFor(() => document.querySelector("#prompt-select").selectedOptions[0]?.textContent.includes("Coach E2E"), { message: "personnage affiché" });
    await send("Bonjour coach");
    await idle(d);
    assert.equal(requests.at(-1).venice_parameters.character_slug, "coach-e2e");
  });

  await step(t, "modèles de messages et alerte de solde", async () => {
    await d.click("#open-settings");
    await d.waitFor(() => document.querySelector("#settings").open, { message: "réglages ouverts" });
    await d.click("#s-template-add");
    await d.type("#s-templates .prompt-row:last-child [data-f=name]", "resume");
    await d.type("#s-templates .prompt-row:last-child [data-f=text]", "Résume en 3 points :");
    await d.click('.settings-tabs [data-tab="usage"]');
    await d.type("#s-balance-alert", "5");
    await d.click("#settings-save");
    await d.waitFor(() => !document.querySelector("#settings").open, { message: "réglages enregistrés" });
    await d.click("#new-chat");
    await d.type("#input", "/res");
    await d.waitVisible("#slash-menu");
    await d.waitText("#slash-menu", "/resume");
    await d.exec(() => document.querySelector("#input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.equal(await d.exec(() => document.querySelector("#input").value), "Résume en 3 points :");
    await send(" ce texte.");
    await idle(d);
    await d.waitText("#toast", "Solde Venice bas");
  });

  await step(t, "versions d'un message et comparaison de modèles", async () => {
    const act = (sel) => d.exec((s) => document.querySelector(s).click(), sel);
    await d.click("#new-chat");
    await setValue(d, "#prompt-select", "");
    await setValue(d, "#effort-select", "");
    await send("Première question");
    await d.waitText("#messages", "Première question. Le mot");
    await idle(d);
    await act('.msg.user [data-act="edit"]');
    await setValue(d, ".edit-box textarea", "Question modifiée", "input");
    await act('.edit-box [data-edit="send"]');
    await d.waitText("#messages", "Question modifiée. Le mot");
    await idle(d);
    await d.waitText(".branch-nav", "2/2");
    await act('.branch-nav [data-act="branch-prev"]');
    await d.waitText(".branch-nav", "1/2");
    await d.waitText("#messages", "Première question. Le mot");
    assert.ok(!(await d.text("#messages")).includes("Question modifiée"), "seule la version affichée est visible");
    await act('.msg.assistant:last-child [data-act="retry"]');
    await idle(d);
    await d.waitText(".branch-nav", "3/3");
    // Comparaison avec un second modèle.
    await setValue(d, "#compare-select", "modele-e2e-vision");
    await send("Compare les réponses");
    await d.waitFor(() => document.querySelectorAll(".msg.assistant:last-child .cmp-col .md").length === 2, { message: "deux réponses côte à côte" });
    await idle(d);
    const models = requests.slice(-2).map((r) => r.model).sort();
    assert.deepEqual(models, ["modele-e2e-vision", "zai-org-glm-5-1"]);
    await act('.msg.assistant:last-child [data-act="keep-compare"]');
    await d.waitFor(() => document.querySelector(".msg.assistant:last-child .cmp-head strong").textContent === "modele-e2e-vision", { message: "réponse gardée" });
    await setValue(d, "#compare-select", "");
    await send("Et ensuite ?");
    await idle(d);
    assert.equal(requests.at(-1).messages.filter((m) => m.role === "assistant").at(-1).content.includes("[modele-e2e-vision]"), true, "la réponse gardée sert de contexte");
  });

  await step(t, "raisonnement <think> séparé de la réponse", async () => {
    await send("RÉFLÉCHIS puis conclus");
    await d.waitText("#messages", "Conclusion visible.");
    await idle(d);
    const last = await d.exec(() => [...document.querySelectorAll(".msg.assistant")].pop().querySelector(":scope > .md").textContent);
    assert.ok(!last.includes("raisonnement caché"), last);
    await d.waitFor(() => [...document.querySelectorAll(".reasoning")].pop()?.textContent.includes("raisonnement caché"), { message: "bloc de raisonnement" });
  });

  await step(t, "recherche dans le contenu des conversations", async () => {
    await d.type("#search", "pamplemousse");
    await d.waitFor(() => document.querySelector("#conv-list mark")?.textContent?.toLowerCase() === "pamplemousse", {
      message: "extrait surligné",
    });
    await setValue(d, "#search", "", "input");
  });

  await step(t, "réglages", async () => {
    await d.click("#open-settings");
    await d.waitFor(() => document.querySelector("#settings").open, { message: "réglages ouverts" });
    await d.click('.settings-tabs [data-tab="code"]');
    await d.waitVisible('#settings .tab[data-tab="code"]');
    await d.click("#settings-cancel");
    await d.waitFor(() => !document.querySelector("#settings").open, { message: "réglages fermés" });
  });

  await step(t, "projet : consignes envoyées au modèle", async () => {
    await setValue(d, "#project-select", "__new");
    await d.waitFor(() => document.querySelector("#project-dialog").open, { message: "fenêtre du projet" });
    await d.type("#p-name", "Projet E2E");
    await d.type("#p-instructions", "Respecter CONSIGNE-PROJET-E2E.");
    await d.click("#p-save");
    await d.waitFor(() => !document.querySelector("#project-dialog").open, { message: "projet enregistré" });
    await d.click("#new-chat");
    await d.waitText(".welcome", "Projet E2E");
    await send("PROJET : as-tu les consignes ?");
    await d.waitText("#messages", "Projet reçu : CONSIGNE-PROJET-E2E");
    await idle(d);
  });

  await step(t, "projet volumineux : recherche sémantique (index mis en cache)", async () => {
    await setValue(d, "#project-select", "proj-semantique");
    await d.click("#new-chat");
    await send("Où se trouve la copie de secours ?");
    await d.waitText("#messages", "Passage absent");
    await idle(d);
    assert.ok(!requests.some((r) => r.path === "/v1/embeddings"), "aucun embedding sans l'option");
    await d.click("#open-settings");
    await d.click('.settings-tabs [data-tab="tools"]');
    await d.click("#s-semantic");
    await d.click("#settings-save");
    await d.waitFor(() => !document.querySelector("#settings").open, { message: "réglages enregistrés" });
    await send("Et la copie de secours, alors ?");
    await d.waitText("#messages", "Passage trouvé : NAS");
    await idle(d);
    const first = requests.filter((r) => r.path === "/v1/embeddings");
    assert.ok(first.some((r) => r.count > 10), "morceaux du projet vectorisés");
    assert.equal(first[0].model, "text-embedding-bge-m3");
    await send("Encore la copie de secours ?");
    await d.waitFor(() => document.querySelectorAll(".msg.assistant").length === 3, { message: "troisième réponse" });
    await idle(d);
    const again = requests.filter((r) => r.path === "/v1/embeddings").slice(first.length);
    assert.deepEqual(again.map((r) => r.count), [1], "seule la question est vectorisée (index en cache)");
  });

  await step(t, "code : AGENTS.md chargé", async () => {
    await d.click('.mode-tabs [data-mode="code"]');
    await d.waitText(".welcome", "Nouvelle session de code");
    await d.click(".welcome [data-ws]");
    await d.waitText(".welcome", "AGENTS.md");
    await send("CONSIGNES : lesquelles ?");
    await d.waitText("#messages", "Consignes reçues : RÈGLE-E2E-42");
    await idle(d);
    assert.equal(requests.at(-1).model, "qwen3-coder-e2e", "modèle de code par défaut (rôle default_code)");
  });

  await step(t, "code : écriture approuvée", async () => {
    await send("ÉCRIS un fichier de notes");
    await d.waitVisible('[data-approve="allow"]');
    assert.ok(!existsSync(join(workspace, "notes/e2e.txt")), "rien d'écrit avant l'approbation");
    await d.click('[data-approve="allow"]');
    await d.waitText("#messages", "Outil terminé");
    await idle(d);
    assert.equal(readFileSync(join(workspace, "notes/e2e.txt"), "utf8"), "créé par le test e2e\n");
  });

  await step(t, "code : écriture refusée", async () => {
    await send("ÉCRIS encore");
    await d.click('[data-approve="deny"]');
    await d.waitText("#activity", "refusé");
    await idle(d);
  });

  await step(t, "mode par défaut des nouvelles sessions", async () => {
    await d.click("#open-settings");
    await d.click('.settings-tabs [data-tab="code"]');
    assert.equal(await d.exec(() => document.querySelector("#s-permission").value), "ask");
    await setValue(d, "#s-permission", "auto");
    await d.click("#settings-save");
    await d.waitFor(() => !document.querySelector("#settings").open, { message: "réglages enregistrés" });
    await d.click("#new-chat");
    await d.click(".welcome [data-ws]");
    assert.equal(await d.exec(() => document.querySelector("#perm-select").value), "auto");
    // Autonome : l'écriture se fait sans demande d'approbation.
    await send("ÉCRIS sans demander");
    await d.waitText("#messages", "Outil terminé");
    await idle(d);
    assert.equal(await d.exec(() => document.querySelectorAll("[data-approve]").length), 0);
  });

  await step(t, "sauvegarde chiffrée : export puis import", async () => {
    await d.click("#open-settings");
    await d.waitFor(() => document.querySelector("#settings").open, { message: "réglages ouverts" });
    await d.type("#backup-pass", "phrase de passe e2e");
    await d.click("#backup-export");
    await d.waitText("#toast", "Sauvegarde chiffrée");
    const archive = readFileSync(app.dirs.backup);
    assert.equal(archive.subarray(0, 4).toString(), "VDBK");
    assert.ok(!archive.includes("pamplemousse"), "aucune donnée en clair dans l'archive");
    await setValue(d, "#backup-pass", "mauvaise phrase", "input");
    await d.click("#backup-import");
    await d.waitText("#toast", "incorrecte");
    await setValue(d, "#backup-pass", "phrase de passe e2e", "input");
    await d.click("#backup-import");
    await d.waitText("#toast", "Importé");
    const convs = await d.exec(() => document.querySelectorAll("#conv-list [data-id]").length);
    assert.match(await d.text("#toast"), new RegExp(`Importé : \\d+ conversation`));
    assert.ok(convs > 0, "conversations toujours listées");
    await d.click("#settings-cancel");
  });
});
