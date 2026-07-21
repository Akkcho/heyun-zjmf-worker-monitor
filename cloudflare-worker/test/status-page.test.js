import assert from 'node:assert/strict';
import test from 'node:test';

import { renderStatusPage } from '../src/status-page.js';

test('状态页按近 30 天真实探测次数计算可用率', () => {
  const dailyHistory = [
    { date: '2026-06-30', checks: 1, failures: 1 },
    ...Array.from({ length: 28 }, (_, index) => ({
      date: `2026-07-${String(index + 1).padStart(2, '0')}`,
      checks: 0,
      failures: 0,
    })),
    { date: '2026-07-29', checks: 12, failures: 0 },
    { date: '2026-07-30', checks: 12, failures: 1 },
  ];
  const html = renderStatusPage([{ id: '8564', name: '主服务器', state: 'healthy', daily_history: dailyHistory }]);

  assert.match(html, /<span class="uptime">● 95\.833%<\/span>/);
  assert.doesNotMatch(html, /<span class="uptime">● 100\.000%<\/span>/);
});

test('状态页没有真实探测记录时不显示虚假的可用率', () => {
  const html = renderStatusPage([{ id: '8564', name: '主服务器', state: 'healthy' }]);

  assert.match(html, /<span class="uptime">● --<\/span>/);
});

test('状态页渲染服务器状态并转义 HTML', () => {
  const html = renderStatusPage([
    {
      id: '8564',
      name: '<script>alert(1)</script>',
      provider: 'heyunidc',
      state: 'healthy',
      last_status_value: 'on',
      last_check_time: 1778384953,
      last_reboot_time: 0,
      reboot_count_today: 0,
      check_method: 'tcp',
      daily_history: [
        { date: '2026/5/9', uptime: '100.000%', checks: 12, failures: 0, downtime_seconds: 0 },
        { date: '2026/5/10', uptime: '91.667%', checks: 12, failures: 1, downtime_seconds: 300 },
      ],
      events: [
        { label: '检测异常', level: 'warning', message: '服务不可达', created_at: 1778384953 },
        { label: '重启指令已发送', level: 'warning', message: '已发送硬重启', created_at: 1778385053 },
        { label: '旧事件', level: 'info', message: '应被截断', created_at: 1778384853 },
      ],
    },
  ]);

  assert.match(html, /ZJMF 服务器监控/);
  assert.match(html, /服务器自动监控/);
  assert.doesNotMatch(html, /核云服务器<br>自动监控/);
  assert.match(html, /--bg:#f6f8fb/);
  assert.match(html, /服务/);
  assert.match(html, /未分组/);
  assert.match(html, /status-card/);
  assert.match(html, /近 30 天可用性/);
  assert.match(html, /最近 60 次探测/);
  assert.match(html, /class="day-track"/);
  assert.match(html, /aria-label="近 30 天可用性"/);
  assert.equal((html.match(/class="day-segment/g) || []).length, 30);
  assert.equal((html.match(/class="day-segment placeholder"/g) || []).length, 28);
  assert.doesNotMatch(html, /class="day-segment empty"/);
  assert.match(html, /100\.000% 可用率/);
  assert.match(html, /不可用时长 0s/);
  assert.match(html, /探测 12 次，失败 1 次/);
  assert.match(html, /box-shadow:0 0 0 2px #fff/);
  assert.match(html, /translateY\(-7px\)/);
  assert.doesNotMatch(html, /active/);
  assert.match(html, /事件历史/);
  assert.match(html, /查看更多/);
  assert.match(html, /history-card/);
  assert.equal((html.match(/class="timeline-item/g) || []).length, 2);
  assert.match(html, /检测异常/);
  assert.match(html, /重启指令已发送/);
  assert.doesNotMatch(html, /旧事件/);
  assert.match(html, /data-tip=/);
  assert.match(html, /aria-label="最近探测详情"/);
  assert.match(html, /tcp/);
  assert.match(html, /管理面板/);
  assert.match(html, /href="\/admin"/);
  assert.match(html, /运行正常/);
  assert.match(html, /24 小时重启/);
  assert.doesNotMatch(html, /本小时重启|今日重启/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('状态页不显示服务器 IP，名称为 IP 时改用泛化名称', () => {
  const html = renderStatusPage([
    {
      id: '8564',
      name: '203.0.113.10',
      ip: '203.0.113.10',
      provider: 'heyunidc',
      state: 'healthy',
      last_status_value: 'on',
      last_check_time: 1778384953,
      last_reboot_time: 0,
      reboot_count_today: 0,
    },
  ]);

  assert.match(html, /服务器 #8564/);
  assert.doesNotMatch(html, /203\.0\.113\.10/);
});

test('状态页使用站点品牌设置渲染标题和描述', () => {
  const html = renderStatusPage([], {
    site_title: '核云状态页',
    site_description: '自定义状态页描述',
  });

  assert.match(html, /<title>核云状态页<\/title>/);
  assert.match(html, /<h1>核云状态页<\/h1>/);
  assert.match(html, /自定义状态页描述/);
  assert.doesNotMatch(html, /服务器自动监控/);
});

test('状态页最近探测条使用真实探测时间和延迟', () => {
  const t1 = new Date(1778385053 * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const t2 = new Date(1778384753 * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const html = renderStatusPage([
    {
      id: '8564',
      name: '主服务器',
      state: 'healthy',
      last_check_time: 1778385053,
      last_latency_ms: 9819,
      recent_checks: [
        { ok: true, latency_ms: 120, created_at: 1778385053 },
        { ok: false, latency_ms: 0, created_at: 1778384753 },
      ],
    },
  ]);

  assert.match(html, new RegExp(t1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, new RegExp(t2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /运行正常 · 120ms/);
  assert.match(html, /探测失败 · -/);
  assert.equal((html.match(/class="probe-placeholder"/g) || []).length, 58);
  assert.doesNotMatch(html, /运行正常 · 9819ms/);
});

test('点击每日竖条会打开真实故障明细弹窗', () => {
  const html = renderStatusPage([
    {
      id: '8564',
      name: '主服务器',
      state: 'healthy',
      daily_history: [
        {
          date: '2026-07-17',
          uptime: '95.417%',
          checks: 288,
          failures: 13,
          downtime_seconds: 3960,
          outages: [{ start_at: 1784247780, end_at: 1784251740, duration_seconds: 3960 }],
        },
        {
          date: '2026-07-20',
          uptime: '100.000%',
          checks: 288,
          failures: 0,
          downtime_seconds: 0,
          outages: [],
        },
      ],
    },
  ]);
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /id="outageModal"/);
  assert.match(html, /故障明细/);
  assert.match(html, /data-outages=/);
  assert.match(html, /data-date="2026-07-17"/);
  assert.match(html, /data-date="2026-07-20"/);
  assert.match(html, /function openOutageModal/);
  assert.match(html, /当天没有记录到故障。/);
  assert.match(html, /outage-row/);
  assert.match(html, /Escape/);
});
