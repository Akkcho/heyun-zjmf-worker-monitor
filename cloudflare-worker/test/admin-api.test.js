import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { D1Repository } from '../src/repository.js';
import { handleRequest } from '../src/routes.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('D1 状态查询包含状态页分组所需字段', async () => {
  let sql = '';
  const repo = new D1Repository({
    prepare(statement) {
      sql = statement;
      return { all: async () => ({ results: [] }) };
    },
  });

  await repo.listStatus();

  assert.match(sql, /s\.group_id/);
  assert.match(sql, /s\.sort_order/);
});

class FakeStatement {
  constructor(data, sql) {
    this.data = data;
    this.sql = sql;
  }

  bind() {
    this.args = [...arguments];
    return this;
  }

  async all() {
    if (this.sql.includes('SELECT key, value FROM settings')) {
      return { results: Object.entries(this.data.settings).map(([key, value]) => ({ key, value })) };
    }
    if (this.sql.includes('FROM providers ORDER BY name')) {
      return {
        results: this.data.providers.map(({ name, display_name, api_base_url, api_account, api_password, created_at, updated_at }) => ({
          name,
          display_name,
          api_base_url,
          api_account,
          api_password,
          created_at,
          updated_at,
        })),
      };
    }
    if (this.sql.includes('FROM monitor_groups ORDER BY sort_order')) return { results: this.data.groups };
    if (this.sql.includes('SELECT * FROM servers ORDER BY id')) return { results: this.data.servers };
    if (this.sql.includes('FROM servers s')) return { results: this.data.status };
    if (this.sql.includes('ORDER BY created_at DESC, id DESC')) return { results: this.data.recentChecks };
    if (this.sql.includes('ORDER BY server_id, created_at ASC')) return { results: this.data.outageChecks || [] };
    if (this.sql.includes('FROM check_results')) return { results: this.data.dailyResults };
    if (this.sql.includes('FROM events')) return { results: this.data.events };
    throw new Error(`Unexpected SQL: ${this.sql}`);
  }

  async first() {
    if (this.sql.includes('SELECT value FROM settings WHERE key')) {
      const value = this.data.settings[this.args[0]];
      return value == null ? null : { value };
    }
    if (this.sql.includes('SELECT * FROM providers WHERE name')) {
      return this.data.providers.find((provider) => provider.name === this.args[0]) || null;
    }
    if (this.sql.includes('SELECT * FROM servers WHERE id')) {
      return this.data.servers.find((server) => server.id === this.args[0]) || null;
    }
    if (this.sql.includes('SELECT * FROM monitor_groups WHERE id')) {
      return this.data.groups.find((group) => group.id === this.args[0]) || null;
    }
    throw new Error(`Unexpected SQL: ${this.sql}`);
  }

  async run() {
    const sql = this.sql.trim();
    if (this.sql.includes('INSERT INTO providers')) {
      this.data.providerWrites.push({
        name: this.args[0],
        display_name: this.args[1],
        api_base_url: this.args[2],
        api_account: this.args[3],
        api_password: this.args[4],
      });
      return {};
    }
    if (this.sql.includes('INSERT INTO servers')) {
      this.data.serverWrites.push({
        id: this.args[0],
        remote_id: this.args[1],
        name: this.args[2],
        ip: this.args[3],
        provider: this.args[4],
        check_method: this.args[5],
        enabled: this.args[6],
        visible_on_status: this.args[7],
        daily_reboot_limit: this.args[8],
        scheduled_reboot: this.args[9],
        http_url: this.args[10],
        tcp_port: this.args[14],
        group_id: this.args[18],
        sort_order: this.args[19],
      });
      return {};
    }
    if (this.sql.includes('INSERT INTO monitor_groups')) {
      const group = {
        id: this.args[0],
        name: this.args[1],
        sort_order: this.args[2],
        created_at: this.args[3],
        updated_at: this.args[3],
      };
      const index = this.data.groups.findIndex((item) => item.id === group.id);
      if (index >= 0) this.data.groups[index] = { ...this.data.groups[index], ...group };
      else this.data.groups.push(group);
      return {};
    }
    if (this.sql.includes('UPDATE monitor_groups SET sort_order')) {
      const group = this.data.groups.find((item) => item.id === this.args[2]);
      if (group) group.sort_order = this.args[0];
      return {};
    }
    if (this.sql.includes('UPDATE servers SET group_id = ?1, sort_order = ?2')) {
      const server = this.data.servers.find((item) => item.id === this.args[3]);
      if (server) Object.assign(server, { group_id: this.args[0], sort_order: this.args[1] });
      return {};
    }
    if (this.sql.includes('UPDATE servers SET group_id = ?1')) {
      const server = this.data.servers.find((item) => item.id === this.args[2]);
      if (server) server.group_id = this.args[0];
      return {};
    }
    if (this.sql.includes("UPDATE servers SET group_id = '', sort_order = 0")) {
      for (const server of this.data.servers) {
        if (server.group_id === this.args[1]) Object.assign(server, { group_id: '', sort_order: 0 });
      }
      return {};
    }
    if (this.sql.includes('DELETE FROM monitor_groups WHERE id')) {
      this.data.groups = this.data.groups.filter((group) => group.id !== this.args[0]);
      return {};
    }
    if (this.sql.includes('INSERT INTO events')) {
      this.data.eventWrites.push({
        server_id: this.args[0],
        label: this.args[3],
        level: this.args[4],
        message: this.args[5],
      });
      return {};
    }
    if (sql === 'DELETE FROM check_results') {
      this.data.dailyResults = [];
      this.data.recentChecks = [];
      return {};
    }
    if (sql === 'DELETE FROM events') {
      this.data.events = [];
      return {};
    }
    if (sql === 'DELETE FROM runtimes') {
      this.data.deletedTables.push('runtimes');
      return {};
    }
    if (sql === 'DELETE FROM servers') {
      this.data.servers = [];
      this.data.status = [];
      return {};
    }
    if (sql === 'DELETE FROM providers') {
      this.data.providers = [];
      return {};
    }
    if (sql === 'DELETE FROM monitor_groups') {
      this.data.groups = [];
      return {};
    }
    if (sql === 'DELETE FROM settings WHERE key != ?1') {
      for (const key of Object.keys(this.data.settings)) {
        if (key !== this.args[0]) delete this.data.settings[key];
      }
      return {};
    }
    if (this.sql.includes('DELETE FROM runtimes')) {
      this.data.deletedRuntimes.push(this.args[0]);
      return {};
    }
    if (this.sql.includes('DELETE FROM servers')) {
      this.data.deletedServers.push(this.args[0]);
      return {};
    }
    if (this.sql.includes('INSERT INTO settings')) {
      this.data.settings[this.args[0]] = this.args[1];
      return {};
    }
    throw new Error(`Unexpected SQL: ${this.sql}`);
  }
}

class FakeD1 {
  constructor(data) {
    this.data = data;
  }

  prepare(sql) {
    return new FakeStatement(this.data, sql);
  }
}

function env(overrides = {}) {
  return {
    ADMIN_TOKEN: 'admin-password',
    GITHUB_TOKEN: overrides.GITHUB_TOKEN,
    GITHUB_REPOSITORY: overrides.GITHUB_REPOSITORY || 'loqwe/heyun-zjmf-worker-monitor',
    GITHUB_BRANCH: overrides.GITHUB_BRANCH || 'main',
    GITHUB_WORKFLOW_FILE: overrides.GITHUB_WORKFLOW_FILE || 'deploy.yml',
    APP_VERSION: overrides.APP_VERSION || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    fetcher: overrides.fetcher,
    DB: new FakeD1({
      settings: {
        pushplus_token: 'pushplus-secret',
        suspect_threshold: '2',
        reboot_cooldown: '300',
        recover_timeout: '300',
        ...(overrides.settings || {}),
      },
      providers: overrides.providers || [
        {
          name: 'heyunidc',
          display_name: '核云',
          api_base_url: 'https://api.example/v1',
          api_account: 'account@example.test',
          api_password: 'provider-secret',
        },
      ],
      providerWrites: [],
      serverWrites: [],
      eventWrites: [],
      deletedTables: [],
      deletedRuntimes: [],
      deletedServers: [],
      groups: overrides.groups || [],
      servers: overrides.servers || [{ id: '8564', name: '主服务器', ip: '203.0.113.10', provider: 'heyunidc', enabled: 1 }],
      status: Object.hasOwn(overrides, 'status') ? overrides.status : [{
        id: '8564',
        name: '203.0.113.10',
        ip: '203.0.113.10',
        http_url: 'https://203.0.113.10/health',
        tcp_host: '203.0.113.10',
        tcp_port: 443,
        visible_on_status: 1,
        state: 'healthy',
        last_status_value: 'on',
      }],
      events: overrides.events || [
        {
          id: 1,
          server_id: '8564',
          old_state: 'suspect',
          new_state: 'down',
          label: '确认宕机',
          level: 'critical',
          message: '测试日志',
          created_at: 1778384953,
        },
      ],
      dailyResults: overrides.dailyResults || [
        { server_id: '8564', date_key: '2026-05-10', total: 2, ok_count: 1, avg_latency_ms: 1500 },
      ],
      recentChecks: overrides.recentChecks || [
        { ok: 1, latency_ms: 120, created_at: 1778385053 },
        { ok: 0, latency_ms: 0, created_at: 1778384753 },
      ],
      outageChecks: overrides.outageChecks || [],
    }),
  };
}

test('管理接口缺少 ZJMF_ADMIN_TOKEN 对应的 Bearer Token 时拒绝访问', async () => {
  const res = await handleRequest(new Request('https://worker.example/api/admin/overview'), env());

  assert.equal(res.status, 401);
});

test('D1 修改后的管理密码优先于部署时 ADMIN_TOKEN', async () => {
  const testEnv = env({ settings: { admin_token_hash: sha256('new-password') } });
  const oldRes = await handleRequest(new Request('https://worker.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin-password' },
  }), testEnv);
  const newRes = await handleRequest(new Request('https://worker.example/api/admin/overview', {
    headers: { authorization: 'Bearer new-password' },
  }), testEnv);

  assert.equal(oldRes.status, 401);
  assert.equal(newRes.status, 200);
});

test('管理后台可以修改登录密码', async () => {
  const testEnv = env();
  const res = await handleRequest(new Request('https://worker.example/api/admin/password', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ old_password: 'admin-password', password: 'changed-password' }),
  }), testEnv);

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.settings.admin_token_hash, sha256('changed-password'));
});

test('管理后台修改登录密码时旧密码错误会拒绝', async () => {
  const testEnv = env();
  const res = await handleRequest(new Request('https://worker.example/api/admin/password', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ old_password: 'wrong-password', password: 'changed-password' }),
  }), testEnv);

  assert.equal(res.status, 400);
  assert.equal(testEnv.DB.data.settings.admin_token_hash, undefined);
});

test('管理后台可以自动获取魔方财务产品列表', async () => {
  const testEnv = env({
    fetcher: async (url) => {
      if (String(url).includes('login_api')) return new Response(JSON.stringify({ jwt: 'jwt-1' }));
      return new Response(JSON.stringify({ data: { host: [{ id: '4075', name: '主服务器', ip: '203.0.113.10', port: 996 }] } }));
    },
  });
  const res = await handleRequest(new Request('https://worker.example/api/admin/zjmf/hosts', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ api_base_url: 'https://api.example/v1', api_account: 'acct', api_password: 'key' }),
  }), testEnv);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.hosts[0].id, '4075');
  assert.equal(data.hosts[0].name, '主服务器');
  assert.equal(data.hosts[0].ip, '203.0.113.10');
  assert.equal(data.hosts[0].tcp_host, '203.0.113.10');
  assert.equal(data.hosts[0].tcp_port, 996);
});

test('魔方财务产品列表 TCP 主机只使用接口返回的真实 IP', async () => {
  const testEnv = env({
    fetcher: async (url) => {
      if (String(url).includes('login_api')) return new Response(JSON.stringify({ jwt: 'jwt-1' }));
      return new Response(JSON.stringify({ data: { host: [
        { id: '8564', hostname: 'ser0906873439', dedicatedip: '186.244.244.31', port: 996 },
        { id: '8565', hostname: 'ser-no-ip', port: 996 },
      ] } }));
    },
  });
  const res = await handleRequest(new Request('https://worker.example/api/admin/zjmf/hosts', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ api_base_url: 'https://api.example/v1', api_account: 'acct', api_password: 'key' }),
  }), testEnv);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.hosts[0].name, 'ser0906873439');
  assert.equal(data.hosts[0].ip, '186.244.244.31');
  assert.equal(data.hosts[0].tcp_host, '186.244.244.31');
  assert.equal(data.hosts[1].name, 'ser-no-ip');
  assert.equal(data.hosts[1].ip, '');
  assert.equal(data.hosts[1].tcp_host, '');
});

test('初始化接口一次保存服务商、服务器、监控参数和通知设置', async () => {
  const testEnv = env();
  const res = await handleRequest(new Request('https://worker.example/api/admin/setup', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      provider: { name: 'heyunidc', display_name: '核云', api_base_url: 'https://api.example/v1', api_account: 'acct', api_password: 'key' },
      server: { id: '4075', name: '主服务器', provider: 'heyunidc', daily_reboot_limit: 5 },
      settings: { check_interval: 120, api_timeout_ms: 15000, reboot_limit_window: 'day' },
      notification: {
        enabled: true,
        type: 'telegram',
        notify_failure_silence: true,
        notify_token: 'bot-token',
        notify_target: '10086',
        notify_secret: 'sign-secret',
      },
    }),
  }), testEnv);

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.providerWrites[0].api_account, 'acct');
  assert.equal(testEnv.DB.data.serverWrites[0].id, 'heyunidc::4075');
  assert.equal(testEnv.DB.data.serverWrites[0].remote_id, '4075');
  assert.equal(testEnv.DB.data.serverWrites[0].check_method, 'service_then_power');
  assert.equal(testEnv.DB.data.settings.check_interval, '120');
  assert.equal(testEnv.DB.data.settings.api_timeout, '15');
  assert.equal(testEnv.DB.data.settings.reboot_limit_window, 'day');
  assert.equal(testEnv.DB.data.settings.default_daily_reboot_limit, '5');
  assert.equal(testEnv.DB.data.settings.notify_failure_silence, 'true');
  assert.equal(testEnv.DB.data.settings.webhook_type, 'telegram');
  assert.equal(testEnv.DB.data.settings.notify_token, 'bot-token');
  assert.equal(testEnv.DB.data.settings.notify_target, '10086');
  assert.equal(testEnv.DB.data.settings.notify_secret, 'sign-secret');
  assert.equal(testEnv.DB.data.settings.setup_completed, '1');
});

test('初始化接口允许跳过魔方财务和服务器导入', async () => {
  const testEnv = env();
  const res = await handleRequest(new Request('https://worker.example/api/admin/setup', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      providers: [],
      servers: [],
      settings: { check_interval: 180, api_timeout_ms: 30000 },
      notification: { enabled: false },
    }),
  }), testEnv);

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.providerWrites.length, 0);
  assert.equal(testEnv.DB.data.serverWrites.length, 0);
  assert.equal(testEnv.DB.data.settings.check_interval, '180');
  assert.equal(testEnv.DB.data.settings.api_timeout, '30');
  assert.equal(testEnv.DB.data.settings.setup_completed, '1');
});

test('初始化接口支持多个账号一次导入多个服务器', async () => {
  const testEnv = env();
  const res = await handleRequest(new Request('https://worker.example/api/admin/setup', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      providers: [
        { name: 'heyunidc_a', display_name: '核云 A', api_base_url: 'https://api.example/v1', api_account: 'a@example.test', api_password: 'key-a' },
        { name: 'heyunidc_b', display_name: '核云 B', api_base_url: 'https://api.example/v1', api_account: 'b@example.test', api_password: 'key-b' },
      ],
      servers: [
        { id: '1001', name: 'A-1', provider: 'heyunidc_a' },
        { id: '1002', name: 'A-2', provider: 'heyunidc_a' },
        { id: '2001', name: 'B-1', provider: 'heyunidc_b' },
      ],
      settings: { check_interval: 300, api_timeout_ms: 60000 },
    }),
  }), testEnv);

  assert.equal(res.status, 200);
  assert.deepEqual(testEnv.DB.data.providerWrites.map((provider) => provider.name), ['heyunidc_a', 'heyunidc_b']);
  assert.deepEqual(testEnv.DB.data.serverWrites.map((server) => server.id), ['heyunidc_a::1001', 'heyunidc_a::1002', 'heyunidc_b::2001']);
  assert.deepEqual(testEnv.DB.data.serverWrites.map((server) => server.remote_id), ['1001', '1002', '2001']);
  assert.deepEqual(testEnv.DB.data.serverWrites.map((server) => server.provider), ['heyunidc_a', 'heyunidc_a', 'heyunidc_b']);
  assert.equal(testEnv.DB.data.settings.setup_completed, '1');
});

test('不同魔方财务 IDC 的相同产品 ID 会保存为独立监控项', async () => {
  const testEnv = env();
  const res = await handleRequest(new Request('https://worker.example/api/admin/setup', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      providers: [
        { name: 'heyun', display_name: '核云', api_base_url: 'https://www.heyunidc.cn/v1/', api_account: 'a', api_password: 'key-a' },
        { name: 'moyun', display_name: '魔云', api_base_url: 'https://api.moyun.example/v1', api_account: 'b', api_password: 'key-b' },
      ],
      servers: [
        { id: '1001', name: '核云服务器', provider: 'heyun' },
        { id: '1001', name: '魔云服务器', provider: 'moyun' },
      ],
      settings: {},
    }),
  }), testEnv);

  assert.equal(res.status, 200);
  assert.deepEqual(testEnv.DB.data.serverWrites.map(({ id, remote_id, provider }) => ({ id, remote_id, provider })), [
    { id: 'heyun::1001', remote_id: '1001', provider: 'heyun' },
    { id: 'moyun::1001', remote_id: '1001', provider: 'moyun' },
  ]);
  assert.equal(testEnv.DB.data.providerWrites[0].api_base_url, 'https://www.heyunidc.cn/v1');
});

test('初始化接口复用迁移前同一 IDC 的旧服务器 ID', async () => {
  const testEnv = env({
    providers: [
      { name: 'heyun', display_name: '核云', api_base_url: 'https://www.heyunidc.cn/v1', api_account: 'a', api_password: 'key-a' },
    ],
    servers: [
      { id: '1001', remote_id: '1001', name: '旧监控项', provider: 'heyun', enabled: 1 },
    ],
  });
  const res = await handleRequest(new Request('https://worker.example/api/admin/setup', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      providers: [
        { name: 'heyun', display_name: '核云', api_base_url: 'https://www.heyunidc.cn/v1', api_account: 'a', api_password: 'key-a' },
      ],
      servers: [
        { remote_id: '1001', name: '更新后的监控项', provider: 'heyun' },
      ],
      settings: {},
    }),
  }), testEnv);

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.serverWrites[0].id, '1001');
  assert.equal(testEnv.DB.data.serverWrites[0].remote_id, '1001');
});

test('初始化接口缺少必填项时返回具体缺失字段', async () => {
  const res = await handleRequest(new Request('https://worker.example/api/admin/setup', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      provider: { name: 'heyunidc', api_base_url: 'https://api.example/v1' },
      server: { name: '主服务器' },
    }),
  }), env());
  const data = await res.json();

  assert.equal(res.status, 400);
  assert.equal(data.error, 'INVALID_SETUP');
  assert.equal(data.message, '初始化信息不完整');
  assert.deepEqual(data.missing, ['provider.api_account', 'provider.api_password', 'server.remote_id']);
});

test('管理概览返回配置并仅隐藏 pushplus token 和服务器 IP', async () => {
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/overview', {
      headers: { authorization: 'Bearer admin-password' },
    }),
    env(),
  );
  const text = await res.text();
  const data = JSON.parse(text);

  assert.equal(res.status, 200);
  assert.equal(data.settings.pushplus_token, '已配置');
  assert.equal(data.settings.notify_token, '已配置');
  assert.equal(data.settings.notify_secret, '');
  assert.equal(data.settings.webhook_name, 'pushplus');
  assert.equal(data.providers[0].api_password, 'provider-secret');
  assert.doesNotMatch(text, /pushplus-secret|203\.0\.113\.10/);
});

test('管理概览返回数据保留和后台分析默认范围配置', async () => {
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/overview', {
      headers: { authorization: 'Bearer admin-password' },
    }),
    env({
      settings: {
        data_retention_days: '45',
        admin_overview_range: '7d',
        admin_monitor_range: '30d',
      },
    }),
  );
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.settings.data_retention_days, 45);
  assert.equal(data.settings.admin_overview_range, '7d');
  assert.equal(data.settings.admin_monitor_range, '30d');
});

test('管理概览返回站点品牌和状态切换默认值配置', async () => {
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/overview', {
      headers: { authorization: 'Bearer admin-password' },
    }),
    env({
      settings: {
        site_title: '核云状态页',
        site_description: '自定义状态页描述',
        timezone: 'UTC',
        suspect_threshold: '4',
        recover_success_threshold: '2',
      },
    }),
  );
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.settings.site_title, '核云状态页');
  assert.equal(data.settings.site_description, '自定义状态页描述');
  assert.equal(data.settings.timezone, 'UTC');
  assert.equal(data.settings.suspect_threshold, 4);
  assert.equal(data.settings.recover_success_threshold, 2);
});

test('管理概览优先返回启用服务器，避免表单默认选中旧禁用记录', async () => {
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/overview', {
      headers: { authorization: 'Bearer admin-password' },
    }),
    env({
      servers: [
        { id: '4075', name: '旧服务器', provider: 'heyunidc', enabled: 0 },
        { id: '8564', name: '主服务器', provider: 'heyunidc', enabled: 1 },
      ],
    }),
  );
  const data = await res.json();

  assert.equal(data.servers[0].id, '8564');
  assert.equal(data.servers[0].enabled, true);
});

test('公共状态接口不返回服务器 IP', async () => {
  const res = await handleRequest(new Request('https://worker.example/api/status'), env());
  const text = await res.text();
  const data = JSON.parse(text);

  assert.equal(res.status, 200);
  assert.equal(data.servers[0].name, '服务器 #8564');
  assert.equal(data.servers[0].ip, undefined);
  assert.equal(data.servers[0].http_url, undefined);
  assert.equal(data.servers[0].tcp_host, undefined);
  assert.doesNotMatch(text, /203\.0\.113\.10/);
});

test('公共状态接口隐藏不在状态页显示的服务器', async () => {
  const res = await handleRequest(new Request('https://worker.example/api/status'), env({
    servers: [
      { id: '8564', name: '主服务器', ip: '203.0.113.10', provider: 'heyunidc', enabled: 1, visible_on_status: 0 },
    ],
    status: [{
      id: '8564',
      name: '203.0.113.10',
      ip: '203.0.113.10',
      http_url: 'https://203.0.113.10/health',
      tcp_host: '203.0.113.10',
      tcp_port: 443,
      state: 'healthy',
      last_status_value: 'on',
      visible_on_status: 0,
    }],
  }));
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.servers.length, 0);
});

test('未完成初始化时根路径直接显示首次配置向导', async () => {
  const res = await handleRequest(new Request('https://worker.example/'), env());
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(text, /首次打开网站/);
  assert.match(text, /开始初始化监控系统/);
  assert.match(text, /确定进入/);
  assert.match(text, /ZJMF_ADMIN_TOKEN/);
});

test('未完成初始化时 /admin 也先显示首次确认弹窗', async () => {
  const res = await handleRequest(new Request('https://worker.example/admin'), env());
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(text, /开始初始化监控系统/);
  assert.match(text, /取消/);
  assert.match(text, /确定进入/);
});

test('公共状态接口返回真实天级可用性和事件历史且不泄露地址', async () => {
  const res = await handleRequest(new Request('https://worker.example/api/status'), env({
    events: [
      {
        id: 2,
        server_id: '8564',
        old_state: 'down',
        new_state: 'rebooting',
        label: '触发重启',
        level: 'critical',
        message: '203.0.113.10 已触发重启',
        created_at: 1778385053,
      },
    ],
    dailyResults: [
      { server_id: '8564', date_key: '2026-05-10', total: 3, ok_count: 2, avg_latency_ms: 1200 },
      { server_id: '8564', date_key: '2026-05-11', total: 1, ok_count: 1, avg_latency_ms: 900 },
    ],
    outageChecks: [
      { server_id: '8564', created_at: 1778384753, next_ok: 1, next_created_at: 1778385053 },
    ],
  }));
  const text = await res.text();
  const data = JSON.parse(text);

  assert.equal(res.status, 200);
  assert.equal(data.servers[0].daily_history.length, 2);
  assert.equal(data.servers[0].daily_history[0].uptime, '66.667%');
  assert.equal(data.servers[0].daily_history[0].failures, 1);
  assert.equal(data.servers[0].daily_history[0].outages.length, 1);
  assert.equal(data.servers[0].daily_history[0].outages[0].start_at, 1778384753);
  assert.equal(data.servers[0].daily_history[0].outages[0].end_at, 1778385053);
  assert.equal(data.servers[0].recent_checks.length, 2);
  assert.equal(data.servers[0].recent_checks[0].latency_ms, 120);
  assert.equal(data.servers[0].events[0].label, '触发重启');
  assert.doesNotMatch(text, /203\.0\.113\.10|api\.example|provider-secret|pushplus-secret/);
});

test('管理后台保存脱敏服务器时保留原 IP', async () => {
  const testEnv = env();
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/servers', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-password',
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ id: '8564', name: '主服务器', provider: 'heyunidc', enabled: false }),
    }),
    testEnv,
  );

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.serverWrites[0].ip, '203.0.113.10');
});

test('管理后台保存服务器时清空旧定时重启配置', async () => {
  const testEnv = env();
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/servers', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-password',
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        id: '8564',
        name: '主服务器',
        provider: 'heyunidc',
        enabled: true,
        check_method: 'http',
        http_url: 'https://example.test/health',
        tcp_port: 443,
        scheduled_reboot: '04:00',
      }),
    }),
    testEnv,
  );

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.serverWrites[0].scheduled_reboot, '');
  assert.equal(testEnv.DB.data.serverWrites[0].check_method, 'http');
  assert.equal(testEnv.DB.data.serverWrites[0].http_url, 'https://example.test/health');
  assert.equal(testEnv.DB.data.serverWrites[0].tcp_port, 443);
});

test('管理后台保存服务器时会写入 visible_on_status', async () => {
  const testEnv = env();
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/servers', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-password',
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        id: '8564',
        name: '主服务器',
        provider: 'heyunidc',
        visible_on_status: false,
      }),
    }),
    testEnv,
  );

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.serverWrites[0].visible_on_status, 0);
});

test('管理后台编辑服务器时不传重启次数上限会保留旧值', async () => {
  const testEnv = env({
    servers: [
      { id: '8564', name: '主服务器', ip: '203.0.113.10', provider: 'heyunidc', enabled: 1, daily_reboot_limit: 7 },
    ],
  });
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/servers', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-password',
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        id: '8564',
        name: '主服务器',
        provider: 'heyunidc',
      }),
    }),
    testEnv,
  );

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.serverWrites[0].daily_reboot_limit, 7);
});

test('管理后台删除监控项会删除配置和运行状态并写入日志', async () => {
  const testEnv = env();
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/servers/8564', {
      method: 'DELETE',
      headers: { authorization: 'Bearer admin-password' },
    }),
    testEnv,
  );

  assert.equal(res.status, 200);
  assert.deepEqual(testEnv.DB.data.deletedRuntimes, ['8564']);
  assert.deepEqual(testEnv.DB.data.deletedServers, ['8564']);
  assert.equal(testEnv.DB.data.eventWrites[0].label, '删除监控项');
  assert.doesNotMatch(testEnv.DB.data.eventWrites[0].message, /203\.0\.113\.10/);
});

test('管理日志接口返回最近事件且不泄露服务器 IP', async () => {
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/events', {
      headers: { authorization: 'Bearer admin-password' },
    }),
    env(),
  );
  const text = await res.text();
  const data = JSON.parse(text);

  assert.equal(res.status, 200);
  assert.equal(data.events[0].server_id, '8564');
  assert.match(data.events[0].message, /测试日志/);
  assert.doesNotMatch(text, /203\.0\.113\.10|provider-secret|pushplus-secret/);
});

test('管理概览附带最近事件，后台无需额外首屏请求日志', async () => {
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/overview', {
      headers: { authorization: 'Bearer admin-password' },
    }),
    env(),
  );
  const data = await res.json();

  assert.equal(data.events[0].label, '确认宕机');
});

test('管理后台可以创建分组并在概览返回', async () => {
  const testEnv = env();
  const createRes = await handleRequest(new Request('https://worker.example/api/admin/groups', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name: '生产环境' }),
  }), testEnv);
  const created = await createRes.json();
  const overviewRes = await handleRequest(new Request('https://worker.example/api/admin/overview', {
    headers: { authorization: 'Bearer admin-password' },
  }), testEnv);
  const overview = await overviewRes.json();

  assert.equal(createRes.status, 200);
  assert.equal(created.group.name, '生产环境');
  assert.deepEqual(overview.groups.map(({ id, name, sort_order }) => ({ id, name, sort_order })), [
    { id: created.group.id, name: '生产环境', sort_order: 0 },
  ]);
});

test('管理后台可以把多个监控项批量移动到目标分组', async () => {
  const testEnv = env({
    groups: [{ id: 'group-prod', name: '生产环境', sort_order: 0 }],
    servers: [
      { id: '8564', name: '主服务器', provider: 'heyunidc', enabled: 1, group_id: '', sort_order: 0 },
      { id: '8565', name: '备用服务器', provider: 'heyunidc', enabled: 1, group_id: '', sort_order: 1 },
    ],
  });
  const res = await handleRequest(new Request('https://worker.example/api/admin/servers/batch-group', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ server_ids: ['8564', '8565'], group_id: 'group-prod', sort_order: 5 }),
  }), testEnv);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.updated, 2);
  assert.deepEqual(testEnv.DB.data.servers.map(({ group_id, sort_order }) => ({ group_id, sort_order })), [
    { group_id: 'group-prod', sort_order: 5 },
    { group_id: 'group-prod', sort_order: 6 },
  ]);
});

test('删除分组只会把监控项移到未分组', async () => {
  const testEnv = env({
    groups: [{ id: 'group-prod', name: '生产环境', sort_order: 0 }],
    servers: [{ id: '8564', name: '主服务器', provider: 'heyunidc', enabled: 1, group_id: 'group-prod', sort_order: 8 }],
  });
  const res = await handleRequest(new Request('https://worker.example/api/admin/groups/group-prod', {
    method: 'DELETE',
    headers: { authorization: 'Bearer admin-password' },
  }), testEnv);

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.groups.length, 0);
  assert.equal(testEnv.DB.data.servers[0].group_id, '');
  assert.equal(testEnv.DB.data.servers[0].sort_order, 0);
});

test('管理后台可以保存分组显示顺序', async () => {
  const testEnv = env({
    groups: [
      { id: 'group-a', name: 'A', sort_order: 0 },
      { id: 'group-b', name: 'B', sort_order: 1 },
    ],
  });
  const res = await handleRequest(new Request('https://worker.example/api/admin/groups/reorder', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ group_ids: ['group-b', 'group-a'] }),
  }), testEnv);

  assert.equal(res.status, 200);
  assert.deepEqual(testEnv.DB.data.groups.map(({ id, sort_order }) => ({ id, sort_order })), [
    { id: 'group-a', sort_order: 1 },
    { id: 'group-b', sort_order: 0 },
  ]);
});

test('已有服务商保存时允许 API 密钥留空并保留旧密钥', async () => {
  const testEnv = env();
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/providers', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-password',
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        name: 'heyunidc',
        display_name: '核云',
        api_base_url: 'https://api.example/v1',
        api_account: 'new-account@example.test',
      }),
    }),
    testEnv,
  );

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.providerWrites[0].api_password, 'provider-secret');
});

test('重走初始教程会清空现有数据但保留管理密码', async () => {
  const testEnv = env({ settings: { admin_token_hash: sha256('changed-password') } });
  const res = await handleRequest(new Request('https://worker.example/api/admin/setup/reset', {
    method: 'POST',
    headers: { authorization: 'Bearer changed-password' },
  }), testEnv);

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.providers.length, 0);
  assert.equal(testEnv.DB.data.servers.length, 0);
  assert.equal(testEnv.DB.data.events.length, 0);
  assert.equal(testEnv.DB.data.dailyResults.length, 0);
  assert.equal(testEnv.DB.data.recentChecks.length, 0);
  assert.equal(testEnv.DB.data.settings.admin_token_hash, sha256('changed-password'));
  assert.equal(testEnv.DB.data.settings.setup_completed, undefined);
});

test('保存服务器时会回退到现有服务商，避免 PROVIDER_NOT_FOUND', async () => {
  const testEnv = env({
    providers: [
      {
        name: 'heyunidc_186_244_244_31',
        display_name: '核云 2',
        api_base_url: 'https://api.example/v1',
        api_account: 'account2@example.test',
        api_password: 'provider-secret-2',
      },
    ],
    servers: [{ id: '8564', name: '主服务器', ip: '203.0.113.10', provider: 'heyunidc_186_244_244_31', enabled: 1 }],
  });
  const res = await handleRequest(
    new Request('https://worker.example/api/admin/servers', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-password',
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        id: '8564',
        name: '主服务器',
        provider: 'heyunidc',
        enabled: true,
        check_method: 'http',
        http_url: 'https://example.test/health',
      }),
    }),
    testEnv,
  );

  assert.equal(res.status, 200);
  assert.equal(testEnv.DB.data.serverWrites[0].provider, 'heyunidc_186_244_244_31');
});

test('多个 IDC 时无效服务商不会回退到第一条', async () => {
  const testEnv = env({
    providers: [
      { name: 'heyun', display_name: '核云', api_base_url: 'https://www.heyunidc.cn/v1', api_account: 'a', api_password: 'key-a' },
      { name: 'other', display_name: '其他 IDC', api_base_url: 'https://idc.example/v1', api_account: 'b', api_password: 'key-b' },
    ],
    servers: [],
  });
  const res = await handleRequest(new Request('https://worker.example/api/admin/servers', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-password',
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ remote_id: '1001', name: '测试服务器', provider: 'missing' }),
  }), testEnv);
  const data = await res.json();

  assert.equal(res.status, 400);
  assert.equal(data.error, 'PROVIDER_NOT_FOUND');
  assert.equal(testEnv.DB.data.serverWrites.length, 0);
});

test('系统更新检查会读取 GitHub 最新提交并返回更新状态', async () => {
  const calls = [];
  const testEnv = env({
    APP_VERSION: '1111111111111111111111111111111111111111',
    fetcher: async (input, init = {}) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({
        sha: '2222222222222222222222222222222222222222',
        commit: { message: 'feat: 更新页面' },
      }));
    },
  });
  const res = await handleRequest(new Request('https://worker.example/api/admin/update/check', {
    headers: { authorization: 'Bearer admin-password' },
  }), testEnv);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.configured, true);
  assert.equal(data.update_available, true);
  assert.equal(data.current_sha, '1111111111111111111111111111111111111111');
  assert.equal(data.latest_sha, '2222222222222222222222222222222222222222');
  assert.match(calls[0].input, /api\.github\.com\/repos\/loqwe\/heyun-zjmf-worker-monitor\/commits\/main/);
});

test('系统更新检查失败时返回 GitHub API 的具体原因', async () => {
  const testEnv = env({
    fetcher: async () => new Response(JSON.stringify({
      message: 'Not Found',
      documentation_url: 'https://docs.github.com/rest/commits/commits#get-a-commit',
    }), { status: 404 }),
  });
  const res = await handleRequest(new Request('https://worker.example/api/admin/update/check', {
    headers: { authorization: 'Bearer admin-password' },
  }), testEnv);
  const data = await res.json();

  assert.equal(res.status, 502);
  assert.equal(data.error, 'GITHUB_CHECK_FAILED');
  assert.equal(data.status, 404);
  assert.equal(data.github_message, 'Not Found');
  assert.equal(data.documentation_url, 'https://docs.github.com/rest/commits/commits#get-a-commit');
  assert.equal(data.repo, 'loqwe/heyun-zjmf-worker-monitor');
  assert.equal(data.branch, 'main');
});

test('系统更新确认会触发 GitHub Actions workflow_dispatch', async () => {
  const calls = [];
  const testEnv = env({
    GITHUB_TOKEN: 'ghp-test-token',
    fetcher: async (input, init = {}) => {
      calls.push({ input: String(input), init });
      return new Response(null, { status: 204 });
    },
  });
  const res = await handleRequest(new Request('https://worker.example/api/admin/update/dispatch', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-password' },
  }), testEnv);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.match(calls[0].input, /api\.github\.com\/repos\/loqwe\/heyun-zjmf-worker-monitor\/actions\/workflows\/deploy\.yml\/dispatches/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main' });
  assert.match(String(calls[0].init.headers.authorization), /Bearer ghp-test-token/);
});
