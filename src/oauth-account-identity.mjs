/** Non-secret structured OAuth identity; account ID alone is a shared workspace, not a seat. */
export function readOAuthIdentity(credentials) {
  const part = (value) => typeof value === 'string' && value.trim() && value.length <= 1024 && !/[\s\x00-\x1f\x7f]/u.test(value)
    ? value : null;
  return { accountId: part(credentials?.chatgpt_account_id), userId: part(credentials?.chatgpt_user_id) };
}

export function compareOAuthIdentity(left, right) {
  if ((left.accountId && right.accountId && left.accountId !== right.accountId)
      || (left.userId && right.userId && left.userId !== right.userId)) return 'different';
  if (left.accountId && left.userId && right.accountId && right.userId) return 'same';
  return 'unknown';
}

const email = (value) => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim()) ? value.trim().toLowerCase() : null;

/** Display names are candidates for duplicate checks, never proof that a remote write succeeded. */
export function provesAccountEmail(account, expected) {
  const values = [account.credentials?.email, account.extra?.email, account.email]
    .filter((value) => value !== undefined && value !== null && value !== '');
  return values.length > 0 && values.every((value) => email(value) === expected);
}
