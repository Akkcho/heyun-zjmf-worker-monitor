import { runMonitorOnce } from './monitor.js';
import { D1Repository } from './repository.js';
import { Notifier } from './notifier.js';
import { renderAdminPage } from './admin-page.js';
import { renderStatusPage } from './status-page.js';
import { normalizeApiBaseUrl, ZjmfClient } from './zjmf-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function boolValue(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

function boolValueWithDefault(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return boolValue(value);
}

function visibleOnStatus(server) {
  return boolValueWithDefault(server?.visible_on_status, true);
}

function remoteServerId(server) {
  const explicit = String(server?.remote_id || server?.product_id || '').trim();
  if (explicit) return explicit;
  const id = String(server?.id || '').trim();
  const prefix = `${String(server?.provider || '').trim()}::`;
  return prefix !== '::' && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function newServerId(provider, remoteId) {
  return `${provider}::${remoteId}`;
}

function newGroupId() {
  const suffix = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `group-${suffix}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function matchesAdminToken(token, env, repo) {
  if (!token) return false;
  const currentHash = await repo.getSetting('admin_token_hash', '');
  if (currentHash) return await sha256Hex(token) === currentHash;
  const bootstrapToken = env.ADMIN_TOKEN || 'admin';
  return token === bootstrapToken;
}

async function isAuthorized(request, env, repo) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return await matchesAdminToken(token, env, repo);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isIpAddress(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || '').trim());
}

function serverDisplayName(server) {
  return isIpAddress(server.name) || isIpAddress(server.ip) ? `服务器 #${server.id}` : server.name;
}

function publicServer(server, index = 0) {
  const {
    id: _id,
    remote_id: _remoteId,
    provider: _provider,
    ip: _ip,
    http_url: _httpUrl,
    tcp_host: _tcpHost,
    visible_on_status: _visible,
    ...rest
  } = server;
  const name = String(server.name || '').trim();
  return {
    ...rest,
    name: name && !isIpAddress(name) ? name : `服务器 ${index + 1}`,
  };
}

function statusServer(server) {
  const { ip: _ip, http_url: _httpUrl, tcp_host: _tcpHost, visible_on_status: _visible, ...rest } = server;
  return { ...rest, name: serverDisplayName(server) };
}

function adminServer(server) {
  const { ip: _ip, ...rest } = server;
  return { ...rest, name: serverDisplayName(server) };
}

function maskAccount(value) {
  const account = String(value || '');
  if (account.length <= 2) return '*'.repeat(account.length);
  if (account.length <= 5) return `${account.slice(0, 1)}${'*'.repeat(account.length - 2)}${account.slice(-1)}`;
  return `${account.slice(0, 3)}${'*'.repeat(account.length - 5)}${account.slice(-2)}`;
}

function isRedactedAccount(value) {
  return String(value || '').includes('*');
}

function adminProvider(provider) {
  const {
    api_account: apiAccount,
    api_password: apiPassword,
    jwt_token: _jwtToken,
    jwt_expire_at: _jwtExpireAt,
    ...rest
  } = provider;
  return {
    ...rest,
    api_account: maskAccount(apiAccount),
    api_account_configured: Boolean(apiAccount),
    api_account_redacted: Boolean(apiAccount),
    api_password_configured: Boolean(apiPassword),
  };
}

function publicEvent(event) {
  const { id, old_state, new_state, label, level, created_at } = event;
  return { id, old_state, new_state, label, level, created_at };
}

function adminServers(servers, status) {
  const activeIds = new Set(status.map((server) => String(server.id)));
  return servers.map(adminServer).sort((a, b) => {
    const activeDiff = Number(activeIds.has(String(b.id))) - Number(activeIds.has(String(a.id)));
    if (activeDiff) return activeDiff;
    const enabledDiff = Number(b.enabled) - Number(a.enabled);
    return enabledDiff || String(a.id).localeCompare(String(b.id), 'zh-CN', { numeric: true });
  });
}

function hostDisplayName(host) {
  const id = host.id ?? host.hostid ?? host.product_id ?? host.uid ?? '';
  const name = host.name || host.title || host.domain || host.hostname || '';
  return isIpAddress(name) || !name ? `服务器 #${id}` : String(name);
}

function hostIpAddress(host) {
  const candidates = [
    host.ip, host.main_ip, host.server_ip, host.dedicatedip, host.dedicated_ip,
    host.ipaddress, host.ip_address, host.public_ip, host.ipv4, host.address,
    host.hostname, host.domain,
  ];
  const value = candidates.find((item) => isIpAddress(item));
  return value ? String(value) : '';
}

function normalizeRepo(value) {
  const text = String(value || '').trim().replace(/\.git$/i, '');
  const match = text.match(/github\.com[:/](.+\/.+)$/i);
  return (match ? match[1] : text).replace(/^\/+|\/+$/g, '');
}

function githubHeaders(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'zjmf-monitor-worker',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubErrorDetail(res) {
  try {
    const data = await res.clone().json();
    return {
      github_message: String(data?.message || '').slice(0, 500),
      documentation_url: String(data?.documentation_url || ''),
    };
  } catch {
    try {
      const text = String(await res.clone().text()).trim();
      return { github_message: text.slice(0, 500) };
    } catch {
      return {};
    }
  }
}

async function githubUpdateConfig(repo, env) {
  const githubRepo = normalizeRepo(await repo.getSetting('github_repo', env.GITHUB_REPOSITORY || env.GITHUB_REPO || ''));
  return {
    repo: githubRepo,
    branch: await repo.getSetting('github_branch', env.GITHUB_BRANCH || env.GITHUB_REF_NAME || 'main'),
    workflow: await repo.getSetting('github_workflow_file', env.GITHUB_WORKFLOW_FILE || 'deploy.yml'),
    currentSha: String(env.APP_VERSION || env.WORKER_VERSION || '').trim(),
    token: env.GITHUB_TOKEN || env.WEB_UPDATE_GITHUB_TOKEN || '',
    fetcher: env.fetcher || ((input, init) => fetch(input, init)),
  };
}

async function dayOrdinal(cfg, dateStr, sha) {
  if (!dateStr || !sha) return { ordinal: 0, total: 0 };
  const dt = new Date(dateStr);
  if (isNaN(dt.getTime())) return { ordinal: 0, total: 0 };
  const day = new Date(dt.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const since = `${day}T00:00:00+08:00`;
  const until = `${day}T23:59:59+08:00`;
  const url = `https://api.github.com/repos/${cfg.repo}/commits?sha=${encodeURIComponent(cfg.branch)}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=100`;
  try {
    const res = await cfg.fetcher(url, { headers: githubHeaders(cfg.token) });
    if (!res.ok) return { ordinal: 0, total: 0 };
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return { ordinal: 0, total: 0 };
    const idx = list.findIndex(c => {
      const cSha = String(c.sha || '');
      return cSha.startsWith(sha) || (sha && sha.startsWith(cSha));
    });
    if (idx < 0) return { ordinal: 0, total: list.length };
    return { ordinal: list.length - idx, total: list.length };
  } catch {
    return { ordinal: 0, total: 0 };
  }
}

function githubActionsUrl(repo, workflow) {
  return `https://github.com/${repo}/actions/workflows/${encodeURIComponent(workflow)}`;
}

function adminHost(host) {
  const id = host.id ?? host.hostid ?? host.product_id ?? host.uid ?? '';
  const ip = hostIpAddress(host);
  const tcpPort = host.tcp_port || host.port || host.service_port || host.listen_port || '';
  return {
    id: String(id),
    name: hostDisplayName(host),
    status: host.status || host.state || host.power_status || '',
    ip: ip ? String(ip) : '',
    tcp_host: ip ? String(ip) : '',
    tcp_port: tcpPort ? Number(tcpPort) : '',
  };
}

async function publicStatus(repo, settings = null) {
  const resolvedSettings = settings || await repo.getSettings();
  const servers = (await repo.listStatus()).filter(visibleOnStatus);
  const groups = await repo.listGroups();
  const groupMap = new Map(groups.map((group) => [String(group.id), group]));
  const ids = servers.map((server) => String(server.id));
  const daily = await repo.listDailyHistory(ids, 30, Math.floor(Date.now() / 1000), resolvedSettings.check_interval);
  const events = await repo.listPublicEvents(ids);
  const recent = new Map();
  for (const server of servers) {
    recent.set(String(server.id), await repo.listRecentChecks(server.id));
  }
  return servers.map((server, index) => ({
    ...publicServer(server, index),
    group_name: groupMap.get(String(server.group_id || ''))?.name || '',
    group_sort_order: Number(groupMap.get(String(server.group_id || ''))?.sort_order ?? Number.MAX_SAFE_INTEGER),
    daily_history: daily.get(String(server.id)) || [],
    events: (events.get(String(server.id)) || []).map(publicEvent),
    recent_checks: recent.get(String(server.id)) || [],
  }));
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const repo = env.__repo || new D1Repository(env.DB);

  if ((url.pathname === '/' || url.pathname === '/status') && request.method === 'GET') {
    if (url.pathname === '/' && (await repo.getSetting('setup_completed', '0')) !== '1') {
      return new Response(renderAdminPage({ showIntro: true }), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    const settings = await repo.getSettings();
    return new Response(renderStatusPage(await publicStatus(repo, settings), settings), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  if (url.pathname === '/admin' && request.method === 'GET') {
    return new Response(renderAdminPage({ showIntro: (await repo.getSetting('setup_completed', '0')) !== '1' }), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  if (url.pathname === '/api/status' && request.method === 'GET') {
    const settings = await repo.getSettings();
    return json({ servers: await publicStatus(repo, settings) });
  }

  if (!url.pathname.startsWith('/api/admin/')) return json({ error: 'NOT_FOUND' }, 404);
  if (!(await isAuthorized(request, env, repo))) return json({ error: 'UNAUTHORIZED' }, 401);
  if (url.pathname === '/api/admin/overview' && request.method === 'GET') {
    const settings = await repo.getSettings();
    const status = (await repo.listStatus()).map(statusServer);
    return json({
      settings: {
        ...settings,
        pushplus_token: settings.pushplus_token ? '已配置' : '',
        notify_token: settings.notify_token || settings.pushplus_token ? '已配置' : '',
        notify_secret: settings.notify_secret ? '已配置' : '',
      },
      providers: (await repo.listProviders()).map(adminProvider),
      groups: await repo.listGroups(),
      servers: adminServers(await repo.listServers(), status),
      status,
      events: await repo.listEvents(50),
    });
  }

  if (url.pathname === '/api/admin/password' && request.method === 'POST') {
    const body = await readJson(request);
    const oldPassword = String(body?.old_password || '').trim();
    const password = String(body?.password || '').trim();
    if (!(await matchesAdminToken(oldPassword, env, repo))) return json({ error: 'INVALID_OLD_PASSWORD' }, 400);
    if (!password) return json({ error: 'INVALID_PASSWORD' }, 400);
    await repo.setSetting('admin_token_hash', await sha256Hex(password));
    return json({ ok: true });
  }

  if (url.pathname === '/api/admin/zjmf/hosts' && request.method === 'POST') {
    const body = await readJson(request);
    const existing = body?.name ? await repo.getProvider(String(body.name)) : null;
    const apiBaseUrl = body?.api_base_url || existing?.api_base_url;
    const apiAccount = existing?.api_account || (body?.api_account && !isRedactedAccount(body.api_account)
      ? body.api_account
      : null);
    const apiPassword = existing?.api_password || body?.api_password;
    if (!apiBaseUrl || !apiAccount || !apiPassword) {
      return json({ error: 'INVALID_PROVIDER' }, 400);
    }
    const settings = await repo.getSettings();
    const client = new ZjmfClient({
      ...existing,
      api_base_url: normalizeApiBaseUrl(apiBaseUrl),
      api_account: apiAccount,
      api_password: apiPassword,
    }, env.fetcher || ((input, init) => fetch(input, init)), settings.api_timeout);
    const hosts = await client.getHosts(Math.floor(Date.now() / 1000));
    if (!hosts) return json({ error: client.lastError || 'HOSTS_FETCH_FAILED' }, 502);
    return json({ hosts: hosts.map(adminHost).filter((host) => host.id) });
  }

  if (url.pathname === '/api/admin/events' && request.method === 'GET') {
    return json({ events: await repo.listEvents(100) });
  }

  if (url.pathname === '/api/admin/run' && request.method === 'POST') {
    const now = Math.floor(Date.now() / 1000);
    return json(await runMonitorOnce({ repo, fetcher: (input, init) => fetch(input, init), tcpConnector: env.tcpConnector, now, force: true }));
  }

  if (url.pathname === '/api/admin/notify/test' && request.method === 'POST') {
    const notifier = new Notifier(await repo.getSettings(), (input, init) => fetch(input, init));
    return json(await notifier.send('ZJMF 测试通知', '这是一条来自管理后台的测试通知。', 'info'));
  }

  if (url.pathname === '/api/admin/update/check' && request.method === 'GET') {
    const cfg = await githubUpdateConfig(repo, env);
    if (!cfg.repo) return json({ ok: true, configured: false, message: '未配置 GitHub 仓库' });
    const latestUrl = `https://api.github.com/repos/${cfg.repo}/commits/${encodeURIComponent(cfg.branch)}`;
    const res = await cfg.fetcher(latestUrl, { headers: githubHeaders(cfg.token) });
    if (!res.ok) {
      const detail = await githubErrorDetail(res);
      return json({
        ok: false,
        configured: true,
        error: 'GITHUB_CHECK_FAILED',
        status: res.status,
        repo: cfg.repo,
        branch: cfg.branch,
        workflow: cfg.workflow,
        actions_url: githubActionsUrl(cfg.repo, cfg.workflow),
        ...detail,
      }, 502);
    }
    const data = await res.json();
    const latestSha = String(data.sha || '').trim();
    const latestDate = String(data.commit?.committer?.date || data.commit?.author?.date || '');
    const currentSha = cfg.currentSha;
    let currentDate = '';
    if (currentSha) {
      try {
        const cur = await cfg.fetcher(`https://api.github.com/repos/${cfg.repo}/commits/${encodeURIComponent(currentSha)}`, { headers: githubHeaders(cfg.token) });
        if (cur.ok) {
          const curData = await cur.json();
          currentDate = String(curData.commit?.committer?.date || curData.commit?.author?.date || '');
        }
      } catch {}
    }
    const latestOrd = await dayOrdinal(cfg, latestDate, latestSha);
    const currentOrd = currentSha && currentDate ? await dayOrdinal(cfg, currentDate, currentSha) : { ordinal: 0, total: 0 };
    const updateAvailable = currentSha && latestSha ? !latestSha.startsWith(currentSha) && !currentSha.startsWith(latestSha) : null;
    return json({
      ok: true,
      configured: true,
      repo: cfg.repo,
      branch: cfg.branch,
      workflow: cfg.workflow,
      current_sha: currentSha,
      current_date: currentDate,
      current_ordinal: currentOrd.ordinal,
      current_day_total: currentOrd.total,
      latest_sha: latestSha,
      latest_date: latestDate,
      latest_ordinal: latestOrd.ordinal,
      latest_day_total: latestOrd.total,
      latest_message: String(data.commit?.message || '').split('\n')[0],
      update_available: updateAvailable,
      actions_url: githubActionsUrl(cfg.repo, cfg.workflow),
    });
  }

  if (url.pathname === '/api/admin/update/dispatch' && request.method === 'POST') {
    const cfg = await githubUpdateConfig(repo, env);
    if (!cfg.repo) return json({ error: 'GITHUB_REPO_NOT_CONFIGURED' }, 400);
    if (!cfg.token) return json({ error: 'GITHUB_TOKEN_NOT_CONFIGURED' }, 400);
    const workflow = encodeURIComponent(cfg.workflow);
    const endpoint = `https://api.github.com/repos/${cfg.repo}/actions/workflows/${workflow}/dispatches`;
    const res = await cfg.fetcher(endpoint, {
      method: 'POST',
      headers: githubHeaders(cfg.token),
      body: JSON.stringify({ ref: cfg.branch }),
    });
    if (!res.ok) return json({ error: 'GITHUB_DISPATCH_FAILED', status: res.status }, 502);
    return json({ ok: true, repo: cfg.repo, branch: cfg.branch, workflow: cfg.workflow, actions_url: githubActionsUrl(cfg.repo, cfg.workflow) });
  }

  if (url.pathname === '/api/admin/setup' && request.method === 'POST') {
    const body = await readJson(request);
    const provider = body?.provider || {};
    const server = body?.server || {};
    const batchMode = Array.isArray(body?.providers) || Array.isArray(body?.servers);
    const providers = batchMode ? (Array.isArray(body.providers) ? body.providers : []) : (provider.api_base_url || provider.api_account || provider.api_password || provider.name ? [provider] : []);
    const servers = batchMode ? (Array.isArray(body.servers) ? body.servers : []) : (server.id || server.name || server.provider || server.http_url || server.tcp_host ? [server] : []);
    const missing = [];
    const providerNames = new Set(providers.map((item) => item.name).filter(Boolean));
    providers.forEach((item, index) => {
      const prefix = batchMode ? `providers.${index}` : 'provider';
      if (batchMode && !item.name) missing.push(`${prefix}.name`);
      if (!item.api_base_url) missing.push(`${prefix}.api_base_url`);
      if (!item.api_account) missing.push(`${prefix}.api_account`);
      if (!item.api_password) missing.push(`${prefix}.api_password`);
    });
    servers.forEach((item, index) => {
      const prefix = batchMode ? `servers.${index}` : 'server';
      if (!remoteServerId(item)) missing.push(`${prefix}.remote_id`);
      if (batchMode && !item.provider) missing.push(`${prefix}.provider`);
      if (batchMode && item.provider && !providerNames.has(item.provider)) missing.push(`${prefix}.provider`);
    });
    if (missing.length) {
      return json({ error: 'INVALID_SETUP', message: '初始化信息不完整', missing }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const firstProvider = providers[0] || provider;
    const firstServer = servers[0] || server;
    for (const item of providers) {
      const name = item.name || firstProvider.name || 'heyunidc';
      await repo.upsertProvider({ ...item, name, display_name: item.display_name || name, api_base_url: normalizeApiBaseUrl(item.api_base_url) }, now);
    }
    const existingServers = await repo.listServers();
    for (const item of servers) {
      const providerName = item.provider || firstProvider.name || 'heyunidc';
      const remoteId = remoteServerId({ ...item, provider: providerName });
      const existing = existingServers.find((serverItem) => serverItem.provider === providerName && remoteServerId(serverItem) === remoteId);
      await repo.upsertServer({
        ...item,
        id: existing?.id || newServerId(providerName, remoteId),
        remote_id: remoteId,
        name: item.name || `服务器 #${remoteId}`,
        provider: providerName,
        check_method: item.check_method || 'http_then_api',
        visible_on_status: boolValueWithDefault(item.visible_on_status, true),
        enabled: true,
        daily_reboot_limit: Number(item.daily_reboot_limit || 3),
        probe_timeout_ms: Number(item.probe_timeout_ms || body.settings?.api_timeout_ms || 10000),
      }, now);
    }
    await repo.setSetting('check_interval', Number(body.settings?.check_interval || 300));
    await repo.setSetting('api_timeout', Math.max(1, Math.ceil(Number(body.settings?.api_timeout_ms || 60000) / 1000)));
    await repo.setSetting('default_daily_reboot_limit', Number(body.settings?.default_daily_reboot_limit || firstServer.daily_reboot_limit || 3));
    await repo.setSetting('reboot_limit_window', body.settings?.reboot_limit_window || 'hour');
    await repo.setSetting('notify_failure_silence', boolValue(body.notification?.notify_failure_silence));
    if (body.notification?.enabled) {
      await repo.setSetting('webhook_type', body.notification.type || 'pushplus');
      await repo.setSetting('webhook_url', body.notification.webhook_url || 'https://www.pushplus.plus/send');
      await repo.setSetting('pushplus_token', body.notification.pushplus_token || '');
      await repo.setSetting('notify_token', body.notification.notify_token || body.notification.pushplus_token || '');
      await repo.setSetting('notify_target', body.notification.notify_target || '');
      await repo.setSetting('notify_secret', body.notification.notify_secret || '');
    }
    await repo.setSetting('setup_completed', '1');
    return json({ ok: true });
  }

  if (url.pathname === '/api/admin/setup/reset' && request.method === 'POST') {
    await repo.resetTutorialData();
    return json({ ok: true });
  }

  if (url.pathname === '/api/admin/groups' && request.method === 'POST') {
    const body = await readJson(request);
    const name = String(body?.name || '').trim();
    if (!name || name.length > 64) return json({ error: 'INVALID_GROUP_NAME' }, 400);
    const groups = await repo.listGroups();
    const requestedId = String(body?.id || '').trim();
    const existing = requestedId ? groups.find((group) => String(group.id) === requestedId) : null;
    if (requestedId && !existing) return json({ error: 'GROUP_NOT_FOUND' }, 404);
    if (groups.some((group) => String(group.id) !== requestedId && String(group.name).toLocaleLowerCase('zh-CN') === name.toLocaleLowerCase('zh-CN'))) {
      return json({ error: 'GROUP_NAME_EXISTS' }, 409);
    }
    const requestedSort = Number(body?.sort_order);
    const nextSort = Object.hasOwn(body || {}, 'sort_order') && Number.isFinite(requestedSort)
      ? Math.max(0, Math.trunc(requestedSort))
      : Number(existing?.sort_order ?? (groups.length ? Math.max(...groups.map((group) => Number(group.sort_order || 0))) + 1 : 0));
    const group = { id: existing?.id || newGroupId(), name, sort_order: nextSort };
    await repo.upsertGroup(group, Math.floor(Date.now() / 1000));
    return json({ ok: true, group });
  }

  if (url.pathname === '/api/admin/groups/reorder' && request.method === 'POST') {
    const body = await readJson(request);
    const groupIds = [...new Set((Array.isArray(body?.group_ids) ? body.group_ids : []).map((id) => String(id).trim()).filter(Boolean))];
    const groups = await repo.listGroups();
    const known = new Set(groups.map((group) => String(group.id)));
    if (groupIds.length !== groups.length || groupIds.some((id) => !known.has(id))) {
      return json({ error: 'INVALID_GROUP_ORDER' }, 400);
    }
    await repo.reorderGroups(groupIds, Math.floor(Date.now() / 1000));
    return json({ ok: true });
  }

  if (url.pathname === '/api/admin/servers/batch-group' && request.method === 'POST') {
    const body = await readJson(request);
    const serverIds = [...new Set((Array.isArray(body?.server_ids) ? body.server_ids : []).map((id) => String(id).trim()).filter(Boolean))];
    if (!serverIds.length) return json({ error: 'NO_SERVERS_SELECTED' }, 400);
    const groupId = String(body?.group_id || '').trim();
    if (groupId && !(await repo.getGroup(groupId))) return json({ error: 'GROUP_NOT_FOUND' }, 404);
    const servers = await repo.listServers();
    const known = new Set(servers.map((server) => String(server.id)));
    const missing = serverIds.find((id) => !known.has(id));
    if (missing) return json({ error: 'SERVER_NOT_FOUND', server_id: missing }, 404);
    const parsedSort = Number(body?.sort_order);
    const sortOrder = Object.hasOwn(body || {}, 'sort_order') && body.sort_order !== '' && Number.isFinite(parsedSort)
      ? Math.max(0, Math.trunc(parsedSort))
      : null;
    await repo.assignServersToGroup(serverIds, groupId, sortOrder, Math.floor(Date.now() / 1000));
    return json({ ok: true, updated: serverIds.length });
  }

  if (url.pathname.startsWith('/api/admin/groups/') && request.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.slice('/api/admin/groups/'.length));
    if (!id || !(await repo.getGroup(id))) return json({ error: 'GROUP_NOT_FOUND' }, 404);
    await repo.deleteGroup(id, Math.floor(Date.now() / 1000));
    return json({ ok: true });
  }

  if (url.pathname === '/api/admin/providers' && request.method === 'POST') {
    const body = await readJson(request);
    const existing = body?.name ? await repo.getProvider(body.name) : null;
    const apiAccount = body?.api_account && !isRedactedAccount(body.api_account)
      ? body.api_account
      : existing?.api_account || '';
    if (!body?.name || !body?.api_base_url || !apiAccount) {
      return json({ error: 'INVALID_PROVIDER' }, 400);
    }
    const apiPassword = body.api_password || existing?.api_password || '';
    if (!apiPassword) return json({ error: 'INVALID_PROVIDER' }, 400);
    await repo.upsertProvider({ ...body, display_name: body.display_name || body.name, api_base_url: normalizeApiBaseUrl(body.api_base_url), api_account: apiAccount, api_password: apiPassword }, Math.floor(Date.now() / 1000));
    return json({ ok: true });
  }

  if (url.pathname === '/api/admin/servers' && request.method === 'POST') {
    const body = await readJson(request);
    if (!body?.name || !remoteServerId(body)) return json({ error: 'INVALID_SERVER' }, 400);
    const requestedId = String(body.id || '').trim();
    const directExisting = requestedId ? await repo.getServer(requestedId) : null;
    const providers = await repo.listProviders();
    const providerName = String(body.provider || '').trim();
    const provider = providers.some((item) => item.name === providerName)
      ? providerName
      : directExisting?.provider && providers.some((item) => item.name === directExisting.provider)
        ? directExisting.provider
        : providers.length === 1 ? providers[0].name : '';
    if (!provider) return json({ error: 'PROVIDER_NOT_FOUND' }, 400);
    const requestedRemoteId = remoteServerId({ ...body, provider });
    const existing = directExisting?.provider === provider
      ? directExisting
      : (await repo.listServers()).find((item) => item.provider === provider && remoteServerId(item) === requestedRemoteId) || null;
    const remoteId = requestedRemoteId || existing?.remote_id || existing?.id;
    const settings = await repo.getSettings();
    const requestedGroupId = Object.hasOwn(body, 'group_id') ? String(body.group_id || '').trim() : String(existing?.group_id || '');
    if (requestedGroupId && !(await repo.getGroup(requestedGroupId))) return json({ error: 'GROUP_NOT_FOUND' }, 400);
    const nextServer = {
      ...body,
      id: existing?.id || (requestedId.includes('::') ? requestedId : newServerId(provider, remoteId)),
      remote_id: remoteId,
      provider,
      ip: Object.hasOwn(body, 'ip') ? body.ip : existing?.ip || '',
      check_method: body.check_method || 'http_then_api',
      daily_reboot_limit: Object.hasOwn(body, 'daily_reboot_limit')
        ? Number(body.daily_reboot_limit || 0)
        : Number(existing?.daily_reboot_limit ?? settings.default_daily_reboot_limit ?? 3),
      visible_on_status: Object.hasOwn(body, 'visible_on_status')
        ? boolValueWithDefault(body.visible_on_status, true)
        : boolValueWithDefault(existing?.visible_on_status, true),
      group_id: requestedGroupId,
      sort_order: Object.hasOwn(body, 'sort_order')
        ? Math.max(0, Math.trunc(Number(body.sort_order) || 0))
        : Number(existing?.sort_order || 0),
      scheduled_reboot: '',
    };
    await repo.upsertServer(nextServer, Math.floor(Date.now() / 1000));
    return json({ ok: true });
  }

  if (url.pathname.startsWith('/api/admin/servers/') && request.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.slice('/api/admin/servers/'.length));
    const existing = id ? await repo.getServer(id) : null;
    if (!existing) return json({ error: 'SERVER_NOT_FOUND' }, 404);
    const now = Math.floor(Date.now() / 1000);
    await repo.deleteServer(id);
    await repo.addEvent({
      server_id: id,
      old_state: 'configured',
      new_state: 'deleted',
      label: '删除监控项',
      level: 'warning',
      message: `监控项 ${serverDisplayName(existing)} 已从管理后台删除`,
      created_at: now,
    });
    return json({ ok: true });
  }

  if (url.pathname === '/api/admin/settings' && request.method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object') return json({ error: 'INVALID_SETTINGS' }, 400);
    for (const [key, value] of Object.entries(body)) await repo.setSetting(key, value);
    return json({ ok: true });
  }

  return json({ error: 'NOT_FOUND' }, 404);
}
