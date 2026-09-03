import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const match = /^corsen-context-(ghost|strapi|directus|wagtail|mediawiki)$/.exec(pkg.name);
assert.ok(match, `Unsupported package name: ${pkg.name}`);
const stack = match[1];

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForPortFile(file, fixture, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fixture.exitCode !== null) {
      throw new Error(`CMS fixture exited early (${fixture.exitCode}): ${logs.join('').slice(-3000)}`);
    }
    try {
      const value = Number.parseInt((await readFile(file, 'utf8')).trim(), 10);
      if (Number.isInteger(value) && value > 0) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CMS fixture did not start: ${logs.join('').slice(-3000)}`);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), `corsen-${stack}-`));
const portFile = path.join(temporary, 'fixture-port');
const fixtureLogs = [];
const appLogs = [];
const fixture = spawn(process.execPath, ['scripts/mock-public-cms.mjs', portFile], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
fixture.stdout.on('data', (chunk) => fixtureLogs.push(chunk.toString()));
fixture.stderr.on('data', (chunk) => fixtureLogs.push(chunk.toString()));

let app;
try {
  const fixturePort = await waitForPortFile(portFile, fixture, fixtureLogs);
  const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
  const appPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const stackEnv = {
    ghost: { GHOST_API_URL: fixtureUrl, GHOST_CONTENT_KEY: 'public-test-fixture' },
    strapi: { STRAPI_URL: fixtureUrl, STRAPI_TOKEN: '' },
    directus: { DIRECTUS_URL: fixtureUrl, DIRECTUS_TOKEN: '' },
    wagtail: {
      WAGTAIL_URL: fixtureUrl,
      WAGTAIL_PAGE_TYPE: 'blog.BlogPage',
      WAGTAIL_BODY_FIELD: 'body',
    },
    mediawiki: {
      MW_API_URL: `${fixtureUrl}/mediawiki/api.php`,
      MW_USER_AGENT: 'Corsen-Context-Integration-Test/1.0',
      MW_MAX_PAGES: '1',
      MW_BATCH_SIZE: '1',
      MW_CACHE_TTL_MS: '1000',
    },
  }[stack];

  app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      ...stackEnv,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      SITE_URL: baseUrl,
      TRUST_PROXY: '0',
      CORSEN_CONTEXT_MCP_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (chunk) => appLogs.push(chunk.toString()));
  app.stderr.on('data', (chunk) => appLogs.push(chunk.toString()));

  const smoke = spawn(
    process.execPath,
    ['scripts/smoke-example-mcp.mjs', baseUrl, `${stack} standalone`, 'webmcp'],
    { cwd: root, stdio: 'inherit' },
  );
  const exitCode = await waitForExit(smoke);
  if (exitCode !== 0) {
    throw new Error(`Integration smoke failed (${exitCode}). Server output: ${appLogs.join('').slice(-4000)}`);
  }

  const hostileTitle = 'WebMCP <unsafe> "quoted"';
  const detailPath =
    stack === 'mediawiki'
      ? `/wiki/${encodeURIComponent(hostileTitle.replace(/ /g, '_'))}`
      : '/posts/webmcp-guide';
  const detail = await fetch(`${baseUrl}${detailPath}`);
  assert.equal(detail.status, 200, `${stack}: hostile-title detail must render`);
  const detailHtml = await detail.text();
  assert.match(
    detailHtml,
    /<title>WebMCP &lt;unsafe&gt; "quoted"<\/title>/,
    `${stack}: document title was not HTML escaped`,
  );
  assert.doesNotMatch(
    detailHtml,
    /<title>WebMCP <unsafe>/i,
    `${stack}: CMS title entered the document title context`,
  );
} finally {
  if (app && app.exitCode === null) {
    app.kill();
    await waitForExit(app);
  }
  if (fixture.exitCode === null) {
    fixture.kill();
    await waitForExit(fixture);
  }
  await rm(temporary, { recursive: true, force: true });
}
