# 👁 Sauron

Panneau **Adobe Premiere Pro** qui importe les médias de ton projet dans des **chutiers
miroir**, en un clic.

Tu déposes tes fichiers dans les dossiers de ton projet (rushs, sons, éléments…), Sauron
les retrouve et les range dans Premiere dans des chutiers qui reproduisent l'arborescence
de tes dossiers — sans doublons, sans clic-par-clic.

## Comment ça s'utilise

Le panneau travaille en deux temps, quand **tu** le décides :

1. **Check** — Sauron repère ton projet ouvert, liste ses dossiers (cases à cocher) et
   t'indique combien de nouveaux fichiers il a trouvés dans chacun. Rien n'est encore importé.
2. **Synchroniser** — il importe le contenu des dossiers cochés dans Premiere, en recréant
   l'arborescence sous forme de chutiers et en ignorant ce qui est déjà là.

Décoche un dossier pour ne pas l'importer. Les dossiers `PROJETS` et `EXPORTS` ainsi que les
proxies sont ignorés automatiquement. Tu peux relancer Check / Synchroniser autant de fois
que tu veux : seuls les nouveaux fichiers sont ajoutés.

## Installation

**Windows** : télécharge **[Sauron-Setup.exe](https://github.com/Splainte/Sauron/releases/latest)**,
double-clique, suis l'assistant (pas de droits administrateur nécessaires). Puis redémarre
Premiere et ouvre **Fenêtre > Extensions > Sauron**.

> À la première installation, Windows peut afficher un avertissement SmartScreen (l'app
> n'est pas signée) : clique sur « Informations complémentaires » puis « Exécuter quand même ».

**Mises à jour** : un bouton **« Vérifier les mises à jour »** en bas du panneau télécharge
et installe la dernière version tout seul, sans ressortir l'avertissement.

Compatibilité : Premiere Pro 2020 (14.0) et versions ultérieures.
