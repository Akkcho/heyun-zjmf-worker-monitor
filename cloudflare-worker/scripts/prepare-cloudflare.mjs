import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';

const workerName = process.env.WORKER_NAME || 'zjmf-monitor';
const databaseName = process.env.D1_DATABASE_NAME || `${workerName}-d1`;
const isWindows = platform() === 'win32';
const wranglerCliPath = process.env.WRANGLER_CLI_PATH?.trim() || '';
const wranglerPackage = process.env.WRANGLER_PACKAGE?.trim() || 'wrangler@latest';

function runWrangler(args) {
  const options = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (wranglerCliPath) {
    return execFileSync(process.execPath, [wranglerCliPath, ...args], options);
  }
  return execFileSync('npx', ['--yes', wranglerPackage, ...args], { ...options, shell: isWindows });
}

function parseD1ListJson(output) {
  try {
    const parsed = JSON.parse(output);
    const list = Array.isArray(parsed) ? parsed : parsed.result || [];
    return list.find((db) => db.name === databaseName)?.uuid || '';
  } catch {
    return '';
  }
}

function parseD1ListTable(output) {
  const line = output.split(/\r?\n/).find((row) => row.includes(databaseName));
  return line?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || '';
}

function findDatabaseId() {
  try {
    return parseD1ListJson(runWrangler(['d1', 'list', '--json']));
  } catch {
    return parseD1ListTable(runWrangler(['d1', 'list']));
  }
}

function createDatabase() {
  const output = runWrangler(['d1', 'create', databaseName]);
  const fromToml = output.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
  const fromUuid = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  return fromToml || fromUuid || '';
}

function tomlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function patchVars(toml, vars) {
  const entries = Object.entries(vars).filter(([, value]) => String(value || '').trim());
  if (entries.length === 0) return toml;
  const lines = toml.split(/\r?\n/);
  let start = lines.findIndex((line) => line.trim() === '[vars]');
  if (start < 0) {
    const insertAt = lines.findIndex((line) => /^\s*\[/.test(line));
    const block = ['[vars]', ...entries.map(([key, value]) => `${key} = "${tomlString(value)}"`), ''];
    lines.splice(insertAt < 0 ? lines.length : insertAt, 0, ...block);
    return lines.join('\n');
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const body = lines.slice(start + 1, end);
  for (const [key, value] of entries) {
    const idx = body.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    const next = `${key} = "${tomlString(value)}"`;
    if (idx >= 0) body[idx] = next;
    else body.push(next);
  }
  lines.splice(start + 1, end - start - 1, ...body);
  return lines.join('\n');
}

function patchWranglerToml(databaseId) {
  const path = 'wrangler.toml';
  let toml = readFileSync(path, 'utf8');
  toml = toml.replace(/^name = ".*"$/m, `name = "${workerName}"`);
  toml = toml.replace(/^database_name = ".*"$/m, `database_name = "${databaseName}"`);
  toml = toml.replace(/^database_id = ".*"$/m, `database_id = "${databaseId}"`);
  toml = patchVars(toml, {
    APP_VERSION: process.env.APP_VERSION || process.env.GITHUB_SHA || '',
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || '',
    GITHUB_BRANCH: process.env.GITHUB_BRANCH || process.env.GITHUB_REF_NAME || '',
    GITHUB_WORKFLOW_FILE: process.env.GITHUB_WORKFLOW_FILE || 'deploy.yml',
  });
  writeFileSync(path, toml);
}

let databaseId = findDatabaseId();
if (!databaseId) databaseId = createDatabase();
if (!databaseId) throw new Error(`Cannot resolve D1 database id for ${databaseName}`);

patchWranglerToml(databaseId);
console.log(`Worker name: ${workerName}`);
console.log(`D1 database: ${databaseName}`);
console.log(`D1 database id: ${databaseId}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `worker_name=${workerName}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `database_name=${databaseName}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `database_id=${databaseId}\n`);
}
