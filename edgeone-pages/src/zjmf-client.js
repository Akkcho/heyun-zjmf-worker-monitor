export function extractJwt(data) {
  return data?.jwt || data?.data?.jwt || '';
}

export function normalizeApiBaseUrl(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    url.search = '';
    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = !path || path === '/' || path.toLowerCase() === '/apimanage' ? '/v1' : path;
    return url.toString().replace(/\/$/, '');
  } catch {
    return text.replace(/\/+$/, '');
  }
}

function validHosts(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function findHosts(raw, depth = 0) {
  if (depth > 3) return [];
  const arrayHosts = validHosts(raw);
  if (arrayHosts.length) return arrayHosts;
  if (!raw || typeof raw !== 'object') return [];
  for (const key of ['host', 'hosts', 'list', 'lists', 'items', 'records', 'products']) {
    const hosts = validHosts(raw[key]);
    if (hosts.length) return hosts;
  }
  return findHosts(raw.data || raw.result || raw.rows, depth + 1);
}

export function extractHosts(data) {
  return findHosts(data?.data ?? data);
}

function textValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

export function extractStatus(data) {
  if (typeof data === 'string') return textValue(data);
  const raw = data?.data;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return textValue(raw.status ?? raw.state ?? raw.power_status ?? raw.power_state);
  }
  return textValue(data?.status ?? data?.state);
}

function withTimeout(timeoutSeconds) {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutSeconds * 1000);
  return { signal: controller.signal, clear: () => clearTimeout(timer), expired: () => expired };
}

function requestErrorMessage(error, timeoutSeconds, timedOut) {
  const raw = error instanceof Error ? error.message : String(error);
  if (timedOut || error?.name === 'AbortError' || /\babort(?:ed)?\b/i.test(raw)) {
    return `IDC API 请求超时（${timeoutSeconds} 秒），请确认 API 地址可从当前部署平台直接访问。`;
  }
  if (/fetch failed|connect(?:ion)?(?: timed? ?out| refused| reset)?|network|socket|econn|etimedout/i.test(raw)) {
    return 'IDC API 网络连接失败，请确认 API 地址可从当前部署平台直接访问。';
  }
  return raw;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function readPayload(response) {
  try {
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return {};
  }
}

export class ZjmfClient {
  constructor(provider, fetcher = (input, init) => globalThis.fetch(input, init), apiTimeout = 60) {
    this.provider = provider;
    this.provider.api_base_url = normalizeApiBaseUrl(provider?.api_base_url);
    this.fetcher = fetcher;
    this.apiTimeout = apiTimeout;
    this.lastError = '';
  }

  async login(now, force = false) {
    if (!force && this.provider.jwt_token && now < (this.provider.jwt_expire_at || 0)) return true;
    const url = new URL(`${this.provider.api_base_url}/login_api`);
    url.searchParams.set('account', this.provider.api_account);
    url.searchParams.set('password', this.provider.api_password);
    const response = await this.requestRaw(url, { method: 'POST' });
    if (!response?.ok) {
      if (!this.lastError) this.lastError = response ? `HTTP ${response.status}` : 'request failed';
      return false;
    }
    const jwt = extractJwt(await readJson(response));
    if (!jwt) return false;
    this.provider.jwt_token = jwt;
    this.provider.jwt_expire_at = now + 7000;
    return true;
  }

  async requestRaw(url, init = {}) {
    const timeout = withTimeout(this.apiTimeout);
    try {
      this.lastError = '';
      return await this.fetcher(url, { ...init, signal: timeout.signal });
    } catch (error) {
      this.lastError = requestErrorMessage(error, this.apiTimeout, timeout.expired());
      return null;
    } finally {
      timeout.clear();
    }
  }

  async request(method, url, now, retry = true) {
    if (!(await this.login(now))) return null;
    const response = await this.requestRaw(url, {
      method,
      headers: { Authorization: `JWT ${this.provider.jwt_token}` },
    });
    if (retry && response && (response.status === 401 || response.status === 403)) {
      this.provider.jwt_token = '';
      this.provider.jwt_expire_at = 0;
      if (!(await this.login(now, true))) return response;
      return this.requestRaw(url, {
        method,
        headers: { Authorization: `JWT ${this.provider.jwt_token}` },
      });
    }
    return response;
  }

  async getHosts(now, page = 1, limit = 100) {
    const url = new URL(`${this.provider.api_base_url}/hosts`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(limit));
    const response = await this.request('GET', url, now);
    if (!response?.ok) return null;
    return extractHosts(await readJson(response));
  }

  async getStatus(hostId, now) {
    const url = new URL(`${this.provider.api_base_url}/hosts/${hostId}/module/status`);
    url.searchParams.set('type', 'host');
    const response = await this.request('GET', url, now);
    if (!response?.ok) return null;
    return extractStatus(await readPayload(response));
  }

  async hardReboot(hostId, now) {
    const url = new URL(`${this.provider.api_base_url}/hosts/${hostId}/module/hard_reboot`);
    const response = await this.request('PUT', url, now);
    if (!response?.ok) return false;
    const data = await readJson(response);
    if (typeof data?.status === 'number' && data.status !== 200) {
      this.lastError = data.msg || `API status ${data.status}`;
      return false;
    }
    return true;
  }

  async powerOn(hostId, now) {
    const url = new URL(`${this.provider.api_base_url}/hosts/${hostId}/module/on`);
    const response = await this.request('PUT', url, now);
    if (!response?.ok) return false;
    const data = await readJson(response);
    if (typeof data?.status === 'number' && data.status !== 200) {
      this.lastError = data.msg || `API status ${data.status}`;
      return false;
    }
    return true;
  }
}
