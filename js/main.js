/*
 * Sauron — côté panneau CEP (Node.js)
 * Surveille la racine du projet montage (parent de PROJETS) via chokidar,
 * sauf PROJETS et EXPORTS, et pousse chaque dossier/fichier vers Premiere
 * (chutiers miroir + import).
 *
 * Portabilité : on ne stocke JAMAIS de chemin absolu. La racine est recalculée
 * depuis app.project.path à chaque démarrage, et le registre anti-doublon
 * (.sauron-registry.json, posé à côté du .prproj) n'utilise que des chemins
 * relatifs — il voyage donc avec le dossier projet.
 */

/* global CSInterface, cep_node */

// Toute erreur non rattrapée s'affiche dans le panneau au lieu de bloquer
// silencieusement sur "Démarrage…".
window.onerror = function (msg, src, line) {
  var st = document.getElementById("status");
  st.textContent = "Erreur (voir log)";
  st.className = "status err";
  var lg = document.getElementById("log");
  var div = document.createElement("div");
  div.className = "err";
  div.textContent = msg + " (" + (src || "?").split("/").pop() + ":" + line + ")";
  lg.appendChild(div);
};

// Selon la version de CEP, le require Node est injecté dans la page
// (--enable-nodejs --mixed-context) ou seulement exposé via cep_node.
var nodeRequire =
  (typeof require !== "undefined") ? require :
  (typeof cep_node !== "undefined") ? cep_node.require : null;
if (!nodeRequire) {
  throw new Error("Node.js indisponible dans ce panneau CEP (require/cep_node absents)");
}

var fs = nodeRequire("fs");
var path = nodeRequire("path");

var cs = new CSInterface();

// Le require de CEP ne résout pas node_modules relativement au HTML de façon
// fiable → chargement par chemin absolu depuis la racine de l'extension.
var extDir = cs.getSystemPath(SystemPath.EXTENSION);
var chokidar;
try {
  chokidar = nodeRequire(path.join(extDir, "node_modules", "chokidar"));
} catch (e) {
  throw new Error("chokidar introuvable dans " + extDir +
    "/node_modules — lancer `npm install` avant d'installer le panneau (" + e.message + ")");
}

// Dossiers de 1er niveau jamais synchronisés : le projet lui-même et les exports.
var HARD_EXCLUDED = ["PROJETS", "EXPORTS"];

// Proxies générés par Premiere : dossier « Proxies » (n'importe où dans
// l'arbo, variantes d'orthographe incluses) + fichiers suffixés _proxy —
// jamais surveillés ni importés.
var PROXY_DIR = /^prox(y|ys|ies|ie|xies)$/i;
var PROXY_FILE = /_proxy\.[^.]+$/i;

// Les monteurs écrivent « EXPORT », « exports », « Projet »… → comparaison
// tolérante : minuscules, sans accents ni espaces, S final ignoré, et une
// faute de frappe d'écart maximum.
function normalizeName(name) {
  var n = String(name).toLowerCase();
  try {
    n = n.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch (e) { /* vieux runtime sans String.normalize : on garde les accents */ }
  return n.replace(/\s+/g, "").replace(/s$/, "");
}

// Damerau-Levenshtein : une transposition (« EXPROTS ») compte pour 1 édition.
function levenshtein(a, b) {
  if (a === b) { return 0; }
  var prevPrev = [], prev = [], cur = [], i, j;
  for (j = 0; j <= b.length; j++) { prev[j] = j; }
  for (i = 1; i <= a.length; i++) {
    cur = [i];
    for (j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)
      );
      if (i > 1 && j > 1 &&
          a.charAt(i - 1) === b.charAt(j - 2) &&
          a.charAt(i - 2) === b.charAt(j - 1)) {
        cur[j] = Math.min(cur[j], prevPrev[j - 2] + 1);
      }
    }
    prevPrev = prev;
    prev = cur;
  }
  return prev[b.length];
}

function fuzzyMatch(name, ref) {
  var a = normalizeName(name);
  var b = normalizeName(ref);
  return a === b || levenshtein(a, b) <= 1;
}

function isHardExcluded(name) {
  for (var i = 0; i < HARD_EXCLUDED.length; i++) {
    if (fuzzyMatch(name, HARD_EXCLUDED[i])) { return true; }
  }
  return false;
}

var state = {
  watcher: null,
  projectPath: "",   // chemin du .prproj actuellement surveillé
  watchRoot: "",     // racine du projet montage (recalculée, jamais persistée)
  registryFile: "",
  registry: {},      // { "ELEMENTS/musique/track.mp3": true } — clés relatives à la racine
  configFile: "",
  config: { excluded: [] }, // dossiers de 1er niveau à ignorer (choix utilisateur)
  knownByName: {},   // nom de fichier → chemins (normalisés) que Premiere connaît déjà
  queue: Promise.resolve() // sérialise les appels evalScript
};

// ---------- UI ----------

var ui = {
  status: document.getElementById("status"),
  target: document.getElementById("target"),
  log: document.getElementById("log"),
  toggle: document.getElementById("toggle"),
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
  return path.relative(state.watchRoot, absPath).split(path.sep).join("/");
}

// NTFS et APFS sont insensibles à la casse mais pas indexOf/les clés d'objet :
// toutes les clés de registre sont en minuscules pour qu'un même fichier vu
// sous deux casses (ou via UNC vs lettre mappée) ne soit jamais réimporté.
function normKey(absPath) {
  return relKey(absPath).toLowerCase();
}

function normalizePath(p) {
  return String(p).split("\\").join("/").toLowerCase();
}

// Premiere peut connaître le même fichier sous un autre chemin absolu que le
// nôtre (importé via \\nas\... alors que le projet est ouvert via Z:\, ancienne
// casse…) : on compare la FIN du chemin (la partie relative à la racine) au
// lieu du préfixe. Deux fichiers différents peuvent porter le même nom →
// on départage par la taille en octets (fiable pour rushs comme images).
// Taille illisible (chemin connu inaccessible d'ici) → considéré connu :
// dans le doute, on ne crée JAMAIS de doublon.
function knownElsewhere(key, absPath) {
  var list = state.knownByName[key.split("/").pop()];
  if (!list) { return false; }
  for (var i = 0; i < list.length; i++) {
    if (normalizePath(list[i]).slice(-(key.length + 1)) !== "/" + key) { continue; }
    try {
      if (fs.statSync(list[i]).size !== fs.statSync(absPath).size) { continue; }
    } catch (e) { /* incomparable : prudence */ }
    return true;
  }
  return false;
}

function loadRegistry() {
  state.registry = {};
  try {
    if (fs.existsSync(state.registryFile)) {
      var raw = JSON.parse(fs.readFileSync(state.registryFile, "utf8"));
      // Migration des registres écrits avant le passage aux clés minuscules.
      Object.keys(raw).forEach(function (k) {
        state.registry[k.toLowerCase()] = true;
      });
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

// Premier segment du chemin relatif à la racine ("ELEMENTS/x.mp3" → "ELEMENTS")
function topFolder(absPath) {
  var rel = path.relative(state.watchRoot, absPath);
  return rel.split(path.sep)[0];
}

function isExcluded(absPath) {
  var top = topFolder(absPath);
  return isHardExcluded(top) ||
         state.config.excluded.indexOf(top) !== -1;
}

function listTopFolders() {
  try {
    return fs.readdirSync(state.watchRoot).filter(function (name) {
      return name.charAt(0) !== "." &&
        !isHardExcluded(name) &&
        fs.statSync(path.join(state.watchRoot, name)).isDirectory();
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

// "ELEMENTS/musique" pour un fichier ELEMENTS/musique/track.mp3 ;
// "" pour un fichier posé à la racine du projet (import à la racine).
function binSegments(absPath) {
  var rel = path.relative(state.watchRoot, path.dirname(absPath));
  if (!rel || rel === ".") { return ""; }
  return rel.split(path.sep).join("/");
}

// Windows/macOS créent d'abord « Nouveau dossier » que l'utilisateur renomme
// ensuite : créer le chutier immédiatement donnerait un chutier fantôme par
// nom transitoire. On attend donc que le nom soit stable, et on ne crée
// jamais de chutier pour un nom de dossier par défaut (un fichier déposé
// dedans créera le chutier de toute façon, via l'import).
var PENDING_DIR_DELAY = 8000;
var DEFAULT_DIR_NAMES = /^(nouveau dossier|new folder|untitled folder)/i;
var pendingDirs = {}; // absPath → timer

function onAddDir(dirPath) {
  if (dirPath === state.watchRoot) { return; }
  if (path.dirname(dirPath) === state.watchRoot) {
    renderFolders(); // nouveau dossier de 1er niveau → rafraîchir la liste UI
  }
  if (isExcluded(dirPath)) { return; }
  if (DEFAULT_DIR_NAMES.test(path.basename(dirPath))) { return; }
  pendingDirs[dirPath] = setTimeout(function () {
    delete pendingDirs[dirPath];
    if (!fs.existsSync(dirPath)) { return; } // renommé/supprimé entre-temps
    var segs = path.relative(state.watchRoot, dirPath).split(path.sep).join("/");
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
  }, PENDING_DIR_DELAY);
}

// Un renommage = unlinkDir (ancien nom) + addDir (nouveau nom) : annuler le
// chutier en attente sous l'ancien nom.
function onUnlinkDir(dirPath) {
  if (pendingDirs[dirPath]) {
    clearTimeout(pendingDirs[dirPath]);
    delete pendingDirs[dirPath];
  }
  if (path.dirname(dirPath) === state.watchRoot) { renderFolders(); }
}

function onAddFile(filePath) {
  var key = normKey(filePath);
  var rel = relKey(filePath); // pour l'affichage (casse d'origine)
  if (path.basename(filePath).charAt(0) === ".") { return; } // fichiers cachés
  if (isExcluded(filePath)) { return; }
  if (state.registry[key]) { return; }
  if (knownElsewhere(key, filePath)) {
    // Premiere connaît déjà ce fichier sous un autre chemin absolu : on le
    // note dans le registre et on n'importe surtout pas de doublon.
    state.registry[key] = true;
    saveRegistry();
    return;
  }
  var segs = binSegments(filePath);
  enqueue(function () {
    return evalScript(
      'SAURON.importFile("' + escapeJsxString(filePath) + '","' +
      escapeJsxString(segs) + '")'
    ).then(function (res) {
      if (res === "OK") {
        state.registry[key] = true;
        saveRegistry();
        log("Importé : " + rel);
      } else {
        log("Échec import " + rel + " → " + res, "err");
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
  Object.keys(pendingDirs).forEach(function (k) {
    clearTimeout(pendingDirs[k]);
    delete pendingDirs[k];
  });
  setStatus("En pause", "paused");
  ui.toggle.textContent = "Démarrer";
}

function startWatcher() {
  evalScript("SAURON.getProjectPath()").then(function (projPath) {
    if (projPath === "EvalScript error.") {
      setStatus("Erreur ExtendScript", "err");
      log("jsx/sauron.jsx n'a pas chargé côté Premiere (EvalScript error).", "err");
      return;
    }
    if (!projPath) {
      setStatus("Aucun projet ouvert", "err");
      log("Ouvre un projet .prproj puis relance.", "warn");
      return;
    }
    // .prproj dans PROJETS/ → on surveille toute la racine du projet montage
    // (parent de PROJETS), PROJETS et EXPORTS exclus en dur.
    var projDir = path.dirname(projPath);
    var watchRoot = path.resolve(projDir, "..");
    if (!fuzzyMatch(path.basename(projDir), "PROJETS")) {
      setStatus("Structure inattendue", "err");
      log("Le .prproj n'est pas dans un dossier PROJETS : " + projDir, "err");
      return;
    }

    state.projectPath = projPath;
    state.watchRoot = watchRoot;
    state.registryFile = path.join(projDir, ".sauron-registry.json");
    state.configFile = path.join(projDir, ".sauron-config.json");
    loadRegistry();
    loadConfig();
    renderFolders();

    // Au premier lancement sur un projet, on considère comme déjà importé
    // tout ce que le projet connaît (évite de dédoublonner un projet existant).
    evalScript("SAURON.listImportedPaths()").then(function (known) {
      if (known === "EvalScript error.") {
        setStatus("Erreur ExtendScript", "err");
        log("Impossible de lister les médias du projet : on ne démarre PAS " +
            "la surveillance (risque de tout réimporter en doublon).", "err");
        return;
      }
      var changed = false;
      var rootPrefix = normalizePath(watchRoot) + "/";
      state.knownByName = {};
      known.split("\n").forEach(function (p) {
        if (!p) { return; }
        var norm = normalizePath(p);
        var base = norm.split("/").pop();
        // chemin d'origine conservé : il sert à relire la taille du fichier
        (state.knownByName[base] = state.knownByName[base] || []).push(p);
        if (norm.indexOf(rootPrefix) === 0) {
          var key = norm.slice(rootPrefix.length);
          if (!state.registry[key]) {
            state.registry[key] = true;
            changed = true;
          }
        }
      });
      if (changed) { saveRegistry(); }

      state.watcher = chokidar.watch(watchRoot, {
        ignored: [
          /(^|[\/\\])\../, // fichiers/dossiers cachés
          function (p) {   // PROJETS / EXPORTS / proxies : pas même surveillés
            var rel = path.relative(watchRoot, p);
            if (rel === "") { return false; }
            var segs = rel.split(path.sep);
            if (isHardExcluded(segs[0])) { return true; }
            for (var i = 0; i < segs.length; i++) {
              if (PROXY_DIR.test(segs[i])) { return true; }
            }
            return PROXY_FILE.test(path.basename(p));
          }
        ],
        persistent: true,
        // attend que la copie soit FINIE avant de notifier (rush 4 Go…)
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 }
      });
      state.watcher.on("addDir", onAddDir);
      state.watcher.on("unlinkDir", onUnlinkDir);
      state.watcher.on("add", onAddFile);
      state.watcher.on("error", function (e) {
        log("Watcher : " + e.message, "err");
      });

      setStatus("Surveillance active", "ok");
      ui.target.textContent = watchRoot + " (sauf " + HARD_EXCLUDED.join(", ") + ")";
      ui.toggle.textContent = "Arrêter";
      log("Surveille " + watchRoot);
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

// Désactivé par défaut : la surveillance ne démarre que sur clic « Démarrer ».
setStatus("En pause", "paused");
ui.toggle.textContent = "Démarrer";
log("Sauron est prêt — clique sur Démarrer pour surveiller le projet ouvert.");
