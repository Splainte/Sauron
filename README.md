# 👁 Sauron

Panneau **CEP pour Adobe Premiere Pro** : tout fichier déposé dans le dossier `ELEMENTS/` du projet
est **importé automatiquement** dans un chutier miroir. Alternative maison et gratuite à Watchtower.

## Comment ça marche

Le panneau lit `app.project.path`, en déduit `ELEMENTS = <dossier du .prproj>/../ELEMENTS`
(structure projet rigide ci-dessous) et le surveille récursivement avec chokidar :

```
NOM DU PROJET/
├── ELEMENTS/   ← surveillé : tout dépôt déclenche un import
├── PROJETS/    ← le .prproj (+ .sauron-registry.json, registre anti-doublon)
├── EXPORTS/
└── RUSHS/
```

- `ELEMENTS/musique/track.mp3` → importé dans le chutier `musique` **dans** le chutier `ELEMENTS`.
- Dossier créé → chutier créé (même vide).
- **Synchro à sens unique (additive)** : on n'efface jamais un chutier quand un dossier disparaît.
- **Aucun chemin absolu stocké** : tout est recalculé depuis le `.prproj`, le registre n'a que des
  chemins relatifs → le dossier projet reste copiable tel quel sur un disque externe.
- `awaitWriteFinish` : un rush de 4 Go n'est importé qu'une fois sa copie terminée.
- **Mode NAS (polling)** : case à cocher dans le panneau, à activer si le projet est sur un
  lecteur réseau (inotify/FSEvents non fiables sur montage réseau).
- **Dossiers synchronisés** : chaque sous-dossier de 1er niveau d'ELEMENTS a sa case à cocher
  dans le panneau (coché = synchronisé, défaut). Les exclusions sont stockées dans
  `.sauron-config.json` à côté du `.prproj` (relatif → portable). Recocher un dossier rattrape
  les fichiers arrivés pendant l'exclusion.

## Installation (dev, non signé)

```bash
git clone <repo> && cd Sauron
npm install        # chokidar doit être présent dans node_modules/
```

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
