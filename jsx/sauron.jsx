/*
 * Sauron — côté ExtendScript (Premiere Pro)
 * Reçoit les ordres du panneau CEP : créer des chutiers miroir, importer des fichiers.
 * Toute la logique de chemins relatifs vit ici et côté JS : on recalcule tout
 * depuis app.project.path, on ne stocke jamais de chemin absolu.
 */

var SAURON = (function () {

  var BIN_TYPE = 2; // ProjectItemType.BIN

  function getProjectPath() {
    if (!app.project || !app.project.path) {
      return "";
    }
    return app.project.path; // chemin du .prproj
  }

  // Trouve un chutier enfant par nom, ou le crée.
  function findOrCreateChildBin(parentBin, name) {
    for (var i = 0; i < parentBin.children.numItems; i++) {
      var child = parentBin.children[i];
      if (child.type === BIN_TYPE && child.name === name) {
        return child;
      }
    }
    return parentBin.createBin(name);
  }

  // segments : tableau de noms de dossiers relatifs à la racine du projet,
  // ex. ["ELEMENTS", "musique"] → chutier musique DANS le chutier ELEMENTS.
  function findOrCreateBinPath(segments) {
    var bin = app.project.rootItem;
    for (var i = 0; i < segments.length; i++) {
      bin = findOrCreateChildBin(bin, segments[i]);
    }
    return bin;
  }

  return {

    getProjectPath: getProjectPath,

    // Crée la chaîne de chutiers (événement addDir). segmentsJoined = "ELEMENTS/musique"
    createBins: function (segmentsJoined) {
      try {
        if (!app.project) { return "ERR:no-project"; }
        if (segmentsJoined) { findOrCreateBinPath(segmentsJoined.split("/")); }
        return "OK";
      } catch (e) {
        return "ERR:" + e.toString();
      }
    },

    // Importe un fichier dans le chutier miroir de son dossier.
    // filePath = chemin absolu (recalculé par le panneau à chaque session),
    // segmentsJoined = "ELEMENTS/musique" (chutier cible), "" = racine du projet.
    importFile: function (filePath, segmentsJoined) {
      try {
        if (!app.project) { return "ERR:no-project"; }
        var bin = segmentsJoined
          ? findOrCreateBinPath(segmentsJoined.split("/"))
          : app.project.rootItem;
        var ok = app.project.importFiles([filePath], true, bin, false);
        return ok ? "OK" : "ERR:import-failed";
      } catch (e) {
        return "ERR:" + e.toString();
      }
    },

    // Liste les chemins de médias déjà présents dans le projet (anti-doublon
    // au premier scan : on ne réimporte pas ce que le projet connaît déjà).
    listImportedPaths: function () {
      try {
        if (!app.project) { return ""; }
        var paths = [];
        (function walk(bin) {
          for (var i = 0; i < bin.children.numItems; i++) {
            var child = bin.children[i];
            if (child.type === BIN_TYPE) {
              walk(child);
            } else {
              var mp = child.getMediaPath ? child.getMediaPath() : "";
              if (mp) { paths.push(mp); }
            }
          }
        })(app.project.rootItem);
        return paths.join("\n");
      } catch (e) {
        return "";
      }
    }
  };
})();
