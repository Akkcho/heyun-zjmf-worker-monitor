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
