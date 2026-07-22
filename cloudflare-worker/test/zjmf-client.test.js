import assert from 'node:assert/strict';
import test from 'node:test';

import { ZjmfClient, extractHosts, extractJwt, extractStatus } from '../src/zjmf-client.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('extractJwt 兼容顶层 jwt 和 data.jwt', () => {
  assert.equal(extractJwt({ jwt: 'a' }), 'a');
  assert.equal(extractJwt({ data: { jwt: 'b' } }), 'b');
  assert.equal(extractJwt({ data: {} }), '');
});

test('extractHosts 兼容 data.host、data.list 和 data 数组', () => {
  assert.deepEqual(extractHosts({ data: { host: [{ id: 1 }] } }), [{ id: 1 }]);
  assert.deepEqual(extractHosts({ data: { list: [{ id: 2 }] } }), [{ id: 2 }]);
  assert.deepEqual(extractHosts({ data: [{ id: 3 }] }), [{ id: 3 }]);
});

test('extractHosts 兼容更多魔方财务产品列表结构', () => {
  assert.deepEqual(extractHosts({ data: { hosts: [{ id: 4 }] } }), [{ id: 4 }]);
  assert.deepEqual(extractHosts({ host: [{ id: 5 }] }), [{ id: 5 }]);
  assert.deepEqual(extractHosts({ data: { data: { host: [{ id: 6 }] } } }), [{ id: 6 }]);
});

test('extractStatus 兼容常见状态字段', () => {
  assert.equal(extractStatus({ data: { status: 'on' } }), 'on');
  assert.equal(extractStatus({ data: { power_state: 'off' } }), 'off');
  assert.equal(extractStatus({ state: 'unknown' }), 'unknown');
});

test('extractStatus 兼容纯文本 on/off 状态', () => {
  assert.equal(extractStatus('on'), 'on');
  assert.equal(extractStatus(' off '), 'off');
});

test('login 使用 query string 传账号和密钥', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ jwt: 'token-1' });
  };
  const provider = { api_base_url: 'https://example.test/v1', api_account: 'acct', api_password: 'key' };

  const client = new ZjmfClient(provider, fetcher, 60);
  assert.equal(await client.login(1000), true);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].url, /login_api\?account=acct&password=key$/);
  assert.equal(provider.jwt_token, 'token-1');
});

test('getStatus 带 JWT 访问状态接口并抽取状态', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('login_api')) return jsonResponse({ jwt: 'token-2' });
    return jsonResponse({ data: { status: 'on' } });
  };
  const provider = { api_base_url: 'https://example.test/v1', api_account: 'acct', api_password: 'key' };

  const client = new ZjmfClient(provider, fetcher, 60);
  assert.equal(await client.getStatus('4075', 1000), 'on');
  assert.match(calls[1].url, /hosts\/4075\/module\/status\?type=host$/);
  assert.equal(calls[1].init.headers.Authorization, 'JWT token-2');
});

test('hardReboot 对 401 自动重新登录后重试一次', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('login_api')) return jsonResponse({ jwt: `token-${calls.length}` });
    if (calls.length === 2) return jsonResponse({ msg: 'expired' }, 401);
    return jsonResponse({ msg: '成功' });
  };
  const provider = { api_base_url: 'https://example.test/v1', api_account: 'acct', api_password: 'key' };

  const client = new ZjmfClient(provider, fetcher, 60);
  assert.equal(await client.hardReboot('4075', 1000), true);
  assert.equal(calls.filter((c) => c.url.includes('login_api')).length, 2);
  assert.equal(calls.at(-1).init.method, 'PUT');
  assert.equal(calls.at(-1).init.headers.Authorization, 'JWT token-3');
});

test('hardReboot 在 JSON status 非 200 时判定失败', async () => {
  const fetcher = async (url) => {
    if (String(url).includes('login_api')) return jsonResponse({ jwt: 'token-4' });
    return jsonResponse({ status: 406, msg: '不能执行该操作' });
  };
  const provider = { api_base_url: 'https://example.test/v1', api_account: 'acct', api_password: 'key' };

  const client = new ZjmfClient(provider, fetcher, 60);
  assert.equal(await client.hardReboot('4075', 1000), false);
});

test('powerOn 调用开机模块接口', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('login_api')) return jsonResponse({ jwt: 'token-5' });
    return jsonResponse({ msg: '成功' });
  };
  const provider = { api_base_url: 'https://example.test/v1', api_account: 'acct', api_password: 'key' };

  const client = new ZjmfClient(provider, fetcher, 60);
  assert.equal(await client.powerOn('4075', 1000), true);
  assert.match(calls.at(-1).url, /hosts\/4075\/module\/on$/);
  assert.equal(calls.at(-1).init.method, 'PUT');
});


test('ZJMF 请求网络异常时返回 null 而不是抛出', async () => {
  const fetcher = async () => {
    throw new Error('network blocked');
  };
  const provider = { api_base_url: 'https://example.test/v1', api_account: 'acct', api_password: 'key' };

  const client = new ZjmfClient(provider, fetcher, 60);
  assert.equal(await client.getStatus('4075', 1000), null);
  assert.match(client.lastError, /IDC API 网络连接失败/);
});

test('ZJMF 请求达到超时时间后返回明确中文原因', async () => {
  const fetcher = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
  });
  const provider = { api_base_url: 'https://example.test/v1', api_account: 'acct', api_password: 'key' };
  const client = new ZjmfClient(provider, fetcher, 0.01);

  assert.equal(await client.getHosts(1000), null);
  assert.match(client.lastError, /IDC API 请求超时（0\.01 秒）/);
  assert.match(client.lastError, /当前部署平台/);
  assert.doesNotMatch(client.lastError, /operation was aborted/i);
});

test('ZJMF 网络连接异常返回可操作的中文原因', async () => {
  const fetcher = async () => {
    throw new TypeError('fetch failed: connect timeout');
  };
  const provider = { api_base_url: 'https://example.test/v1', api_account: 'acct', api_password: 'key' };
  const client = new ZjmfClient(provider, fetcher, 60);

  assert.equal(await client.getHosts(1000), null);
  assert.match(client.lastError, /IDC API 网络连接失败/);
  assert.match(client.lastError, /当前部署平台/);
  assert.doesNotMatch(client.lastError, /fetch failed/i);
});
