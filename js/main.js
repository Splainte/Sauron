/*
 * Sauron — côté panneau CEP (Node.js)
 * Surveille <dossier projet>/../ELEMENTS via chokidar et pousse chaque
 * dossier/fichier vers Premiere (chutiers miroir + import).
 *
 * Portabilité : on ne stocke JAMAIS de chemin absolu. ELEMENTS est recalculé
 * depuis app.project.path à chaque démarrage, et le registre anti-doublon
 * (.sauron-registry.json, posé à côté du .prproj) n'utilise que des chemins
 * relatifs — il voyage donc avec le dossier projet.
 */

/* global CSInterface */

var fs = require("fs");
var path = require("path");
var chokidar = require("chokidar");

var cs = new CSInterface();

var state = {
  watcher: null,
  projectPath: "",   // chemin du .prproj actuellement surveillé
  elementsDir: "",   // dossier ELEMENTS absolu (recalculé, jamais persisté)
  registryFile: "",
  registry: {},      // { "musique/track.mp3": true } — clés relatives à ELEMENTS
  configFile: "",
  config: { excluded: [] }, // dossiers de 1er niveau d'ELEMENTS à ignorer
  queue: Promise.resolve() // sérialise les appels evalScript
};

// ---------- UI ----------

var ui = {
  status: document.getElementById("status"),
  target: document.getElementById("target"),
  log: document.getElementById("log"),
  toggle: document.getElementById("toggle"),
  polling: document.getElementById("polling"),
  folders: document.getElementById("folders")
};

function setStatus(text, cls) {
  ui.status.textContent = text;
  ui.status.className = "status " + (cls || "");
}

function log(msg, cls) {
  var line = document.createElement("div");
  line.className = cls || "";
  line.textContent = new Date().toLocaleTimeString() + "  " + msg;
  ui.log.appendChild(line);
  while (ui.log.childNodes.length > 200) {
    ui.log.removeChild(ui.log.firstChild);
  }
  ui.log.scrollTop = ui.log.scrollHeight;
}

// ---------- Pont ExtendScript ----------

function escapeJsxString(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function evalScript(script) {
  return new Promise(function (resolve) {
    cs.evalScript(script, resolve);
  });
}

// Sérialise les ordres vers Premiere : un import à la fois, dans l'ordre.
function enqueue(fn) {
  state.queue = state.queue.then(fn).catch(function (e) {
    log("Erreur interne : " + e, "err");
  });
  return state.queue;
}

// ---------- Registre anti-doublon ----------

function relKey(absPath) {
  return path.relative(state.elementsDir, absPath).split(path.sep).join("/");
}

function loadRegistry() {
  state.registry = {};
  try {
    if (fs.existsSync(state.registryFile)) {
      state.registry = JSON.parse(fs.readFileSync(state.registryFile, "utf8"));
    }
  } catch (e) {
    log("Registre illisible, repart de zéro (" + e.message + ")", "warn");
  }
}

function saveRegistry() {
  try {
    fs.writeFileSync(state.registryFile, JSON.stringify(state.registry, null, 1));
  } catch (e) {
    log("Impossible d'écrire le registre : " + e.message, "err");
  }
}

// ---------- Config par projet (dossiers exclus) ----------
// Stockée dans .sauron-config.json à côté du .prproj : noms relatifs only,
// la config voyage avec le projet. Un nouveau dossier est synchronisé par
// défaut (on ne stocke que les exclusions).

function loadConfig() {
  state.config = { excluded: [] };
  try {
    if (fs.existsSync(state.configFile)) {
      var c = JSON.parse(fs.readFileSync(state.configFile, "utf8"));
      if (c && c.excluded instanceof Array) { state.config = c; }
    }
  } catch (e) {
    log("Config illisible, repart des défauts (" + e.message + ")", "warn");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(state.configFile, JSON.stringify(state.config, null, 1));
  } catch (e) {
    log("Impossible d'écrire la config : " + e.message, "err");
  }
}

// Premier segment du chemin relatif à ELEMENTS ("musique/track.mp3" → "musique")
function topFolder(absPath) {
  var rel = path.relative(state.elementsDir, absPath);
  return rel.split(path.sep)[0];
}

function isExcluded(absPath) {
  return state.config.excluded.indexOf(topFolder(absPath)) !== -1;
}

function listTopFolders() {
  try {
    return fs.readdirSync(state.elementsDir).filter(function (name) {
      return name.charAt(0) !== "." &&
        fs.statSync(path.join(state.elementsDir, name)).isDirectory();
    }).sort();
  } catch (e) {
    return [];
  }
}

function renderFolders() {
  ui.folders.innerHTML = "";
  var names = listTopFolders();
  if (!names.length) {
    ui.folders.innerHTML = '<span class="muted">(aucun sous-dossier)</span>';
    return;
  }
  names.forEach(function (name) {
    var excluded = state.config.excluded.indexOf(name) !== -1;
    var label = document.createElement("label");
    if (excluded) { label.className = "off"; }
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !excluded;
    box.addEventListener("change", function () {
      var idx = state.config.excluded.indexOf(name);
      if (box.checked && idx !== -1) {
        state.config.excluded.splice(idx, 1);
      } else if (!box.checked && idx === -1) {
        state.config.excluded.push(name);
      }
      saveConfig();
      log((box.checked ? "Synchronise " : "Ignore ") + name);
      // Redémarrer le watcher : un dossier recoché doit rattraper les fichiers
      // arrivés pendant l'exclusion (le registre dédoublonne le reste).
      if (state.watcher) {
        stopWatcher();
        startWatcher();
      }
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(name));
    ui.folders.appendChild(label);
  });
}

// ---------- Cœur : événements fichiers ----------

// "ELEMENTS/musique" pour un fichier ELEMENTS/musique/track.mp3
function binSegments(absPath) {
  var rel = path.relative(state.elementsDir, path.dirname(absPath));
  var segs = ["ELEMENTS"];
  if (rel && rel !== ".") {
    segs = segs.concat(rel.split(path.sep));
  }
  return segs.join("/");
}

function onAddDir(dirPath) {
  if (dirPath === state.elementsDir) { return; }
  if (path.dirname(dirPath) === state.elementsDir) {
    renderFolders(); // nouveau dossier de 1er niveau → rafraîchir la liste UI
  }
  if (isExcluded(dirPath)) { return; }
  var segs = "ELEMENTS/" +
    path.relative(state.elementsDir, dirPath).split(path.sep).join("/");
  enqueue(function () {
    return evalScript('SAURON.createBins("' + escapeJsxString(segs) + '")')
      .then(function (res) {
        if (res === "OK") {
          log("Chutier : " + segs);
        } else {
          log("Échec chutier " + segs + " → " + res, "err");
        }
      });
  });
}

function onAddFile(filePath) {
  var key = relKey(filePath);
  if (path.basename(filePath).charAt(0) === ".") { return; } // fichiers cachés
  if (isExcluded(filePath)) { return; }
  if (state.registry[key]) { return; }
  var segs = binSegments(filePath);
  enqueue(function () {
    return evalScript(
      'SAURON.importFile("' + escapeJsxString(filePath) + '","' +
      escapeJsxString(segs) + '")'
    ).then(function (res) {
      if (res === "OK") {
        state.registry[key] = true;
        saveRegistry();
        log("Importé : " + key);
      } else {
        log("Échec import " + key + " → " + res, "err");
      }
    });
  });
}

// ---------- Démarrage / arrêt ----------

function stopWatcher() {
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }
  setStatus("En pause", "paused");
  ui.toggle.textContent = "Démarrer";
}

function startWatcher() {
  evalScript("SAURON.getProjectPath()").then(function (projPath) {
    if (!projPath) {
      setStatus("Aucun projet ouvert", "err");
      log("Ouvre un projet .prproj puis relance.", "warn");
      return;
    }
    // .prproj dans PROJETS/ → ELEMENTS = <dossier .prproj>/../ELEMENTS
    var projDir = path.dirname(projPath);
    var elementsDir = path.resolve(projDir, "..", "ELEMENTS");
    if (!fs.existsSync(elementsDir)) {
      setStatus("ELEMENTS introuvable", "err");
      log("Pas de dossier ELEMENTS à côté de PROJETS : " + elementsDir, "err");
      return;
    }

    state.projectPath = projPath;
    state.elementsDir = elementsDir;
    state.registryFile = path.join(projDir, ".sauron-registry.json");
    state.configFile = path.join(projDir, ".sauron-config.json");
    loadRegistry();
    loadConfig();
    renderFolders();

    // Au premier lancement sur un projet, on considère comme déjà importé
    // tout ce que le projet connaît (évite de dédoublonner un projet existant).
    evalScript("SAURON.listImportedPaths()").then(function (known) {
      var changed = false;
      known.split("\n").forEach(function (p) {
        if (!p) { return; }
        if (p.indexOf(elementsDir) === 0) {
          var key = relKey(p);
          if (!state.registry[key]) {
            state.registry[key] = true;
            changed = true;
          }
        }
      });
      if (changed) { saveRegistry(); }

      var usePolling = ui.polling.checked;
      state.watcher = chokidar.watch(elementsDir, {
        ignored: /(^|[\/\\])\../, // fichiers/dossiers cachés
        persistent: true,
        usePolling: usePolling,
        interval: usePolling ? 2000 : 100,
        // attend que la copie soit FINIE avant de notifier (rush 4 Go…)
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 }
      });
      state.watcher.on("addDir", onAddDir);
      state.watcher.on("add", onAddFile);
      state.watcher.on("error", function (e) {
        log("Watcher : " + e.message, "err");
      });

      setStatus("Surveillance active" + (usePolling ? " (polling)" : ""), "ok");
      ui.target.textContent = elementsDir;
      ui.toggle.textContent = "Arrêter";
      log("Surveille " + elementsDir);
    });
  });
}

// Si Robin change de projet pendant que le panneau tourne, on suit.
setInterval(function () {
  if (!state.watcher) { return; }
  evalScript("SAURON.getProjectPath()").then(function (p) {
    if (p && p !== state.projectPath) {
      log("Changement de projet détecté, redémarrage…", "warn");
      stopWatcher();
      startWatcher();
    }
  });
}, 5000);

// ---------- Bindings UI ----------

ui.toggle.addEventListener("click", function () {
  if (state.watcher) { stopWatcher(); } else { startWatcher(); }
});

ui.polling.checked = localStorage.getItem("sauron.polling") === "1";
ui.polling.addEventListener("change", function () {
  localStorage.setItem("sauron.polling", ui.polling.checked ? "1" : "0");
  if (state.watcher) { // appliquer à chaud
    stopWatcher();
    startWatcher();
  }
});

startWatcher();
