// The app's own page: the logo while the app starts, and the error that stops the startup, with Retry, Report a problem
// and Open the logs (and the way back to this PC's engine when the one in use is another PC's). It shows the state the
// app sends (command `startup_status`, event `mango://status`); when startup ends the app moves the window to the web UI.
// Everything else (models, downloads, the engine of another PC) is in the settings of the web UI.
"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// --- texts ------------------------------------------------------------------------------------
// Every text of the page, in both languages. Elements of index.html get theirs through `data-text`. The language is the
// app's (`language` command).

const TEXTS = {
  it: {
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
    remoteBack: "Torna al motore di questo PC",
    logsFolder: "Cartella dei log: ",
    cannotRetry: "Non riesco a riprovare: ",
    cannotOpenLogs: "Non riesco ad aprire i log: ",
    detailsCopied: "Dettagli copiati negli appunti.",
    copyFailed: "Copia non riuscita: seleziona il testo a mano.",
    cannotReadState: "Mango Code non riesce a leggere il proprio stato",
  },
  en: {
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
    remoteBack: "Back to the engine of this PC",
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
}

// --- views ------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

let received = false;    // a state has already arrived (an event always beats the initial read)
let lastError = null;    // the last error state, to go back to the screen if "Retry" fails

// While the app starts the page shows the logo and nothing else ("starting"); "error" shows the error section.
function view(name) {
  $("error").hidden = name !== "error";
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
  $("local-engine").hidden = !e.remote;
  $("retry").disabled = false;
  $("status").textContent = e.logs ? t.logsFolder + e.logs : "";
}

function apply(s) {
  received = true;
  if (s.stage === "error") showError(s);
  else view("starting");
}

$("retry").addEventListener("click", async () => {
  // First the page goes back to the logo: the events of the new startup can arrive before the answer.
  view("starting");
  try {
    await invoke("retry_startup");
  } catch (e) {
    showError(lastError);
    $("status").textContent = t.cannotRetry + e;
  }
});

// With the engine of another PC saved, the way out of an error that is that PC's: this one's engine.
$("local-engine").addEventListener("click", async () => {
  view("starting");
  try {
    await window.__MANGO_DESKTOP__.engineRemote.disconnect();
  } catch (e) {
    showError(lastError);
    $("status").textContent = t.cannotRetry + (e?.message ?? e);
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
