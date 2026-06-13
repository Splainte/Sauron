# 👁 Sauron

Panneau **CEP pour Adobe Premiere Pro** : synchronise en un clic les dossiers du projet
(rushs, éléments…) vers des **chutiers miroir** dans Premiere. Alternative maison et
gratuite à Watchtower.

## Comment ça marche

Fonctionnement **ponctuel**, en deux temps :

1. **Check** : le panneau lit `app.project.path`, en déduit la racine du projet montage
   (le `.prproj` vit dans `PROJETS/`), liste ses dossiers de 1er niveau sous forme de
   **cases à cocher** et compte les fichiers que Premiere ne connaît pas encore.
   **Rien n'est importé** à cette étape.
2. **Synchroniser** : importe tout le contenu des dossiers cochés vers des chutiers
   miroir, en évitant les doublons.

`PROJETS` et `EXPORTS` sont **exclus en dur** :

```
NOM DU PROJET/      ← racine du projet montage
├── ELEMENTS/       ← synchronisé → chutier ELEMENTS
├── RUSHS/          ← synchronisé → chutier RUSHS (idem tout autre dossier)
├── PROJETS/        ← JAMAIS synchronisé (le .prproj + .sauron-*.json vivent ici)
└── EXPORTS/        ← JAMAIS synchronisé
```

La reconnaissance de `PROJETS`/`EXPORTS` (et du dossier `Proxies`) est **tolérante aux
variantes** : casse, accents, espaces, S final et une faute de frappe près
(« EXPORT », « exports », « Éxports », « EXPROTS »… sont tous reconnus). Pareil pour
localiser le dossier `PROJETS`.

- `ELEMENTS/musique/track.mp3` → importé dans le chutier `musique` **dans** le chutier `ELEMENTS`.
- Les sous-dossiers (même vides) deviennent des chutiers à la synchro.
- **Synchro à sens unique (additive)** : on n'efface jamais un chutier quand un dossier disparaît.
- **Anti-doublon** : registre `.sauron-registry.json` à côté du `.prproj` + reconnaissance des
  médias que Premiere connaît déjà sous un autre chemin absolu (UNC vs lettre mappée, casse…),
  homonymes départagés par la taille en octets. Dans le doute, on n'importe pas.
- **Aucun chemin absolu stocké** : tout est recalculé depuis le `.prproj`, le registre n'a que des
  chemins relatifs → le dossier projet reste copiable tel quel sur un disque externe.
- **Copies en cours détectées** : un fichier dont la taille bouge encore (gros rush depuis le
  NAS…) est ignoré pour cette synchro, signalé dans le log, et rattrapé à la suivante.
- **Proxies ignorés** : tout dossier `Proxies` (où qu'il soit dans l'arbo) et tout fichier
  `*_proxy.*` sont invisibles pour Sauron — la génération de proxies Premiere ne pollue
  jamais les chutiers.
- **Rien ne se passe sans clic** : ouvrir le panneau ne déclenche aucune analyse ni import.
- **Cases à cocher** : chaque dossier de 1er niveau est coché par défaut. Les exclusions sont
  stockées dans `.sauron-config.json` à côté du `.prproj` (relatif → portable). Recocher un
  dossier rattrape les fichiers arrivés pendant l'exclusion.

## Installation

**Windows (recommandé)** : télécharger `Sauron-Setup.exe` depuis la
[dernière release](https://github.com/Splainte/Sauron/releases/latest), double-clic,
suivre l'assistant. Pas de droits admin nécessaires. Redémarrer Premiere →
**Fenêtre > Extensions > Sauron**.

**Mises à jour** : bouton « Vérifier les mises à jour » en bas du panneau — il télécharge
et lance l'installeur de la dernière version publiée.

Compatibilité : Premiere Pro 2020 (14.0) et + (tant qu'Adobe maintient CEP).

### Installation dev (depuis le repo)

```bash
git clone https://github.com/Splainte/Sauron.git && cd Sauron
```

Aucune dépendance à installer (panneau 100 % Node intégré à CEP) : un `git pull` suffit
pour se mettre à jour.

- **Windows** : double-clic sur `install/install-windows.bat`
- **macOS** : `bash install/install-macos.sh`

Les scripts font la même chose que l'installeur : `PlayerDebugMode` (CSXS 9→12) + copie du
panneau dans le dossier extensions CEP utilisateur.

### Publier une release

1. Mettre à jour `ExtensionBundleVersion` (deux occurrences) dans `CSXS/manifest.xml`.
2. Tagger : `git tag v1.2.3 && git push origin v1.2.3`.
3. GitHub Actions compile `Sauron-Setup.exe` (Inno Setup) et publie la release — c'est elle
   que le bouton de mise à jour du panneau interroge.

## Debug

`.debug` expose le panneau sur `http://localhost:8088` (DevTools Chrome) quand PlayerDebugMode est actif.

## Distribution équipe (plus tard)

Packager en `.zxp` signé via [ZXPSignCmd](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD)
pour installer sans PlayerDebugMode.
