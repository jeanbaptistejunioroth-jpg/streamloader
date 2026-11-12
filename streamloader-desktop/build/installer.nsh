; ─────────────────────────────────────────────────────────────
;  Assistant d'installation StreamLoader (pages supplémentaires)
;  Bienvenue → Pour qui → Dossier → Raccourcis → Installation → Terminé
; ─────────────────────────────────────────────────────────────

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  Var SlDesktopCheckbox
  Var SlDesktopWanted
!endif

; Page de bienvenue
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Bienvenue dans l'installation de StreamLoader"
  !define MUI_WELCOMEPAGE_TEXT "Cet assistant va installer StreamLoader sur ton ordinateur.$\r$\n$\r$\nStreamLoader pour Windows est réservé aux abonnés Premium : tu te connecteras avec ton compte du site streamloaders.net.$\r$\n$\r$\nClique sur Suivant pour continuer."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Page « Raccourcis » : case à cocher pour le Bureau
!macro customPageAfterChangeDir
  Page custom SlShortcutPageCreate SlShortcutPageLeave

  Function SlShortcutPageCreate
    StrCpy $SlDesktopWanted ${BST_CHECKED}
    !insertmacro MUI_HEADER_TEXT "Raccourcis" "Choisis où tu veux retrouver ${PRODUCT_NAME}."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 24u "${PRODUCT_NAME} sera ajouté au menu Démarrer. Tu peux aussi placer un raccourci sur ton Bureau :"
    Pop $0
    ${NSD_CreateCheckbox} 0 34u 100% 12u "Créer un raccourci sur le Bureau"
    Pop $SlDesktopCheckbox
    ${NSD_Check} $SlDesktopCheckbox
    nsDialogs::Show
  FunctionEnd

  Function SlShortcutPageLeave
    ${NSD_GetState} $SlDesktopCheckbox $SlDesktopWanted
  FunctionEnd
!macroend

!macro customInstall
  ${If} $SlDesktopWanted == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${endIf}
!macroend
