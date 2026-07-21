import { DEFAULT_SETTINGS } from './constants.js';
import { createRuntime } from './state-machine.js';

const STATE_KEY = 'zjmf_monitor_state';

function numberSetting(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolSetting(value, fallback) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function percent(ok, total) {
  const count = Number(total || 0);
  if (count <= 0) return '0.000%';
  return `${((Number(ok || 0) / count) * 100).toFixed(3)}%`;
}

const HISTORY_TIMEZONE_OFFSET = 8 * 60 * 60;

function checkOk(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function historyDate(timestamp) {
  return new Date((Number(timestamp || 0) + HISTORY_TIMEZONE_OFFSET) * 1000).toISOString().slice(0, 10);
}

function appendOutage(grouped, serverId, startAt, endAt) {
  let cursor = Number(startAt || 0);
  const end = Number(endAt || 0);
  while (cursor < end) {
    const date = historyDate(cursor);
    const dayStart = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) - HISTORY_TIMEZONE_OFFSET;
    const pieceEnd = Math.min(end, dayStart + 24 * 60 * 60);
    const serverDays = grouped.get(serverId) || new Map();
    const outages = serverDays.get(date) || [];
    outages.push({ start_at: cursor, end_at: pieceEnd, duration_seconds: pieceEnd - cursor });
    serverDays.set(date, outages);
    grouped.set(serverId, serverDays);
    cursor = pieceEnd;
  }
}

function dailyOutages(rows, intervalSeconds) {
  const interval = Math.max(1, Number(intervalSeconds || 300));
  const maxGap = interval * 2;
  const grouped = new Map();
  let active = null;

  const commit = () => {
    if (!active) return;
    appendOutage(grouped, active.server_id, active.start_at, active.end_at);
    active = null;
  };

  for (const row of rows || []) {
    const serverId = String(row.server_id);
    const startAt = Number(row.created_at || 0);
    const nextAt = Number(row.next_created_at || 0);
    const gap = nextAt - startAt;
    const hasNearbyNext = gap > 0 && gap <= maxGap;
    const endAt = hasNearbyNext ? nextAt : startAt + interval;
    const nextIsFailure = !checkOk(row.next_ok) && row.next_ok != null;

    if (active && (active.server_id !== serverId || startAt > active.end_at + 1)) commit();
    if (!active) active = { server_id: serverId, start_at: startAt, end_at: endAt };
    else active.end_at = Math.max(active.end_at, endAt);
    if (!hasNearbyNext || !nextIsFailure) commit();
  }
  commit();
  return grouped;
}

function defaultState() {
  return {
    settings: {},
    providers: [],
    groups: [],
    servers: [],
    runtimes: {},
    events: [],
    check_results: [],
    next_event_id: 1,
    next_check_id: 1,
  };
}

function normalizeState(raw) {
  const state = { ...defaultState(), ...(raw && typeof raw === 'object' ? raw : {}) };
  state.groups = (Array.isArray(state.groups) ? state.groups : []).map((group) => ({
    ...group,
    sort_order: numberSetting(group.sort_order, 0),
  }));
  state.servers = (Array.isArray(state.servers) ? state.servers : []).map((server) => ({
    ...server,
    remote_id: server.remote_id || server.id,
    group_id: server.group_id || '',
    sort_order: numberSetting(server.sort_order, 0),
  }));
  return state;
}

async function kvGetJson(kv, key) {
  const value = await kv.get(key);
  if (!value) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function kvPutJson(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

export class KVRepository {
  constructor(kv) {
    if (!kv?.get || !kv?.put) throw new Error('EdgeOne KV 未绑定，请配置 ZJMF_KV 或 KV 环境变量');
    this.kv = kv;
  }

  async readState() {
    return normalizeState(await kvGetJson(this.kv, STATE_KEY));
  }

  async writeState(state) {
    await kvPutJson(this.kv, STATE_KEY, normalizeState(state));
  }

  async updateState(mutator) {
    const state = await this.readState();
    const result = await mutator(state);
    await this.writeState(state);
    return result;
  }

  settingsWithDefaults(raw = {}) {
    return {
      check_interval: numberSetting(raw.check_interval, DEFAULT_SETTINGS.check_interval),
      suspect_threshold: numberSetting(raw.suspect_threshold, DEFAULT_SETTINGS.suspect_threshold),
      reboot_cooldown: numberSetting(raw.reboot_cooldown, DEFAULT_SETTINGS.reboot_cooldown),
      recover_timeout: numberSetting(raw.recover_timeout, DEFAULT_SETTINGS.recover_timeout),
      recover_check_interval: numberSetting(raw.recover_check_interval, DEFAULT_SETTINGS.recover_check_interval),
      api_timeout: numberSetting(raw.api_timeout, DEFAULT_SETTINGS.api_timeout),
      default_daily_reboot_limit: numberSetting(raw.default_daily_reboot_limit, DEFAULT_SETTINGS.default_daily_reboot_limit),
      reboot_limit_window: raw.reboot_limit_window || DEFAULT_SETTINGS.reboot_limit_window,
      data_retention_days: numberSetting(raw.data_retention_days, DEFAULT_SETTINGS.data_retention_days),
      recover_success_threshold: numberSetting(raw.recover_success_threshold, DEFAULT_SETTINGS.recover_success_threshold),
      admin_overview_range: raw.admin_overview_range || DEFAULT_SETTINGS.admin_overview_range,
      admin_monitor_range: raw.admin_monitor_range || DEFAULT_SETTINGS.admin_monitor_range,
      site_title: raw.site_title || DEFAULT_SETTINGS.site_title,
      site_description: raw.site_description || DEFAULT_SETTINGS.site_description,
      webhook_name: raw.webhook_name || DEFAULT_SETTINGS.webhook_name,
      webhook_url: raw.webhook_url || '',
      webhook_type: raw.webhook_type || 'custom',
      webhook_timeout: numberSetting(raw.webhook_timeout, DEFAULT_SETTINGS.webhook_timeout),
      webhook_headers: raw.webhook_headers || DEFAULT_SETTINGS.webhook_headers,
      webhook_template: raw.webhook_template || DEFAULT_SETTINGS.webhook_template,
      notify_failure_silence: boolSetting(raw.notify_failure_silence, DEFAULT_SETTINGS.notify_failure_silence),
      pushplus_token: raw.pushplus_token || '',
      notify_token: raw.notify_token || raw.pushplus_token || DEFAULT_SETTINGS.notify_token,
      notify_target: raw.notify_target || DEFAULT_SETTINGS.notify_target,
      notify_secret: raw.notify_secret || DEFAULT_SETTINGS.notify_secret,
      timezone: raw.timezone || DEFAULT_SETTINGS.timezone,
      setup_completed: raw.setup_completed || '0',
    };
  }

  async getSettings() {
    const state = await this.readState();
    return this.settingsWithDefaults(state.settings);
  }

  async getSetting(key, fallback = '') {
    const state = await this.readState();
    return state.settings[key] ?? fallback;
  }

  async setSetting(key, value) {
    await this.updateState((state) => {
      state.settings[key] = String(value);
    });
  }

  async listEnabledServers() {
    return (await this.listServers()).filter((server) => server.enabled);
  }

  async listServers() {
    const state = await this.readState();
    return state.servers.map((server) => ({ ...server, enabled: server.enabled !== false }));
  }

  async listGroups() {
    const state = await this.readState();
    return [...state.groups].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)
      || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  }

  async getGroup(id) {
    return (await this.listGroups()).find((group) => String(group.id) === String(id)) || null;
  }

  async getServer(id) {
    return (await this.listServers()).find((server) => String(server.id) === String(id)) || null;
  }

  async listProviders() {
    const state = await this.readState();
    return [...state.providers].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async getProvider(name) {
    const state = await this.readState();
    return state.providers.find((provider) => provider.name === name) || null;
  }

  async updateProvider(provider) {
    await this.updateState((state) => {
      const index = state.providers.findIndex((item) => item.name === provider.name);
      if (index >= 0) state.providers[index] = { ...state.providers[index], ...provider, updated_at: Math.floor(Date.now() / 1000) };
    });
  }

  async upsertProvider(provider, now) {
    await this.updateState((state) => {
      const next = { ...provider, created_at: provider.created_at || now, updated_at: now };
      const index = state.providers.findIndex((item) => item.name === provider.name);
      if (index >= 0) state.providers[index] = { ...state.providers[index], ...next };
      else state.providers.push(next);
    });
  }

  async upsertServer(server, now) {
    await this.updateState((state) => {
      const next = {
        ...server,
        remote_id: server.remote_id || server.id,
        group_id: server.group_id || '',
        sort_order: numberSetting(server.sort_order, 0),
        enabled: server.enabled !== false,
        created_at: server.created_at || now,
        updated_at: now,
      };
      const index = state.servers.findIndex((item) => String(item.id) === String(server.id));
      if (index >= 0) state.servers[index] = { ...state.servers[index], ...next };
      else state.servers.push(next);
    });
  }

  async upsertGroup(group, now) {
    await this.updateState((state) => {
      const next = {
        ...group,
        sort_order: numberSetting(group.sort_order, 0),
        created_at: group.created_at || now,
        updated_at: now,
      };
      const index = state.groups.findIndex((item) => String(item.id) === String(group.id));
      if (index >= 0) state.groups[index] = { ...state.groups[index], ...next };
      else state.groups.push(next);
    });
  }

  async reorderGroups(groupIds, now) {
    await this.updateState((state) => {
      const positions = new Map(groupIds.map((id, index) => [String(id), index]));
      state.groups = state.groups.map((group) => positions.has(String(group.id))
        ? { ...group, sort_order: positions.get(String(group.id)), updated_at: now }
        : group);
    });
  }

  async assignServersToGroup(serverIds, groupId, sortOrder, now) {
    await this.updateState((state) => {
      const positions = new Map(serverIds.map((id, index) => [String(id), index]));
      state.servers = state.servers.map((server) => {
        const index = positions.get(String(server.id));
        if (index == null) return server;
        return {
          ...server,
          group_id: groupId,
          sort_order: sortOrder == null ? numberSetting(server.sort_order, 0) : sortOrder + index,
          updated_at: now,
        };
      });
    });
  }

  async deleteGroup(id, now) {
    await this.updateState((state) => {
      state.groups = state.groups.filter((group) => String(group.id) !== String(id));
      state.servers = state.servers.map((server) => String(server.group_id || '') === String(id)
        ? { ...server, group_id: '', sort_order: 0, updated_at: now }
        : server);
    });
  }

  async deleteServer(id) {
    await this.updateState((state) => {
      state.servers = state.servers.filter((server) => String(server.id) !== String(id));
      delete state.runtimes[String(id)];
    });
  }

  async resetTutorialData() {
    const state = await this.readState();
    const adminTokenHash = state.settings.admin_token_hash || '';
    const next = defaultState();
    if (adminTokenHash) next.settings.admin_token_hash = adminTokenHash;
    await this.writeState(next);
  }

  async getRuntime(serverId) {
    const state = await this.readState();
    const row = state.runtimes[String(serverId)];
    return row ? createRuntime(row) : null;
  }

  async saveRuntime(serverId, runtime) {
    await this.updateState((state) => {
      state.runtimes[String(serverId)] = runtime;
    });
  }

  async addEvent(event) {
    await this.updateState((state) => {
      state.events.push({ id: state.next_event_id++, ...event });
      state.events = state.events.slice(-500);
    });
  }

  async addCheckResult(result) {
    await this.updateState((state) => {
      state.check_results.push({ id: state.next_check_id++, ...result, ok: Boolean(result.ok) });
      state.check_results = state.check_results.slice(-3000);
    });
  }

  async pruneCheckResults(retentionDays, now = Math.floor(Date.now() / 1000)) {
    const days = Number(retentionDays || 0);
    if (!Number.isFinite(days) || days <= 0) return;
    const before = Math.floor(now - days * 24 * 60 * 60);
    await this.updateState((state) => {
      state.check_results = state.check_results.filter((row) => Number(row.created_at || 0) >= before);
    });
  }

  async listRecentChecks(serverId, limit = 60) {
    const state = await this.readState();
    return state.check_results
      .filter((row) => String(row.server_id) === String(serverId))
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0) || Number(b.id || 0) - Number(a.id || 0))
      .slice(0, limit)
      .map((row) => ({ ok: Boolean(row.ok), latency_ms: Number(row.latency_ms || 0), created_at: Number(row.created_at || 0) }));
  }

  async countRecentReboots(serverId, since) {
    const state = await this.readState();
    return state.events.filter((event) => String(event.server_id) === String(serverId)
      && event.old_state === 'rebooting'
      && event.new_state === 'recovering'
      && Number(event.created_at || 0) >= since).length;
  }

  async listStatus() {
    const state = await this.readState();
    return state.servers.filter((server) => server.enabled !== false).map((server) => {
      const runtime = state.runtimes[String(server.id)] || {};
      const last = [...state.check_results].reverse().find((row) => String(row.server_id) === String(server.id)) || {};
      return { ...server, ...runtime, last_latency_ms: Number(last.latency_ms || 0) };
    });
  }

  async listEvents(limit = 50) {
    const state = await this.readState();
    return [...state.events].sort((a, b) => Number(b.id || 0) - Number(a.id || 0)).slice(0, limit);
  }

  async listDailyHistory(serverIds, days = 30, now = Math.floor(Date.now() / 1000), intervalSeconds = 300) {
    const state = await this.readState();
    const since = now - days * 24 * 60 * 60;
    const grouped = new Map(serverIds.map((id) => [String(id), []]));
    const buckets = new Map();
    const serverIdSet = new Set(serverIds.map(String));
    const rows = state.check_results.filter((item) => serverIdSet.has(String(item.server_id)) && Number(item.created_at || 0) >= since);
    for (const row of rows) {
      const date = historyDate(row.created_at);
      const key = `${row.server_id}|${date}`;
      const bucket = buckets.get(key) || { server_id: String(row.server_id), date, total: 0, ok: 0, latency: 0 };
      bucket.total += 1;
      bucket.ok += checkOk(row.ok) ? 1 : 0;
      bucket.latency += Number(row.latency_ms || 0);
      buckets.set(key, bucket);
    }
    const sortedRows = [...rows].sort((a, b) => String(a.server_id).localeCompare(String(b.server_id))
      || Number(a.created_at || 0) - Number(b.created_at || 0)
      || Number(a.id || 0) - Number(b.id || 0));
    const failedRows = [];
    sortedRows.forEach((row, index) => {
      if (checkOk(row.ok)) return;
      const next = sortedRows[index + 1];
      const sameServer = next && String(next.server_id) === String(row.server_id);
      failedRows.push({
        server_id: row.server_id,
        created_at: row.created_at,
        next_ok: sameServer ? next.ok : null,
        next_created_at: sameServer ? next.created_at : null,
      });
    });
    const outages = dailyOutages(failedRows, intervalSeconds);
    for (const bucket of buckets.values()) {
      const dayOutages = outages.get(bucket.server_id)?.get(bucket.date) || [];
      grouped.get(bucket.server_id)?.push({
        date: bucket.date,
        checks: bucket.total,
        failures: Math.max(0, bucket.total - bucket.ok),
        uptime: percent(bucket.ok, bucket.total),
        avg_latency_ms: Math.round(bucket.latency / bucket.total),
        downtime_seconds: dayOutages.reduce((total, outage) => total + Number(outage.duration_seconds || 0), 0),
        outages: dayOutages,
      });
    }
    return grouped;
  }

  async listPublicEvents(serverIds, limit = 80) {
    const grouped = new Map(serverIds.map((id) => [String(id), []]));
    const events = (await this.listEvents(limit)).filter((event) => serverIds.map(String).includes(String(event.server_id)));
    for (const event of events) grouped.get(String(event.server_id))?.push(event);
    return grouped;
  }
}
