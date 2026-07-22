@echo off
chcp 65001 >nul
setlocal EnableExtensions

cd /d "%~dp0"
set "SCRIPT_DIR=%CD%"
set "UPSTREAM_REPO=loqwe/heyun-zjmf-worker-monitor"
set "REMOTE_BASE=https://raw.githubusercontent.com/%UPSTREAM_REPO%/main/windows-one-click-deploy"
set "PS1_FILE=%SCRIPT_DIR%\deploy-one-click.ps1"
set "EXAMPLE_FILE=%SCRIPT_DIR%\one-click.config.example.jsonc"
set "CONFIG_FILE=%SCRIPT_DIR%\one-click.config.jsonc"
set "PS1_URL=%REMOTE_BASE%/deploy-one-click.ps1"
set "EXAMPLE_URL=%REMOTE_BASE%/one-click.config.example.jsonc"

set "PS_EXE="
call :detect_pwsh
if defined PS_EXE goto after_detect_powershell

echo [提示] 未找到 PowerShell 7，正在尝试通过 winget 自动安装。
call :install_powershell_7
call :detect_pwsh
:after_detect_powershell

if not defined PS_EXE (
  echo [ERROR] 需要 PowerShell 7，但自动安装未成功。
  echo 请先安装 PowerShell 7 后重新运行本脚本：
  echo https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows
  pause
  exit /b 1
)

echo.
echo ========================================
echo heyun-zjmf-worker-monitor 步骤2-一键部署
echo ========================================
echo.

if not exist "%PS1_FILE%" (
  echo [提示] 缺少 deploy-one-click.ps1，正在自动下载。
  call :fetch "%PS1_FILE%" "%PS1_URL%" "deploy-one-click.ps1"
  if errorlevel 1 goto support_download_failed
)

if not exist "%EXAMPLE_FILE%" (
  echo [提示] 缺少配置模板，正在自动下载。
  call :fetch "%EXAMPLE_FILE%" "%EXAMPLE_URL%" "one-click.config.example.jsonc"
  if errorlevel 1 goto support_download_failed
)

if not exist "%CONFIG_FILE%" (
  copy /Y "%EXAMPLE_FILE%" "%CONFIG_FILE%" >nul
  if errorlevel 1 goto config_create_failed
  echo [成功] 已创建 one-click.config.jsonc
)

call :normalize_utf8_bom "%PS1_FILE%"
if errorlevel 1 exit /b 1

if /I "%~1"=="--self-test" (
  set "ZJMF_ADMIN_TOKEN=admin"
  "%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS1_FILE%" -ConfigPath "%CONFIG_FILE%" -PreflightOnly
  exit /b %ERRORLEVEL%
)

"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS1_FILE%" -ConfigPath "%CONFIG_FILE%" -Interactive -RefreshSource
set "SCRIPT_EXIT=%ERRORLEVEL%"
echo.
if not "%SCRIPT_EXIT%"=="0" (
  echo [ERROR] 部署已中断，退出码：%SCRIPT_EXIT%
  echo 请查看上方错误信息。
) else (
  echo [OK] 部署脚本执行完成。
)
pause
exit /b %SCRIPT_EXIT%

:support_download_failed
echo [ERROR] 部署辅助文件下载失败，请检查网络后重新运行。
pause
exit /b 1

:config_create_failed
echo [ERROR] 无法创建 one-click.config.jsonc，请检查目录写入权限。
pause
exit /b 1

:detect_pwsh
set "PS_EXE="
where pwsh >nul 2>nul
if not errorlevel 1 set "PS_EXE=pwsh"
if defined PS_EXE exit /b 0
if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PS_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
exit /b 0

:install_powershell_7
where winget >nul 2>nul
if errorlevel 1 exit /b 1
winget install -e --id Microsoft.PowerShell --source winget --silent --accept-package-agreements --accept-source-agreements
set "PATH=%ProgramFiles%\PowerShell\7;%PATH%"
exit /b 0

:fetch
echo 下载/更新：%~3
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $tmp='%~1.tmp'; $attempt=0; while($attempt -lt 3){$attempt++; try{if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force}; Invoke-WebRequest -Uri '%~2' -OutFile $tmp -UseBasicParsing; Move-Item -LiteralPath $tmp -Destination '%~1' -Force; exit 0}catch{if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force}; if($attempt -ge 3){throw}; Write-Host ('下载失败，正在进行第 '+($attempt+1)+' 次尝试...') -ForegroundColor Yellow; Start-Sleep -Seconds (2*$attempt)}}"
exit /b %ERRORLEVEL%

:normalize_utf8_bom
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$p='%~1'; $t=Get-Content -LiteralPath $p -Raw -Encoding UTF8; [System.IO.File]::WriteAllText($p,$t,[System.Text.UTF8Encoding]::new($true))"
exit /b %ERRORLEVEL%
