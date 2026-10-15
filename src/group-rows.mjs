import { displayMultiplier } from './currency-display.mjs';

export function buildGroupRows(sites, snapshots) {
  return (sites ?? []).flatMap((site) => {
    const snapshot = snapshots?.[site.id] ?? { groups: [], tokens: [] };
    const tokens = Array.isArray(snapshot.tokens) ? snapshot.tokens : [];

    return (snapshot.groups ?? []).flatMap((group) => {
      const groupTokens = tokens.filter((token) => tokenBelongsToGroup(token, group));
      if (groupTokens.length === 0) {
        return [createGroupRow({ site, snapshot, group, token: null, tokenIndex: 0 })];
      }
      return groupTokens.map((token, tokenIndex) => (
        createGroupRow({ site, snapshot, group, token, tokenIndex })
      ));
    });
  });
}

function tokenBelongsToGroup(token, group) {
  return String(token?.groupId ?? token?.group_id ?? '') === String(group?.id ?? '');
}

function createGroupRow({ site, snapshot, group, token, tokenIndex }) {
  const tokenId = token ? String(token.id ?? token.name ?? 'token') : 'group';
  const hasToken = Boolean(token);
  const displayGroup = {
    ...group,
    multiplier: displayMultiplier({ site, snapshot, multiplier: group.multiplier }),
  };
  return {
    rowId: `${site.id}:${group.id}:${hasToken ? `token:${tokenId}:${tokenIndex}` : 'group'}`,
    site,
    snapshot,
    group: displayGroup,
    token,
    hasApiKey: hasToken,
    keyCount: hasToken ? 1 : 0,
  };
}
