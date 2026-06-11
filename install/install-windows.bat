@echo off
REM Sauron — installation dev sur Windows (PC fixe)
REM 1. Active PlayerDebugMode (panneaux CEP non signés)
REM 2. Copie le panneau dans le dossier extensions CEP utilisateur

for %%V in (9 10 11 12) do (
  reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
)

set DEST=%APPDATA%\Adobe\CEP\extensions\com.splainte.sauron
robocopy "%~dp0.." "%DEST%" /MIR /XD .git install /XF .gitignore >nul

echo.
echo Sauron installe dans %DEST%
echo Redemarre Premiere Pro puis : Fenetre ^> Extensions ^> Sauron
pause
