export const DEFAULT_USD_TO_CNY_RATE = 1;

export function displayMultiplier({ site, snapshot, multiplier }) {
  const value = Number(multiplier ?? 0);
  if (normalizeCurrency(snapshot?.balanceCurrency) !== 'USD') return value;
  return multiplyDecimalNumbers(value, siteUsdToCnyRate(site));
}

export function formatMultiplier(multiplier) {
  const value = Number(multiplier ?? 0);
  if (!Number.isFinite(value)) return '0';
  return decimalParts(value).text;
}

export function displayBalance({ site, snapshot }) {
  const amount = Number(
    snapshot?.balanceAmount
      ?? snapshot?.balanceCny
      ?? snapshot?.balanceUsd
      ?? 0,
  );
  const upstreamCurrency = normalizeCurrency(snapshot?.balanceCurrency);
  if (upstreamCurrency === 'USD') {
    return { amount: multiplyDecimalNumbers(amount, siteUsdToCnyRate(site)), currency: 'CNY' };
  }
  return { amount, currency: upstreamCurrency };
}

export function siteUsdToCnyRate(site) {
  const rate = Number(site?.usdToCnyRate ?? DEFAULT_USD_TO_CNY_RATE);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_TO_CNY_RATE;
}

// 预计归0：按最近两次成功探测的展示余额差值与时间差线性外推，精确到分钟
export function depletionEtaMinutes({ site, snapshot }) {
  const previous = snapshot?.previousBalance;
  if (!previous || snapshot?.error) return null;
  const refreshedAt = Date.parse(snapshot?.refreshedAt ?? '');
  const previousAt = Date.parse(previous.refreshedAt ?? '');
  const elapsedMs = refreshedAt - previousAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;

  const current = displayBalance({ site, snapshot });
  if (current.amount <= 0) return 0;
  const previousDisplay = displayBalance({
    site,
    snapshot: { balanceAmount: previous.amount, balanceCurrency: previous.currency },
  });
  const consumed = previousDisplay.amount - current.amount;
  if (consumed <= 0) return null;

  const minutes = (current.amount / consumed) * (elapsedMs / 60_000);
  return Number.isFinite(minutes) ? minutes : null;
}

export function depletionEtaDisplay({ site, snapshot }) {
  const minutes = depletionEtaMinutes({ site, snapshot });
  if (minutes === null) return '—';
  if (minutes === 0 && displayBalance({ site, snapshot }).amount <= 0) return '已归0';
  return formatDurationMinutes(minutes);
}

export function isDepletionAlert({ site, snapshot }) {
  const thresholdHours = Number(site?.depletionAlertHours ?? 1);
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) return false;
  const minutes = depletionEtaMinutes({ site, snapshot });
  return minutes !== null && minutes < thresholdHours * 60;
}

function formatDurationMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}分钟`;
  return `${hours}小时${rest}分钟`;
}

export function ceilToScale(value, scale = 4) {
  const safeScale = Number.isInteger(scale) && scale >= 0 ? scale : 4;
  const parts = decimalParts(value);
  if (parts.scale <= safeScale) return parts.text;
  const factor = 10n ** BigInt(parts.scale - safeScale);
  const quotient = parts.integer / factor;
  const remainder = parts.integer % factor;
  const ceiled = remainder !== 0n && parts.integer > 0n ? quotient + 1n : quotient;
  return formatScaledInteger(ceiled, safeScale);
}

function normalizeCurrency(value) {
  const currency = String(value ?? 'USD').trim().toUpperCase();
  return currency || 'USD';
}

function multiplyDecimalNumbers(left, right) {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  return Number(formatScaledInteger(
    leftParts.integer * rightParts.integer,
    leftParts.scale + rightParts.scale,
  ));
}

export function decimalParts(value) {
  const text = String(value).trim().toLowerCase();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(text);
  if (!match) return { integer: 0n, scale: 0, text: '0' };

  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  const digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  const scale = fraction.length - exponent;
  const integer = scale < 0
    ? sign * BigInt(`${digits}${'0'.repeat(-scale)}`)
    : sign * BigInt(digits);
  const normalizedScale = Math.max(scale, 0);

  return {
    integer,
    scale: normalizedScale,
    text: formatScaledInteger(integer, normalizedScale),
  };
}

export function formatScaledInteger(integer, scale) {
  const sign = integer < 0n ? '-' : '';
  const digits = (integer < 0n ? -integer : integer).toString();
  if (scale === 0) return `${sign}${digits}`;

  const padded = digits.padStart(scale + 1, '0');
  const decimalIndex = padded.length - scale;
  const text = `${sign}${padded.slice(0, decimalIndex)}.${padded.slice(decimalIndex)}`;
  return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
