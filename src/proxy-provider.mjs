export const PROXY_PROVIDER_MAX_LENGTH = 100;

export function normalizeProxyProvider(value) {
  if (value != null && typeof value !== 'string') throw new Error('服务商必须是文本');
  const provider = String(value ?? '').trim();
  if (provider.length > PROXY_PROVIDER_MAX_LENGTH) {
    throw new Error(`服务商名称不能超过 ${PROXY_PROVIDER_MAX_LENGTH} 个字符`);
  }
  if (/\p{Cc}/u.test(provider)) {
    throw new Error('服务商名称不能包含控制字符');
  }
  return provider;
}

/** Return names in ascending order, filling the smallest available number first. */
export function allocateProxyProviderNames(provider, existingRows, count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid proxy count');
  const normalizedProvider = normalizeProxyProvider(provider);
  if (!normalizedProvider || count <= 0) return [];
  const prefix = `${normalizedProvider}-`;
  const providerNumbers = new Set();
  const usedNames = new Set();
  for (const row of existingRows ?? []) {
    const name = String(row?.name ?? '');
    usedNames.add(name);
    if (normalizeProxyProvider(row?.provider) !== normalizedProvider || !name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (/^\d+$/.test(suffix)) providerNumbers.add(Number(suffix));
  }
  const names = [];
  let number = 1;
  while (names.length < count) {
    const candidate = `${prefix}${String(number).padStart(3, '0')}`;
    if (!providerNumbers.has(number) && !usedNames.has(candidate)) {
      names.push(candidate);
      providerNumbers.add(number);
      usedNames.add(candidate);
    }
    number += 1;
  }
  return names;
}
