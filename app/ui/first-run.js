// Startup page: shows the state the app sends (command `startup_status`, event
// `mango://status`): the startup in progress, the choice of models to download, the download, the error.
// When startup ends the app moves the window to the web UI and this page disappears by itself.
"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// --- texts ------------------------------------------------------------------------------------
// Every text of the page, in both languages. Elements of index.html get theirs through `data-text`
// and `data-placeholder`. The language is the app's (`language` command).

const TEXTS = {
  it: {
    locale: "it-IT",
    wordsPerToken: 0.65, // Italian: serves to give an idea, not to measure
    stepStartup: "Preparazione",
    stepEngine: "Modello di linguaggio",
    stepVoice: "Dettatura",
    stepAgent: "Assistente",
    stepPreparing: "Preparazione del modello",
    startupTitle: "Sto preparando tutto",
    readyTitle: "Pronto, apro Mango Code",
    startupNote: "Di solito ci vogliono da venti secondi a un minuto.",
    yourComputer: "Il tuo computer",
    models: "Modelli",
    fastestNote:
      "«Probabilmente il più veloce»: sulla scheda video un modello va più veloce che sul processore; a parità di posto vince quello che legge meno pesi per ogni parola che scrive.",
    optimizeIntro:
      "Per ottimizzare Mango Code su questo computer, usa un'AI di frontiera (per esempio Claude Code) con la skill di ottimizzazione inclusa:",
    optimizeOpen: "apri la cartella della skill",
    otherModels: "Altri modelli",
    otherIntro:
      "I modelli qui sopra sono quelli provati con Mango Code. Ne puoi usare altri: cercali su Hugging Face, incolla il link di un modello GGUF o scegli un file che hai già sul computer. Prima di aggiungerlo, ti dico se ci sta nella memoria del computer.",
    searchPlaceholder: "Cerca per nome o incolla un link di Hugging Face",
    search: "Cerca",
    chooseFile: "Scegli un file…",
    add: "Aggiungi",
    addAnyway: "Aggiungi comunque",
    close: "Chiudi",
    tokenSummary: "Token di Hugging Face",
    tokenNote:
      "Serve solo per i modelli protetti: accetta i termini sulla pagina del modello, poi incolla qui il tuo token. Resta nel Gestore credenziali di Windows, mai in un file.",
    save: "Salva",
    remove: "Togli",
    download: "Scarica e continua",
    continue: "Continua",
    cancel: "Annulla",
    downloadNote: "Se chiudi Mango Code, al prossimo avvio lo scaricamento riprende da dove era arrivato.",
    errorHint: "Puoi riprovare. Se il problema si ripete, premi «Segnala il problema»: i log e, se lo lasci acceso, una schermata della finestra arrivano a Mango Code, senza i tuoi dati personali.",
    technicalDetails: "Dettagli tecnici",
    copyDetails: "Copia i dettagli",
    retry: "Riprova",
    openLogs: "Apri i log",
    report: "Segnala il problema",
    reportScreenshot: "Includi una schermata della finestra (aiuta a capire il problema, ma mostra quello che c'è nella finestra)",
    reportFiles: "Allega file",
    reportFilesHint: "Immagini, documenti o altro. I file partono così come sono: non vengono anonimizzati.",
    reportFilesTooLarge: "«{name}» pesa {size}: gli allegati possono arrivare a {max} in tutto.",
    reportSent: "Inviato, grazie.",
    reportSaved: "Su GitHub si è aperta la segnalazione: allega il file salvato sul Desktop, ",
    cannotReport: "Impossibile preparare la segnalazione: ",
    technicalDetailMarker: " (dettaglio tecnico:",
    // choice page
    choiceTitleCancelable: "Modelli e motore",
    choiceTitleFirstRun: "Prima di cominciare, scegli un modello",
    choiceIntroCancelable: "Aggiungi un modello o cambia il motore. Se scarichi qualcosa, l'assistente si riavvia.",
    choiceIntroFirstRun:
      "Mango Code lavora con un modello di linguaggio che gira sul tuo computer. Un modello è un file molto grande, da scaricare una volta sola. Ne puoi aggiungere altri più avanti, dall'icona di Mango Code nella barra delle applicazioni.",
    graphicsCards: "Schede video",
    noGraphicsCard: "Nessuna scheda video utilizzabile",
    noGraphicsCardNote: "Il modello userà il processore: funziona, ma è più lento.",
    processor: "Processore",
    cores: (n) => `${n} core`,
    memory: "Memoria",
    engine: "Motore",
    alreadyInstalled: "Già installato",
    toDownload: (size) => `Da scaricare: ${size}`,
    setup: "Configurazione",
    setupOptimized: "Ottimizzata per il tuo computer",
    setupGeneral: "Generale",
    setupOptimizedNote: (n) =>
      `Per ${n === 1 ? "un modello" : n + " modelli"} c'è un assetto messo a punto proprio su queste schede.`,
    setupGeneralNote: "Va bene su ogni computer, senza assetti specifici per le tue schede.",
    badgeOnComputer: "Già sul computer",
    badgeRecommended: "Consigliato",
    badgeFastest: "Probabilmente il più veloce",
    badgeOptimized: "Ottimizzato",
    badgeUser: "Tuo",
    badgeProtected: "Protetto",
    optimizedTitle: "Assetto messo a punto per queste schede: ",
    onGpu: "Sulla scheda video",
    onCpu: "Sul processore · più lento",
    contextLabel: (k) => `${k}k di contesto`,
    memoryHint: (reason, thousandWords) => `${reason} Ricorda circa ${thousandWords} mila parole di conversazione.`,
    doesNotFit: "Non ci sta in questo computer",
    filesOnComputer: "File già sul computer",
    alsoReadsImages: "Legge anche le immagini",
    removeFromList: "Togli dall'elenco",
    removeFromListTitle: "Il modello esce da questo elenco; i file già scaricati restano dove sono.",
    chooseAtLeastOne: "Scegli almeno un modello.",
    everythingThere: "Per questa scelta c'è già tutto sul computer.",
    cannotStart: "Non riesco a cominciare: ",
    cannotCancel: "Non riesco ad annullare: ",
    // other models
    noResults: "Nessun modello GGUF con questo nome.",
    downloadsAndLikes: (downloads, likes) => `${downloads} scaricamenti · ${likes} mi piace`,
    recommendedVariant: "Consigliata",
    imagesOption: (size) => `Legge anche le immagini (circa ${size} in più)`,
    lookingOnHuggingFace: "Guardo su Hugging Face…",
    modelsFilter: "Modelli GGUF",
    readingFile: "Leggo il file…",
    addingModel: "Aggiungo il modello…",
    addedToList: "Aggiunto all'elenco. Premi «Scarica e continua» per averlo sul computer.",
    removingModel: "Tolgo il modello…",
    warningLabel: "Attenzione: ",
    tokenSavedPlaceholder: "Token salvato. Incollane un altro per sostituirlo",
    checkingToken: "Controllo il token…",
    tokenSaved: "Token salvato nel Gestore credenziali di Windows.",
    tokenRemoved: "Token tolto.",
    // download
    waiting: "In attesa",
    done: "Fatto",
    connecting: "Mi collego…",
    progress: (done, total, percent) => `${done} di ${total} · ${percent}%`,
    // error
    logsFolder: "Cartella dei log: ",
    cannotRetry: "Non riesco a riprovare: ",
    cannotOpenLogs: "Non riesco ad aprire i log: ",
    detailsCopied: "Dettagli copiati negli appunti.",
    copyFailed: "Copia non riuscita: seleziona il testo a mano.",
    cannotReadState: "Mango Code non riesce a leggere il proprio stato",
  },
  en: {
    locale: "en-US",
    wordsPerToken: 0.75,
    stepStartup: "Preparing",
    stepEngine: "Language model",
    stepVoice: "Dictation",
    stepAgent: "Assistant",
    stepPreparing: "Preparing the model",
    startupTitle: "Getting everything ready",
    readyTitle: "Ready, opening Mango Code",
    startupNote: "It usually takes between twenty seconds and a minute.",
    yourComputer: "Your computer",
    models: "Models",
    fastestNote:
      "\"Probably the fastest\": a model runs faster on the graphics card than on the processor; at equal placement, the one that reads fewer weights for each word it writes wins.",
    optimizeIntro:
      "To optimize Mango Code on this computer, use a frontier AI (for example Claude Code) with the included optimization skill:",
    optimizeOpen: "open the skill folder",
    otherModels: "Other models",
    otherIntro:
      "The models above are the ones tested with Mango Code. You can use others: look for them on Hugging Face, paste the link of a GGUF model or choose a file you already have on the computer. Before adding it, I tell you whether it fits in the computer's memory.",
    searchPlaceholder: "Search by name or paste a Hugging Face link",
    search: "Search",
    chooseFile: "Choose a file…",
    add: "Add",
    addAnyway: "Add anyway",
    close: "Close",
    tokenSummary: "Hugging Face token",
    tokenNote:
      "Only needed for protected models: accept the terms on the model page, then paste your token here. It stays in the Windows Credential Manager, never in a file.",
    save: "Save",
    remove: "Remove",
    download: "Download and continue",
    continue: "Continue",
    cancel: "Cancel",
    downloadNote: "If you close Mango Code, the download resumes where it left off at the next start.",
    errorHint: "You can try again. If the problem happens again, press \"Report a problem\": the logs and, if you leave it on, a screenshot of the window reach Mango Code, without your personal data.",
    technicalDetails: "Technical details",
    copyDetails: "Copy the details",
    retry: "Retry",
    openLogs: "Open the logs",
    report: "Report a problem",
    reportScreenshot: "Include a screenshot of the window (it helps to understand the problem, but it shows what is in the window)",
    reportFiles: "Attach files",
    reportFilesHint: "Images, documents or anything else. Files are sent as they are: they are not anonymized.",
    reportFilesTooLarge: "«{name}» is {size}: attachments can add up to {max} in total.",
    reportSent: "Sent, thank you.",
    reportSaved: "The issue is open on GitHub: attach the file saved on the Desktop, ",
    cannotReport: "Cannot prepare the report: ",
    technicalDetailMarker: " (technical detail:",
    choiceTitleCancelable: "Models and engine",
    choiceTitleFirstRun: "Before you start, choose a model",
    choiceIntroCancelable: "Add a model or change the engine. If you download something, the assistant restarts.",
    choiceIntroFirstRun:
      "Mango Code works with a language model that runs on your computer. A model is a very large file, downloaded only once. You can add more later, from the Mango Code icon in the taskbar.",
    graphicsCards: "Graphics cards",
    noGraphicsCard: "No usable graphics card",
    noGraphicsCardNote: "The model will use the processor: it works, but it is slower.",
    processor: "Processor",
    cores: (n) => `${n} cores`,
    memory: "Memory",
    engine: "Engine",
    alreadyInstalled: "Already installed",
    toDownload: (size) => `To download: ${size}`,
    setup: "Setup",
    setupOptimized: "Optimized for your computer",
    setupGeneral: "General",
    setupOptimizedNote: (n) =>
      `For ${n === 1 ? "one model" : n + " models"} there is a tune made for exactly these graphics cards.`,
    setupGeneralNote: "Works on every computer, with no tune specific to your graphics cards.",
    badgeOnComputer: "Already on the computer",
    badgeRecommended: "Recommended",
    badgeFastest: "Probably the fastest",
    badgeOptimized: "Optimized",
    badgeUser: "Yours",
    badgeProtected: "Protected",
    optimizedTitle: "Tune made for these graphics cards: ",
    onGpu: "On the graphics card",
    onCpu: "On the processor · slower",
    contextLabel: (k) => `${k}k context`,
    memoryHint: (reason, thousandWords) => `${reason} It remembers about ${thousandWords} thousand words of conversation.`,
    doesNotFit: "Does not fit in this computer",
    filesOnComputer: "Files already on the computer",
    alsoReadsImages: "Also reads images",
    removeFromList: "Remove from the list",
    removeFromListTitle: "The model leaves this list; files already downloaded stay where they are.",
    chooseAtLeastOne: "Choose at least one model.",
    everythingThere: "Everything for this choice is already on the computer.",
    cannotStart: "Cannot start: ",
    cannotCancel: "Cannot cancel: ",
    noResults: "No GGUF model with this name.",
    downloadsAndLikes: (downloads, likes) => `${downloads} downloads · ${likes} likes`,
    recommendedVariant: "Recommended",
    imagesOption: (size) => `Also reads images (about ${size} more)`,
    lookingOnHuggingFace: "Looking on Hugging Face…",
    modelsFilter: "GGUF models",
    readingFile: "Reading the file…",
    addingModel: "Adding the model…",
    addedToList: "Added to the list. Press \"Download and continue\" to have it on the computer.",
    removingModel: "Removing the model…",
    warningLabel: "Warning: ",
    tokenSavedPlaceholder: "Token saved. Paste another to replace it",
    checkingToken: "Checking the token…",
    tokenSaved: "Token saved in the Windows Credential Manager.",
    tokenRemoved: "Token removed.",
    waiting: "Waiting",
    done: "Done",
    connecting: "Connecting…",
    progress: (done, total, percent) => `${done} of ${total} · ${percent}%`,
    logsFolder: "Logs folder: ",
    cannotRetry: "Cannot retry: ",
    cannotOpenLogs: "Cannot open the logs: ",
    detailsCopied: "Details copied to the clipboard.",
    copyFailed: "Copy failed: select the text by hand.",
    cannotReadState: "Mango Code cannot read its own state",
  },
};

// Until the app answers, the Windows display language (the same rule the app uses without a setting).
let t = TEXTS[navigator.language.startsWith("it") ? "it" : "en"];

function applyLanguage(code) {
  t = TEXTS[code];
  document.documentElement.lang = code;
  for (const el of document.querySelectorAll("[data-text]")) el.textContent = t[el.dataset.text];
  for (const el of document.querySelectorAll("[data-placeholder]")) el.placeholder = t[el.dataset.placeholder];
  $("startup-title").textContent = t.startupTitle;
}

// --- views ------------------------------------------------------------------------------------

const ORDER = ["startup", "engine", "voice", "agent", "preparing", "ready"];
const $ = (id) => document.getElementById(id);
const stepRows = [...document.querySelectorAll("#steps li")];
const VIEWS = ["starting", "choice", "download", "error"];

let received = false;    // a state has already arrived (an event always beats the initial read)
let lastError = null;    // the last error state, to go back to the screen if "Retry" fails
let choice = null;       // the choice shown now (the app's assessment), for the summary
let shownChoice = "";    // the same choice arriving twice does not reset what the user already ticked

function view(name) {
  if (name !== "choice") {
    shownChoice = "";
    choice = null;
  }
  for (const v of VIEWS) $(v).hidden = v !== name;
  document.querySelector("main").dataset.view = name;
}

// --- numbers for the reader -------------------------------------------------------------------

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const num = (n, digits = 1) => n.toLocaleString(t.locale, { maximumFractionDigits: digits });
const size = (bytes) => (bytes >= GB ? `${num(bytes / GB)} GB` : `${num(Math.max(1, Math.round(bytes / MB)), 0)} MB`);
const memory = (mib) => (mib >= 1024 ? `${num(mib / 1024, mib >= 10240 ? 0 : 1)} GB` : `${num(mib, 0)} MB`);
const thousandWords = (context) => num(Math.max(1, Math.round((context * t.wordsPerToken) / 1000)), 0);
const contextLabel = (tokens) => t.contextLabel(num(Math.round(tokens / 1024), 0));

// Where a model runs, in few words: all on the graphics cards or all on the processor (never split).
const where = (placement) => (placement === "gpu" ? t.onGpu : t.onCpu);

// --- startup in progress ----------------------------------------------------------------------

function showStartup(s) {
  view("starting");
  const pos = ORDER.indexOf(s.stage);
  if (pos < 0) return;
  $("startup-title").textContent = s.stage === "ready" ? t.readyTitle : t.startupTitle;
  for (const li of stepRows) {
    const step = li.dataset.step;
    // dictation is optional and model preparation exists only if it was not already ready: they appear when they start
    if (step === s.stage && li.dataset.optional !== undefined) li.hidden = false;
    const i = ORDER.indexOf(step);
    li.classList.toggle("done", i < pos || s.stage === "ready");
    li.classList.toggle("active", i === pos && s.stage !== "ready");
    const name = li.querySelector(".name").textContent;
    li.querySelector(".detail").textContent = i === pos && s.detail && s.detail !== name ? s.detail : "";
  }
}

// --- model choice -----------------------------------------------------------------------------

// A row of the "Your computer" card: title, one or more lines of text, a smaller note.
function row(title, lines, note) {
  const dt = document.createElement("dt");
  dt.textContent = title;
  const dd = document.createElement("dd");
  for (const l of lines) {
    const d = document.createElement("div");
    d.textContent = l;
    dd.append(d);
  }
  if (note) {
    const s = document.createElement("small");
    s.textContent = note;
    dd.append(s);
  }
  return [dt, dd];
}

function showComputer(assessment) {
  const c = assessment.computer;
  const el = $("computer");
  el.replaceChildren();
  const optimized = assessment.models.filter((m) => m.engine.profile).length;
  const rows = [
    c.gpus.length
      ? row(t.graphicsCards, c.gpus.map((g) => `${g.name} · ${memory(g.memory_mib)}`))
      : row(t.graphicsCards, [t.noGraphicsCard], t.noGraphicsCardNote),
    row(t.processor, [c.cpu], t.cores(c.cores)),
    row(t.memory, [memory(c.ram_mib)]),
    row(t.engine, [assessment.engine.label], assessment.engine.installed ? t.alreadyInstalled : t.toDownload(size(assessment.engine.bytes))),
    row(
      t.setup,
      [optimized ? t.setupOptimized : t.setupGeneral],
      optimized ? t.setupOptimizedNote(optimized) : t.setupGeneralNote,
    ),
  ];
  for (const [a, b] of rows) el.append(a, b);
}

function badge(text, className) {
  const s = document.createElement("span");
  s.className = "badge " + (className || "");
  s.textContent = text;
  return s;
}

function modelItem(m, ticked) {
  const li = document.createElement("li");
  li.className = "model" + (m.placement ? "" : " no-fit");
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = m.key;
  checkbox.disabled = !m.placement;
  checkbox.checked = ticked ? ticked.has(m.key) : m.recommended;
  checkbox.addEventListener("change", summary);
  const body = document.createElement("span");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = m.label;
  if (m.present && m.engine.installed) name.append(badge(t.badgeOnComputer, "ok"));
  else if (m.recommended) name.append(badge(t.badgeRecommended));
  if (m.fastest) name.append(badge(t.badgeFastest, "fastest"));
  if (m.engine.profile) {
    const b = badge(t.badgeOptimized);
    b.title = t.optimizedTitle + m.engine.profile;
    name.append(b);
  }
  // Where it runs, written first: whoever picks a model that goes on the processor reads it before downloading it. For
  // the user's models only where, without the context.
  const place = document.createElement("span");
  place.className = "where" + (m.placement === "cpu" ? " cpu" : "");
  if (m.placement) {
    place.textContent = m.user ? where(m.placement) : `${where(m.placement)} · ${contextLabel(m.context)}`;
    place.title = t.memoryHint(m.reason, thousandWords(m.context));
  } else {
    place.className = "why";
    place.textContent = t.doesNotFit + ": " + m.reason;
  }
  const meta = document.createElement("span");
  meta.className = "meta";
  const pieces = [m.present ? t.filesOnComputer : t.toDownload(size(m.bytes))];
  if (m.images) pieces.push(t.alsoReadsImages);
  meta.textContent = pieces.join(" · ");
  body.append(name, place, meta);
  label.append(checkbox, body);
  li.append(label);
  if (m.user) {
    name.append(badge(t.badgeUser));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link remove";
    remove.textContent = t.removeFromList;
    remove.title = t.removeFromListTitle;
    remove.addEventListener("click", () => removeModel(m.key));
    li.append(remove);
  }
  return li;
}

function chosen() {
  return [...document.querySelectorAll("#models input:checked")].map((c) => c.value);
}

// How much would be downloaded with the choice made: the missing weights and the engines not yet installed
// (only one even if two models share it).
function toDownload() {
  const models = choice.assessment.models.filter((m) => chosen().includes(m.key));
  const engines = new Map();
  for (const m of models) if (!m.engine.installed) engines.set(m.engine.name + "/" + m.engine.build, m.engine.bytes);
  const weights = models.filter((m) => !m.present).reduce((total, m) => total + m.bytes, 0);
  return { n: models.length, bytes: weights + [...engines.values()].reduce((total, b) => total + b, 0) };
}

function summary() {
  const { n, bytes } = toDownload();
  $("start-download").disabled = n === 0;
  $("start-download").textContent = bytes ? t.download : t.continue;
  $("summary").textContent = n === 0 ? t.chooseAtLeastOne : bytes ? t.toDownload(size(bytes)) : t.everythingThere;
}

function showChoice(s) {
  view("choice");
  const signature = JSON.stringify(s);
  if (signature === shownChoice) return; // the same state arriving twice: what the user already ticked is not lost
  shownChoice = signature;
  // If the choice comes back with a changed list (a model added or removed), what the user had already
  // ticked stays ticked; the new model ticks itself.
  const ticked = choice ? new Set([...chosen(), ...(s.added ? [s.added] : [])]) : null;
  choice = s;
  const assessment = s.assessment;
  $("choice-title").textContent = s.cancelable ? t.choiceTitleCancelable : t.choiceTitleFirstRun;
  $("choice-intro").textContent = s.cancelable ? t.choiceIntroCancelable : t.choiceIntroFirstRun;
  showComputer(assessment);
  $("models").replaceChildren(...assessment.models.map((m) => modelItem(m, ticked)));
  $("optimize-folder").textContent = s.optimize_dir;
  if (!ticked) refreshToken();
  $("cancel").hidden = !s.cancelable;
  $("choice-status").textContent = "";
  $("cancel").disabled = false;
  summary();
}

$("start-download").addEventListener("click", async () => {
  $("start-download").disabled = true;
  $("cancel").disabled = true;
  try {
    await invoke("choice_confirm", { chosen: chosen() });
  } catch (e) {
    $("choice-status").textContent = t.cannotStart + e;
    $("cancel").disabled = false;
    summary();
  }
});

$("optimize-open").addEventListener("click", async () => {
  try {
    await invoke("open_optimize");
  } catch (e) {
    $("choice-status").textContent = String(e);
  }
});

$("cancel").addEventListener("click", async () => {
  try {
    await invoke("choice_cancel");
  } catch (e) {
    $("choice-status").textContent = t.cannotCancel + e;
  }
});

// --- other models -----------------------------------------------------------------------------
// You search on Hugging Face, paste a link or choose a file; the app analyzes (memory, conversation format) and,
// if the user confirms, writes the model in their list: the choice comes back with the new model already ticked.

let analysis = null; // the analysis open in "Other models"

function otherStatus(text) {
  $("other-status").textContent = text;
}

function busy(yes) {
  for (const id of ["other-search", "other-file", "other-text", "other-add"]) $(id).disabled = yes;
}

async function work(message, action) {
  otherStatus(message);
  busy(true);
  try {
    await action();
    return true;
  } catch (e) {
    otherStatus(String(e));
    return false;
  } finally {
    busy(false);
  }
}

function closeAnalysis() {
  analysis = null;
  $("other-detail").hidden = true;
}

function showResults(results) {
  closeAnalysis();
  otherStatus(results.length ? "" : t.noResults);
  $("other-results").replaceChildren(
    ...results.map((r) => {
      const li = document.createElement("li");
      li.className = "model";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "result";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.id;
      if (r.gated) name.append(badge(t.badgeProtected));
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = t.downloadsAndLikes(num(r.downloads, 0), num(r.likes, 0));
      b.append(name, meta);
      b.addEventListener("click", () => openOther(r.id));
      li.append(b);
      return li;
    }),
  );
}

// The proposal chosen now in the open analysis: the quantization and, if ticked, the image encoder.
function currentProposal() {
  const i = Number(document.querySelector("#other-variants input:checked")?.value ?? -1);
  const v = analysis.variants[i];
  if (!v) return null;
  const withImages = $("other-images").checked ? v.with_images : null;
  return { key: v.key, ...(withImages ?? v) };
}

function drawVariants() {
  const marked = Number(document.querySelector("#other-variants input:checked")?.value ?? analysis.variants.findIndex((v) => v.recommended));
  const withImages = $("other-images").checked;
  $("other-variants").replaceChildren(
    ...analysis.variants.map((v, i) => {
      const p = withImages && v.with_images ? v.with_images : v;
      const li = document.createElement("li");
      li.className = "model" + (p.placement ? "" : " no-fit");
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "variant";
      radio.value = String(i);
      radio.disabled = !p.placement;
      radio.checked = i === marked && !!p.placement;
      radio.addEventListener("change", updateAdd);
      const body = document.createElement("span");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = v.name;
      if (v.recommended) name.append(badge(t.recommendedVariant));
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = [size(p.bytes), p.placement ? where(p.placement) : t.doesNotFit].join(" · ");
      meta.title = p.reason;
      body.append(name, meta);
      if (!p.placement) {
        const why = document.createElement("span");
        why.className = "why";
        why.textContent = p.reason;
        body.append(why);
      }
      label.append(radio, body);
      li.append(label);
      return li;
    }),
  );
  updateAdd();
}

function updateAdd() {
  const severe = analysis.warnings.some((a) => a.severe);
  $("other-add").disabled = !currentProposal();
  $("other-add").textContent = severe ? t.addAnyway : t.add;
}

function showAnalysis(a, repo) {
  analysis = a;
  otherStatus("");
  $("other-results").replaceChildren();
  $("other-name").textContent = repo ? `${a.name} · ${repo}` : a.name;
  if (a.gated) $("other-name").append(badge(t.badgeProtected));
  $("other-warnings").replaceChildren(
    ...a.warnings.map((w) => {
      const li = document.createElement("li");
      li.className = w.severe ? "severe" : "";
      li.dataset.label = t.warningLabel;
      li.textContent = w.text;
      return li;
    }),
  );
  const largest = a.variants.reduce((m, v) => Math.max(m, v.with_images ? v.with_images.bytes - v.bytes : 0), 0);
  $("other-images-row").hidden = !largest;
  $("other-images").checked = false;
  $("other-images-text").textContent = t.imagesOption(size(largest));
  $("other-detail").hidden = false;
  drawVariants();
}

// A search by name gives a list of repos; a link, or a repo chosen from the list, gives its quantizations.
async function openOther(text) {
  text = text.trim();
  if (!text) return;
  await work(t.lookingOnHuggingFace, async () => {
    const r = await invoke("other_models_open", { text });
    if (r.type === "results") showResults(r.results);
    else showAnalysis(r.analysis, r.repo);
  });
}

$("other-form").addEventListener("submit", (e) => {
  e.preventDefault();
  openOther($("other-text").value);
});

$("other-file").addEventListener("click", async () => {
  const path = await window.__TAURI__.dialog.open({ multiple: false, filters: [{ name: t.modelsFilter, extensions: ["gguf"] }] });
  if (!path) return;
  await work(t.readingFile, async () => showAnalysis(await invoke("other_models_local", { path }), null));
});

$("other-images").addEventListener("change", drawVariants);
$("other-close").addEventListener("click", () => {
  closeAnalysis();
  otherStatus("");
});

$("other-add").addEventListener("click", async () => {
  const p = currentProposal();
  if (!p) return;
  const ok = await work(t.addingModel, () => invoke("other_models_add", { key: p.key, entry: p.entry }));
  if (!ok) return;
  // The choice comes back by itself with the new model in the list, already ticked.
  closeAnalysis();
  otherStatus(t.addedToList);
});

async function removeModel(key) {
  await work(t.removingModel, () => invoke("other_models_remove", { key }));
  otherStatus("");
}

// --- Hugging Face token ---

async function refreshToken() {
  try {
    const saved = await invoke("other_models_token_status");
    $("token-remove").hidden = !saved;
    $("token-value").placeholder = saved ? t.tokenSavedPlaceholder : "hf_…";
  } catch (e) {
    $("token-status").textContent = String(e);
  }
}

$("token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("token-save").disabled = true;
  $("token-status").textContent = t.checkingToken;
  try {
    await invoke("other_models_token_save", { token: $("token-value").value });
    $("token-value").value = "";
    $("token-status").textContent = t.tokenSaved;
    refreshToken();
  } catch (err) {
    $("token-status").textContent = String(err);
  } finally {
    $("token-save").disabled = false;
  }
});

$("token-remove").addEventListener("click", async () => {
  try {
    await invoke("other_models_token_remove");
    $("token-status").textContent = t.tokenRemoved;
    refreshToken();
  } catch (err) {
    $("token-status").textContent = String(err);
  }
});

// --- download ---------------------------------------------------------------------------------

function showDownload(s) {
  view("download");
  $("download-title").textContent = s.detail;
  $("download-steps").replaceChildren(
    ...s.download.steps.map((p) => {
      const li = document.createElement("li");
      li.className = p.state === "done" ? "done" : p.state === "in_progress" ? "active" : "";
      const indicator = document.createElement("span");
      indicator.className = "indicator";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p.name;
      const detail = document.createElement("span");
      detail.className = "detail";
      const bar = document.createElement("span");
      bar.className = "bar";
      const fill = document.createElement("i");
      bar.append(fill);
      if (p.state === "waiting") detail.textContent = t.waiting;
      else if (p.state === "done") detail.textContent = p.total ? size(p.total) : t.done;
      else if (p.total) {
        const percent = Math.min(100, Math.floor((p.done / p.total) * 100));
        detail.textContent = t.progress(size(p.done), size(p.total), percent);
        fill.style.width = percent + "%";
      } else detail.textContent = t.connecting;
      li.append(indicator, name, detail, bar);
      return li;
    }),
  );
}

// --- error ------------------------------------------------------------------------------------

function showError(s) {
  lastError = s;
  const e = s.error || { title: s.detail, message: "", logs: null };
  view("error");
  $("error-title").textContent = e.title;
  // What happened and what to do is read at once; the technical lines stay in the details.
  $("error-sentence").textContent = e.message.split(t.technicalDetailMarker)[0];
  $("error-message").textContent = e.message;
  $("logs").hidden = !e.logs;
  $("retry").disabled = false;
  $("status").textContent = e.logs ? t.logsFolder + e.logs : "";
}

function apply(s) {
  received = true;
  if (s.stage === "error") showError(s);
  else if (s.stage === "choice") showChoice(s.choice);
  else if (s.stage === "download") showDownload(s);
  else showStartup(s);
}

function reset() {
  for (const li of stepRows) li.classList.remove("done", "active");
  for (const li of stepRows) if (li.dataset.optional !== undefined) li.hidden = true;
}

$("retry").addEventListener("click", async () => {
  // First the page is reset: the events of the new startup can arrive before the answer.
  reset();
  showStartup({ stage: "startup", detail: "" });
  try {
    await invoke("retry_startup");
  } catch (e) {
    showError(lastError);
    $("status").textContent = t.cannotRetry + e;
  }
});

$("report").hidden = !window.__MANGO_DESKTOP__;
$("report-screenshot-row").hidden = !window.__MANGO_DESKTOP__;

// The files the user attaches: where the report can carry them (the app says how much), within the limit for the whole.
let reportFiles = [];
let reportMax = 0;
const megabytes = (n) => (n < 1e6 ? Math.round(n / 1e3) + " KB" : (n / 1e6).toFixed(1) + " MB");
window.__MANGO_DESKTOP__?.reportInfo().then((info) => {
  reportMax = info.maxBytes;
  $("report-files-row").hidden = !info.attachments;
}).catch(() => {});
$("report-files").addEventListener("change", (event) => {
  let total = reportFiles.reduce((sum, f) => sum + f.size, 0);
  for (const file of event.target.files) {
    if (total + file.size > reportMax) {
      $("status").textContent = t.reportFilesTooLarge.replace("{name}", file.name).replace("{size}", megabytes(file.size)).replace("{max}", megabytes(reportMax));
      continue;
    }
    reportFiles.push(file);
    total += file.size;
  }
  event.target.value = "";
  $("report-files-list").textContent = reportFiles.map((f) => f.name + " (" + megabytes(f.size) + ")").join(", ");
});
$("report").addEventListener("click", () => {
  const details = $("error-title").textContent + "\n\n" + $("error-message").textContent;
  window.__MANGO_DESKTOP__
    .reportProblem({ error: details, screenshot: $("report-screenshot").checked, files: reportFiles })
    .then((done) => {
      $("status").textContent = done.sent ? t.reportSent : t.reportSaved + done.file;
      $("report").disabled = done.sent;
    })
    .catch((e) => { $("status").textContent = t.cannotReport + (e?.message ?? e); });
});

$("logs").addEventListener("click", () => {
  invoke("open_logs").catch((e) => { $("status").textContent = t.cannotOpenLogs + e; });
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("error-title").textContent + "\n\n" + $("error-message").textContent);
    $("status").textContent = t.detailsCopied;
  } catch {
    $("status").textContent = t.copyFailed;
  }
});

// First the language and the listening, then the read: the event can arrive before the page is ready.
invoke("language")
  .then(applyLanguage)
  .then(() => listen("mango://status", (e) => apply(e.payload)))
  .then(() => invoke("startup_status"))
  .then((s) => { if (!received) apply(s); })
  .catch((e) => showError({ stage: "error", detail: "", error: { title: t.cannotReadState, message: String(e), logs: null } }));
