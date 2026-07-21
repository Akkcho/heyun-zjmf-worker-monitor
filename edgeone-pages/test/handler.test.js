import assert from 'node:assert/strict';
import test from 'node:test';

import { handleEdgeOneRequest, edgeOneTcpConnector } from '../src/handler.js';
import { onRequest } from '../edge-functions/index.js';

class MemoryKV {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    return this.map.get(key) || null;
  }

  async put(key, value) {
    this.map.set(key, value);
  }
}

test('EdgeOne handler 渲染初始化页', async () => {
  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/'), {
    ADMIN_TOKEN: 'admin',
    ZJMF_KV: new MemoryKV(),
  });
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /首次配置|管理面板/);
  assert.match(html, /id="providerTestResult"/);
  assert.match(html, /function runProviderConnectionTest/);
  assert.doesNotMatch(html, /task\('测试 IDC 连接'/);
});

test('EdgeOne handler 使用 KV 管理接口', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/settings', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin',
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ setup_completed: '1' }),
  }), env);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
});

test('空的 ADMIN_TOKEN 仍会回退到默认 admin', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: '', ZJMF_KV: kv };
  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);

  assert.equal(res.status, 200);
});

test('EdgeOne handler 支持全局 KV 绑定变量', async () => {
  const kv = new MemoryKV();
  const previous = globalThis.ZJMF_KV;
  globalThis.ZJMF_KV = kv;
  try {
    const res = await handleEdgeOneRequest(new Request('https://edgeone.example/'), {
      ADMIN_TOKEN: 'admin',
    });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /首次配置|管理面板/);
  } finally {
    if (previous === undefined) {
      delete globalThis.ZJMF_KV;
    } else {
      globalThis.ZJMF_KV = previous;
    }
  }
});

test('EdgeOne 管理概览不回显 IDC 密码', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/providers', {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      name: 'heyunidc',
      display_name: '核云',
      api_base_url: 'https://api.example/v1',
      api_account: '28817567790',
      api_password: 'secret',
    }),
  }), env);
  const overview = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);
  const data = await overview.json();

  assert.equal(data.providers[0].api_password, undefined);
  assert.equal(data.providers[0].api_password_configured, true);
  assert.equal(data.providers[0].api_account, '288******90');
  assert.equal(data.providers[0].api_account_redacted, true);
});

test('EdgeOne TCP 连接器不依赖 Node 原生模块', async () => {
  await assert.rejects(
    () => edgeOneTcpConnector('127.0.0.1', 996, 1000),
    /EdgeOne Pages 暂不支持 TCP 原生端口探测/,
  );
});

test('EdgeOne 测试产品列表时可复用已有 IDC 密码，但不回显到概览', async () => {
  const calls = [];
  const kv = new MemoryKV();
  const env = {
    ADMIN_TOKEN: 'admin',
    ZJMF_KV: kv,
    fetcher: async (url) => {
      calls.push(String(url));
      if (String(url).includes('login_api')) return new Response(JSON.stringify({ jwt: 'jwt-1' }));
      return new Response(JSON.stringify({ data: { host: [{ id: '4075', name: '主服务器', ip: '203.0.113.10', port: 996 }] } }));
    },
  };
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/providers', {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      name: 'heyunidc',
      display_name: '核云',
      api_base_url: 'https://api.example/v1',
      api_account: 'acct',
      api_password: 'secret',
    }),
  }), env);
  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/zjmf/hosts', {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name: 'heyunidc', api_base_url: 'https://api.example/v1', api_account: 'acct' }),
  }), env);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.match(calls[0], /login_api\?account=acct&password=secret$/);
  assert.equal(data.hosts[0].id, '4075');
});

test('Edge Function 入口支持全局 KV 绑定', async () => {
  const previous = globalThis.ZJMF_KV;
  globalThis.ZJMF_KV = new MemoryKV();
  try {
    const res = await onRequest({
      request: new Request('https://edgeone.example/'),
      env: { ADMIN_TOKEN: 'admin' },
    });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.match(html, /首次配置|管理面板/);
  } finally {
    if (previous === undefined) {
      delete globalThis.ZJMF_KV;
    } else {
      globalThis.ZJMF_KV = previous;
    }
  }
});

test('管理初始化弹窗支持滚动显示完整内容', async () => {
  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/admin'), {
    ADMIN_TOKEN: 'admin',
    ZJMF_KV: new MemoryKV(),
  });
  const html = await res.text();
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /#setupWizardModal,#notifyModal,#editModal\{align-items:start;overflow:auto\}/);
  assert.match(html, /#setupWizardModal \.setup-modal\{width:min\(1180px,calc\(100vw - 48px\)\);scrollbar-gutter:stable\}/);
  assert.match(html, /name="visible_on_status" type="hidden" value="false"/);
  const editModalStart = html.indexOf('id="editModal"');
  const editModal = html.slice(editModalStart, html.indexOf('</section>', editModalStart));
  assert.doesNotMatch(editModal, /daily_reboot_limit/);
  assert.match(html, /function fieldControl/);
  assert.match(html, /\[type="checkbox"\]/);
  assert.match(html, /填 IP 或完整网址；非默认端口才加 :端口/);
  assert.match(html, /HTTP\(S\) \+ API（EdgeOne 选这个）/);
  assert.match(html, /HTTP\(S\) \+ TCP \+ API（Cloudflare Worker 选这个）<\/option>/);
  assert.match(html, /name="provider_type"/);
  assert.match(html, /核云（预设）/);
  assert.match(html, /其他魔方财务 IDC/);
  assert.match(html, /name="provider_display_name"/);
  assert.match(html, /https:\/\/你的IDC域名\/v1/);
  assert.match(html, /id="serverProviderSelect"/);
  assert.match(html, /name="remote_id"/);
  assert.match(html, /function renderProviderOptions/);
  assert.match(html, /id="testProviderBtn"/);
  assert.match(html, /统计窗口/);
  assert.match(html, /<option value="hour" selected>每小时/);
  assert.doesNotMatch(html, /支持的通知渠道/);
  assert.match(html, /README\.md/);
  assert.match(html, /<option value="bark">Bark/);
  assert.match(html, /<option value="telegram">Telegram/);
  assert.match(html, /<option value="feishu">飞书机器人/);
  assert.match(html, /<option value="wecom">企业微信机器人/);
  assert.match(html, /<option value="dingtalk">钉钉机器人/);
  assert.match(html, /<option value="slack">Slack Webhook/);
  assert.match(html, /<option value="discord">Discord Webhook/);
  assert.match(html, /失败阶段静默/);
  assert.match(html, /notifyToggleStack/);
  assert.doesNotMatch(html, /notifySwitchColumn/);
  assert.match(html, /name="notify_failure_silence"/);
  assert.match(html, /不勾选时，检测异常\/确认宕机会通知/);
  assert.match(html, /notify_failure_silence:false/);
  assert.match(html, /notify_failure_silence:b\.notify_failure_silence==='on'/);
  assert.doesNotMatch(html, /name="notify_failure_threshold"/);
  assert.match(html, /name="notify_token"/);
  assert.match(html, /name="notify_target"/);
  assert.match(html, /function syncNotifyFields/);
  assert.doesNotMatch(html, /showUrl=type==='pushplus'/);
  assert.match(html, /probeTcpField is-hidden/);
  assert.match(html, /#selectedHostPanel\{padding:12px 14px\}/);
  assert.match(html, /#selectedHostPanel \.grid2\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\);gap:10px\}/);
  assert.doesNotMatch(html, /id="serverIdInput"/);
  assert.doesNotMatch(html, /id="serverNameInput"/);
  assert.doesNotMatch(html, /三步检测/);
});

test('EdgeOne 监控项弹窗可以快速新增 IDC 并自动选中', async () => {
  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/admin'), {
    ADMIN_TOKEN: 'admin',
    ZJMF_KV: new MemoryKV(),
  });
  const html = await res.text();

  assert.match(html, /所属 IDC[\s\S]{0,240}id="quickAddProviderBtn"/);
  assert.match(html, /id="quickProviderModal"/);
  assert.match(html, /id="quickProviderForm"/);
  assert.match(html, /保存并选中/);
  assert.match(html, /#quickProviderModal\{z-index:30;align-items:start;overflow:auto\}/);
  assert.match(html, /#quickProviderModal \.setup-modal\{width:min\(720px,calc\(100vw - 48px\)\);max-height:calc\(100vh - 48px\);overflow-y:auto\}/);
  assert.match(html, /async function saveQuickProvider/);
  assert.match(html, /renderProviderOptions\(payload\.name\)/);
  assert.match(html, /\$\('serverProviderSelect'\)\.value=payload\.name/);
});

test('EdgeOne 监控项页面实装分组筛选、管理和批量分配', async () => {
  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/admin'), {
    ADMIN_TOKEN: 'admin',
    ZJMF_KV: new MemoryKV(),
  });
  const html = await res.text();
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /\.dashboard\{[^}]*align-items:start/);
  assert.match(html, /id="groupLines"/);
  assert.match(html, /data-group-filter="all"/);
  assert.match(html, /data-group-filter="ungrouped"/);
  assert.match(html, /id="newGroupBtn"/);
  assert.match(html, /id="groupCountText"/);
  assert.match(html, /id="groupModal"/);
  assert.match(html, /id="deleteGroupModal"/);
  assert.match(html, /class="groupMeta"/);
  assert.match(html, /id="batchGroupSelect"/);
  assert.match(html, /id="moveSelectedBtn"/);
  assert.match(html, /selectAllServers/);
  assert.doesNotMatch(html, /id="groupModeSelect"/);
  assert.doesNotMatch(html, /function groupedMonitorHtml|groupTableRow|emptyGroupRow/);
  assert.match(html, /batch\.value=activeGroupFilter==='ungrouped'\?'':activeGroupFilter/);
  assert.match(html, /function renderGroupManager/);
  assert.match(html, /function filteredServers/);
  assert.match(html, /\/api\/admin\/groups/);
  assert.match(html, /\/api\/admin\/servers\/batch-group/);
});

test('EdgeOne 初始化默认使用 HTTP(S) + API', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  const setup = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin',
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      providers: [{
        name: 'heyunidc',
        display_name: '核云',
        api_base_url: 'https://api.example/v1',
        api_account: 'account',
        api_password: 'secret',
      }],
      servers: [{
        id: '1001',
        name: '测试服务器',
        provider: 'heyunidc',
      }],
      settings: {},
      notification: { enabled: false },
    }),
  }), env);

  assert.equal(setup.status, 200);
  const overview = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);
  const data = await overview.json();

  assert.equal(data.servers[0].check_method, 'http_then_api');
});

test('EdgeOne 支持不同 IDC 保存相同远程产品 ID', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  const setup = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      providers: [
        { name: 'heyun', display_name: '核云', api_base_url: 'https://www.heyunidc.cn/v1', api_account: 'a', api_password: 'key-a' },
        { name: 'other', display_name: '其他 IDC', api_base_url: 'https://idc.example/v1', api_account: 'b', api_password: 'key-b' },
      ],
      servers: [
        { id: '1001', name: '核云服务器', provider: 'heyun' },
        { id: '1001', name: '其他服务器', provider: 'other' },
      ],
      settings: {},
    }),
  }), env);

  assert.equal(setup.status, 200);
  const overview = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);
  const data = await overview.json();
  assert.deepEqual(data.servers.map(({ id, remote_id, provider }) => ({ id, remote_id, provider })), [
    { id: 'heyun::1001', remote_id: '1001', provider: 'heyun' },
    { id: 'other::1001', remote_id: '1001', provider: 'other' },
  ]);
});

test('EdgeOne 管理接口支持分组创建、批量移动和安全删除', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      providers: [{ name: 'heyunidc', display_name: '核云', api_base_url: 'https://api.example/v1', api_account: 'account', api_password: 'secret' }],
      servers: [{ id: '1001', name: '测试服务器', provider: 'heyunidc' }],
      settings: {},
    }),
  }), env);
  const createRes = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/groups', {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name: '生产环境' }),
  }), env);
  const created = await createRes.json();
  const moveRes = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/servers/batch-group', {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ server_ids: ['heyunidc::1001'], group_id: created.group.id, sort_order: 3 }),
  }), env);
  const overviewRes = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);
  const overview = await overviewRes.json();

  assert.equal(createRes.status, 200);
  assert.equal(moveRes.status, 200);
  assert.equal(overview.groups[0].name, '生产环境');
  assert.equal(overview.servers[0].group_id, created.group.id);
  assert.equal(overview.servers[0].sort_order, 3);

  const deleteRes = await handleEdgeOneRequest(new Request(`https://edgeone.example/api/admin/groups/${created.group.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer admin' },
  }), env);
  const afterRes = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);
  const after = await afterRes.json();

  assert.equal(deleteRes.status, 200);
  assert.equal(after.groups.length, 0);
  assert.equal(after.servers[0].group_id, '');
  assert.equal(after.servers[0].sort_order, 0);
});

test('EdgeOne 初始化复用旧 KV 中同一 IDC 的服务器 ID', async () => {
  const kv = new MemoryKV();
  await kv.put('zjmf_monitor_state', JSON.stringify({
    providers: [
      { name: 'heyun', display_name: '核云', api_base_url: 'https://www.heyunidc.cn/v1', api_account: 'a', api_password: 'key-a' },
    ],
    servers: [
      { id: '1001', remote_id: '1001', name: '旧监控项', provider: 'heyun', enabled: true },
    ],
  }));
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  const headers = { authorization: 'Bearer admin', 'content-type': 'application/json; charset=utf-8' };
  const setup = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providers: [
        { name: 'heyun', display_name: '核云', api_base_url: 'https://www.heyunidc.cn/v1', api_account: 'a', api_password: 'key-a' },
      ],
      servers: [
        { remote_id: '1001', name: '更新后的监控项', provider: 'heyun' },
      ],
      settings: {},
    }),
  }), env);

  assert.equal(setup.status, 200);
  const overview = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);
  const data = await overview.json();
  assert.equal(data.servers.length, 1);
  assert.equal(data.servers[0].id, '1001');
  assert.equal(data.servers[0].remote_id, '1001');
  assert.equal(data.servers[0].name, '更新后的监控项');
});

test('EdgeOne 初始化会保存更多通知渠道字段并脱敏返回', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  const headers = { authorization: 'Bearer admin', 'content-type': 'application/json; charset=utf-8' };
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providers: [],
      servers: [],
      settings: {},
      notification: { enabled: true, type: 'telegram', notify_failure_silence: true, notify_token: 'bot-token', notify_target: '10086' },
    }),
  }), env);
  const overview = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);
  const data = await overview.json();

  assert.equal(data.settings.webhook_type, 'telegram');
  assert.equal(data.settings.notify_failure_silence, true);
  assert.equal(data.settings.notify_token, '已配置');
  assert.equal(data.settings.notify_target, '10086');
});

test('管理面板顶部提供重走初始教程入口', async () => {
  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/admin'), {
    ADMIN_TOKEN: 'admin',
    ZJMF_KV: new MemoryKV(),
  });
  const html = await res.text();

  assert.match(html, /重走初始教程/);
  assert.match(html, /data-action="restart-tutorial"/);
});

test('重走初始教程会清空现有数据但保留管理密码', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  const headers = (token) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
  });
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/password', {
    method: 'POST',
    headers: headers('admin'),
    body: JSON.stringify({ old_password: 'admin', password: 'secret123' }),
  }), env);
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers: headers('secret123'),
    body: JSON.stringify({
      providers: [{
        name: 'heyunidc',
        display_name: '核云',
        api_base_url: 'https://api.example/v1',
        api_account: 'account',
        api_password: 'secret',
      }],
      servers: [{
        id: '1001',
        name: '测试服务器',
        provider: 'heyunidc',
      }],
      settings: {},
      notification: { enabled: false },
    }),
  }), env);
  const reset = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup/reset', {
    method: 'POST',
    headers: headers('secret123'),
  }), env);
  assert.equal(reset.status, 200);

  const overview = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer secret123' },
  }), env);
  const data = await overview.json();

  assert.equal(data.providers.length, 0);
  assert.equal(data.servers.length, 0);
  assert.equal(data.settings.setup_completed, '0');
});

test('保存服务器时自动使用已有服务商', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  const headers = {
    authorization: 'Bearer admin',
    'content-type': 'application/json; charset=utf-8',
  };
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providers: [{
        name: 'heyunidc_demo_account',
        display_name: '核云',
        api_base_url: 'https://api.example/v1',
        api_account: 'demo@example.com',
        api_password: 'secret',
      }],
      servers: [],
      settings: {},
      notification: { enabled: false },
    }),
  }), env);

  const save = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/servers', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: '1001', name: '测试服务器', provider: 'heyunidc' }),
  }), env);
  assert.equal(save.status, 200);

  const overview = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);
  const data = await overview.json();

  assert.equal(data.servers[0].provider, 'heyunidc_demo_account');
});

test('EdgeOne 多个 IDC 时无效服务商不会回退到第一条', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  const headers = {
    authorization: 'Bearer admin',
    'content-type': 'application/json; charset=utf-8',
  };
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providers: [
        { name: 'heyun', display_name: '核云', api_base_url: 'https://www.heyunidc.cn/v1', api_account: 'a', api_password: 'key-a' },
        { name: 'other', display_name: '其他 IDC', api_base_url: 'https://idc.example/v1', api_account: 'b', api_password: 'key-b' },
      ],
      servers: [],
      settings: {},
      notification: { enabled: false },
    }),
  }), env);

  const save = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/servers', {
    method: 'POST',
    headers,
    body: JSON.stringify({ remote_id: '1001', name: '测试服务器', provider: 'missing' }),
  }), env);
  const data = await save.json();

  assert.equal(save.status, 400);
  assert.equal(data.error, 'PROVIDER_NOT_FOUND');
  const overview = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);
  assert.equal((await overview.json()).servers.length, 0);
});

test('EdgeOne 编辑服务器时不传重启次数上限会保留旧值', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  const headers = {
    authorization: 'Bearer admin',
    'content-type': 'application/json; charset=utf-8',
  };
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providers: [{
        name: 'heyunidc',
        display_name: '核云',
        api_base_url: 'https://api.example/v1',
        api_account: 'demo@example.com',
        api_password: 'secret',
      }],
      servers: [{ id: '1001', name: '主服务器', provider: 'heyunidc', daily_reboot_limit: 9 }],
      settings: { default_daily_reboot_limit: 3 },
      notification: { enabled: false },
    }),
  }), env);

  const save = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/servers', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: '1001', name: '主服务器', provider: 'heyunidc' }),
  }), env);
  assert.equal(save.status, 200);

  const overview = await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin' },
  }), env);
  const data = await overview.json();

  assert.equal(data.servers[0].daily_reboot_limit, 9);
});

test('EdgeOne 公共状态接口隐藏不在状态页显示的服务器', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  const headers = {
    authorization: 'Bearer admin',
    'content-type': 'application/json; charset=utf-8',
  };
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providers: [{
        name: 'heyunidc',
        display_name: '核云',
        api_base_url: 'https://api.example/v1',
        api_account: 'demo@example.com',
        api_password: 'secret',
      }],
      servers: [{ id: '1001', name: '隐藏服务器', provider: 'heyunidc', visible_on_status: false }],
      settings: {},
      notification: { enabled: false },
    }),
  }), env);

  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/api/status'), env);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.servers.length, 0);
});

test('EdgeOne 公共状态接口不返回服务器账号痕迹', async () => {
  const kv = new MemoryKV();
  const env = { ADMIN_TOKEN: 'admin', ZJMF_KV: kv };
  await handleEdgeOneRequest(new Request('https://edgeone.example/api/admin/setup', {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      providers: [{ name: 'heyunidc', display_name: '核云', api_base_url: 'https://api.example/v1', api_account: 'demo@example.com', api_password: 'secret' }],
      servers: [{ id: '1001', name: '203.0.113.10', provider: 'heyunidc', visible_on_status: true }],
      settings: {},
      notification: { enabled: false },
    }),
  }), env);
  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/api/status'), env);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.servers[0].name, '服务器 1');
  assert.equal(data.servers[0].id, undefined);
  assert.equal(data.servers[0].remote_id, undefined);
  assert.equal(data.servers[0].provider, undefined);
  assert.equal(data.servers[0].ip, undefined);
  assert.equal(data.servers[0].http_url, undefined);
  assert.equal(data.servers[0].tcp_host, undefined);
  assert.equal(data.servers[0].events[0]?.server_id, undefined);
  assert.doesNotMatch(JSON.stringify(data), /203\.0\.113\.10|1001|api\.example|heyunidc/);
});

test('EdgeOne 状态页包含可点击的故障明细弹窗', async () => {
  const kv = new MemoryKV();
  await kv.put('zjmf_monitor_state', JSON.stringify({
    settings: { setup_completed: '1' },
    providers: [],
    servers: [{ id: '1001', name: '测试服务器', provider: 'heyun', enabled: true, visible_on_status: true }],
    runtimes: { 1001: { state: 'healthy', last_check_time: 1784251740 } },
    events: [],
    check_results: [
      { id: 1, server_id: '1001', ok: false, created_at: 1784247780 },
      { id: 2, server_id: '1001', ok: false, created_at: 1784248080 },
      { id: 3, server_id: '1001', ok: true, created_at: 1784248380 },
    ],
    next_event_id: 1,
    next_check_id: 4,
  }));
  const res = await handleEdgeOneRequest(new Request('https://edgeone.example/status'), {
    ADMIN_TOKEN: 'admin',
    ZJMF_KV: kv,
  });
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /id="outageModal"/);
  assert.match(html, /data-outages=/);
  assert.match(html, /function openOutageModal/);
  assert.match(html, /当天没有记录到故障。/);
});
