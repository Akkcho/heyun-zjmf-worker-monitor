[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [string]$SourceRoot = "",
    [string]$UpstreamRepo = "loqwe/heyun-zjmf-worker-monitor",
    [string]$UpstreamRef = "main",
    [string]$WranglerVersion = "4.91.0",
    [string]$CacheRoot = "",
    [switch]$RefreshSource,
    [switch]$PreflightOnly,
    [switch]$PrepareOnly,
    [switch]$SkipSeed,
    [switch]$Interactive
)

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host "部署已中断: 需要 PowerShell 7 或更高版本，请安装后使用 pwsh 重新运行。" -ForegroundColor Red
    exit 1
}

$ScriptPath = $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ScriptPath)) {
    Write-Host "部署已中断: 无法确定 deploy-one-click.ps1 所在目录，请通过 pwsh -File 和完整脚本路径运行。" -ForegroundColor Red
    exit 1
}
$ScriptDirectory = Split-Path -Parent $ScriptPath
if ([string]::IsNullOrWhiteSpace($ScriptDirectory)) {
    Write-Host "部署已中断: 无法解析 deploy-one-click.ps1 所在目录，请重新下载部署文件。" -ForegroundColor Red
    exit 1
}
$Root = [System.IO.Path]::GetFullPath($ScriptDirectory)
if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
    $CacheRoot = Join-Path $Root ".cache\heyun-zjmf-worker-monitor"
}

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Npm = if (Get-Command "npm.cmd" -ErrorAction SilentlyContinue) { "npm.cmd" } else { "npm" }
$WranglerPackage = "wrangler@$WranglerVersion"
$script:WranglerToolRoot = Join-Path $CacheRoot "tools\wrangler-$WranglerVersion"
$script:WranglerCliPath = Join-Path $script:WranglerToolRoot "node_modules\wrangler\bin\wrangler.js"
$script:WranglerNpmCache = Join-Path $CacheRoot "npm-cache"
$env:npm_config_cache = $script:WranglerNpmCache
$env:WRANGLER_PACKAGE = $WranglerPackage
$script:TranscriptStarted = $false
$script:LogFinalized = $false
$script:RawLogPath = ""
$script:SafeLogPath = ""

function Write-Step([string]$Message) { Write-Host ""; Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note([string]$Message) { Write-Host " -> $Message" -ForegroundColor DarkGray }
function Start-DeploymentLog {
    try {
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $script:SafeLogPath = Join-Path $Root "部署日志-$timestamp-$PID.log"
        $script:RawLogPath = Join-Path ([System.IO.Path]::GetTempPath()) "zjmf-deploy-$timestamp-$PID-$([guid]::NewGuid().ToString('N')).raw.log"
        Start-Transcript -Path $script:RawLogPath -Force -UseMinimalHeader | Out-Null
        $script:TranscriptStarted = $true
        Write-Note "已开启部署日志，结束后会自动脱敏。"
    } catch {
        $script:TranscriptStarted = $false
        Write-Host "警告：无法开启部署日志：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}
function Get-SensitiveLogValues {
    $values = [System.Collections.Generic.List[string]]::new()
    foreach ($name in @(
        "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "WEB_UPDATE_GITHUB_TOKEN",
        "ZJMF_ADMIN_TOKEN", "ZJMF_API_ACCOUNT", "ZJMF_API_PASSWORD", "ZJMF_SERVER_IP",
        "PUSHPLUS_TOKEN", "USERPROFILE"
    )) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrWhiteSpace($value)) { $values.Add($value) }
    }
    $configVariable = Get-Variable -Name Config -Scope Script -ErrorAction SilentlyContinue
    if ($configVariable -and $configVariable.Value -is [System.Collections.IDictionary]) {
        foreach ($key in @(
            "cloudflareAccountId", "adminToken", "webUpdateGitHubToken", "zjmfApiAccount",
            "zjmfApiPassword", "serverIp", "tcpHost", "pushplusToken"
        )) {
            if ($configVariable.Value.Contains($key)) {
                $value = [string]$configVariable.Value[$key]
                if (-not [string]::IsNullOrWhiteSpace($value)) { $values.Add($value) }
            }
        }
    }
    foreach ($name in @("adminToken", "versionToken", "webUpdateToken")) {
        $variable = Get-Variable -Name $name -Scope Script -ErrorAction SilentlyContinue
        if ($variable -and -not [string]::IsNullOrWhiteSpace([string]$variable.Value)) { $values.Add([string]$variable.Value) }
    }
    return $values | Select-Object -Unique
}
function Protect-DeploymentLogText([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return "" }
    $safe = $Text
    foreach ($value in @(Get-SensitiveLogValues)) {
        if ($value.Length -ge 6 -and $value -notmatch '[\r\n]') { $safe = $safe.Replace($value, "[REDACTED]") }
    }
    $safe = [regex]::Replace($safe, '(?i)\b(?:cfut_|github_pat_|gh[pousr]_)[A-Za-z0-9_-]{8,}\b', '[REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}', '${1}[REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)([?&](?:token|secret|password|passwd|api[_-]?key)=)[^&\s]+', '${1}[REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', '[REDACTED]')
    $safe = [regex]::Replace($safe, '(?<!\d)1[3-9]\d{9}(?!\d)', '[REDACTED]')
    $safe = [regex]::Replace($safe, '\b(?:\d{1,3}\.){3}\d{1,3}\b', '[REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)\b[0-9a-f]{32}\b', '[REDACTED]')
    $safe = [regex]::Replace($safe, '(?i)C:\\Users\\[^\\\s]+', '[REDACTED_USERPROFILE]')
    $safe = [regex]::Replace($safe, '(?im)^Username:\s*.+$', 'Username: [REDACTED]')
    return $safe
}
function Complete-DeploymentLog {
    if ($script:LogFinalized) { return }
    $script:LogFinalized = $true
    if (-not $script:TranscriptStarted) { return }
    try { Stop-Transcript | Out-Null } catch {}
    $logError = ""
    try {
        $raw = [System.IO.File]::ReadAllText($script:RawLogPath)
        $safe = Protect-DeploymentLogText $raw
        $header = "heyun-zjmf-worker-monitor 脱敏部署日志`r`n敏感凭证、账号、IP 和本机用户信息已替换为 [REDACTED]。`r`n`r`n"
        [System.IO.File]::WriteAllText($script:SafeLogPath, $header + $safe, [System.Text.UTF8Encoding]::new($false))
    } catch {
        $logError = $_.Exception.Message
    } finally {
        if ($script:RawLogPath -and (Test-Path -LiteralPath $script:RawLogPath)) {
            Remove-Item -LiteralPath $script:RawLogPath -Force -ErrorAction SilentlyContinue
        }
    }
    if ($logError) {
        Write-Host "警告：部署日志脱敏保存失败：$logError" -ForegroundColor Yellow
    } else {
        Write-Host "脱敏部署日志：$script:SafeLogPath" -ForegroundColor Cyan
    }
}
function Invoke-DownloadFile([string]$Url, [string]$OutFile) {
    if (Test-Path $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -TimeoutSec 180 -UseBasicParsing -Headers @{ "User-Agent" = "heyun-zjmf-worker-monitor-one-click" }
        if (-not (Test-Path $OutFile) -or (Get-Item -LiteralPath $OutFile).Length -le 0) { throw "下载文件为空" }
        return $true
    } catch {
        if (Test-Path $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
        Write-Note "当前地址失败：$($_.Exception.Message)"
        return $false
    }
}
function Get-ConfigValue($Config, [string]$Key, [string]$Default = "") {
    if ($Config.ContainsKey($Key) -and $null -ne $Config[$Key] -and -not [string]::IsNullOrWhiteSpace([string]$Config[$Key])) { return [string]$Config[$Key] }
    return $Default
}
function Get-ConfigInt($Config, [string]$Key, [int]$Default) {
    $value = Get-ConfigValue $Config $Key ""
    if ($value -match '^\d+$') { return [int]$value }
    return $Default
}
function New-RandomSecret([int]$Length = 32) {
    $chars = @()
    $chars += [char[]](48..57)
    $chars += [char[]](65..90)
    $chars += [char[]](97..122)
    return -join (1..$Length | ForEach-Object { $chars | Get-Random })
}
function Read-RequiredText([string]$Prompt) {
    do {
        $raw = Read-Host $Prompt
        if ($null -eq $raw) { throw "未读取到输入：$Prompt" }
        $value = $raw.Trim()
    } while ([string]::IsNullOrWhiteSpace($value))
    return $value
}
function Read-OptionalText([string]$Prompt) {
    $raw = Read-Host $Prompt
    if ($null -eq $raw) { return "" }
    return $raw.Trim()
}
function ConvertTo-PlainText([System.Security.SecureString]$SecureValue) {
    $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Read-OptionalSecret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    if ($null -eq $secure) { return "" }
    return (ConvertTo-PlainText $secure).Trim()
}
function Read-AdminTokenWithConfirmation {
    while ($true) {
        $first = Read-OptionalSecret "请输入当前管理后台网站密码（首次部署直接回车使用默认密码 admin）"
        $second = Read-OptionalSecret "请再次输入当前管理后台网站密码"
        if ([string]::IsNullOrWhiteSpace($first) -and [string]::IsNullOrWhiteSpace($second)) { return "admin" }
        if ($first -ceq $second -and -not [string]::IsNullOrWhiteSpace($first)) { return $first }
        Write-Host "两次输入不一致，请重新输入。" -ForegroundColor Yellow
    }
}
function Show-InteractiveGuide {
    Write-Step "部署前准备"
    Write-Host "1. 获取 Cloudflare API Token："
    Write-Host "   打开 https://dash.cloudflare.com/profile/api-tokens"
    Write-Host "   点击 创建令牌 -> API 令牌模板 -> 编辑 Cloudflare Workers -> 使用模板。"
    Write-Host "   下一步点击 增加更多帐户，添加 D1 / 编辑。"
    Write-Host "   账户资源选择 包括所有账户；区域资源选择 包括所有区域。"
    Write-Host "   最后滑到最下面，点击 继续以显示摘要，再点 创建令牌。"
    Write-Host "   Token 只显示一次，请复制保存，后面会要求粘贴。"
    Write-Host "2. 获取 Cloudflare 账户 ID（不是 IP）："
    Write-Host "   可复制脚本检测显示的账户 ID；也可在 Cloudflare 账户主页右侧三个点里点击 复制账户 ID。"
    Write-Host "3. GitHub 仓库地址："
    Write-Host "   复制你 Fork 后仓库的地址，例如 https://github.com/你的用户名/heyun-zjmf-worker-monitor。"
    Write-Host ""
    Write-Host "更新方式："
    Write-Host "1. 首推：双击 步骤1-一键安装脚本.bat，脚本会刷新源码并复用同名 D1 数据库。"
    Write-Host "2. 管理后台 -> 系统更新 -> 检查更新 / 确定更新。此方式需要 GitHub 更新令牌："
    Write-Host "   打开 https://github.com/settings/personal-access-tokens/new"
    Write-Host "   Token name 填 zjmf-monitor-update；Resource owner 选择你的 GitHub 账号。"
    Write-Host "   Repository access 选择 Only select repositories，并选择你 Fork 后的仓库。"
    Write-Host "   Repository permissions 设置 Actions: Read and write、Contents: Read-only。"
    Write-Host "   点击 Generate token 后复制 github_pat_ 开头的令牌；不填则只能检查更新。"
    Write-Host "3. 到你的 Fork 仓库点 Sync fork -> Update branch；前提是仓库已配置 Actions Secrets。"
}
function Convert-GitHubRepoInput([string]$Value) {
    $text = $Value.Trim().TrimEnd("/")
    $text = $text -replace '\.git$', ''
    if ($text -match 'github\.com[:/]+([^/]+)/([^/#?]+)') { return "$($matches[1])/$($matches[2])" }
    if ($text -match '^[^/\s]+/[^/\s]+$') { return $text }
    throw "仓库地址格式不正确，请输入 https://github.com/用户名/仓库名 或 用户名/仓库名。"
}
function Resolve-GitHubRefSha([string]$Repo, [string]$Ref, [string]$Token = "") {
    if ([string]::IsNullOrWhiteSpace($Repo) -or [string]::IsNullOrWhiteSpace($Ref)) { return "" }
    try {
        $headers = @{ "User-Agent" = "heyun-zjmf-worker-monitor-one-click"; "Accept" = "application/vnd.github+json" }
        if (-not [string]::IsNullOrWhiteSpace($Token)) { $headers.Authorization = "Bearer $Token" }
        $apiUrl = "https://api.github.com/repos/$Repo/commits/$Ref"
        $data = Invoke-RestMethod -Method Get -Uri $apiUrl -Headers $headers -TimeoutSec 30
        return [string]$data.sha
    } catch {
        Write-Note "未能解析 GitHub 当前版本号：$($_.Exception.Message)"
        return ""
    }
}
function Save-Config($Config) {
    $Config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $script:ConfigPath -Encoding utf8
}
function Remove-JsonComments([string]$Text) {
    $sb = [System.Text.StringBuilder]::new()
    $inString = $false; $escape = $false; $lineComment = $false; $blockComment = $false
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $c = $Text[$i]
        $n = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }
        if ($lineComment) {
            if ($c -eq "`n") { [void]$sb.Append($c); $lineComment = $false }
            continue
        }
        if ($blockComment) {
            if ($c -eq "*" -and $n -eq "/") { $i++; $blockComment = $false }
            continue
        }
        if ($inString) {
            [void]$sb.Append($c)
            if ($escape) { $escape = $false }
            elseif ($c -eq "\") { $escape = $true }
            elseif ($c -eq '"') { $inString = $false }
            continue
        }
        if ($c -eq '"') { [void]$sb.Append($c); $inString = $true; continue }
        if ($c -eq "/" -and $n -eq "/") { $i++; $lineComment = $true; continue }
        if ($c -eq "/" -and $n -eq "*") { $i++; $blockComment = $true; continue }
        [void]$sb.Append($c)
    }
    return $sb.ToString()
}
function ConvertFrom-JsoncFile([string]$Path) {
    $content = Get-Content -LiteralPath $Path -Raw -Encoding utf8
    return (Remove-JsonComments $content | ConvertFrom-Json -AsHashtable)
}
function Get-DefaultConfigText {
    return @'
{
  // Cloudflare Worker 名称和 D1 数据库名
  "workerName": "zjmf-monitor",
  "d1DatabaseName": "zjmf-monitor",
  "cloudflareAccountId": "",

  // GitHub 仓库地址，步骤1-一键安装脚本会从这里下载源码
  "upstreamRepo": "loqwe/heyun-zjmf-worker-monitor",

  // 管理后台网站密码；双击 BAT 交互部署时会要求输入两次
  "adminToken": "请填写强密码",

  // 可选：网页“系统更新 -> 确定更新”触发 GitHub Actions 用的 Fine-grained PAT
  // 获取：https://github.com/settings/personal-access-tokens/new
  // 仓库只选你的 Fork；权限给 Actions: Read and write、Contents: Read-only
  "webUpdateGitHubToken": "",

  // 魔方财务配置；可留空，部署后到 /admin 初始化向导填写
  "providerName": "heyunidc",
  "providerDisplayName": "核云",
  "zjmfApiBaseUrl": "https://www.heyunidc.cn/v1",
  "zjmfApiAccount": "",
  "zjmfApiPassword": "",
  "serverId": "",
  "serverName": "",
  "serverIp": "",

  // 检测配置
  "checkMethod": "service_then_power",
  "httpUrl": "",
  "httpMethod": "GET",
  "httpExpectedStatus": "200-399",
  "tcpHost": "",
  "tcpPort": 996,
  "dailyRebootLimit": 3,

  // 通知配置
  "pushplusToken": "",
  "timezone": "Asia/Shanghai"
}
'@
}
function Get-WranglerCommand([string[]]$SubCommands) {
    return @("node", $script:WranglerCliPath) + $SubCommands
}
function Initialize-Wrangler {
    if (Test-Path -LiteralPath $script:WranglerCliPath) {
        $env:WRANGLER_CLI_PATH = $script:WranglerCliPath
        Write-Note "复用已安装的 Wrangler $WranglerVersion。"
        return
    }
    Write-Step "准备 Wrangler $WranglerVersion"
    New-Item -ItemType Directory -Path $script:WranglerToolRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $script:WranglerNpmCache -Force | Out-Null
    $installCommand = @($Npm, "install", "--prefix", $script:WranglerToolRoot, "--cache", $script:WranglerNpmCache, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", $WranglerPackage)
    try {
        Invoke-CommandLineWithRetry $installCommand $Root $null 3 | Out-Null
    } catch {
        if (-not (Test-Path -LiteralPath $script:WranglerCliPath)) { throw }
        Write-Note "npm 清理缓存时返回警告，但 Wrangler 已安装，继续部署。"
    }
    if (-not (Test-Path -LiteralPath $script:WranglerCliPath)) {
        throw "Wrangler 安装失败，请关闭其他 Node.js/npm 窗口后重新运行。"
    }
    $env:WRANGLER_CLI_PATH = $script:WranglerCliPath
}
function Get-CloudflareWhoamiAccountIds([string]$Output) {
    $ids = @()
    foreach ($match in [regex]::Matches($Output, '\b[0-9a-f]{32}\b', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        $value = $match.Value.ToLowerInvariant()
        if (-not $ids.Contains($value)) { $ids += $value }
    }
    return $ids
}
function Invoke-CommandLine([string[]]$Command, [string]$WorkingDirectory = $Root, [string]$InputText = $null) {
    Push-Location $WorkingDirectory
    try {
        $exe = $Command[0]
        $args = @()
        if ($Command.Length -gt 1) { $args = $Command[1..($Command.Length - 1)] }
        Write-Note ("运行: " + ($Command -join " "))
        $global:LASTEXITCODE = 0
        $output = if ($null -ne $InputText) {
            $InputText | & $exe @args 2>&1 | Out-String -Width 4096
        } else {
            & $exe @args 2>&1 | Out-String -Width 4096
        }
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "命令失败，退出码 $exitCode`n命令: $($Command -join ' ')`n`n完整输出:`n$output"
        }
        return $output.Trim()
    } finally {
        Pop-Location
    }
}
function Invoke-CommandLineWithRetry(
    [string[]]$Command,
    [string]$WorkingDirectory = $Root,
    [string]$InputText = $null,
    [int]$MaxAttempts = 3
) {
    $transientPattern = '(?i)fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_|socket hang up|EBUSY|EPERM|resource busy or locked'
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            return (Invoke-CommandLine $Command $WorkingDirectory $InputText)
        } catch {
            $message = $_.Exception.Message
            if ($message -notmatch $transientPattern -or $attempt -ge $MaxAttempts) { throw }
            $delay = $attempt * 2
            Write-Host "Cloudflare 网络请求暂时失败，第 $attempt/$MaxAttempts 次，$delay 秒后重试。" -ForegroundColor Yellow
            Start-Sleep -Seconds $delay
        }
    }
}
function Invoke-CommandLineVisible([string[]]$Command, [string]$WorkingDirectory = $Root) {
    Push-Location $WorkingDirectory
    try {
        $exe = $Command[0]
        $cmdArgs = @()
        if ($Command.Length -gt 1) { $cmdArgs = $Command[1..($Command.Length - 1)] }
        Write-Note ("运行: " + ($Command -join " "))
        & $exe @cmdArgs
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "命令失败，退出码 $exitCode`n命令: $($Command -join ' ')"
        }
    } finally {
        Pop-Location
    }
}
function Invoke-WranglerDeploy([string]$WorkerRoot, [string]$WorkerName) {
    Push-Location $WorkerRoot
    try {
        $commandText = "node `"$script:WranglerCliPath`" deploy"
        $maxAttempts = 5
        $transientPattern = '(?i)fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_|socket hang up'
        for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
            Write-Note "运行: $commandText"
            $deployOutput = @()
            $global:LASTEXITCODE = 0
            & node $script:WranglerCliPath deploy 2>&1 | Tee-Object -Variable deployOutput | Out-Host
            $exitCode = $LASTEXITCODE
            if ($exitCode -eq 0) { return }
            if ($exitCode -eq -1073740791) {
                Write-Note "Wrangler 在 Windows 上返回崩溃码，正在二次确认部署状态。"
                $status = Invoke-CommandLineWithRetry (Get-WranglerCommand @("deployments", "status", "--name", $WorkerName)) $WorkerRoot $null 5
                if ($status -match "Version\(s\):|Created:") {
                    Write-Note "已确认 Cloudflare 端存在最新部署，继续后续步骤。"
                    return
                }
            }
            $outputText = $deployOutput | Out-String -Width 4096
            if ($outputText -match $transientPattern -and $attempt -lt $maxAttempts) {
                $delay = $attempt * 2
                Write-Host "Cloudflare 网络请求暂时失败，第 $attempt/$maxAttempts 次，$delay 秒后重新部署。" -ForegroundColor Yellow
                Start-Sleep -Seconds $delay
                continue
            }
            throw "命令失败，退出码 $exitCode`n命令: $commandText`n`n完整输出:`n$outputText"
        }
    } finally {
        Pop-Location
    }
}
function Test-WorkerRoot([string]$Path) {
    return (Test-Path (Join-Path $Path "package.json")) -and (Test-Path (Join-Path $Path "wrangler.toml")) -and (Test-Path (Join-Path $Path "migrations\0001_init.sql"))
}
function Resolve-WorkerRoot {
    if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
        $resolved = [System.IO.Path]::GetFullPath($SourceRoot)
        if (Test-WorkerRoot $resolved) { return $resolved }
        $nested = Join-Path $resolved "cloudflare-worker"
        if (Test-WorkerRoot $nested) { return $nested }
        throw "-SourceRoot 不是 heyun-zjmf-worker-monitor 源码目录: $resolved"
    }
    $local = Join-Path $Root "cloudflare-worker"
    if (Test-WorkerRoot $local) { return $local }
    $cacheSource = Join-Path $CacheRoot "source"
    $zipPath = Join-Path $CacheRoot "source.zip"
    if ($RefreshSource -and (Test-Path $cacheSource)) { Remove-Item -LiteralPath $cacheSource -Recurse -Force }
    if (-not (Test-Path $cacheSource)) {
        New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
        Write-Step "下载项目源码"
        $urls = @(
            "https://codeload.github.com/$UpstreamRepo/zip/refs/heads/$UpstreamRef",
            "https://codeload.github.com/$UpstreamRepo/zip/refs/tags/$UpstreamRef",
            "https://github.com/$UpstreamRepo/archive/refs/heads/$UpstreamRef.zip",
            "https://github.com/$UpstreamRepo/archive/refs/tags/$UpstreamRef.zip",
            "https://github.com/$UpstreamRepo/archive/$UpstreamRef.zip"
        )
        $downloaded = $false
        foreach ($url in $urls) {
            Write-Note "下载: $url"
            if (Invoke-DownloadFile $url $zipPath) { $downloaded = $true; break }
        }
        if (-not $downloaded) { throw "源码下载失败，请检查网络或使用 -SourceRoot 指定本地源码。" }
        Expand-Archive -Path $zipPath -DestinationPath $cacheSource -Force
    }
    foreach ($dir in Get-ChildItem -Path $cacheSource -Directory -Recurse) {
        if ($dir.Name -eq "cloudflare-worker" -and (Test-WorkerRoot $dir.FullName)) { return $dir.FullName }
    }
    throw "缓存源码里没有找到 cloudflare-worker 目录。"
}
function Read-Config {
    $defaultJsonc = Join-Path $Root "one-click.config.jsonc"
    $defaultJson = Join-Path $Root "one-click.config.json"
    $configFile = if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
        if (Test-Path $defaultJsonc) { $defaultJsonc } elseif (Test-Path $defaultJson) { $defaultJson } else { $defaultJsonc }
    } else {
        [System.IO.Path]::GetFullPath($ConfigPath)
    }
    $exampleJsonc = Join-Path $Root "one-click.config.example.jsonc"
    $exampleJson = Join-Path $Root "one-click.config.example.json"
    if (-not (Test-Path $configFile)) {
        if (Test-Path $exampleJsonc) {
            Copy-Item -LiteralPath $exampleJsonc -Destination $configFile
        } elseif (Test-Path $exampleJson) {
            Copy-Item -LiteralPath $exampleJson -Destination $configFile
        } else {
            Get-DefaultConfigText | Set-Content -LiteralPath $configFile -Encoding utf8
        }
        Write-Note "已生成配置文件: $configFile"
    }
    $script:ConfigPath = $configFile
    if ($configFile -match '\.jsonc$') {
        return (ConvertFrom-JsoncFile $configFile)
    }
    return (Get-Content -LiteralPath $configFile -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable)
}
function Invoke-InteractiveSetup($Config) {
    if (-not $Interactive) { return }
    Show-InteractiveGuide
    if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
        $env:CLOUDFLARE_API_TOKEN = Read-RequiredText "请输入 Cloudflare API Token"
    }
    $whoami = ""
    try { $whoami = Invoke-CommandLine (Get-WranglerCommand @("whoami")) } catch {}
    $detectedAccountIds = @(Get-CloudflareWhoamiAccountIds $whoami)
    if ($detectedAccountIds.Count -gt 0) {
        Write-Host "检测到账户 ID：" -ForegroundColor Cyan
        for ($i = 0; $i -lt $detectedAccountIds.Count; $i++) {
            Write-Host ("  [{0}] {1}" -f ($i + 1), $detectedAccountIds[$i])
        }
    }
    $pickedAccount = Read-RequiredText "请输入要部署的 Cloudflare Account ID（必须手动填写）"
    if ($detectedAccountIds.Count -gt 0 -and -not ($detectedAccountIds -contains $pickedAccount.ToLowerInvariant())) {
        Write-Host "警告：输入的 Account ID 不在当前 Token 检测列表里，请确认 Token 有该账户权限。" -ForegroundColor Yellow
    }
    $Config.cloudflareAccountId = $pickedAccount
    $env:CLOUDFLARE_ACCOUNT_ID = $pickedAccount
    Save-Config $Config
    $repoInput = Read-RequiredText "请输入 GitHub 仓库地址（例如 https://github.com/loqwe/heyun-zjmf-worker-monitor）"
    $script:UpstreamRepo = Convert-GitHubRepoInput $repoInput
    $Config.upstreamRepo = $script:UpstreamRepo
    Save-Config $Config
    $existingUpdateToken = Get-ConfigValue $Config "webUpdateGitHubToken" $env:WEB_UPDATE_GITHUB_TOKEN
    $updateToken = Read-OptionalSecret "请输入 GitHub 更新令牌（用于管理后台点确定更新；直接回车可跳过）"
    if (-not [string]::IsNullOrWhiteSpace($updateToken)) {
        $Config.webUpdateGitHubToken = $updateToken
        $env:WEB_UPDATE_GITHUB_TOKEN = $updateToken
        Save-Config $Config
    } elseif (-not [string]::IsNullOrWhiteSpace($existingUpdateToken)) {
        $env:WEB_UPDATE_GITHUB_TOKEN = $existingUpdateToken
        Write-Note "已保留配置文件中的 GitHub 更新令牌。"
    } else {
        Write-Host "未填写 GitHub 更新令牌：管理后台仍可检查更新，但点“确定更新”会提示 GITHUB_TOKEN_NOT_CONFIGURED。" -ForegroundColor Yellow
    }
    $Config.adminToken = Read-AdminTokenWithConfirmation
    Save-Config $Config
    if ($Config.adminToken -eq "admin") { Write-Host "已使用默认管理后台密码。部署后可在管理面板设置里修改。" -ForegroundColor Yellow }
}
function Ensure-CloudflareAuth($Config) {
    $whoami = ""
    try { $whoami = Invoke-CommandLine (Get-WranglerCommand @("whoami")) } catch {}
    $detectedAccountIds = @(Get-CloudflareWhoamiAccountIds $whoami)
    $configAccountId = (Get-ConfigValue $Config "cloudflareAccountId" "").ToLowerInvariant()
    $envAccountId = if ($env:CLOUDFLARE_ACCOUNT_ID) { $env:CLOUDFLARE_ACCOUNT_ID.Trim().ToLowerInvariant() } else { "" }
    $resolvedAccountId = if ($configAccountId) { $configAccountId } else { $envAccountId }
    if ([string]::IsNullOrWhiteSpace($resolvedAccountId)) {
        if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
            Write-Step "Cloudflare 登录"
            Invoke-CommandLine (Get-WranglerCommand @("login")) | Out-Null
        }
        throw "未填写 Cloudflare Account ID。请双击 步骤2-一键部署.bat 输入，或在 one-click.config.jsonc 填写 cloudflareAccountId。"
    }
    $env:CLOUDFLARE_ACCOUNT_ID = $resolvedAccountId
    if ($configAccountId -ne $resolvedAccountId) {
        $Config.cloudflareAccountId = $resolvedAccountId
        Save-Config $Config
    }
    if ($detectedAccountIds.Count -gt 0 -and -not ($detectedAccountIds -contains $resolvedAccountId)) {
        Write-Host "警告：当前使用的 Account ID 不在 Token 检测列表里，请确认 Token 有该账户权限。" -ForegroundColor Yellow
        return
    }
    Write-Note "使用用户指定的 Cloudflare Account ID: $resolvedAccountId"
}
function Use-FixedWranglerInSource([string]$WorkerRoot) {
    $preparePath = Join-Path $WorkerRoot "scripts\prepare-cloudflare.mjs"
    if (-not (Test-Path $preparePath)) { return }
    $content = Get-Content -LiteralPath $preparePath -Raw -Encoding utf8
    $patched = $content -replace "'wrangler@latest'", "'$WranglerPackage'"
    if ($patched -ne $content) {
        Set-Content -LiteralPath $preparePath -Value $patched -Encoding utf8
        Write-Note "已固定 Wrangler 版本: $WranglerPackage"
    }
}
function Ensure-WorkersDevEnabled([string]$WorkerRoot) {
    $tomlPath = Join-Path $WorkerRoot "wrangler.toml"
    if (-not (Test-Path $tomlPath)) { return }
    $toml = Get-Content -LiteralPath $tomlPath -Raw -Encoding utf8
    if ($toml -match '(?m)^workers_dev\s*=') {
        $toml = [regex]::Replace($toml, '(?m)^workers_dev\s*=.*$', 'workers_dev = true')
    } else {
        $toml = $toml -replace '(?m)^(compatibility_date\s*=.*)$', "`$1`nworkers_dev = true"
    }
    Set-Content -LiteralPath $tomlPath -Value $toml -Encoding utf8
}
function Post-Admin($BaseUrl, $Token, [string]$Path, $Body) {
    $json = $Body | ConvertTo-Json -Depth 8 -Compress
    try {
        Invoke-RestMethod -Method Post -Uri "$BaseUrl$Path" -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json; charset=utf-8" -Body $json -TimeoutSec 30 | Out-Null
        return $true
    } catch {
        Write-Host "警告：POST $Path 失败（$($_.Exception.Message)），可在管理后台手动补齐。" -ForegroundColor Yellow
        return $false
    }
}
function Get-HttpStatusCode($ErrorRecord) {
    try {
        $statusCode = $ErrorRecord.Exception.Response.StatusCode
        if ($null -ne $statusCode) { return [int]$statusCode }
    } catch {}
    $message = [string]$ErrorRecord.Exception.Message
    if ($message -match '(?<!\d)(401|403|404|429|5\d\d)(?!\d)') { return [int]$matches[1] }
    return 0
}
function Wait-AdminApiReady($BaseUrl, $Token) {
    Write-Step "等待管理接口就绪"
    $maxAttempts = 30
    for ($i = 1; $i -le $maxAttempts; $i++) {
        try {
            Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/admin/overview" -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 30 | Out-Null
            Write-Note "管理接口已就绪。"
            return [pscustomobject]@{ Ready = $true }
        } catch {
            $message = $_.Exception.Message
            $statusCode = Get-HttpStatusCode $_
            if ($statusCode -eq 401) {
                Write-Host "管理接口返回 401：现有站点可能已在管理后台修改密码。" -ForegroundColor Yellow
                Write-Note "跳过自动初始化，不影响访问地址、现有配置或本次 Worker 部署。"
                return [pscustomobject]@{ Ready = $false }
            }
            if ($message -match "HttpClient\.Timeout|timed out|operation has timed out|请求超时|超时") {
                $message = "请求响应超时，Worker 可能仍在冷启动或部署传播中，继续重试"
            }
            Write-Note "管理接口正在冷启动或部署传播中，第 $i/$maxAttempts 次等待：$message"
            Start-Sleep -Seconds 6
        }
    }
    Write-Host "警告：管理接口暂未就绪，跳过自动写入初始化配置；可稍后重走脚本或到 /admin 手动补齐。" -ForegroundColor Yellow
    return [pscustomobject]@{ Ready = $false }
}
function Get-WorkersDevUrl([string]$WorkerName, $Config) {
    $accountId = Get-ConfigValue $Config "cloudflareAccountId" $env:CLOUDFLARE_ACCOUNT_ID
    if ([string]::IsNullOrWhiteSpace($accountId) -or [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
        return ""
    }
    try {
        $headers = @{ Authorization = "Bearer $env:CLOUDFLARE_API_TOKEN" }
        $apiUrl = "https://api.cloudflare.com/client/v4/accounts/$accountId/workers/subdomain"
        $response = Invoke-RestMethod -Method Get -Uri $apiUrl -Headers $headers -TimeoutSec 30
        $subdomain = [string]$response.result.subdomain
        if (-not [string]::IsNullOrWhiteSpace($subdomain)) {
            return "https://$WorkerName.$subdomain.workers.dev"
        }
    } catch {
        Write-Note "未能自动读取 workers.dev 子域，将以上方 Wrangler 输出为准。"
    }
    return ""
}
function Enable-WorkerSubdomain([string]$WorkerName, $Config) {
    $accountId = Get-ConfigValue $Config "cloudflareAccountId" $env:CLOUDFLARE_ACCOUNT_ID
    if ([string]::IsNullOrWhiteSpace($accountId) -or [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
        Write-Note "缺少 Cloudflare Token 或 Account ID，跳过 workers.dev 显式启用。"
        return
    }
    try {
        $headers = @{ Authorization = "Bearer $env:CLOUDFLARE_API_TOKEN" }
        $apiUrl = "https://api.cloudflare.com/client/v4/accounts/$accountId/workers/scripts/$WorkerName/subdomain"
        $body = @{ enabled = $true; previews_enabled = $true } | ConvertTo-Json -Compress
        $response = Invoke-RestMethod -Method Post -Uri $apiUrl -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 30
        if ($response.success -and $response.result.enabled) {
            Write-Note "已启用 workers.dev 访问 URL。"
            return
        }
        Write-Host "警告：workers.dev 启用接口返回异常，请到 Cloudflare 后台手动启用。" -ForegroundColor Yellow
    } catch {
        Write-Host "警告：未能自动启用 workers.dev，请到 Cloudflare 后台的 域和路由 手动启用。" -ForegroundColor Yellow
        Write-Note $_.Exception.Message
    }
}
function Seed-MonitorConfig($BaseUrl, $AdminToken, $Config) {
    $apiAccount = Get-ConfigValue $Config "zjmfApiAccount" $env:ZJMF_API_ACCOUNT
    $apiPassword = Get-ConfigValue $Config "zjmfApiPassword" $env:ZJMF_API_PASSWORD
    $serverId = Get-ConfigValue $Config "serverId" $env:ZJMF_SERVER_ID
    $githubRepo = Get-ConfigValue $Config "upstreamRepo" $script:UpstreamRepo
    if ($githubRepo) { $null = Post-Admin $BaseUrl $AdminToken "/api/admin/settings" @{ github_repo = $githubRepo; github_branch = Get-ConfigValue $Config "githubBranch" "main"; github_workflow_file = Get-ConfigValue $Config "githubWorkflowFile" "deploy.yml" } }
    if ([string]::IsNullOrWhiteSpace($apiAccount) -or [string]::IsNullOrWhiteSpace($apiPassword) -or [string]::IsNullOrWhiteSpace($serverId)) {
        Write-Note "未填写魔方财务账号/API密钥/serverId，跳过初始化；可部署后进 /admin 手动添加。"
        return
    }
    $provider = Get-ConfigValue $Config "providerName" "heyunidc"
    $serverIp = Get-ConfigValue $Config "serverIp" $env:ZJMF_SERVER_IP
    $httpUrl = Get-ConfigValue $Config "httpUrl" ""
    $tcpHost = Get-ConfigValue $Config "tcpHost" $serverIp
    $tcpPort = Get-ConfigInt $Config "tcpPort" 996
    $method = Get-ConfigValue $Config "checkMethod" ""
    if (-not $method) { $method = if ($httpUrl -and $tcpHost) { "service_then_power" } elseif ($httpUrl) { "http_then_api" } elseif ($tcpHost -and $tcpPort -gt 0) { "tcp_then_api" } else { "api_only" } }
    if ($method -eq "service_then_power" -and -not $httpUrl -and -not $tcpHost) { $method = "api_only" }
    Write-Step "初始化监控配置"
    $null = Post-Admin $BaseUrl $AdminToken "/api/admin/providers" @{
        name = $provider; display_name = Get-ConfigValue $Config "providerDisplayName" "核云"; api_base_url = Get-ConfigValue $Config "zjmfApiBaseUrl" "https://www.heyunidc.cn/v1"; api_account = $apiAccount; api_password = $apiPassword
    }
    $null = Post-Admin $BaseUrl $AdminToken "/api/admin/servers" @{
        id = $serverId; name = Get-ConfigValue $Config "serverName" (if ($serverIp) { $serverIp } else { $serverId }); ip = $serverIp; provider = $provider; check_method = $method; enabled = $true; daily_reboot_limit = Get-ConfigInt $Config "dailyRebootLimit" 3; http_url = $httpUrl; http_method = Get-ConfigValue $Config "httpMethod" "GET"; http_expected_status = Get-ConfigValue $Config "httpExpectedStatus" "200-399"; tcp_host = $tcpHost; tcp_port = $tcpPort
    }
    $pushplus = Get-ConfigValue $Config "pushplusToken" $env:PUSHPLUS_TOKEN
    if ($pushplus) { $null = Post-Admin $BaseUrl $AdminToken "/api/admin/settings" @{ webhook_url = "https://www.pushplus.plus/send"; webhook_type = "pushplus"; pushplus_token = $pushplus; timezone = Get-ConfigValue $Config "timezone" "Asia/Shanghai" } }
    $null = Post-Admin $BaseUrl $AdminToken "/api/admin/run" @{}
}

trap { Write-Host ""; Write-Host "部署已中断: $($_.Exception.Message)" -ForegroundColor Red; Complete-DeploymentLog; exit 1 }

if (-not $PreflightOnly) { Start-DeploymentLog }
$Config = Read-Config
$ConfigPath = $script:ConfigPath
$UpstreamRepo = Get-ConfigValue $Config "upstreamRepo" $UpstreamRepo

Write-Step "环境预检"
foreach ($cmd in @("node", $Npm)) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "找不到命令 $cmd，请先安装 Node.js 20+。" }
}
if (-not $PreflightOnly) { Initialize-Wrangler }
Invoke-InteractiveSetup $Config
$adminToken = Get-ConfigValue $Config "adminToken" ""
if (-not $Interactive -and $env:ZJMF_ADMIN_TOKEN) { $adminToken = $env:ZJMF_ADMIN_TOKEN }
if ([string]::IsNullOrWhiteSpace($adminToken) -or $adminToken -eq "请填写强密码") { throw "请在配置文件填写 adminToken，或设置环境变量 ZJMF_ADMIN_TOKEN。" }
if ($PreflightOnly) { Write-Host "预检通过。" -ForegroundColor Green; exit 0 }

$workerRoot = Resolve-WorkerRoot
Use-FixedWranglerInSource $workerRoot
Ensure-WorkersDevEnabled $workerRoot
$workerName = Get-ConfigValue $Config "workerName" "zjmf-monitor"
$databaseName = Get-ConfigValue $Config "d1DatabaseName" "$workerName-d1"
$env:WORKER_NAME = $workerName
$env:D1_DATABASE_NAME = $databaseName
$env:GITHUB_REPOSITORY = Get-ConfigValue $Config "upstreamRepo" $UpstreamRepo
$env:GITHUB_REF_NAME = Get-ConfigValue $Config "githubBranch" $UpstreamRef
$env:GITHUB_WORKFLOW_FILE = Get-ConfigValue $Config "githubWorkflowFile" "deploy.yml"
$versionToken = Get-ConfigValue $Config "webUpdateGitHubToken" $env:WEB_UPDATE_GITHUB_TOKEN
$resolvedSha = Resolve-GitHubRefSha $env:GITHUB_REPOSITORY $env:GITHUB_REF_NAME $versionToken
if ($resolvedSha) { $env:APP_VERSION = $resolvedSha }

Write-Step "本次部署配置"
Write-Host "  源码目录 : $workerRoot"
Write-Host "  Worker   : $workerName"
Write-Host "  D1       : $databaseName"
Write-Host "  配置文件 : $ConfigPath"

Ensure-CloudflareAuth $Config

Write-Step "创建或复用 D1，并写入 wrangler.toml"
Invoke-CommandLine @("node", (Join-Path $workerRoot "scripts\prepare-cloudflare.mjs")) $workerRoot | Write-Host
if ($PrepareOnly) { Write-Host "已完成预生成，未正式部署。" -ForegroundColor Green; Complete-DeploymentLog; exit 0 }

Write-Step "执行 D1 迁移"
Invoke-CommandLineWithRetry (Get-WranglerCommand @("d1", "migrations", "apply", $databaseName, "--remote")) $workerRoot | Out-Null

Write-Step "写入管理后台密钥"
Invoke-CommandLine (Get-WranglerCommand @("secret", "put", "ADMIN_TOKEN")) $workerRoot $adminToken | Out-Null

$webUpdateToken = Get-ConfigValue $Config "webUpdateGitHubToken" $env:WEB_UPDATE_GITHUB_TOKEN
if ($webUpdateToken) {
    Write-Step "写入网页更新 GitHub Token"
    Invoke-CommandLine (Get-WranglerCommand @("secret", "put", "GITHUB_TOKEN")) $workerRoot $webUpdateToken | Out-Null
}

Write-Step "部署 Worker"
Invoke-WranglerDeploy $workerRoot $workerName
Write-Step "启用 workers.dev 访问 URL"
Enable-WorkerSubdomain $workerName $Config
$workerUrl = Get-WorkersDevUrl $workerName $Config
if (-not $workerUrl) {
    Write-Host ""
    Write-Host "部署命令已完成，但脚本未自动解析到 workers.dev 地址；请以上方 Wrangler 输出为准。" -ForegroundColor Yellow
}

if (-not $SkipSeed -and $workerUrl) {
    $adminReady = Wait-AdminApiReady $workerUrl $adminToken
    if ($adminReady.Ready) {
        Seed-MonitorConfig $workerUrl $adminToken $Config
    }
}

Write-Host ""
Write-Host "部署完成。" -ForegroundColor Green
if ($workerUrl) {
    Write-Host "状态页     : $workerUrl/"
    Write-Host "管理后台   : $workerUrl/admin"
    Write-Host "状态 API   : $workerUrl/api/status"
} else {
    Write-Host "Worker 名称: $workerName"
    Write-Host "请从上方 Wrangler 输出复制 workers.dev 链接。"
}
Complete-DeploymentLog
