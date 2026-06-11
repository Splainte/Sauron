# 👁 Sauron

Panneau **CEP pour Adobe Premiere Pro** : tout fichier déposé dans le dossier `ELEMENTS/` du projet
est **importé automatiquement** dans un chutier miroir. Alternative maison et gratuite à Watchtower.

## Comment ça marche

Le panneau lit `app.project.path`, en déduit la racine du projet montage (le `.prproj` vit dans
`PROJETS/`) et la surveille récursivement avec chokidar — **sauf `PROJETS` et `EXPORTS`**,
exclus en dur :

```
NOM DU PROJET/      ← racine surveillée
├── ELEMENTS/       ← synchronisé → chutier ELEMENTS
├── RUSHS/          ← synchronisé → chutier RUSHS (idem tout autre dossier)
├── PROJETS/        ← JAMAIS synchronisé (le .prproj + .sauron-*.json vivent ici)
└── EXPORTS/        ← JAMAIS synchronisé
```

La reconnaissance de `PROJETS`/`EXPORTS` (et du dossier `Proxies`) est **tolérante aux
variantes** : casse, accents, espaces, S final et une faute de frappe près
(« EXPORT », « exports », « Éxports », « EXPROTS »… sont tous reconnus). Pareil pour
localiser le dossier `PROJETS` au démarrage.

- `ELEMENTS/musique/track.mp3` → importé dans le chutier `musique` **dans** le chutier `ELEMENTS`.
- Dossier créé → chutier créé (même vide), **après stabilisation du nom** : pas de chutier
  fantôme « Nouveau dossier » pendant que tu tapes le vrai nom (création différée de 8 s,
  annulée si le dossier est renommé ; les noms par défaut de l'OS ne sont jamais importés tels quels).
- **Synchro à sens unique (additive)** : on n'efface jamais un chutier quand un dossier disparaît.
- **Aucun chemin absolu stocké** : tout est recalculé depuis le `.prproj`, le registre n'a que des
  chemins relatifs → le dossier projet reste copiable tel quel sur un disque externe.
- `awaitWriteFinish` : un rush de 4 Go n'est importé qu'une fois sa copie terminée.
- **Proxies ignorés** : tout dossier `Proxies` (où qu'il soit dans l'arbo) et tout fichier
  `*_proxy.*` sont invisibles pour Sauron — la génération de proxies Premiere ne pollue
  jamais les chutiers.
- **Dossiers synchronisés** : chaque sous-dossier de 1er niveau d'ELEMENTS a sa case à cocher
  dans le panneau (coché = synchronisé, défaut). Les exclusions sont stockées dans
  `.sauron-config.json` à côté du `.prproj` (relatif → portable). Recocher un dossier rattrape
  les fichiers arrivés pendant l'exclusion.

## Installation (dev, non signé)

```bash
git clone https://github.com/Splainte/Sauron.git && cd Sauron
```

Les dépendances (`node_modules/`, ~600 Ko) sont versionnées dans le repo : **pas besoin de
Node/npm sur la machine de montage**, un `git pull` suffit pour se mettre à jour.

- **Windows** : double-clic sur `install/install-windows.bat`
- **macOS** : `bash install/install-macos.sh`

Les scripts activent `PlayerDebugMode` (CSXS 9→12) et installent le panneau dans le dossier
extensions CEP utilisateur. Redémarrer Premiere → **Fenêtre > Extensions > Sauron**.

Compatibilité : Premiere Pro 2020 (14.0) et + (tant qu'Adobe maintient CEP).

## Debug

`.debug` expose le panneau sur `http://localhost:8088` (DevTools Chrome) quand PlayerDebugMode est actif.

## Distribution équipe (plus tard)

Packager en `.zxp` signé via [ZXPSignCmd](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD)
pour installer sans PlayerDebugMode.
