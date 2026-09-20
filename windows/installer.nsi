Unicode true
Name "local-harness-ai"
OutFile "..\local_harness_ai_1_0.exe"
InstallDir "$LOCALAPPDATA\local-harness-ai"
RequestExecutionLevel user

Page directory
Page instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File "dist\LocalHarnessAI.exe"
  File "dist\local-harness-ai-server.exe"
  CreateDirectory "$SMPROGRAMS\local-harness-ai"
  CreateShortcut "$SMPROGRAMS\local-harness-ai\local-harness-ai.lnk" "$INSTDIR\LocalHarnessAI.exe"
  CreateShortcut "$DESKTOP\local-harness-ai.lnk" "$INSTDIR\LocalHarnessAI.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local-harness-ai" "DisplayName" "local-harness-ai"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local-harness-ai" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\local-harness-ai.lnk"
  Delete "$SMPROGRAMS\local-harness-ai\local-harness-ai.lnk"
  RMDir "$SMPROGRAMS\local-harness-ai"
  Delete "$INSTDIR\LocalHarnessAI.exe"
  Delete "$INSTDIR\local-harness-ai-server.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\local-harness-ai"
SectionEnd
