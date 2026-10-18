; SnAgentsOS custom NSIS hooks. electron-builder includes this file in the
; script header (nsis.include), before its templates: the macros below expand
; only where the templates insert them, with LogicLib and FileFunc loaded.
;
; One file shared by several epics (PLAN D7): E0 (v2.0) owns customInit,
; customPageAfterChangeDir and customInstall plus their helpers. Later epics add
; their own macro (customUnInstall, customUnInit) without touching these.
; scripts/test-rebrand.cjs guards the rules: read with SHCTX, never write
; InstallLocation, never kill a process tree and Pop after every nsExec::Exec.

!ifndef BUILD_UNINSTALLER
!define SN_LEGACY_FOLDER "SnMultiCC"
!define SN_LEGACY_EXE "SnMultiCC.exe"

Var snLegacyInstDir
Var snLegacyPinned

; Shown when a portable data folder sits where the old uninstaller would RMDir /r.
LangString snPortableDataInside 1033 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 3082 "Hay datos de una versión portable dentro de la carpeta de instalación. Movelos a otra carpeta y volvé a ejecutar el instalador."
; Every other bundled installer language falls back to English (makensis runs with -WX).
LangString snPortableDataInside 1031 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1036 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 2052 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1028 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1041 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1042 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1040 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1043 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1030 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1053 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1044 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1035 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1049 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 2070 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1046 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1045 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1058 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1029 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1051 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1038 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1025 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1055 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1054 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."
LangString snPortableDataInside 1066 "There is data from a portable version inside the installation folder. Move it to another folder and run the installer again."

; Legacy InstallLocation from the current context: HKCU per-user, HKLM per-machine
; (setInstallModePerUser / setInstallModePerAllUsers already chose it). Read before
; the install section: uninstallOldVersion deletes the key and
; registryAddInstallInfo rewrites it with the new folder.
!macro snReadLegacyInstDir
  ReadRegStr $snLegacyInstDir SHCTX "Software\${APP_GUID}" InstallLocation
!macroend

; Moves $INSTDIR to <parent>\SnAgentsOS only while it is still the legacy folder
; and its last component is the legacy name (LogicLib compares case-insensitively).
; A folder the user picked in the wizard is left alone, and on 2.x to 2.y the last
; component is already the new name, so nothing happens.
!macro snRedirectLegacyInstDir
  !insertmacro snReadLegacyInstDir
  ${If} $snLegacyInstDir != ""
  ${AndIf} $INSTDIR == $snLegacyInstDir
    ${GetFileName} $snLegacyInstDir $R8
    ${If} $R8 == "${SN_LEGACY_FOLDER}"
      ${GetParent} $snLegacyInstDir $R9
      StrCpy $INSTDIR "$R9\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}
!macroend

; The old uninstaller does RMDir /r on its folder (uninstaller.nsh:169) and a
; future one will do the same on the new folder: portable data inside would be
; lost. Stop before anything is uninstalled. The only manual stop of the setup.
!macro snGuardPortableData DIR
  ${If} ${FileExists} "${DIR}\snmulticc-data\*.*"
  ${OrIf} ${FileExists} "${DIR}\snagentsos-data\*.*"
    MessageBox MB_OK|MB_ICONSTOP "$(snPortableDataInside)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro snPrepareUpgrade
  !insertmacro snRedirectLegacyInstDir
  ${If} $snLegacyInstDir != ""
    !insertmacro snGuardPortableData "$snLegacyInstDir"
  ${EndIf}
  !insertmacro snGuardPortableData "$INSTDIR"
  ; Taskbar pin (E0-FR-31): the old uninstaller probably unpins it, so only
  ; remember it existed and let the app ask to pin again.
  SetShellVarContext current
  ${If} ${FileExists} "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SN_LEGACY_FOLDER}.lnk"
    StrCpy $snLegacyPinned "1"
  ${EndIf}
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
  ; Closes the current user's 1.x before uninstallOldVersion, even if its own
  ; uninstaller fails later. Only the process itself, never its tree: the 1.14.1
  ; updater launches this setup as a child of the old exe, so a tree kill would
  ; take the setup down too. cmd.exe expands %USERNAME% at runtime (same trick
  ; as FIND_PROCESS in allowOnlyOneInstallerInstance.nsh).
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /IM ${SN_LEGACY_EXE} /FI "USERNAME eq %USERNAME%"`
  Pop $R7
  Sleep 2000
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /IM ${SN_LEGACY_EXE} /F /FI "USERNAME eq %USERNAME%"`
  Pop $R7
!macroend
!endif

!macro customInit
  ; Silent path: no page rewrites $INSTDIR after this (except per-machine with
  ; /S, where the install section calls setInstallModePerAllUsers again, R14).
  ${If} ${Silent}
    !insertmacro snPrepareUpgrade
  ${EndIf}
!macroend

; Invisible page after the directory page. The install mode page already put the
; legacy folder back (multiUserUi.nsh), so the redirect runs here, before
; instFilesPre. It is also the first point where the user confirmed the wizard:
; cancelling earlier never closes the running 1.x. Abort in PRE skips the page.
!macro customPageAfterChangeDir
  Page custom snLegacyDirPre
  Function snLegacyDirPre
    !insertmacro snPrepareUpgrade
    Abort
  FunctionEnd
!macroend

!macro customInstall
  ; 1.x installer cache (APP_INSTALLER_STORE_FILE), no user data. Always the
  ; user's profile: with SetShellVarContext all, $LOCALAPPDATA is ProgramData.
  SetShellVarContext current
  RMDir /r "$LOCALAPPDATA\snmulticc-updater"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
  ; Read and deleted by the app's legacy cleanup (E0-FR-31, FR-32, FR-34). Value
  ; names must match INSTALLER_REG in src/shared/brand.ts.
  ${If} $snLegacyInstDir != ""
  ${AndIf} $snLegacyInstDir != $INSTDIR
    WriteRegStr SHCTX "Software\${APP_GUID}" LegacyInstallLocation $snLegacyInstDir
  ${EndIf}
  ${If} $snLegacyPinned == "1"
    WriteRegStr SHCTX "Software\${APP_GUID}" LegacyTaskbarPinned "1"
  ${EndIf}
!macroend
