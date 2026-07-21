import assert from 'node:assert/strict';
import test from 'node:test';

import { KVRepository } from '../src/kv-repository.js';

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

test('KVRepository 保存服务商、服务器和设置', async () => {
  const repo = new KVRepository(new MemoryKV());
  await repo.setSetting('setup_completed', '1');
  await repo.upsertProvider({
    name: 'heyunidc',
    display_name: '核云',
    api_base_url: 'https://api.example/v1',
    api_account: 'account',
    api_password: 'secret',
  }, 100);
  await repo.upsertServer({
    id: '1001',
    name: '测试服务器',
    provider: 'heyunidc',
    check_method: 'api_only',
    enabled: true,
  }, 100);

  assert.equal(await repo.getSetting('setup_completed'), '1');
  assert.equal((await repo.listProviders())[0].name, 'heyunidc');
  assert.equal((await repo.listEnabledServers())[0].id, '1001');
});

test('KVRepository 生成状态页所需历史和事件', async () => {
  const repo = new KVRepository(new MemoryKV());
  await repo.addCheckResult({ server_id: '1001', ok: false, latency_ms: 0, created_at: 1700000000 });
  await repo.addCheckResult({ server_id: '1001', ok: false, latency_ms: 0, created_at: 1700000300 });
  await repo.addCheckResult({ server_id: '1001', ok: true, latency_ms: 23, created_at: 1700000600 });
  await repo.addEvent({ server_id: '1001', old_state: 'healthy', new_state: 'suspect', label: '检测异常', level: 'warning', message: '异常', created_at: 1700000000 });

  const recent = await repo.listRecentChecks('1001');
  const daily = await repo.listDailyHistory(['1001'], 30, 1700000300);
  const events = await repo.listPublicEvents(['1001']);

  assert.equal(recent[0].ok, true);
  assert.equal(daily.get('1001')[0].checks, 3);
  assert.deepEqual(daily.get('1001')[0].outages, [
    { start_at: 1700000000, end_at: 1700000600, duration_seconds: 600 },
  ]);
  assert.equal(events.get('1001')[0].label, '检测异常');
});

test('KVRepository 兼容没有分组字段的旧数据', async () => {
  const kv = new MemoryKV();
  await kv.put('zjmf_monitor_state', JSON.stringify({
    servers: [{ id: '1001', name: '旧服务器', provider: 'heyunidc' }],
  }));
  const repo = new KVRepository(kv);

  assert.deepEqual(await repo.listGroups(), []);
  assert.equal((await repo.listServers())[0].group_id, '');
  assert.equal((await repo.listServers())[0].sort_order, 0);
});

test('KVRepository 保存分组、批量移动和分组顺序', async () => {
  const repo = new KVRepository(new MemoryKV());
  await repo.upsertServer({ id: '1001', name: '服务器 1', provider: 'heyunidc' }, 100);
  await repo.upsertServer({ id: '1002', name: '服务器 2', provider: 'heyunidc' }, 100);
  await repo.upsertGroup({ id: 'group-a', name: 'A', sort_order: 0 }, 100);
  await repo.upsertGroup({ id: 'group-b', name: 'B', sort_order: 1 }, 100);
  await repo.assignServersToGroup(['1001', '1002'], 'group-b', 4, 101);
  await repo.reorderGroups(['group-b', 'group-a'], 102);

  assert.deepEqual((await repo.listServers()).map(({ group_id, sort_order }) => ({ group_id, sort_order })), [
    { group_id: 'group-b', sort_order: 4 },
    { group_id: 'group-b', sort_order: 5 },
  ]);
  assert.deepEqual((await repo.listGroups()).map(({ id, sort_order }) => ({ id, sort_order })), [
    { id: 'group-b', sort_order: 0 },
    { id: 'group-a', sort_order: 1 },
  ]);
});
