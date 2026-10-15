// 代理批量导入的文本解析（参考 sub2api 前端 ProxiesView 的 parseProxyUrl，前后端共用）。
// 支持格式：
//   protocol://[user:pass@]host:port   —— 协议取自前缀（http/https/socks5/socks5h）
//   host:port:user:pass                —— 裸格式，默认 socks5（密码允许再含冒号）
//   host:port                          —— 裸格式，默认 socks5
import { normalizeProxyHost, proxyDedupeKey } from './proxy-identity.mjs';

export { proxyDedupeKey };

const BARE_AUTH_LINE = /^([^:]+):(\d+):([^:]+):(.+)$/;
const BARE_LINE = /^([^:]+):(\d+)$/;

export function parseProxyImportLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;

  if (/^(https?|socks5h?):\/\//i.test(trimmed)) {
    try {
      const authority = trimmed.slice(trimmed.indexOf('://') + 3).split(/[/?#]/, 1)[0];
      const endpoint = authority.slice(authority.lastIndexOf('@') + 1);
      const explicitPort = endpoint.match(/^(?:\[[^\]]+\]|[^:]+):(\d+)$/)?.[1];
      if (!explicitPort) return null;
      const url = new URL(trimmed);
      if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return null;
      const protocol = url.protocol.slice(0, -1).toLowerCase();
      // URL 会移除显式的 80/443 端口；从原 authority 保留用户确实填写的端口。
      const port = explicitPort;
      return buildEntry(protocol, url.hostname, port, decodeURIComponent(url.username), decodeURIComponent(url.password));
    } catch { return null; }
  }
  let match;
  match = trimmed.match(BARE_AUTH_LINE);
  if (match) {
    return buildEntry('socks5', match[1], match[2], match[3], match[4]);
  }
  match = trimmed.match(BARE_LINE);
  if (match) {
    return buildEntry('socks5', match[1], match[2], '', '');
  }
  return null;
}

function buildEntry(protocol, host, port, username, password) {
  const portNumber = Number(port);
  const normalizedHost = normalizeProxyHost(host);
  if (!normalizedHost || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return null;
  }
  return {
    protocol,
    host: normalizedHost,
    port: portNumber,
    username: String(username ?? '').trim(),
    password: String(password ?? ''),
  };
}

// 整段文本 → 解析结果：批内按 host:port:user:pass 去重，统计有效/无效/重复
export function parseProxyImportText(text, existing = []) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const seen = new Set(existing.map(proxyDedupeKey));
  const proxies = [];
  let invalid = 0;
  let duplicate = 0;
  for (const line of lines) {
    const parsed = parseProxyImportLine(line);
    if (!parsed) {
      invalid += 1;
      continue;
    }
    const key = proxyDedupeKey(parsed);
    if (seen.has(key)) {
      duplicate += 1;
      continue;
    }
    seen.add(key);
    proxies.push(parsed);
  }
  return { total: lines.length, valid: proxies.length, invalid, duplicate, proxies };
}
