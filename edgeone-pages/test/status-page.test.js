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

test('状态页按真实分组和监控排序展示服务器', () => {
  const html = renderStatusPage([
    { id: 'b-2', name: 'B 服务器', state: 'healthy', group_id: 'group-b', group_name: '备用环境', group_sort_order: 1, sort_order: 2 },
    { id: 'a-2', name: '生产 2', state: 'healthy', group_id: 'group-a', group_name: '生产环境', group_sort_order: 0, sort_order: 2 },
    { id: 'none', name: '未分组服务器', state: 'healthy', group_id: '', group_name: '', sort_order: 0 },
    { id: 'a-1', name: '生产 1', state: 'healthy', group_id: 'group-a', group_name: '生产环境', group_sort_order: 0, sort_order: 1 },
  ]);

  const production = html.indexOf('<h2 class="group-title">生产环境</h2>');
  const production1 = html.indexOf('<h3>生产 1</h3>');
  const production2 = html.indexOf('<h3>生产 2</h3>');
  const backup = html.indexOf('<h2 class="group-title">备用环境</h2>');
  const ungrouped = html.indexOf('<h2 class="group-title">未分组</h2>');

  assert.ok(production >= 0 && production < production1);
  assert.ok(production1 < production2);
  assert.ok(production2 < backup);
  assert.ok(backup < ungrouped);
});
