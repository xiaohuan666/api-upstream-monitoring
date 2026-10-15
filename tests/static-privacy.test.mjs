import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestHandler } from '../src/http.mjs';
import { PUBLIC_ASSET_PATHS } from '../src/public-assets.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'aum-public-assets-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'index.html'), '<title>Public fixture</title>');
  await writeFile(path.join(root, 'src/app.mjs'), 'export const publicFixture = true;');
  const server = createServer(createRequestHandler({ publicDir: root, repository: {} }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  });
  return { root, base: `http://127.0.0.1:${server.address().port}` };
}

test('private files remain inaccessible even when they exist beside public assets', async (t) => {
  const { root, base } = await fixture(t);
  const paths = ['.git/config', '.git/index', '.env', 'tasks/share-design.md', 'backup.dump',
    'server.mjs', 'package.json', 'src/db.mjs', 'src/public-assets.mjs', 'src/unknown.mjs'];
  for (const pathname of paths) {
    await mkdir(path.dirname(path.join(root, pathname)), { recursive: true });
    await writeFile(path.join(root, pathname), 'private fixture contents');
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(`${base}/${pathname}`, { method });
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assert.equal(await response.text(), method === 'HEAD' ? '' : 'Not found');
    }
  }
  for (const pathname of ['/src/..%2f.env', '/src/%2e%2e%2f.git/config', '/%2egit/config', '/src/%ZZ']) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 404, pathname);
    assert.equal(await response.text(), 'Not found');
  }
});

test('allowlisted assets and SPA pages load, while asset writes return 404', async (t) => {
  const { root, base } = await fixture(t);
  await writeFile(path.join(root, 'styles.css'), 'body { color: black; }');
  for (const pathname of ['/', '/sites', '/groups', '/oauth-tasks', '/settings/my-sites', '/index.html', '/styles.css', '/src/app.mjs']) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.ok((await response.text()).length > 0);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const head = await fetch(`${base}/src/app.mjs`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await fetch(`${base}/src/app.mjs`, { method });
    assert.equal(response.status, 404, method);
    assert.equal(await response.text(), 'Not found');
  }
});

test('a public filename cannot expose a private file through a symlink', async (t) => {
  const { root, base } = await fixture(t);
  await writeFile(path.join(root, '.env'), 'private fixture contents');
  await symlink(path.join(root, '.env'), path.join(root, 'styles.css'));
  const response = await fetch(`${base}/styles.css`);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});

test('a symlinked source directory cannot bypass the public asset boundary', async (t) => {
  const { root, base } = await fixture(t);
  await rm(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'private-source'));
  await writeFile(path.join(root, 'private-source/app.mjs'), 'private fixture contents');
  await symlink(path.join(root, 'private-source'), path.join(root, 'src'));
  const response = await fetch(`${base}/src/app.mjs`);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});

test('the explicit public manifest covers every current browser import and stylesheet', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const manifest = new Set(PUBLIC_ASSET_PATHS);
  const pending = ['/src/app.mjs'];
  const visited = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/[^"?]+\.(?:mjs|css))(?:\?[^" ]*)?"/g)) {
    assert.ok(manifest.has(match[1]), `Unpublished HTML asset: ${match[1]}`);
  }
  while (pending.length) {
    const pathname = pending.pop();
    if (visited.has(pathname)) continue;
    visited.add(pathname);
    assert.ok(manifest.has(pathname), `Unpublished browser dependency: ${pathname}`);
    const source = await readFile(path.join(root, pathname), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      pending.push(path.posix.resolve(path.posix.dirname(pathname), match[1]));
    }
  }
  for (const pathname of PUBLIC_ASSET_PATHS) await readFile(path.join(root, pathname));
});
