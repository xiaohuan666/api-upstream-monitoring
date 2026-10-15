export class SnapshotReloadError extends Error {
  constructor(cause) {
    super(cause.message, { cause });
    this.name = 'SnapshotReloadError';
  }
}

export class StoredDataReloadError extends Error {
  constructor(failures) {
    const firstFailure = failures[0];
    super(firstFailure?.error?.message ?? '读取数据库数据失败', { cause: firstFailure?.error });
    this.name = 'StoredDataReloadError';
    this.failures = failures;
  }
}

export async function refreshActiveSnapshotAndReload({
  site,
  refreshSnapshot,
  reloadStoredSnapshots,
}) {
  if (!site) return { failures: [] };

  await refreshSnapshot(site);
  await reloadSnapshotState(reloadStoredSnapshots);
  return { failures: [] };
}

export async function refreshAllSnapshotsAndReload({
  sites,
  refreshSnapshot,
  reloadStoredSnapshots,
}) {
  const failures = [];

  for (const site of sites) {
    try {
      await refreshSnapshot(site);
    } catch (error) {
      failures.push({ site, error });
    }
  }

  await reloadSnapshotState(reloadStoredSnapshots);
  return { failures, total: sites.length };
}

async function reloadSnapshotState(reloadStoredSnapshots) {
  try {
    await reloadStoredSnapshots();
  } catch (error) {
    throw new SnapshotReloadError(error);
  }
}

export async function loadStoredDataCandidate({
  readSites,
  readGroupSettingsForSite,
  readSnapshotForSite,
}) {
  let sites;
  try {
    sites = await readSites();
  } catch (error) {
    return {
      sites: [],
      groupSettings: {},
      snapshots: {},
      failures: [{ site: null, domain: 'sites', error }],
    };
  }

  const failures = [];
  const groupSettings = {};
  const snapshots = {};
  const [groupResults, snapshotResults] = await Promise.all([
    Promise.all(sites.map(async (site) => {
      try {
        return { site, value: await readGroupSettingsForSite(site) };
      } catch (error) {
        return { site, error };
      }
    })),
    Promise.all(sites.map(async (site) => {
      try {
        return { site, value: await readSnapshotForSite(site) };
      } catch (error) {
        return { site, error };
      }
    })),
  ]);

  for (const result of groupResults) {
    if (result.error) failures.push({ site: result.site, domain: 'group-settings', error: result.error });
    else groupSettings[result.site.id] = result.value;
  }
  for (const result of snapshotResults) {
    if (result.error) failures.push({ site: result.site, domain: 'snapshot', error: result.error });
    else snapshots[result.site.id] = result.value;
  }

  return { sites, groupSettings, snapshots, failures };
}

export function buildTolerantSnapshots({ candidate, createErrorSnapshot }) {
  const failuresBySiteId = new Map(
    candidate.failures
      .filter((failure) => failure.domain === 'snapshot' && failure.site)
      .map((failure) => [failure.site.id, failure]),
  );
  return Object.fromEntries(candidate.sites.map((site) => {
    const failure = failuresBySiteId.get(site.id);
    return [site.id, failure ? createErrorSnapshot(site, failure.error) : candidate.snapshots[site.id]];
  }));
}

export async function reloadStoredDataStrict({ loadCandidate, buildReplacement, applyStoredData }) {
  const candidate = await loadCandidate();
  if (candidate.failures.length > 0) throw new StoredDataReloadError(candidate.failures);
  const replacement = buildReplacement(candidate);
  await applyStoredData(replacement);
  return replacement;
}

export async function reloadTablesFromDatabase({
  readSites,
  readGroupSettingsForSite,
  readSnapshotForSite,
  buildReplacement,
  applyStoredData,
}) {
  const candidate = await loadStoredDataCandidate({
    readSites,
    readGroupSettingsForSite,
    readSnapshotForSite,
  });
  const fatalFailures = candidate.failures.filter((failure) => failure.domain !== 'snapshot');
  if (fatalFailures.length > 0) throw new StoredDataReloadError(fatalFailures);

  const replacement = buildReplacement(candidate);
  await applyStoredData(replacement);
  return { replacement, failures: candidate.failures };
}

export function summarizeRefreshCompletion({ total, failures }) {
  const failureCount = failures.length;
  const successCount = Math.max(0, total - failureCount);

  if (failureCount === 0) {
    return {
      type: 'success',
      title: '同步完成',
      message: `已同步 ${total} 个上游，并刷新页面数据。`,
      duration: 3000,
    };
  }

  const failedNames = failures
    .slice(0, 3)
    .map(({ site }) => site.name ?? site.id)
    .join('、');
  const failedPreview = failureCount > 3 ? `${failedNames} 等` : failedNames;

  return {
    type: 'warning',
    title: '部分站点同步失败',
    message: `已同步 ${successCount}/${total} 个上游，失败 ${failureCount} 个站点：${failedPreview}`,
    duration: 5000,
  };
}
