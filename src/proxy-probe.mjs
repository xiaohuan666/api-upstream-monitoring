import { spawn } from 'node:child_process';
import { isIP } from 'node:net';

const TARGETS = [
  { url: 'http://ip-api.com/json/?lang=zh-CN', parser: 'ip-api' },
  { url: 'https://api64.ipify.org?format=json', parser: 'ipify' },
];
const MAX_BYTES = 64 * 1024;

function configString(value) {
  // curl config has its own quoting rules. Never pass credentials on the command line.
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\v/g, '\\v')}"`;
}

export function requestThroughProxy(proxy, url, { timeoutMs = 8000 } = {}) {
  const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  const auth = proxy.username || proxy.password
    ? `${encodeURIComponent(proxy.username ?? '')}:${encodeURIComponent(proxy.password ?? '')}@`
    : '';
  const config = [
    `proxy = ${configString(`${proxy.protocol}://${auth}${host}:${proxy.port}`)}`,
    'noproxy = ""',
    `url = ${configString(url)}`,
    `max-time = ${Math.max(0.1, timeoutMs / 1000)}`,
    'connect-timeout = 5',
    'max-filesize = 65536',
    'silent', 'fail',
  ];
  return new Promise((resolve, reject) => {
    // -q disables host curlrc; noproxy="" prevents an environment bypass of the selected proxy.
    const child = spawn('curl', ['-q', '--config', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let size = 0;
    let oversized = false;
    let timedOut = false;
    const chunks = [];
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs + 1000);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) { oversized = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('探测程序不可用')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code === 28) return reject(new Error('连接超时'));
      if (oversized || code === 63) return reject(new Error('探测响应过大'));
      if (code !== 0) return reject(new Error('代理连接、认证或探测请求失败'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(config.join('\n') + '\n');
  });
}

function parseExitInfo(text, parser) {
  const value = JSON.parse(text);
  const ip = parser === 'ip-api' ? value.query : value.ip;
  if (!isIP(String(ip ?? '')) || (parser === 'ip-api' && value.status !== 'success')) throw new Error('invalid exit response');
  const location = (key) => typeof value[key] === 'string' ? value[key].slice(0, 160) : '';
  return { ip, country: parser === 'ip-api' ? location('country') : '',
    region: parser === 'ip-api' ? location('regionName') || location('region') : '',
    city: parser === 'ip-api' ? location('city') : '' };
}

export async function probeProxy(proxy, { request = requestThroughProxy, targets = TARGETS } = {}) {
  for (const target of targets) {
    const start = performance.now();
    try {
      const exit = parseExitInfo(await request(proxy, target.url), target.parser);
      return { ok: true, latencyMs: Math.round(performance.now() - start), ...exit, checkedAt: new Date().toISOString(), error: '' };
    } catch {
      // Provider bodies and transport errors may contain credentials. Return a controlled error only.
    }
  }
  return { ok: false, latencyMs: null, ip: '', country: '', region: '', city: '',
    checkedAt: new Date().toISOString(), error: '探测失败：请检查代理地址、认证及网络；探测服务也可能暂不可用' };
}

export function createProxyProbeService({ repository, probe = probeProxy, concurrency = 4, maxPending = 200 }) {
  const inFlight = new Map();
  const waiting = [];
  let active = 0;
  function pump() {
    while (active < concurrency && waiting.length) {
      const { id, resolve, reject } = waiting.shift();
      active++;
      (async () => {
        const proxy = await repository.getProxyById(id);
        if (!proxy) throw Object.assign(new Error('代理不存在'), { statusCode: 404 });
        const result = await probe(proxy);
        if (!await repository.saveProxyProbe(proxy, result)) {
          throw Object.assign(new Error('代理已修改或删除，请重新测试'), { statusCode: 409 });
        }
        return result;
      })().then(resolve, reject).finally(() => { active--; inFlight.delete(id); pump(); });
    }
  }
  return {
    test(id) {
      if (inFlight.has(id)) return inFlight.get(id);
      if (inFlight.size >= maxPending) return Promise.reject(Object.assign(new Error('测试队列已满，请稍后重试'), { statusCode: 429 }));
      const promise = new Promise((resolve, reject) => waiting.push({ id, resolve, reject }));
      inFlight.set(id, promise);
      pump();
      return promise;
    },
  };
}
