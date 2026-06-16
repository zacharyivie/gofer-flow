!include LogicLib.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

Var GoferCliPathCheckbox
Var GoferCliPathChoice

!macro customInit
  StrCpy $GoferCliPathChoice ${BST_CHECKED}
!macroend

!macro customPageAfterChangeDir
  Page custom GoferCliPathPageCreate GoferCliPathPageLeave
!macroend

!macro customInstall
  ${If} $GoferCliPathChoice == ${BST_CHECKED}
    Call AddGoferCliToUserPath
  ${EndIf}
!macroend

!macro customUnInstall
  Call un.RemoveGoferCliFromUserPath
!macroend

Function GoferCliPathPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Command line" "Choose whether to make gof available from terminals."

  ${NSD_CreateLabel} 0 0 100% 24u "Gofer Flow includes the gof command line tool for running workflows from PowerShell, Command Prompt, scripts, and automation."
  Pop $0

  ${NSD_CreateCheckbox} 0 34u 100% 12u "Add gof CLI to my user PATH"
  Pop $GoferCliPathCheckbox
  ${NSD_Check} $GoferCliPathCheckbox

  nsDialogs::Show
FunctionEnd

Function GoferCliPathPageLeave
  ${NSD_GetState} $GoferCliPathCheckbox $GoferCliPathChoice
FunctionEnd

Function AddGoferCliToUserPath
  nsExec::ExecToLog "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $\"$$entry = '$INSTDIR\resources\backend'; $$path = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$path -split ';' | Where-Object { $$_ }); if ($$parts -notcontains $$entry) { $$parts += $$entry; [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User') }$\""
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
FunctionEnd

Function un.RemoveGoferCliFromUserPath
  nsExec::ExecToLog "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $\"$$entry = '$INSTDIR\resources\backend'; $$path = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$path -split ';' | Where-Object { $$_ -and $$_ -ne $$entry }); [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User')$\""
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
FunctionEnd
