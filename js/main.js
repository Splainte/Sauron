/*
 * Sauron — côté panneau CEP (Node.js)
 * Fonctionnement ponctuel, en deux temps :
 *  - « Check » : repère la racine du projet montage (parent de PROJETS),
 *    liste ses dossiers de 1er niveau (cases à cocher) et compte ce que
 *    Premiere ne connaît pas encore. N'importe RIEN.
 *  - « Synchroniser » : importe le contenu des dossiers cochés vers des
 *    chutiers miroir, en évitant les doublons.
 *
 * Portabilité : on ne stocke JAMAIS de chemin absolu. La racine est recalculée
 * depuis app.project.path à chaque Check, et le registre anti-doublon
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
var os = nodeRequire("os");
var https = nodeRequire("https");
var urlMod = nodeRequire("url");
var spawn = nodeRequire("child_process").spawn;

var cs = new CSInterface();
var extDir = cs.getSystemPath(SystemPath.EXTENSION);

// Dossiers de 1er niveau jamais synchronisés : le projet lui-même et les exports.
var HARD_EXCLUDED = ["PROJETS", "EXPORTS"];

// Proxies générés par Premiere : dossier « Proxies » (n'importe où dans
// l'arbo, variantes d'orthographe incluses) + fichiers suffixés _proxy —
// jamais listés ni importés.
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
  projectPath: "",   // chemin du .prproj du dernier Check
  watchRoot: "",     // racine du projet montage (recalculée, jamais persistée)
  registryFile: "",
  registry: {},      // { "elements/musique/track.mp3": true } — clés relatives minuscules
  configFile: "",
  config: { excluded: [] }, // dossiers de 1er niveau décochés (choix utilisateur)
  knownByName: {}    // nom de fichier → chemins que Premiere connaît déjà
};

var busy = false;        // un Check ou une Synchro est en cours
var checkedOnce = false; // Synchroniser n'est actif qu'après un Check réussi

// ---------- UI ----------

var ui = {
  status: document.getElementById("status"),
  target: document.getElementById("target"),
  log: document.getElementById("log"),
  check: document.getElementById("check"),
  sync: document.getElementById("sync"),
  folders: document.getElementById("folders"),
  version: document.getElementById("version"),
  update: document.getElementById("update")
};

function setStatus(text, cls) {
  ui.status.textContent = text;
  ui.status.className = "status " + (cls || "");
}

function setButtons() {
  ui.check.disabled = busy;
  ui.sync.disabled = busy || !checkedOnce;
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

// Exécute fn sur chaque élément, un à la fois, dans l'ordre (un seul ordre
// evalScript en vol vers Premiere à la fois).
function sequence(items, fn) {
  return items.reduce(function (p, item) {
    return p.then(function () { return fn(item); });
  }, Promise.resolve());
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
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
// la config voyage avec le projet. Un nouveau dossier est coché par
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

// counts : { nom: nb de nouveaux fichiers } calculé par le Check (optionnel).
function renderFolders(counts) {
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
      label.className = box.checked ? "" : "off";
      saveConfig();
    });
    label.appendChild(box);
    var text = name;
    if (counts && counts.hasOwnProperty(name)) {
      text += counts[name] > 0 ?
        " — " + counts[name] + " nouveau" + (counts[name] > 1 ? "x" : "") :
        " — à jour";
    }
    label.appendChild(document.createTextNode(text));
    ui.folders.appendChild(label);
  });
}

// ---------- Détection (Check) ----------

// "ELEMENTS/musique" pour un fichier ELEMENTS/musique/track.mp3 ;
// "" pour un fichier posé à la racine du projet.
function binSegments(absPath) {
  var rel = path.relative(state.watchRoot, path.dirname(absPath));
  if (!rel || rel === ".") { return ""; }
  return rel.split(path.sep).join("/");
}

// Parcours récursif d'un dossier : collecte les sous-dossiers (pour les
// chutiers, même vides) et les fichiers, en sautant cachés et proxies.
function walk(dir, out) {
  var entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    log("Dossier illisible : " + dir + " (" + e.message + ")", "warn");
    return;
  }
  entries.forEach(function (name) {
    if (name.charAt(0) === ".") { return; }
    var p = path.join(dir, name);
    var st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
      if (PROXY_DIR.test(name)) { return; }
      out.dirs.push(p);
      walk(p, out);
    } else if (st.isFile()) {
      if (!PROXY_FILE.test(name)) { out.files.push(p); }
    }
  });
}

// Repère la racine du projet montage depuis le .prproj ouvert dans Premiere.
function resolveProject() {
  return evalScript("SAURON.getProjectPath()").then(function (projPath) {
    if (projPath === "EvalScript error.") {
      throw new Error("jsx/sauron.jsx n'a pas chargé côté Premiere (EvalScript error)");
    }
    if (!projPath) {
      throw new Error("aucun projet ouvert — ouvre un .prproj puis relance Check");
    }
    var projDir = path.dirname(projPath);
    if (!fuzzyMatch(path.basename(projDir), "PROJETS")) {
      throw new Error("le .prproj n'est pas dans un dossier PROJETS : " + projDir);
    }
    state.projectPath = projPath;
    state.watchRoot = path.resolve(projDir, "..");
    state.registryFile = path.join(projDir, ".sauron-registry.json");
    state.configFile = path.join(projDir, ".sauron-config.json");
  });
}

// Considère comme déjà importé tout ce que le projet Premiere connaît
// (évite de dédoublonner un projet existant). Refuse de continuer si la
// liste échoue : risque de tout réimporter en doublon sinon.
function seedFromProject() {
  return evalScript("SAURON.listImportedPaths()").then(function (known) {
    if (known === "EvalScript error.") {
      throw new Error("impossible de lister les médias du projet (EvalScript error)");
    }
    var changed = false;
    var rootPrefix = normalizePath(state.watchRoot) + "/";
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
  });
}

// Arborescence + fichiers que Premiere ne connaît pas encore, pour un
// dossier de 1er niveau. Les fichiers connus sous un autre chemin absolu
// sont notés dans le registre au passage (et jamais réimportés).
function detectFolder(name) {
  var out = { dirs: [], files: [] };
  walk(path.join(state.watchRoot, name), out);
  var fresh = [];
  out.files.forEach(function (p) {
    var key = normKey(p);
    if (state.registry[key]) { return; }
    if (knownElsewhere(key, p)) {
      state.registry[key] = true;
      return;
    }
    fresh.push(p);
  });
  return { dirs: out.dirs, fresh: fresh };
}

function runCheck() {
  if (busy) { return; }
  busy = true;
  setButtons();
  setStatus("Analyse…", "paused");
  resolveProject()
    .then(function () {
      ui.target.textContent = state.watchRoot;
      loadRegistry();
      loadConfig();
      return seedFromProject();
    })
    .then(function () {
      var counts = {};
      var total = 0;
      listTopFolders().forEach(function (name) {
        var d = detectFolder(name);
        counts[name] = d.fresh.length;
        total += d.fresh.length;
      });
      saveRegistry(); // fichiers reconnus « ailleurs » notés pendant la détection
      renderFolders(counts);
      checkedOnce = true;
      if (total) {
        setStatus(total + " nouveau" + (total > 1 ? "x" : "") + " fichier" +
          (total > 1 ? "s" : ""), "ok");
        log("Check : " + total + " fichier(s) à importer — coche les dossiers " +
          "voulus puis clique sur Synchroniser.");
      } else {
        setStatus("Tout est à jour", "ok");
        log("Check : rien de nouveau, Premiere connaît déjà tout.");
      }
    })
    .catch(function (e) {
      setStatus("Erreur", "err");
      log("Check impossible : " + e.message, "err");
    })
    .then(function () {
      busy = false;
      setButtons();
    });
}

// ---------- Synchronisation ----------

function importOne(filePath, result) {
  var key = normKey(filePath);
  var rel = relKey(filePath); // pour l'affichage (casse d'origine)
  var segs = binSegments(filePath);
  return evalScript(
    'SAURON.importFile("' + escapeJsxString(filePath) + '","' +
    escapeJsxString(segs) + '")'
  ).then(function (res) {
    if (res === "OK") {
      state.registry[key] = true;
      saveRegistry();
      result.imported++;
      log("Importé : " + rel);
    } else {
      result.failed++;
      log("Échec import " + rel + " → " + res, "err");
    }
  });
}

function createBinFor(dirPath) {
  var segs = path.relative(state.watchRoot, dirPath).split(path.sep).join("/");
  return evalScript('SAURON.createBins("' + escapeJsxString(segs) + '")')
    .then(function (res) {
      if (res !== "OK") {
        log("Échec chutier " + segs + " → " + res, "err");
      }
    });
}

function runSync() {
  if (busy || !checkedOnce) { return; }
  busy = true;
  setButtons();
  setStatus("Synchronisation…", "paused");
  var result = { imported: 0, failed: 0, skipped: 0 };
  // Le projet ouvert a pu changer depuis le Check : on revalide tout
  // (racine, registre, médias connus) avant d'importer quoi que ce soit.
  resolveProject()
    .then(function () {
      ui.target.textContent = state.watchRoot;
      loadRegistry();
      loadConfig();
      return seedFromProject();
    })
    .then(function () {
      var names = listTopFolders().filter(function (name) {
        return state.config.excluded.indexOf(name) === -1;
      });
      var dirs = [];
      var files = [];
      names.forEach(function (name) {
        var d = detectFolder(name);
        dirs = dirs.concat(d.dirs);
        files = files.concat(d.fresh);
      });
      saveRegistry();
      if (!files.length) {
        // Les chutiers miroir restent créés même sans nouveau fichier
        // (dossiers vides ajoutés depuis la dernière synchro).
        return sequence(dirs, createBinFor).then(function () {
          renderFolders();
          setStatus("Tout est à jour", "ok");
          log("Synchro : rien de nouveau à importer.");
        });
      }
      // Un fichier encore en cours de copie (gros rush depuis le NAS…) ne
      // doit pas être importé tronqué : taille relevée deux fois à 2 s
      // d'écart, on ne garde que les tailles stables.
      var sizes = {};
      files.forEach(function (p) {
        try { sizes[p] = fs.statSync(p).size; } catch (e) { sizes[p] = -1; }
      });
      log(files.length + " fichier(s) à importer, vérification des copies en cours…");
      return delay(2000).then(function () {
        var stable = files.filter(function (p) {
          var size = -2;
          try { size = fs.statSync(p).size; } catch (e) { /* disparu/illisible */ }
          if (size !== sizes[p]) {
            result.skipped++;
            log("Copie en cours, ignoré pour cette fois : " + relKey(p), "warn");
            return false;
          }
          return true;
        });
        return sequence(dirs, createBinFor).then(function () {
          return sequence(stable, function (p) { return importOne(p, result); });
        });
      }).then(function () {
        renderFolders();
        var parts = [result.imported + " importé" + (result.imported > 1 ? "s" : "")];
        if (result.failed) { parts.push(result.failed + " échec(s)"); }
        if (result.skipped) { parts.push(result.skipped + " en cours de copie"); }
        setStatus(parts.join(", "), result.failed ? "err" : "ok");
        log("Synchro terminée : " + parts.join(", ") + ".");
        if (result.skipped) {
          log("Relance Check puis Synchroniser quand les copies seront finies.", "warn");
        }
      });
    })
    .catch(function (e) {
      setStatus("Erreur", "err");
      log("Synchro impossible : " + e.message, "err");
    })
    .then(function () {
      busy = false;
      setButtons();
    });
}

// ---------- Mise à jour automatique ----------
// La dernière release GitHub fait foi : si son tag est plus récent que la
// version du manifest local, on télécharge Sauron-Setup.exe et on le lance
// (Windows). Sur macOS, pas d'installeur : on ouvre la page de la release.

var UPDATE_REPO = "Splainte/Sauron";
var IS_WINDOWS = navigator.platform.indexOf("Win") === 0;

function currentVersion() {
  try {
    var m = fs.readFileSync(path.join(extDir, "CSXS", "manifest.xml"), "utf8")
      .match(/ExtensionBundleVersion="([^"]+)"/);
    return m ? m[1] : "0.0.0";
  } catch (e) {
    return "0.0.0";
  }
}

// true si a > b ("1.2.0" vs "1.1.9")
function isNewer(a, b) {
  var pa = String(a).replace(/^v/, "").split(".");
  var pb = String(b).replace(/^v/, "").split(".");
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var na = parseInt(pa[i], 10) || 0;
    var nb = parseInt(pb[i], 10) || 0;
    if (na !== nb) { return na > nb; }
  }
  return false;
}

// GET https en suivant les redirections (GitHub sert les binaires via 302).
// url.parse plutôt que https.get(url, options) : le Node embarqué par CEP
// est ancien et ne connaît pas cette signature.
function httpsGet(url, redirectsLeft) {
  return new Promise(function (resolve, reject) {
    var opts = urlMod.parse(url);
    opts.headers = { "User-Agent": "Sauron-panel" };
    https.get(opts, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 &&
          res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(httpsGet(res.headers.location, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("HTTP " + res.statusCode));
        return;
      }
      resolve(res);
    }).on("error", reject);
  });
}

function httpsGetText(url) {
  return httpsGet(url, 5).then(function (res) {
    return new Promise(function (resolve, reject) {
      var data = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { data += c; });
      res.on("end", function () { resolve(data); });
      res.on("error", reject);
    });
  });
}

function httpsDownload(url, dest) {
  return httpsGet(url, 5).then(function (res) {
    return new Promise(function (resolve, reject) {
      var out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on("finish", function () { resolve(dest); });
      out.on("error", reject);
      res.on("error", reject);
    });
  });
}

var updating = false;

function checkUpdate() {
  if (updating) { return; }
  updating = true;
  ui.update.disabled = true;
  log("Recherche de mise à jour…");
  httpsGetText("https://api.github.com/repos/" + UPDATE_REPO + "/releases/latest")
    .then(function (body) {
      var rel = JSON.parse(body);
      var latest = String(rel.tag_name || "").replace(/^v/, "");
      if (!latest) { throw new Error("release sans numéro de version"); }
      if (!isNewer(latest, currentVersion())) {
        log("Sauron est à jour (v" + currentVersion() + ").");
        return;
      }
      log("Nouvelle version disponible : v" + latest);
      if (!IS_WINDOWS) {
        // macOS : on télécharge le script d'installation avec Node — donc sans
        // attribut de quarantaine, donc sans alerte Gatekeeper — et on le lance.
        // Il récupère et installe la dernière version tout seul.
        log("Téléchargement du programme d'installation…");
        var sh = path.join(os.tmpdir(), "sauron-install.sh");
        return httpsDownload(
          "https://raw.githubusercontent.com/" + UPDATE_REPO + "/main/install/install-macos.sh",
          sh
        ).then(function () {
          spawn("/bin/bash", [sh], { detached: true, stdio: "ignore" }).unref();
          log("Mise à jour v" + latest + " en cours — patiente, puis redémarre Premiere.", "warn");
        });
      }
      var asset = null;
      (rel.assets || []).forEach(function (a) {
        if (/setup.*\.exe$/i.test(a.name)) { asset = a; }
      });
      if (!asset) { throw new Error("pas d'installeur Windows dans la release"); }
      log("Téléchargement de " + asset.name + "…");
      var dest = path.join(os.tmpdir(), "Sauron-Setup-v" + latest + ".exe");
      return httpsDownload(asset.browser_download_url, dest).then(function () {
        // Le Node embarqué dans CEP renvoie « spawn UNKNOWN » si on lance un
        // .exe détaché directement. On passe par cmd /c start, fiable ici.
        spawn("cmd.exe", ["/c", "start", "", dest], {
          detached: true, stdio: "ignore", windowsHide: true
        }).unref();
        log("Installeur v" + latest + " lancé : suis l'assistant, puis redémarre Premiere.", "warn");
      });
    })
    .catch(function (e) {
      log("Mise à jour impossible : " + e.message, "err");
    })
    .then(function () {
      updating = false;
      ui.update.disabled = false;
    });
}

// ---------- Bindings UI ----------

ui.check.addEventListener("click", runCheck);
ui.sync.addEventListener("click", runSync);
ui.update.addEventListener("click", checkUpdate);
ui.version.textContent = "v" + currentVersion();

setButtons();
setStatus("Prêt", "paused");
log("Sauron est prêt — clique sur Check pour analyser le projet ouvert.");
