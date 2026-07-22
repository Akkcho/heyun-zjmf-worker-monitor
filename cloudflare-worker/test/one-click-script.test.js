import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const localScriptDir = path.join(repoRoot, 'windows-one-click-deploy');

function readUtf8(relativePath) {
  return readFileSync(path.join(localScriptDir, relativePath), 'utf8');
}

function assertCrLfBatch(relativePath) {
  const bytes = readFileSync(path.join(localScriptDir, relativePath));
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) assert.equal(bytes[index - 1], 0x0d, `${relativePath} contains a bare LF at byte ${index}`);
    if (bytes[index] === 0x0d) assert.equal(bytes[index + 1], 0x0a, `${relativePath} contains a bare CR at byte ${index}`);
  }
}

test('步骤2批处理统一使用 CRLF，避免 cmd 将后半段当成命令', () => {
  assertCrLfBatch('步骤2-一键部署.bat');
});

test('步骤2只使用 PowerShell 7，并在缺失时尝试自动安装', () => {
  const deployer = readUtf8('步骤2-一键部署.bat');

  assert.match(deployer, /where pwsh/);
  assert.match(deployer, /winget install -e --id Microsoft\.PowerShell/);
  assert.match(deployer, /需要 PowerShell 7/);
  assert.doesNotMatch(deployer, /set "PS_EXE=powershell"/i);
});

test('PowerShell 部署脚本启动后再解析脚本目录和默认缓存目录', () => {
  const script = readUtf8('deploy-one-click.ps1');

  assert.match(script, /\[string\]\$CacheRoot = ""/);
  assert.match(script, /\$PSVersionTable\.PSVersion\.Major -lt 7/);
  assert.match(script, /\$MyInvocation\.MyCommand\.Path/);
  assert.match(script, /\$CacheRoot = Join-Path \$Root "\.cache\\heyun-zjmf-worker-monitor"/);
  assert.doesNotMatch(script, /Join-Path \$PSScriptRoot/);
  assert.doesNotMatch(script, /GetFullPath\(\$PSScriptRoot\)/);
});

test('Windows 一键部署使用独立缓存安装并复用 Wrangler CLI', () => {
  const script = readUtf8('deploy-one-click.ps1');
  const prepare = readFileSync(path.join(repoRoot, 'cloudflare-worker', 'scripts', 'prepare-cloudflare.mjs'), 'utf8');

  assert.match(script, /function Initialize-Wrangler/);
  assert.match(script, /npm-cache/);
  assert.match(script, /\$installArgs = @\("install", "--prefix"/);
  assert.match(script, /\$env:WRANGLER_CLI_PATH = \$script:WranglerCliPath/);
  assert.match(script, /return @\(\$script:NodeCommand, \$script:WranglerCliPath\) \+ \$SubCommands/);
  assert.doesNotMatch(script, /return @\(\$Npx, "--yes", \$WranglerPackage\)/);
  assert.match(prepare, /process\.env\.WRANGLER_CLI_PATH/);
  assert.match(prepare, /execFileSync\(process\.execPath, \[wranglerCliPath, \.\.\.args\]/);
});

test('Wrangler 固定缓存损坏或被占用时改用新的安装槽位', () => {
  const script = readUtf8('deploy-one-click.ps1');
  const initializeFunction = script.match(/function Initialize-Wrangler[\s\S]+?\r?\n}\r?\nfunction Get-CloudflareWhoamiAccountIds/)?.[0] ?? '';

  assert.match(script, /function Test-WranglerCli/);
  assert.match(script, /--version/);
  assert.match(initializeFunction, /Get-ChildItem[\s\S]+wrangler-\$WranglerVersion\*/);
  assert.match(initializeFunction, /wrangler-\$WranglerVersion-install-\$PID-\$attempt-/);
  assert.match(initializeFunction, /npm-cache[\\/]wrangler-\$WranglerVersion-install-/);
  assert.match(initializeFunction, /Invoke-CommandLineStreaming \$installCommand/);
  assert.doesNotMatch(initializeFunction, /Invoke-CommandLineWithRetry \$installCommand/);
});

test('Wrangler 安装实时显示并保留 npm 完整输出', () => {
  const script = readUtf8('deploy-one-click.ps1');
  const streamingFunction = script.match(/function Invoke-CommandLineStreaming[\s\S]+?\r?\n}\r?\nfunction Invoke-CommandLineWithRetry/)?.[0] ?? '';

  assert.match(streamingFunction, /Tee-Object -Variable commandOutput \| Out-Host/);
  assert.match(streamingFunction, /完整输出/);
  assert.match(streamingFunction, /return \$output\.Trim\(\)/);
});

test('Windows ARM64 自动改用便携版 Node x64 运行 Wrangler', () => {
  const script = readUtf8('deploy-one-click.ps1');
  const runtimeFunction = script.match(/function Initialize-WranglerNodeRuntime[\s\S]+?\r?\n}\r?\nfunction Get-WranglerCommand/)?.[0] ?? '';

  assert.match(script, /\$PortableNodeVersion = "22\.22\.0"/);
  assert.match(script, /\$PortableNodeSha256 = "c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a"/);
  assert.match(runtimeFunction, /process\.platform/);
  assert.match(runtimeFunction, /process\.arch/);
  assert.match(runtimeFunction, /win32/);
  assert.match(runtimeFunction, /arm64/);
  assert.match(runtimeFunction, /\$archiveName = "\$nodeFolderName\.zip"/);
  assert.match(runtimeFunction, /https:\/\/nodejs\.org\/dist/);
  assert.match(runtimeFunction, /https:\/\/npmmirror\.com\/mirrors\/node/);
  assert.match(runtimeFunction, /Expand-Archive/);
  assert.match(runtimeFunction, /Get-FileHash[\s\S]+SHA256/);
  assert.match(runtimeFunction, /\$actualHash -ceq \$PortableNodeSha256/);
  assert.match(script, /\$script:NodeCommand = \$portableNode/);
  assert.match(script, /\$script:NpmCliPath = Join-Path \$PortableRoot "node_modules\\npm\\bin\\npm-cli\.js"/);
  assert.match(script, /\$env:Path = "\$PortableRoot;\$env:Path"/);
  assert.match(script, /@\(\$script:NodeCommand, \$script:NpmCliPath\) \+ \$installArgs/);
  assert.match(script, /Initialize-WranglerNodeRuntime\r?\n\s*Initialize-Wrangler/);
});

test('所有 Wrangler 和准备命令统一使用选定的 Node 运行时', () => {
  const script = readUtf8('deploy-one-click.ps1');

  assert.match(script, /return @\(\$script:NodeCommand, \$script:WranglerCliPath\) \+ \$SubCommands/);
  assert.match(script, /& \$script:NodeCommand \$CliPath --version/);
  assert.match(script, /& \$script:NodeCommand \$script:WranglerCliPath deploy/);
  assert.match(script, /Invoke-CommandLine @\(\$script:NodeCommand, \(Join-Path \$workerRoot "scripts\\prepare-cloudflare\.mjs"\)\)/);
  assert.doesNotMatch(script, /& node \$script:WranglerCliPath deploy/);
});

test('Windows 一键部署自动生成脱敏日志且 Cloudflare Token 输入保持可见', () => {
  const script = readUtf8('deploy-one-click.ps1');

  assert.match(script, /function Start-DeploymentLog/);
  assert.match(script, /function Protect-DeploymentLogText/);
  assert.match(script, /function Complete-DeploymentLog/);
  assert.match(script, /Start-Transcript/);
  assert.match(script, /部署日志-/);
  assert.match(script, /\$script:SafeLogPath = Join-Path \$Root "部署日志-/);
  assert.doesNotMatch(script, /Join-Path \$Root "logs"/);
  assert.match(script, /\[REDACTED\]/);
  assert.match(script, /cfut_/);
  assert.match(script, /github_pat_/);
  assert.match(script, /CLOUDFLARE_API_TOKEN = Read-RequiredText/);
  assert.doesNotMatch(script, /CLOUDFLARE_API_TOKEN = Read-RequiredSecret/);
  assert.doesNotMatch(script, /默认 admin|密码：admin/);
  assert.match(script, /trap \{[\s\S]*Complete-DeploymentLog[\s\S]*exit 1 \}/);
});

test('步骤1脚本写明 GitHub 仓库地址并复用为下载源', () => {
  const wrapperBytes = readFileSync(path.join(localScriptDir, '步骤1-一键安装脚本.bat'));
  const wrapperLatin1 = wrapperBytes.toString('binary');
  const installer = readUtf8('步骤1-一键安装.bat');

  assert.match(wrapperLatin1, /UPSTREAM_REPO/);
  assert.match(wrapperLatin1, /chcp 936/);
  assert.match(wrapperLatin1, /REAL_FILE=/);
  assert.match(wrapperLatin1, /releases\/download\/release-step1-bat-v1\/step1-install\.bat/);
  assert.match(installer, /GitHub 仓库地址|UPSTREAM_REPO/);
  assert.match(installer, /raw\.githubusercontent\.com/);
});

test('步骤2一键部署默认刷新源码缓存，避免部署旧版本', () => {
  const deployer = readUtf8('步骤2-一键部署.bat');

  assert.match(deployer, /deploy-one-click\.ps1/);
  assert.match(deployer, /-Interactive -RefreshSource/);
  assert.match(deployer, /normalize_utf8_bom "%PS1_FILE%"/);
  assert.match(deployer, /UTF8Encoding\]::new\(\$true\)/);
});

test('步骤2缺少辅助文件时会自动补下载并创建配置', () => {
  const deployer = readUtf8('步骤2-一键部署.bat');

  assert.match(deployer, /REMOTE_BASE=https:\/\/raw\.githubusercontent\.com/);
  assert.match(deployer, /call :fetch "%PS1_FILE%" "%PS1_URL%"/);
  assert.match(deployer, /call :fetch "%EXAMPLE_FILE%" "%EXAMPLE_URL%"/);
  assert.match(deployer, /copy \/Y "%EXAMPLE_FILE%" "%CONFIG_FILE%"/);
});

test('步骤2下载辅助文件时会重试瞬时网络错误', () => {
  const deployer = readUtf8('步骤2-一键部署.bat');

  assert.match(deployer, /\$attempt -lt 3/);
  assert.match(deployer, /Start-Sleep -Seconds/);
});

test('步骤2不再由 cmd 输出容易乱码拆行的重复中文准备说明', () => {
  const deployer = readUtf8('步骤2-一键部署.bat');

  assert.doesNotMatch(deployer, /准备方式：|Cloudflare Token：打开|账户 ID：复制|GitHub 仓库地址：复制/);
  assert.match(readUtf8('deploy-one-click.ps1'), /function Show-InteractiveGuide/);
});

test('步骤1会刷新部署脚本，源码下载优先使用 codeload', () => {
  const installer = readUtf8('步骤1-一键安装.bat');
  const script = readUtf8('deploy-one-click.ps1');
  const prepare = readFileSync(path.join(repoRoot, 'cloudflare-worker', 'scripts', 'prepare-cloudflare.mjs'), 'utf8');

  assert.doesNotMatch(installer, /if exist "%~1" exit \/b 0/);
  assert.match(installer, /fix_utf8_bom "%PS1_FILE%"/);
  assert.match(installer, /UTF8Encoding\]::new\(\$true\)/);
  assert.match(script, /codeload\.github\.com\/\$UpstreamRepo\/zip\/refs\/heads\/\$UpstreamRef/);
  assert.match(script, /Invoke-DownloadFile/);
  assert.match(script, /User-Agent/);
  assert.match(prepare, /APP_VERSION: process\.env\.APP_VERSION \|\| process\.env\.GITHUB_SHA/);
  assert.match(prepare, /function patchVars/);
});

test('一键部署写入配置前等待新版管理接口就绪并隐藏布尔返回值', () => {
  const script = readUtf8('deploy-one-click.ps1');

  assert.match(script, /function Wait-AdminApiReady/);
  assert.match(script, /\$adminReady = Wait-AdminApiReady \$workerUrl \$adminToken/);
  assert.match(script, /\$maxAttempts = 30/);
  assert.match(script, /-TimeoutSec 30/);
  assert.match(script, /冷启动或部署传播中/);
  assert.doesNotMatch(script, /-TimeoutSec 15/);
  assert.match(script, /\$null = Post-Admin \$BaseUrl \$AdminToken "\/api\/admin\/settings"/);
  assert.doesNotMatch(script, /if \(\$githubRepo\) \{ Post-Admin \$BaseUrl \$AdminToken/);
});

test('一键部署遇到 401 时跳过自动初始化且不再询问网站密码', () => {
  const script = readUtf8('deploy-one-click.ps1');
  const waitFunction = script.match(/function Wait-AdminApiReady[\s\S]+?\r?\n}\r?\nfunction Get-WorkersDevUrl/)?.[0] ?? '';

  assert.match(script, /function Get-HttpStatusCode/);
  assert.match(waitFunction, /if \(\$statusCode -eq 401\)/);
  assert.match(waitFunction, /跳过自动初始化，不影响访问地址/);
  assert.doesNotMatch(waitFunction, /Read-OptionalSecret|请输入.*网站密码/);
  assert.doesNotMatch(script, /同步当前管理后台密码/);
  assert.doesNotMatch(script, /TokenChanged/);
  assert.match(script, /\$first -ceq \$second/);
  assert.match(script, /Seed-MonitorConfig \$workerUrl \$adminToken \$Config/);
});

test('一键部署按默认 Worker 名称和 workers.dev 子域输出访问地址', () => {
  const script = readUtf8('deploy-one-click.ps1');

  assert.match(script, /\$workerName = Get-ConfigValue \$Config "workerName" "zjmf-monitor"/);
  assert.match(script, /return "https:\/\/\$WorkerName\.\$subdomain\.workers\.dev"/);
  assert.match(script, /\$workerUrl = Get-WorkersDevUrl \$workerName \$Config/);
  assert.match(script, /状态页\s+: \$workerUrl\//);
  assert.match(script, /管理后台\s+: \$workerUrl\/admin/);
  assert.match(script, /状态 API\s+: \$workerUrl\/api\/status/);
});

test('D1 迁移遇到瞬时 fetch failed 时自动重试', () => {
  const script = readUtf8('deploy-one-click.ps1');

  assert.match(script, /function Invoke-CommandLineWithRetry/);
  assert.match(script, /fetch failed\|ECONNRESET\|ETIMEDOUT\|EAI_AGAIN\|UND_ERR_/);
  assert.match(script, /\[int\]\$MaxAttempts = 3/);
  assert.match(script, /Invoke-CommandLineWithRetry \(Get-WranglerCommand @\("d1", "migrations", "apply"/);
});

test('Windows 部署崩溃后的状态确认会重试网络错误', () => {
  const script = readUtf8('deploy-one-click.ps1');

  assert.match(script, /\$status = Invoke-CommandLineWithRetry \(Get-WranglerCommand @\("deployments", "status", "--name", \$WorkerName\)\) \$WorkerRoot \$null 5/);
});

test('Worker 部署遇到瞬时 fetch failed 时自动重试', () => {
  const script = readUtf8('deploy-one-click.ps1');
  const deployFunction = script.match(/function Invoke-WranglerDeploy[\s\S]+?\r?\n}\r?\nfunction Test-WorkerRoot/)?.[0] ?? '';

  assert.match(deployFunction, /\$maxAttempts = 5/);
  assert.match(deployFunction, /Tee-Object -Variable deployOutput \| Out-Host/);
  assert.match(deployFunction, /\$outputText -match \$transientPattern/);
  assert.match(deployFunction, /Cloudflare 网络请求暂时失败/);
});

test('一键部署会引导填写网页更新令牌并写入 Worker Secret', () => {
  const script = readUtf8('deploy-one-click.ps1');
  const usage = readUtf8('使用说明.txt');
  const rootReadme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const workerReadme = readFileSync(path.join(repoRoot, 'cloudflare-worker', 'README.md'), 'utf8');

  assert.match(script, /请输入 GitHub 更新令牌/);
  assert.match(script, /personal-access-tokens\/new/);
  assert.match(script, /webUpdateGitHubToken/);
  assert.match(script, /secret", "put", "GITHUB_TOKEN"/);
  assert.match(script, /GITHUB_TOKEN_NOT_CONFIGURED/);
  for (const text of [usage, rootReadme, workerReadme]) {
    assert.match(text, /personal-access-tokens\/new/);
    assert.match(text, /Actions: Read and write/);
    assert.match(text, /Contents: Read-only/);
    assert.match(text, /github_pat_/);
  }
});

test('文档里的步骤1下载入口使用 main 分支 raw 直链', () => {
  const rootReadme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const workerReadme = readFileSync(path.join(repoRoot, 'cloudflare-worker', 'README.md'), 'utf8');
  const usage = readUtf8('使用说明.txt');
  const downloadUrl = /https:\/\/github\.com\/loqwe\/heyun-zjmf-worker-monitor\/raw\/main\/windows-one-click-deploy\/步骤1-一键安装脚本\.bat/;

  assert.match(rootReadme, downloadUrl);
  assert.match(workerReadme, downloadUrl);
  assert.match(usage, downloadUrl);
  assert.match(rootReadme, /直接下载 `步骤1-一键安装脚本\.bat`/);
  assert.doesNotMatch(rootReadme, /htmlpreview\.github\.io/);
  assert.doesNotMatch(workerReadme, /htmlpreview\.github\.io/);
});

test('Release workflow 会发布中文名步骤1安装脚本附件', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'release-step1-bat.yml'), 'utf8');

  assert.match(workflow, /release-step1-bat-v1/);
  assert.match(workflow, /ASSET_NAME: step1-install\.bat/);
  assert.match(workflow, /ASSET_LABEL: 步骤1-一键安装脚本\.bat/);
  assert.match(workflow, /ASSET_PATH: windows-one-click-deploy\/步骤1-一键安装\.bat/);
  assert.match(workflow, /actions\/github-script@v7/);
  assert.match(workflow, /createRelease/);
  assert.match(workflow, /uploadReleaseAsset/);
  assert.match(workflow, /deleteReleaseAsset/);
});
