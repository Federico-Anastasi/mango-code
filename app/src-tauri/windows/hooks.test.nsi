; Test harness of hooks.nsh (hooks.test.mjs compiles it). It stands in for Tauri's template just enough for
; the macros to expand (so a mistake in their syntax fails the build) and runs the one that deletes data.
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${OUT}"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\Italian.nlf"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
!include LogicLib.nsh

!define SHCTX HKCU
!define MAINBINARYNAME "mango-code"
Var UpdateMode
Function CreateOrUpdateDesktopShortcut
FunctionEnd
!include "hooks.nsh"

; Never called: it is there for the macros to expand.
Function ExpandHooks
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro NSIS_HOOK_POSTINSTALL
  !insertmacro NSIS_HOOK_PREUNINSTALL
  !insertmacro NSIS_HOOK_POSTUNINSTALL
FunctionEnd

Section
  !insertmacro MANGO_FREE_SPACE "$EXEDIR\data"
SectionEnd
