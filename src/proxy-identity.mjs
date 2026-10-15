// URL 的 IPv6 序列化统一方括号、压缩形式和大小写；旧数据也走同一身份口径。
export function normalizeProxyHost(value) {
  const host = String(value ?? '').trim();
  if (!host.includes(':')) return host;
  const address = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return host;
  }
}

// 保留字段边界，避免凭据中的冒号让不同代理产生相同的去重键。
export function proxyDedupeKey(entry) {
  return JSON.stringify([
    normalizeProxyHost(entry.host),
    Number(entry.port),
    String(entry.username ?? ''),
    String(entry.password ?? ''),
  ]);
}
