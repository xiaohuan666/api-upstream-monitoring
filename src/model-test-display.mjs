const DOWN_STATUSES = new Set(['down', 'failed']);

export function modelTestDisplay(lastTest) {
  if (!lastTest) return { tone: 'unknown', label: '未知' };
  const status = String(lastTest.status ?? '').trim().toLowerCase();
  if (DOWN_STATUSES.has(status)) return { tone: 'down', label: '不通' };

  const latency = Number(lastTest.responseTimeMs);
  if (!Number.isFinite(latency)) return { tone: 'unknown', label: '未知' };
  if (latency < 3000) return { tone: 'fast', label: '快' };
  if (latency < 5000) return { tone: 'normal', label: '正常' };
  return { tone: 'slow', label: '慢' };
}
