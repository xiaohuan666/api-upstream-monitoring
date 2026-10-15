// 代理批量导出的渲染（与 proxy-import.mjs 的四种导入格式互逆，另加 sub2api「数据导出」JSON）。
// JSON 结构对齐 sub2api backend DataPayload/DataProxy（handler/admin/account_data.go），可直接被 sub2api 导入。
export const PROXY_EXPORT_FORMATS = Object.freeze([
  { id: 'url-auth', label: 'protocol://user:pass@host:port', extension: 'txt', mime: 'text/plain' },
  { id: 'url', label: 'protocol://host:port', extension: 'txt', mime: 'text/plain' },
  { id: 'bare-auth', label: 'host:port:user:pass', extension: 'txt', mime: 'text/plain' },
  { id: 'bare', label: 'host:port', extension: 'txt', mime: 'text/plain' },
  { id: 'sub2api-json', label: 'sub2api JSON（数据导出）', extension: 'json', mime: 'application/json' },
]);

export function proxyExportFormat(formatId) {
  return PROXY_EXPORT_FORMATS.find((format) => format.id === formatId) ?? PROXY_EXPORT_FORMATS[0];
}

export function formatProxyLine(proxy, formatId) {
  const { protocol, host, port, username, password } = normalizeProxyFields(proxy);
  const hasAuth = username !== '' || password !== '';
  switch (formatId) {
    case 'url-auth':
      return hasAuth
        ? `${protocol}://${username}:${password}@${host}:${port}`
        : `${protocol}://${host}:${port}`;
    case 'url':
      return `${protocol}://${host}:${port}`;
    case 'bare-auth':
      return hasAuth ? `${host}:${port}:${username}:${password}` : `${host}:${port}`;
    case 'bare':
      return `${host}:${port}`;
    default:
      return null;
  }
}

// sub2api buildProxyKey：protocol|host|port|username|password
export function proxyExportKey(proxy) {
  const { protocol, host, port, username, password } = normalizeProxyFields(proxy);
  return `${protocol}|${host}|${port}|${username}|${password}`;
}

export function buildSub2ApiProxyPayload(proxies, exportedAt = new Date()) {
  return {
    type: 'sub2api-data',
    version: 1,
    exported_at: exportedAt.toISOString(),
    proxies: proxies.map((proxy) => {
      const { protocol, host, port, username, password } = normalizeProxyFields(proxy);
      return {
        proxy_key: proxyExportKey(proxy),
        name: String(proxy.name ?? ''),
        protocol,
        host,
        port,
        // 与 sub2api DataProxy 一致：username/password 为空时省略，expires_at 为 unix 秒
        ...(username !== '' ? { username } : {}),
        ...(password !== '' ? { password } : {}),
        status: String(proxy.status ?? 'active'),
        ...(proxy.expiresAt ? { expires_at: Math.floor(new Date(proxy.expiresAt).getTime() / 1000) } : {}),
      };
    }),
    accounts: [],
  };
}

// 选中代理 → 指定格式的导出内容（文本按行连接，JSON 走 sub2api 结构）
export function buildProxyExportContent(proxies, formatId, exportedAt = new Date()) {
  if (formatId === 'sub2api-json') {
    return JSON.stringify(buildSub2ApiProxyPayload(proxies, exportedAt), null, 2);
  }
  return proxies.map((proxy) => formatProxyLine(proxy, formatId)).join('\n');
}

function normalizeProxyFields(proxy) {
  return {
    protocol: String(proxy.protocol ?? 'http').trim(),
    host: String(proxy.host ?? '').trim(),
    port: Number(proxy.port),
    username: String(proxy.username ?? '').trim(),
    password: String(proxy.password ?? '').trim(),
  };
}
