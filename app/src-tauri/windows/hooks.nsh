; Hooks of the Mango Code installer (included by Tauri's NSIS template).

; Before copying, remove the program files of the previous version: an update that only
; overwrites them would leave deleted ones lying around (a removed skill would stay visible to the
; model). The user's data is in %LOCALAPPDATA%\MangoCode and is not touched.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\resources"
!macroend

; "Open with Mango Code" ("Apri con Mango Code" in Italian) in the File Explorer right-click menu: on a folder and
; on the background of an open folder (`%V` is one or the other). The trailing `\.` is for drive roots: `"C:\"` would
; escape the closing quote and the path would reach the app wrong. Under SHCTX like all the installer
; entries: HKCU\Software\Classes for a per-user install, HKLM for a per-machine one. The label follows the
; language the installer runs in (Tauri's NSIS languages: Italian and English).
!macro MANGO_FOLDER_MENU_ENTRY key
  ${If} $LANGUAGE = ${LANG_ITALIAN}
    WriteRegStr SHCTX "Software\Classes\${key}\MangoCode" "" "Apri con Mango Code"
  ${Else}
    WriteRegStr SHCTX "Software\Classes\${key}\MangoCode" "" "Open with Mango Code"
  ${EndIf}
  WriteRegStr SHCTX "Software\Classes\${key}\MangoCode" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\${key}\MangoCode\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V\."'
!macroend

; Desktop shortcut always: in Tauri's template it is only a checkbox on the final page,
; and whoever unticks it by mistake would be left without an icon.
!macro NSIS_HOOK_POSTINSTALL
  Call CreateOrUpdateDesktopShortcut
  !insertmacro MANGO_FOLDER_MENU_ENTRY "Directory\shell"
  !insertmacro MANGO_FOLDER_MENU_ENTRY "Directory\Background\shell"
  ; After an update Windows would keep the old icon in the taskbar (icon cache,
  ; same executable path): SHCNE_ASSOCCHANGED makes it reread it.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\MangoCode"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\MangoCode"
!macroend

; On uninstall, the user is asked whether to delete their data too. The 9 GB model is in
; %LOCALAPPDATA%\MangoCode\models: keeping it by default avoids a new download for whoever reinstalls.
; On updates (the new installer removes the previous version) and on silent
; uninstall nothing is asked and the data stays.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
  ${AndIfNot} ${Silent}
    ${If} $LANGUAGE = ${LANG_ITALIAN}
      StrCpy $0 "Vuoi eliminare anche il modello scaricato, i log e le impostazioni di Mango Code?$\r$\n$\r$\nLa cartella $LOCALAPPDATA\MangoCode occupa diversi gigabyte. Se pensi di reinstallare Mango Code conviene tenerla."
    ${Else}
      StrCpy $0 "Also delete the downloaded model, logs and settings of Mango Code?$\r$\n$\r$\nThe folder $LOCALAPPDATA\MangoCode takes several gigabytes. If you plan to reinstall Mango Code it is better to keep it."
    ${EndIf}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$0" IDNO +2
    RMDir /r "$LOCALAPPDATA\MangoCode"
  ${EndIf}
!macroend
