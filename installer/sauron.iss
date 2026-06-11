; Sauron — installeur Windows en un seul fichier, sans droits admin.
; Compilé par GitHub Actions à chaque release (version injectée via /DAppVersion).
; Il fait exactement ce que install/install-windows.bat fait en dev :
; PlayerDebugMode (CSXS 9→12) + copie du panneau dans les extensions CEP utilisateur.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{C2A3F0D1-7B7E-4A52-9B1C-5E1F3D8A6E47}
AppName=Sauron
AppVersion={#AppVersion}
AppPublisher=Splainte
AppPublisherURL=https://github.com/Splainte/Sauron
; Tout vit dans le profil utilisateur (AppData + HKCU) → pas d'élévation.
PrivilegesRequired=lowest
DefaultDirName={userappdata}\Adobe\CEP\extensions\com.splainte.sauron
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=Sauron-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Premiere peut tourner pendant une mise à jour : les fichiers du panneau
; ne sont pas verrouillés, inutile de forcer la fermeture d'applications.
CloseApplications=no

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
french.FinishedLabel=Sauron est installé.%n%nRedémarrez Premiere Pro puis ouvrez Fenêtre > Extensions > Sauron.
english.FinishedLabel=Sauron is installed.%n%nRestart Premiere Pro, then open Window > Extensions > Sauron.

[Files]
Source: "..\*"; DestDir: "{app}"; Excludes: "\.git*,\install,\installer"; Flags: recursesubdirs ignoreversion

[Registry]
; Panneaux CEP non signés : PlayerDebugMode pour toutes les versions CSXS visées.
Root: HKCU; Subkey: "Software\Adobe\CSXS.9"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
