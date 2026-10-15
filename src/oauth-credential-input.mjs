/**
 * 原子解析单行凭据；竖线格式优先，横线格式以完整、等长的连续横线段为边界。
 * 横线格式不能表达密码首尾横线，这类密码必须使用竖线输入。
 * 不校验账号或密钥业务有效性。
 */
export function parseOAuthCredentialInput(input) {
  if (typeof input !== 'string' || input.length > 4096) {
    throw new Error('请输入不超过 4096 字符的单行账号信息。');
  }
  // 只容忍复制一行时附带的行末换行，不对密码做 trim 或其他归一化。
  const line = input.replace(/\r?\n$/, '');
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(line)) {
    throw new Error('仅支持单个账号的一行信息，不能包含换行或控制字符。');
  }
  const hasPipe = /[|｜]/u.test(line);
  const separators = hasPipe ? null : line.match(/-{2,}/gu);
  // 等长检查只拒绝明显不一致；无法推测用户原密码，不能自动补回边界横线。
  if (!hasPipe && (!separators || separators.length !== 2 || separators[0] !== separators[1])) {
    throw new Error('横线格式需要两段等长的连续横线；密码首尾有横线时请用竖线格式。');
  }
  const parts = line.split(hasPipe ? /[|｜]/u : /-{2,}/u);
  if (parts.length !== 3 || parts.some((part) => !part.trim())) {
    throw new Error('请按账号、密码、2FA 密钥顺序填写恰好三段；使用连续横线或竖线分隔。字段不能含所选分隔符。');
  }
  return { email: parts[0].trim(), password: parts[1], totpSecret: parts[2].trim() };
}

/** 多行解析供界面仅展示计数；容量越界整批拒绝，绝不截断有效账号。 */
export function parseOAuthCredentialBatch(input) {
  if (typeof input !== 'string' || new TextEncoder().encode(input).byteLength > 128 * 1024) {
    throw new Error('批量输入不能超过 128 KiB，请拆分后重新解析。');
  }
  const accounts = [];
  const emails = new Set();
  let failureCount = 0;
  try {
    for (const line of input.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let account;
      try { account = parseOAuthCredentialInput(line); } catch { failureCount += 1; continue; }
      const key = account.email.toLowerCase();
      if (emails.has(key)) {
        account.password = ''; account.totpSecret = '';
        failureCount += 1;
        continue;
      }
      emails.add(key);
      accounts.push(account);
      if (accounts.length > 30) throw new Error('一批最多 30 个有效账号，请拆分后重新解析。');
    }
    return { accounts, successCount: accounts.length, failureCount };
  } catch (error) {
    for (const account of accounts) { account.password = ''; account.totpSecret = ''; }
    accounts.length = 0;
    throw error;
  }
}
