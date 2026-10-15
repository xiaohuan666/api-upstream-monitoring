import { mountOAuthSettings } from './oauth-settings-view.mjs';
import { mountOAuthTasks } from './oauth-tasks-view.mjs';
import { mountOAuthOnboarding } from './oauth-onboarding-view.mjs';
import {
  normalizePlatformDisplay,
  normalizeSiteUrl,
  summarizeFleet,
} from './domain.mjs';
import {
  SnapshotReloadError,
  buildTolerantSnapshots,
  loadStoredDataCandidate,
  refreshActiveSnapshotAndReload,
  refreshAllSnapshotsAndReload,
  reloadStoredDataStrict,
  reloadTablesFromDatabase,
  summarizeRefreshCompletion,
} from './client-refresh.mjs';
import {
  DEFAULT_AUTO_REFRESH_SETTINGS,
  normalizeAutoRefreshSettings,
  validateAutoRefreshRules,
} from './auto-refresh-settings.mjs';
import { createAutoRefreshRuleEditor } from './auto-refresh-rule-editor.mjs';
import { configureExternalLink } from './client-links.mjs';
import { APP_PATHS, resolveAppRoute } from './client-route.mjs';
import { createGroupRateView } from './group-rate-view.mjs';
import { PROXY_EXPORT_FORMATS, buildProxyExportContent, proxyExportFormat } from './proxy-export.mjs';
import { parseProxyImportText, proxyDedupeKey } from './proxy-import.mjs';
import { allocateProxyProviderNames, normalizeProxyProvider } from './proxy-provider.mjs';
import { depletionEtaDisplay, displayBalance, formatMultiplier, isDepletionAlert } from './currency-display.mjs';
import { buildGroupRows } from './group-rows.mjs';
import {
  DEFAULT_GROUP_FILTERS,
  GROUP_FILTER_FIELDS,
  normalizeGroupFilterPreset,
  normalizeGroupFilters,
  normalizeGroupViewPreferences,
} from './group-view-preferences.mjs';
import { modelTestDisplay } from './model-test-display.mjs';
import {
  enhanceSelect,
  initSearchableSelects,
  matchesSearchText,
} from './searchable-select.mjs';
import {
  normalizeSiteViewPreferences,
} from './site-view-preferences.mjs';

const GROUP_VIEW_PREFERENCES_ENDPOINT = '/api/ui-preferences/group-management';
const SITE_VIEW_PREFERENCES_ENDPOINT = '/api/ui-preferences/site-management';
const GROUP_FILTER_PRESETS_ENDPOINT = '/api/group-filter-presets';
// "分组"筛选里固定的"未分组"选项值（无任何映射账号的行）
const UNGROUPED_FILTER_VALUE = '__ungrouped__';
const AUTO_REFRESH_SETTINGS_ENDPOINT = '/api/auto-refresh-settings';

const pendingProxyTests = new Set();
const groupRateView = createGroupRateView({ document, window, copySiteUrl });
const oauthSettingsView = mountOAuthSettings(document.querySelector('#settings-oauth-onboarding-panel'));
const oauthTasksView = mountOAuthTasks(document.querySelector('#oauth-tasks-panel'));
const oauthOnboardingView = mountOAuthOnboarding(document.querySelector('#oauth-accounts-panel'), {
  onAccepted: (batchId) => navigateToPath(`${APP_PATHS.oauthTasks}?batch=${encodeURIComponent(batchId)}`),
});

const state = {
  sites: [],
  proxies: [],
  selectedProxyIds: new Set(),
  proxyBulkAction: null,
  proxyExportFormatId: PROXY_EXPORT_FORMATS[0].id,
  mySiteProxyLinks: [],
  snapshots: {},
  groupModelSettings: {},
  pendingModelTests: new Set(),
  batchModelTestPending: false,
  activeTab: 'sites',
  activeRouteId: 'sites',
  activeSetting: null,
  siteBalanceAlertOnly: false,
  sitesSiteFilter: [],
  sitesWatchFilter: 'all',
  editingSiteId: null,
  editingProxyId: null,
  editingGroupModel: null,
  ...DEFAULT_GROUP_FILTERS,
  groupSortKey: null,
  groupSortDirection: 'asc',
  groupFilterPresets: [],
  groupPresetName: '',
  editingGroupPresetName: null,
  autoRefreshSettings: { ...DEFAULT_AUTO_REFRESH_SETTINGS },
  mySites: [],
  mySitesLoaded: false,
  mySiteAccounts: [],
  mySiteGroupOptions: [],
  mySiteAccountSchedulable: {},
  mySiteAccountSchedulableLoaded: false,
  editingMySiteId: null,
  createAccountContext: null,
  createAccountRemoteGroups: [],
  createAccountGroupsRequest: null,
  linkedAccountsContext: null,
};

const elements = {
  tabButtons: [...document.querySelectorAll('.tab-button')],
  routeLinks: [...document.querySelectorAll('[data-route-link]')],
  configMenu: document.querySelector('.config-menu'),
  configManagementLink: document.querySelector('#config-management-link'),
  settingRouteLinks: [...document.querySelectorAll('[data-setting-route]')],
  groupSortButtons: [...document.querySelectorAll('[data-group-sort]')],
  sitesPanel: document.querySelector('#sites-panel'),
  groupsPanel: document.querySelector('#groups-panel'),
  settingsProxiesPanel: document.querySelector('#settings-proxies-panel'),
  ipManagementPanel: document.querySelector('#ip-management-panel'),
  ipManagementTable: document.querySelector('#ip-management-table'),
  settingsAutoRefreshPanel: document.querySelector('#settings-auto-refresh-panel'),
  settingsMySitesPanel: document.querySelector('#settings-my-sites-panel'),
  openSiteModal: document.querySelector('#open-site-modal'),
  siteModal: document.querySelector('#site-modal'),
  siteForm: document.querySelector('#site-form'),
  siteType: document.querySelector('#site-type'),
  siteSyncVariant: document.querySelector('#site-sync-variant'),
  siteProxyId: document.querySelector('#site-proxy-id'),
  modalTitle: document.querySelector('#site-modal-title'),
  modalSubmit: document.querySelector('#site-modal-submit'),
  closeModalButtons: [...document.querySelectorAll('[data-close-modal]')],
  proxyForm: document.querySelector('#proxy-form'),
  proxyFormTitle: document.querySelector('#proxy-form-title'),
  proxySubmit: document.querySelector('#proxy-submit'),
  proxyFormReset: document.querySelector('#proxy-form-reset'),
  proxiesTable: document.querySelector('#proxies-table'),
  openProxyImport: document.querySelector('#open-proxy-import'),
  proxyImportModal: document.querySelector('#proxy-import-modal'),
  proxyImportInput: document.querySelector('#proxy-import-input'),
  proxyImportProvider: document.querySelector('#proxy-import-provider'),
  proxyProviderOptions: document.querySelector('#proxy-provider-options'),
  proxyImportNaming: document.querySelector('#proxy-import-naming'),
  proxyImportExpiresAt: document.querySelector('#proxy-import-expires-at'),
  proxyImportStats: document.querySelector('#proxy-import-stats'),
  proxyImportSubmit: document.querySelector('#proxy-import-submit'),
  closeProxyImportButtons: [...document.querySelectorAll('[data-close-proxy-import-modal]')],
  bulkProxyTest: document.querySelector('#bulk-proxy-test'),
  bulkProxyMap: document.querySelector('#bulk-proxy-map'),
  bulkProxyDelete: document.querySelector('#bulk-proxy-delete'),
  openProxyExport: document.querySelector('#open-proxy-export'),
  proxyEditModal: document.querySelector('#proxy-edit-modal'),
  proxyEditForm: document.querySelector('#proxy-edit-form'),
  proxyEditContext: document.querySelector('#proxy-edit-context'),
  closeProxyEditButtons: [...document.querySelectorAll('[data-close-proxy-edit-modal]')],
  proxySelectAll: document.querySelector('#proxy-select-all'),
  proxyExportModal: document.querySelector('#proxy-export-modal'),
  proxyExportContext: document.querySelector('#proxy-export-context'),
  proxyExportFormats: document.querySelector('#proxy-export-formats'),
  proxyExportPreview: document.querySelector('#proxy-export-preview'),
  proxyExportDownload: document.querySelector('#proxy-export-download'),
  closeProxyExportButtons: [...document.querySelectorAll('[data-close-proxy-export-modal]')],
  autoRefreshForm: document.querySelector('#auto-refresh-form'),
  autoRefreshEnabled: document.querySelector('#auto-refresh-enabled'),
  autoRefreshIntervalValue: document.querySelector('#auto-refresh-interval-value'),
  autoRefreshIntervalUnit: document.querySelector('#auto-refresh-interval-unit'),
  autoRefreshSummary: document.querySelector('#auto-refresh-summary'),
  groupModelModal: document.querySelector('#group-model-modal'),
  groupModelForm: document.querySelector('#group-model-form'),
  groupModelTitle: document.querySelector('#group-model-modal-title'),
  groupModelSubtitle: document.querySelector('#group-model-modal-subtitle'),
  groupModelSelect: document.querySelector('#group-model-select'),
  groupTestModelSelect: document.querySelector('#group-test-model-select'),
  groupModelManual: document.querySelector('#group-model-manual'),
  addGroupModelOption: document.querySelector('#add-group-model-option'),
  fetchGroupModels: document.querySelector('#fetch-group-models'),
  closeGroupModelButtons: [...document.querySelectorAll('[data-close-group-model-modal]')],
  refreshAll: document.querySelector('#refresh-all'),
  refreshSites: document.querySelector('#refresh-sites'),
  refreshSitesTable: document.querySelector('#refresh-sites-table'),
  refreshGroupsTable: document.querySelector('#refresh-groups-table'),
  metricSites: document.querySelector('#metric-sites'),
  metricBalance: document.querySelector('#metric-balance'),
  metricBalanceAlerts: document.querySelector('#metric-balance-alerts'),
  sitesBalanceAlertFilter: document.querySelector('#sites-balance-alert-filter'),
  sitesWatchFilter: document.querySelector('#sites-watch-filter'),
  sitesTable: document.querySelector('#sites-table'),
  groupsTable: document.querySelector('#groups-table'),
  testAllFilteredModels: document.querySelector('#test-all-filtered-models'),
  groupPresetDropdown: document.querySelector('#group-preset-dropdown'),
  groupPresetTrigger: document.querySelector('#group-preset-trigger'),
  groupPresetLabel: document.querySelector('#group-preset-label'),
  groupPresetMenu: document.querySelector('#group-preset-menu'),
  saveGroupFilterPreset: document.querySelector('#save-group-filter-preset'),
  editGroupFilterPreset: document.querySelector('#edit-group-filter-preset'),
  deleteGroupFilterPreset: document.querySelector('#delete-group-filter-preset'),
  groupPresetModal: document.querySelector('#group-preset-modal'),
  groupPresetForm: document.querySelector('#group-preset-form'),
  groupPresetFields: document.querySelector('#group-preset-fields'),
  groupPresetName: document.querySelector('#group-preset-name'),
  groupPresetModalTitle: document.querySelector('#group-preset-modal-title'),
  groupPresetSubmit: document.querySelector('#group-preset-submit'),
  closeGroupPresetButtons: [...document.querySelectorAll('[data-close-group-preset-modal]')],
  toastRegion: document.querySelector('#toast-region'),
  mySiteForm: document.querySelector('#my-site-form'),
  mySiteFormTitle: document.querySelector('#my-site-form-title'),
  mySiteSubmit: document.querySelector('#my-site-submit'),
  mySiteFormReset: document.querySelector('#my-site-form-reset'),
  mySitesTable: document.querySelector('#my-sites-table'),
  createAccountModal: document.querySelector('#create-account-modal'),
  createAccountForm: document.querySelector('#create-account-form'),
  createAccountSubmit: document.querySelector('#create-account-submit'),
  createAccountContext: document.querySelector('#create-account-context'),
  createAccountExisting: document.querySelector('#create-account-existing'),
  createAccountMySite: document.querySelector('#create-account-my-site'),
  createAccountMyGroup: document.querySelector('#create-account-my-group'),
  createAccountResponsesField: document.querySelector('#create-account-responses-field'),
  createAccountResponsesMode: document.querySelector('#create-account-responses-mode'),
  createAccountPoolMode: document.querySelector('#create-account-pool-mode'),
  createAccountPoolRetryCount: document.querySelector('#create-account-pool-retry-count'),
  createAccountExcludedModels: document.querySelector('#create-account-excluded-models'),
  closeCreateAccountButtons: [...document.querySelectorAll('[data-close-create-account-modal]')],
  linkedAccountsModal: document.querySelector('#linked-accounts-modal'),
  linkedAccountsContext: document.querySelector('#linked-accounts-context'),
  linkedAccountsList: document.querySelector('#linked-accounts-list'),
  closeLinkedAccountsButtons: [...document.querySelectorAll('[data-close-linked-accounts-modal]')],
};

let toastCounter = 0;
const toastTimers = new Map();

function kebabCase(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

// 筛选控件注册表：key → 筛选栏控件 + 预设弹窗控件（弹窗控件由 renderGroupPresetFields 生成）
const groupFilterControls = {};
for (const field of GROUP_FILTER_FIELDS) {
  groupFilterControls[field.key] = {
    field,
    main: document.querySelector(`#${kebabCase(field.key)}`),
    preset: null,
  };
}

for (const link of elements.routeLinks) link.addEventListener('click', handleRouteLinkClick);
window.addEventListener('popstate', applyLocationRoute);

for (const button of elements.groupSortButtons) {
  button.addEventListener('click', () => {
    const key = button.dataset.groupSort;
    if (state.groupSortKey === key) {
      state.groupSortDirection = state.groupSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      state.groupSortKey = key;
      state.groupSortDirection = 'asc';
    }
    renderGroupsTable();
    renderGroupSortButtons();
    saveGroupViewPreferences();
  });
}

elements.openSiteModal.addEventListener('click', () => openSiteModal());
for (const button of elements.closeModalButtons) {
  button.addEventListener('click', () => closeSiteModal());
}
for (const button of elements.closeGroupModelButtons) {
  button.addEventListener('click', () => closeGroupModelModal());
}

elements.siteType.addEventListener('change', updateSiteFormRequirements);
elements.siteSyncVariant.addEventListener('change', updateSiteFormRequirements);
elements.siteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveSiteFromModal();
});
elements.proxyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveProxyFromModal();
});
elements.proxyFormReset.addEventListener('click', () => resetProxyForm());
elements.openProxyImport.addEventListener('click', () => openProxyImportModal());
elements.proxyImportInput.addEventListener('input', () => renderProxyImportStats());
elements.proxyImportProvider.addEventListener('input', () => renderProxyImportStats());
elements.proxyImportSubmit.addEventListener('click', () => importProxiesFromText());
for (const button of elements.closeProxyImportButtons) {
  button.addEventListener('click', () => closeProxyImportModal());
}
elements.bulkProxyTest.addEventListener('click', () => testSelectedProxies());
elements.bulkProxyMap.addEventListener('click', () => mapSelectedProxies());
elements.bulkProxyDelete.addEventListener('click', () => deleteSelectedProxies());
elements.openProxyExport.addEventListener('click', () => openProxyExportModal());
elements.proxyEditForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveProxyEditFromModal();
});
for (const button of elements.closeProxyEditButtons) {
  button.addEventListener('click', () => closeProxyEditModal());
}
elements.proxySelectAll.addEventListener('change', () => toggleSelectAllProxies());
elements.proxyExportDownload.addEventListener('click', () => downloadProxyExport());
for (const button of elements.closeProxyExportButtons) {
  button.addEventListener('click', () => closeProxyExportModal());
}
elements.mySiteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveMySiteFromForm();
});
elements.mySiteFormReset.addEventListener('click', () => resetMySiteForm());
for (const button of elements.closeCreateAccountButtons) {
  button.addEventListener('click', () => closeCreateAccountModal());
}
for (const button of elements.closeLinkedAccountsButtons) {
  button.addEventListener('click', () => closeLinkedAccountsModal());
}
elements.createAccountModal.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeCreateAccountModal();
});
elements.createAccountForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveMySiteAccountFromModal();
});
elements.createAccountMySite.addEventListener('change', () => {
  void loadCreateAccountRemoteGroups(elements.createAccountMySite.value);
});
elements.createAccountMyGroup.addEventListener('change', () => {
  updateCreateAccountOptionsVisibility();
});
const autoRefreshRuleEditor = createAutoRefreshRuleEditor({
  container: document.querySelector('#auto-refresh-rules'),
  addButton: document.querySelector('#auto-refresh-add-rule'),
  onChange: () => updateAutoRefreshSummary(),
});
elements.autoRefreshForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveAutoRefreshSettings();
});
elements.autoRefreshEnabled.addEventListener('change', () => updateAutoRefreshSummary());
elements.autoRefreshIntervalValue.addEventListener('input', () => updateAutoRefreshSummary());
elements.autoRefreshIntervalUnit.addEventListener('change', () => {
  updateAutoRefreshIntervalBounds();
  updateAutoRefreshSummary();
});
elements.groupModelForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveGroupModelFromModal();
});
elements.fetchGroupModels.addEventListener('click', () => fetchModelsForGroupModal());
elements.addGroupModelOption.addEventListener('click', () => addManualModelOption());

elements.refreshAll.addEventListener('click', refreshAllSitesAndReload);
elements.refreshSites.addEventListener('click', refreshAllSitesAndReload);
elements.refreshSitesTable.addEventListener('click', (event) => refreshTablesFromDatabase(event.currentTarget));
elements.metricBalanceAlerts.addEventListener('click', () => setSiteBalanceAlertOnly(true, { navigate: true }));
elements.sitesBalanceAlertFilter.addEventListener('change', (event) => {
  setSiteBalanceAlertOnly(event.currentTarget.checked);
});
elements.sitesWatchFilter.addEventListener('change', (event) => {
  state.sitesWatchFilter = normalizeSiteViewPreferences({ sitesWatchFilter: event.currentTarget.value }).sitesWatchFilter;
  renderSitesTable();
  saveSiteViewPreferences();
});
elements.refreshGroupsTable.addEventListener('click', (event) => refreshTablesFromDatabase(event.currentTarget));
elements.testAllFilteredModels.addEventListener('click', () => testAllFilteredGroupModels());

for (const { field, main } of Object.values(groupFilterControls)) {
  if (field.control === 'multiselect') continue;
  main.addEventListener(field.control === 'number' ? 'input' : 'change', () => {
    state[field.key] = field.normalize(main.value);
    setActiveGroupPreset('');
    if (field.key === 'groupSchedulableFilter') void ensureMySiteAccountSchedulable();
    renderGroupsTable();
    saveGroupViewPreferences();
  });
}

setupMyGroupFilterControl();
setupSiteFilterControl();

elements.groupPresetTrigger.addEventListener('click', () => toggleGroupPresetMenu());
document.addEventListener('click', (event) => {
  if (!elements.groupPresetDropdown.contains(event.target)) closeGroupPresetMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeGroupPresetMenu();
});

elements.saveGroupFilterPreset.addEventListener('click', () => openGroupPresetModal());
elements.editGroupFilterPreset.addEventListener('click', () => openGroupPresetModal(state.groupPresetName));
elements.deleteGroupFilterPreset.addEventListener('click', () => deleteGroupFilterPreset());
for (const button of elements.closeGroupPresetButtons) {
  button.addEventListener('click', () => closeGroupPresetModal());
}
elements.groupPresetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveGroupFilterPresetFromModal();
});

elements.siteModal.addEventListener('click', (event) => {
  if (event.target === elements.siteModal) closeSiteModal();
});
elements.groupModelModal.addEventListener('click', (event) => {
  if (event.target === elements.groupModelModal) closeGroupModelModal();
});
elements.groupPresetModal.addEventListener('click', (event) => {
  if (event.target === elements.groupPresetModal) closeGroupPresetModal();
});
elements.createAccountModal.addEventListener('click', (event) => {
  if (event.target === elements.createAccountModal) closeCreateAccountModal();
});
elements.proxyExportModal.addEventListener('click', (event) => {
  if (event.target === elements.proxyExportModal) closeProxyExportModal();
});
elements.proxyImportModal.addEventListener('click', (event) => {
  if (event.target === elements.proxyImportModal) closeProxyImportModal();
});
elements.proxyEditModal.addEventListener('click', (event) => {
  if (event.target === elements.proxyEditModal) closeProxyEditModal();
});

updateSiteFormRequirements();
initSearchableSelects();
renderGroupPresetFields();
applyLocationRoute();
loadInitialData();

for (const panel of ['#oauth-accounts-panel', '#oauth-tasks-panel']) {
  document.querySelector(panel).addEventListener('click', (event) => {
    const link = event.target.closest('a[data-route-link], a[data-oauth-create-link]');
    if (link) handleRouteLinkClick(event, link);
  });
}

function handleRouteLinkClick(event, link = event.currentTarget) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href, window.location.href);
  const targetRoute = resolveAppRoute(url.pathname);
  if (url.origin !== window.location.origin || !targetRoute) return;
  event.preventDefault();
  navigateToPath(`${url.pathname}${url.search}`);
}

function navigateToPath(pathname, { replace = false } = {}) {
  const targetRoute = resolveAppRoute(new URL(pathname, window.location.href).pathname);
  if (!targetRoute) return;
  if (replace) {
    window.history.replaceState({}, '', pathname);
  } else {
    window.history.pushState({}, '', pathname);
  }
  applyLocationRoute();
}

function applyLocationRoute() {
  const route = resolveAppRoute(window.location.pathname);
  if (!route) return;
  if (window.location.pathname !== route.canonicalPath) {
    window.history.replaceState(window.history.state ?? {}, '', route.canonicalPath);
  }
  state.activeRouteId = route.id;
  state.activeTab = route.section;
  state.activeSetting = route.setting ?? null;
  groupRateView.setRoute(route.section, window.location.search);
  if (route.section === 'oauth-accounts') void oauthOnboardingView.activate();
  else oauthOnboardingView.deactivate();
  if (route.section === 'oauth-tasks') void oauthTasksView.activate({ batchId: new URLSearchParams(window.location.search).get('batch') });
  else oauthTasksView.deactivate();
  if (route.setting === 'oauth-onboarding') void oauthSettingsView.activate();
  else oauthSettingsView.deactivate();
  state.siteBalanceAlertOnly = new URLSearchParams(window.location.search).has('balance-alert');
  render();
  maybeLoadMySitesData();
}

async function loadInitialData() {
  await loadGroupViewPreferences();
  await loadSiteViewPreferences();
  await loadAutoRefreshSettings();
  await loadProxiesFromApi();
  await loadMySiteProxyLinks();
  await loadMySiteAccounts();
  await loadMySiteGroupOptions();
  await ensureMySiteAccountSchedulable();
  await loadSitesFromApi();
  maybeLoadMySitesData();
}

async function loadGroupViewPreferences() {
  try {
    const [preferenceResponse, presetResponse] = await Promise.all([
      fetch(GROUP_VIEW_PREFERENCES_ENDPOINT, { cache: 'no-store' }),
      fetch(GROUP_FILTER_PRESETS_ENDPOINT, { cache: 'no-store' }),
    ]);
    if (!preferenceResponse.ok) throw new Error(`读取分组视图配置失败: HTTP ${preferenceResponse.status}`);
    const payload = await preferenceResponse.json().catch(() => ({}));
    applyGroupViewPreferences(payload.preference?.preferences ?? {});
    if (presetResponse.ok) {
      const presetPayload = await presetResponse.json().catch(() => ({}));
      state.groupFilterPresets = Array.isArray(presetPayload.presets) ? presetPayload.presets : [];
    }
  } catch (error) {
    console.warn(error);
  }
}

function applyGroupViewPreferences(preferences) {
  const normalized = normalizeGroupViewPreferences(preferences);
  state.groupSortKey = normalized.groupSortKey;
  state.groupSortDirection = normalized.groupSortDirection;
  Object.assign(state, normalizeGroupFilters(normalized));
}

function currentGroupViewPreferences() {
  return normalizeGroupViewPreferences({
    groupSortKey: state.groupSortKey,
    groupSortDirection: state.groupSortDirection,
    ...normalizeGroupFilters(state),
  });
}

async function saveGroupViewPreferences() {
  try {
    await fetch(GROUP_VIEW_PREFERENCES_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(currentGroupViewPreferences()),
    });
  } catch (error) {
    console.warn(error);
  }
}

async function loadSiteViewPreferences() {
  try {
    const response = await fetch(SITE_VIEW_PREFERENCES_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取站点视图配置失败: HTTP ${response.status}`);
    const payload = await response.json().catch(() => ({}));
    Object.assign(state, normalizeSiteViewPreferences(payload.preference?.preferences ?? {}));
  } catch (error) {
    console.warn(error);
  }
}

async function saveSiteViewPreferences() {
  try {
    await fetch(SITE_VIEW_PREFERENCES_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(normalizeSiteViewPreferences(state)),
    });
  } catch (error) {
    console.warn(error);
  }
}

async function loadAutoRefreshSettings() {
  try {
    const response = await fetch(AUTO_REFRESH_SETTINGS_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取定时拉取配置失败: HTTP ${response.status}`);
    const payload = await response.json().catch(() => ({}));
    applyAutoRefreshSettings(payload.preference?.preferences ?? {});
  } catch (error) {
    console.warn(error);
    applyAutoRefreshSettings(DEFAULT_AUTO_REFRESH_SETTINGS);
  }
}

function applyAutoRefreshSettings(settings) {
  state.autoRefreshSettings = normalizeAutoRefreshSettings(settings);
  renderAutoRefreshForm();
}

function renderAutoRefreshForm() {
  const settings = normalizeAutoRefreshSettings(state.autoRefreshSettings);
  const form = elements.autoRefreshForm.elements;
  form.enabled.checked = settings.enabled;
  form.interval_value.value = settings.intervalValue;
  form.interval_unit.value = settings.intervalUnit;
  autoRefreshRuleEditor.setRules(settings.rules);
  updateAutoRefreshIntervalBounds();
  updateAutoRefreshSummary(settings);
}

function updateAutoRefreshIntervalBounds() {
  const unit = elements.autoRefreshIntervalUnit.value;
  const min = unit === 'minutes' ? 5 : 1;
  elements.autoRefreshIntervalValue.min = String(min);
  const current = Number(elements.autoRefreshIntervalValue.value);
  if (!Number.isFinite(current) || current < min) {
    elements.autoRefreshIntervalValue.value = String(min);
  }
}

function updateAutoRefreshSummary(settings = readAutoRefreshFormInput()) {
  const normalized = normalizeAutoRefreshSettings(settings);
  elements.autoRefreshSummary.textContent = normalized.enabled
    ? `已启用 · ${normalized.rules.length} 条专属规则 · 其余站点每 ${normalized.intervalValue} ${autoRefreshUnitLabel(normalized.intervalUnit)}同步一次。`
    : '已关闭。';
}

async function saveAutoRefreshSettings() {
  const submit = document.querySelector('#auto-refresh-submit');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    const input = readAutoRefreshFormInput();
    validateAutoRefreshRules(input, state.sites);
    const settings = normalizeAutoRefreshSettings(input);
    const response = await fetch(AUTO_REFRESH_SETTINGS_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `保存定时拉取配置失败: HTTP ${response.status}`);
    applyAutoRefreshSettings(payload.preference?.preferences ?? settings);
    showToast({
      type: 'success',
      title: '定时拉取配置已保存',
      message: state.autoRefreshSettings.enabled
        ? `${state.autoRefreshSettings.rules.length} 条专属规则，其余站点每 ${state.autoRefreshSettings.intervalValue} ${autoRefreshUnitLabel(state.autoRefreshSettings.intervalUnit)}同步一次`
        : '已关闭定时拉取',
      duration: 2500,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '保存定时拉取失败',
      message: error.message,
      duration: 5000,
    });
  } finally {
    submit.disabled = false;
  }
}

function readAutoRefreshFormInput() {
  const formData = new FormData(elements.autoRefreshForm);
  return {
    enabled: formData.get('enabled') === 'on',
    intervalValue: Number(formData.get('interval_value')),
    intervalUnit: String(formData.get('interval_unit') ?? 'minutes'),
    rules: autoRefreshRuleEditor.getRules(),
  };
}

function autoRefreshUnitLabel(unit) {
  return {
    minutes: '分钟',
    hours: '小时',
    days: '天',
  }[unit] ?? '分钟';
}

async function loadProxiesFromApi() {
  try {
    const response = await fetch('/api/proxies', { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取代理失败: HTTP ${response.status}`);
    const payload = await response.json();
    state.proxies = payload.proxies ?? [];
    renderProxyProviderOptions();
    // 代理列表刷新后，丢掉已不存在的选择，避免导出脏数据
    const existingIds = new Set(state.proxies.map((proxy) => proxy.id));
    state.selectedProxyIds = new Set([...state.selectedProxyIds].filter((id) => existingIds.has(id)));
    renderSiteProxyOptions();
    renderProxiesTable();
  } catch (error) {
    state.proxies = [];
    state.selectedProxyIds = new Set();
    renderSiteProxyOptions();
    showTableError(elements.proxiesTable, 11, `读取代理失败: ${error.message}`);
    showTableError(elements.ipManagementTable, 12, `读取代理失败: ${error.message}`);
    syncProxySelectionUI();
  }
}

// IP 映射关系：监控侧代理 ↔ 我站点（sub2api）代理记录
async function loadMySiteProxyLinks() {
  try {
    const response = await fetch('/api/my-site-proxies', { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取 IP 映射失败: HTTP ${response.status}`);
    const payload = await response.json();
    state.mySiteProxyLinks = payload.links ?? [];
    renderProxiesTable();
  } catch (error) {
    console.warn(error);
    state.mySiteProxyLinks = [];
  }
}

function maybeLoadMySitesData() {
  void loadMySites();
}

async function loadMySites() {
  state.mySitesLoaded = true;
  try {
    const response = await fetch('/api/my-sites', { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取我的站点失败: HTTP ${response.status}`);
    const payload = await response.json();
    state.mySites = payload.mySites ?? [];
    renderMySitesTable();
  } catch (error) {
    state.mySites = [];
    showTableError(elements.mySitesTable, 6, `读取我的站点失败: ${error.message}`);
  }
}

async function loadMySiteAccounts() {
  try {
    const response = await fetch('/api/my-site-accounts', { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取站点账号失败: HTTP ${response.status}`);
    const payload = await response.json();
    state.mySiteAccounts = payload.accounts ?? [];
  } catch (error) {
    state.mySiteAccounts = [];
    console.warn(error);
  }
}

async function readSitesFromApi() {
  const response = await fetch('/api/sites', { cache: 'no-store' });
  if (!response.ok) throw new Error(`读取站点失败: HTTP ${response.status}`);
  const payload = await response.json();
  return payload.sites ?? [];
}

async function loadSitesFromApi() {
  try {
    await reloadTablesFromDatabase({
      readSites: readSitesFromApi,
      readGroupSettingsForSite: readGroupModelSettingsForSite,
      readSnapshotForSite: readStoredSnapshotFromApi,
      buildReplacement: buildTolerantTableReplacement,
      applyStoredData: applyLoadedTables,
    });
  } catch (error) {
    if (state.sites.length === 0) showTableError(elements.sitesTable, 11, `读取数据库失败: ${error.message}`);
  }
}

async function reloadSitesFromApi() {
  return await reloadStoredDataStrict({
    loadCandidate: loadDatabaseCandidate,
    buildReplacement: buildStrictTableReplacement,
    applyStoredData: applyLoadedTables,
  });
}

async function readGroupModelSettingsForSite(site) {
  const response = await fetch(`/api/sites/${encodeURIComponent(site.id)}/group-model-settings`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `读取分组模型配置失败: HTTP ${response.status}`);
  }
  const payload = await response.json();
  return payload.settings ?? [];
}

function indexGroupModelSettings(entryLists) {
  const settings = {};
  for (const entryList of entryLists) {
    for (const setting of entryList) {
      settings[groupSettingKey(setting.siteId, setting.groupId)] = setting;
    }
  }
  return settings;
}

async function readStoredSnapshotFromApi(site) {
  if (!isSnapshotSupported(site)) {
    return createPendingSnapshot(site, '其他类型暂不支持同步快照');
  }

  const response = await fetch(`/api/sites/${encodeURIComponent(site.id)}/snapshot`, {
    cache: 'no-store',
  });
  if (response.status === 404) {
    return createPendingSnapshot(site, '暂无已保存快照，点击同步');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `读取快照失败: HTTP ${response.status}`);
  }
  const payload = await response.json();
  return payload.snapshot;
}

function loadDatabaseCandidate() {
  return loadStoredDataCandidate({
    readSites: readSitesFromApi,
    readGroupSettingsForSite: readGroupModelSettingsForSite,
    readSnapshotForSite: readStoredSnapshotFromApi,
  });
}

function buildStrictTableReplacement(candidate) {
  return buildTableReplacement(candidate, candidate.snapshots);
}

function buildTolerantTableReplacement(candidate) {
  return buildTableReplacement(
    candidate,
    buildTolerantSnapshots({
      candidate,
      createErrorSnapshot: (site, error) => createErrorSnapshot(site, error.message),
    }),
  );
}

function buildTableReplacement(candidate, snapshots) {
  return {
    sites: candidate.sites,
    groupSettings: indexGroupModelSettings(Object.values(candidate.groupSettings)),
    snapshots,
  };
}

function applyLoadedTables({ sites, groupSettings, snapshots }) {
  state.sites = sites;
  autoRefreshRuleEditor.setSites(sites);
  groupRateView.setSites(sites);
  state.groupModelSettings = groupSettings;
  state.snapshots = snapshots;
  if (
    state.groupSiteFilter !== 'all'
    && !state.sites.some((site) => site.id === state.groupSiteFilter)
  ) {
    state.groupSiteFilter = 'all';
  }
  render();
}

async function createSite(input) {
  const response = await fetch('/api/sites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `新增站点失败: HTTP ${response.status}`);
  return payload.site;
}

async function updateSite(id, input) {
  const response = await fetch(`/api/sites/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `编辑站点失败: HTTP ${response.status}`);
  return payload.site;
}

async function deleteSiteFromApi(site) {
  const confirmed = window.confirm(`删除站点「${site.name}」？`);
  if (!confirmed) return;

  const response = await fetch(`/api/sites/${encodeURIComponent(site.id)}`, {
    method: 'DELETE',
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    window.alert(payload.error ?? `删除站点失败: HTTP ${response.status}`);
    return;
  }

  delete state.snapshots[site.id];
  await loadSitesFromApi();
}

async function refreshSiteSnapshotToDatabase(site) {
  if (!isSnapshotSupported(site)) {
    throw new Error('其他类型暂不支持同步快照');
  }

  const response = await fetch(`/api/sites/${encodeURIComponent(site.id)}/snapshot/refresh`, {
    method: 'POST',
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `刷新上游失败: HTTP ${response.status}`);
  return payload.snapshot;
}

async function refreshOneSiteAndReload(site, trigger = null) {
  trigger?.classList.add('is-refreshing');
  setRefreshControlsDisabled(true);
  try {
    await refreshActiveSnapshotAndReload({
      site,
      refreshSnapshot: refreshSiteSnapshotToDatabase,
      reloadStoredSnapshots: reloadSitesFromApi,
    });
    // 后端同步时会清理失效的"我的站点"映射账号，前端跟着重载让 ×N 计数即时更新
    await loadMySiteAccounts();
    state.mySiteAccountSchedulableLoaded = false;
    await ensureMySiteAccountSchedulable();
    renderGroupsTable();
  } catch (error) {
    if (error instanceof SnapshotReloadError) {
      showToast({ type: 'error', title: '同步失败', message: error.message, duration: 5000 });
      return;
    }
    state.snapshots[site.id] = createErrorSnapshot(site, error.message);
    render();
  } finally {
    void groupRateView.refreshAfterSnapshots();
    trigger?.classList.remove('is-refreshing');
    setRefreshControlsDisabled(false);
  }
}

async function refreshAllSitesAndReload() {
  setRefreshControlsDisabled(true);
  try {
    const result = await refreshAllSnapshotsAndReload({
      sites: [...state.sites],
      refreshSnapshot: refreshSiteSnapshotToDatabase,
      reloadStoredSnapshots: reloadSitesFromApi,
    });
    await loadMySiteAccounts();
    state.mySiteAccountSchedulableLoaded = false;
    await ensureMySiteAccountSchedulable();
    renderGroupsTable();
    showRefreshToast(summarizeRefreshCompletion(result));
  } catch (error) {
    showToast({
      type: 'error',
      title: '同步失败',
      message: error.message,
      duration: 5000,
    });
  } finally {
    void groupRateView.refreshAfterSnapshots();
    setRefreshControlsDisabled(false);
  }
}

async function refreshTablesFromDatabase(trigger) {
  trigger?.classList.add('is-refreshing');
  setRefreshControlsDisabled(true);
  try {
    const result = await reloadTablesFromDatabase({
      readSites: readSitesFromApi,
      readGroupSettingsForSite: readGroupModelSettingsForSite,
      readSnapshotForSite: readStoredSnapshotFromApi,
      buildReplacement: buildTolerantTableReplacement,
      applyStoredData: applyLoadedTables,
    });
    await loadMySiteAccounts();
    await loadMySiteGroupOptions();
    await ensureMySiteAccountSchedulable({ force: true });
    renderGroupsTable();
    if (result.failures.length === 0) {
      showToast({
        type: 'success',
        title: '表格已刷新',
        message: '已重新读取数据库中的站点、分组和快照。',
        duration: 2500,
      });
    } else {
      showToast({
        type: 'warning',
        title: '表格已部分刷新',
        message: `已刷新数据库数据，但 ${result.failures.length} 个站点快照读取失败。`,
        duration: 5000,
      });
    }
  } catch (error) {
    showToast({ type: 'error', title: '刷新表格失败', message: error.message, duration: 5000 });
  } finally {
    void groupRateView.refreshAfterSnapshots();
    trigger?.classList.remove('is-refreshing');
    setRefreshControlsDisabled(false);
  }
}

function setRefreshControlsDisabled(disabled) {
  elements.refreshAll.disabled = disabled;
  elements.refreshSites.disabled = disabled;
  elements.refreshSitesTable.disabled = disabled;
  elements.refreshGroupsTable.disabled = disabled;
  for (const button of document.querySelectorAll('[data-action="refresh"], .balance-refresh')) {
    button.disabled = disabled;
  }
}

function showRefreshToast(summary) {
  showToast(summary);
}

async function copyApiKey(key) {
  const value = String(key ?? '');
  if (!value) {
    showToast({
      type: 'warning',
      title: '没有可复制的 API Key',
      message: '当前行没有拿到 API Key 明文。',
      duration: 3000,
    });
    return;
  }

  try {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
    await navigator.clipboard.writeText(value);
    showToast({
      type: 'success',
      title: 'API Key 已复制',
      message: '已复制到剪贴板。',
      duration: 2500,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '复制 API Key 失败',
      message: error.message,
      duration: 5000,
    });
  }
}

async function copySiteUrl(url) {
  const value = String(url ?? '');
  if (!value) {
    showToast({
      type: 'warning',
      title: '没有可复制的链接',
      message: '当前行没有站点 URL。',
      duration: 3000,
    });
    return;
  }

  try {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
    await navigator.clipboard.writeText(value);
    showToast({
      type: 'success',
      title: '链接已复制',
      message: value,
      duration: 2500,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '复制链接失败',
      message: error.message,
      duration: 5000,
    });
  }
}

function copySiteUrlButtonHtml(url) {
  return `
    <button
      class="model-action copy-site-url"
      type="button"
      data-action="copy-site-url"
      data-url="${escapeAttribute(url)}"
      title="复制链接"
      aria-label="复制链接"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 8h11v11H8zM5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" />
      </svg>
    </button>
  `;
}

function showToast({ type = 'success', title, message, duration = 3000 }) {
  if (!elements.toastRegion) return;

  const id = `toast-${++toastCounter}`;
  const toast = document.createElement('section');
  toast.className = `toast ${type}`;
  toast.dataset.toastId = id;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const content = document.createElement('div');
  content.className = 'toast-content';

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = toastIconSvg(type);

  const copy = document.createElement('div');
  const titleNode = document.createElement('p');
  titleNode.className = 'toast-title';
  titleNode.textContent = title;
  const messageNode = document.createElement('p');
  messageNode.className = 'toast-message';
  messageNode.textContent = message;
  copy.append(titleNode, messageNode);

  const closeButton = document.createElement('button');
  closeButton.className = 'toast-close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭通知');
  closeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>';
  closeButton.addEventListener('click', () => dismissToast(id));

  content.append(icon, copy);
  toast.append(content, closeButton);

  if (duration > 0) {
    const progress = document.createElement('span');
    progress.className = 'toast-progress';
    progress.style.animationDuration = `${duration}ms`;
    toast.append(progress);
    toastTimers.set(id, window.setTimeout(() => dismissToast(id), duration));
  }

  elements.toastRegion.append(toast);
}

function dismissToast(id) {
  const toast = elements.toastRegion?.querySelector(`[data-toast-id="${id}"]`);
  if (!toast) return;

  const timer = toastTimers.get(id);
  if (timer) window.clearTimeout(timer);
  toastTimers.delete(id);

  toast.classList.add('is-exiting');
  window.setTimeout(() => {
    toast.remove();
  }, 180);
}

function toastIconSvg(type) {
  if (type === 'warning') {
    return '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z" /></svg>';
  }
  if (type === 'error') {
    return '<svg viewBox="0 0 24 24"><path d="M15 9l-6 6M9 9l6 6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>';
  }
  return '<svg viewBox="0 0 24 24"><path d="m7 12 3 3 7-7M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>';
}

function openGroupModelModal(site, group) {
  const setting = getGroupModelSetting(site.id, group.id);
  state.editingGroupModel = {
    site,
    group,
    modelOptions: mergeModelOptions(setting?.modelOptions ?? [], setting?.selectedModel ?? '', setting?.testModel ?? ''),
  };
  elements.groupModelTitle.textContent = '编辑分组模型';
  elements.groupModelSubtitle.textContent = `${site.name} / ${group.name}`;
  elements.groupModelManual.value = '';
  renderGroupModelSelects({
    selectedModel: setting?.selectedModel ?? '',
    testModel: setting?.testModel ?? '',
  });
  elements.groupModelModal.showModal();
  elements.groupModelSelect.focus();
}

function closeGroupModelModal() {
  state.editingGroupModel = null;
  elements.groupModelModal.close();
}

function applyGroupFilterPreset(name) {
  const preset = state.groupFilterPresets.find((item) => item.name === name);
  if (!preset) return;
  Object.assign(state, normalizeGroupFilters(preset));
  state.groupPresetName = preset.name;
  renderGroupFilters();
  // 预设可能打开"可调度"筛选：映射账号状态是按需拉取的，应用预设时也要触发
  void ensureMySiteAccountSchedulable();
  renderGroupsTable();
  saveGroupViewPreferences();
}

function renderGroupPresetFields() {
  const nameLabel = elements.groupPresetFields.firstElementChild;
  const labels = Object.values(groupFilterControls).map((control) => {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = control.field.label;
    control.preset = buildPresetControl(control.field);
    label.append(span, control.preset);
    if (control.field.control === 'select') enhanceSelect(control.preset);
    return label;
  });
  elements.groupPresetFields.replaceChildren(nameLabel, ...labels);
}

function buildPresetControl(field) {
  if (field.control === 'number') {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.001';
    input.id = `preset-${kebabCase(field.key)}`;
    return input;
  }
  const select = document.createElement('select');
  select.id = `preset-${kebabCase(field.key)}`;
  if (field.control === 'multiselect') {
    select.multiple = true;
    return select;
  }
  if (field.options) {
    select.replaceChildren(...field.options.map(([value, label]) => optionElement(value, label)));
  }
  return select;
}

function openGroupPresetModal(editingName = '') {
  state.editingGroupPresetName = editingName || null;
  elements.groupPresetModalTitle.textContent = state.editingGroupPresetName ? '编辑筛选预设' : '保存筛选预设';
  elements.groupPresetSubmit.textContent = state.editingGroupPresetName ? '保存修改' : '保存预设';
  elements.groupPresetName.value = state.editingGroupPresetName ?? '';
  for (const { field, main, preset } of Object.values(groupFilterControls)) {
    if (field.control === 'multiselect') {
      const selected = new Set(state[field.key]);
      preset.replaceChildren(
        ...myGroupFilterOptions().map((option) => {
          const element = optionElement(option.value, option.label);
          element.selected = selected.has(option.value);
          return element;
        }),
      );
      continue;
    }
    if (field.control === 'select' && field.source) {
      preset.replaceChildren(...[...main.options].map((option) => option.cloneNode(true)));
    }
    preset.value = String(state[field.key]);
    if (field.control === 'select' && ![...preset.options].some((option) => option.value === preset.value)) {
      preset.value = 'all';
    }
  }
  elements.groupPresetModal.showModal();
  elements.groupPresetName.focus();
}

function closeGroupPresetModal() {
  state.editingGroupPresetName = null;
  elements.groupPresetModal.close();
}

async function saveGroupFilterPresetFromModal() {
  const editingName = state.editingGroupPresetName;
  const name = String(elements.groupPresetName.value ?? '').trim();
  if (!name) {
    elements.groupPresetName.focus();
    return;
  }
  const input = { name };
  for (const { field, preset } of Object.values(groupFilterControls)) {
    input[field.key] = field.control === 'multiselect'
      ? [...preset.selectedOptions].map((option) => option.value)
      : preset.value;
  }
  const preset = normalizeGroupFilterPreset(input);
  try {
    const response = await fetch(GROUP_FILTER_PRESETS_ENDPOINT, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...preset, originalName: editingName || undefined }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.warn(error);
    showToast({
      type: 'error',
      title: '保存预设失败',
      message: `筛选预设「${preset.name}」保存失败，请重试`,
      duration: 4000,
    });
    return;
  }
  if (editingName && editingName !== preset.name) {
    state.groupFilterPresets = state.groupFilterPresets.filter((item) => item.name !== editingName);
  }
  const existingIndex = state.groupFilterPresets.findIndex((item) => item.name === preset.name);
  if (existingIndex >= 0) {
    state.groupFilterPresets[existingIndex] = preset;
  } else {
    state.groupFilterPresets.push(preset);
  }
  setActiveGroupPreset(preset.name);
  closeGroupPresetModal();
  showToast({
    type: 'success',
    title: '预设已保存',
    message: `筛选预设「${preset.name}」已保存`,
    duration: 3000,
  });
}

async function deleteGroupFilterPreset() {
  const name = state.groupPresetName;
  if (!name) return;
  const confirmed = window.confirm(`删除筛选预设「${name}」？`);
  if (!confirmed) return;
  try {
    const response = await fetch(GROUP_FILTER_PRESETS_ENDPOINT, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.warn(error);
    showToast({
      type: 'error',
      title: '删除预设失败',
      message: `筛选预设「${name}」删除失败，请重试`,
      duration: 4000,
    });
    return;
  }
  state.groupFilterPresets = state.groupFilterPresets.filter((item) => item.name !== name);
  setActiveGroupPreset('');
  showToast({
    type: 'success',
    title: '预设已删除',
    message: `筛选预设「${name}」已删除`,
    duration: 3000,
  });
}

async function fetchModelsForGroupModal() {
  const editing = state.editingGroupModel;
  if (!editing) return;
  elements.fetchGroupModels.disabled = true;
  elements.fetchGroupModels.classList.add('is-refreshing');
  try {
    const response = await fetch(
      `/api/sites/${encodeURIComponent(editing.site.id)}/models?groupId=${encodeURIComponent(editing.group.id)}`,
      {
        cache: 'no-store',
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `拉取模型失败: HTTP ${response.status}`);
    editing.modelOptions = mergeModelOptions(
      editing.modelOptions,
      elements.groupModelSelect.value,
      elements.groupTestModelSelect.value,
      payload.models ?? [],
    );
    renderGroupModelSelects({
      selectedModel: elements.groupModelSelect.value,
      testModel: elements.groupTestModelSelect.value,
    });
    showToast({
      type: 'success',
      title: '模型列表已更新',
      message: `拉取到 ${payload.models?.length ?? 0} 个模型。`,
      duration: 3000,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '拉取模型失败',
      message: error.message,
      duration: 5000,
    });
  } finally {
    elements.fetchGroupModels.disabled = false;
    elements.fetchGroupModels.classList.remove('is-refreshing');
  }
}

function addManualModelOption() {
  const editing = state.editingGroupModel;
  if (!editing) return;
  const model = elements.groupModelManual.value.trim();
  if (!model) return;
  editing.modelOptions = mergeModelOptions(editing.modelOptions, model, [{ id: model, ownedBy: 'manual' }]);
  elements.groupModelManual.value = '';
  renderGroupModelSelects({
    selectedModel: model,
    testModel: elements.groupTestModelSelect.value || model,
  });
}

async function saveGroupModelFromModal() {
  const editing = state.editingGroupModel;
  if (!editing) return;
  const selectedModel = elements.groupModelSelect.value.trim();
  const testModel = elements.groupTestModelSelect.value.trim();
  const modelOptions = mergeModelOptions(editing.modelOptions, selectedModel, testModel);
  try {
    const response = await fetch(
      `/api/sites/${encodeURIComponent(editing.site.id)}/group-model-settings`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: editing.group.id, selectedModel, testModel, modelOptions }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `保存模型失败: HTTP ${response.status}`);
    state.groupModelSettings[groupSettingKey(payload.setting.siteId, payload.setting.groupId)] = payload.setting;
    closeGroupModelModal();
    renderGroupFilters();
    renderGroupsTable();
    showToast({
      type: 'success',
      title: '模型选择已保存',
      message: selectedModel || '已清空该分组使用模型。',
      duration: 3000,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '保存模型失败',
      message: error.message,
      duration: 5000,
    });
  }
}

async function runGroupModelTest(site, group) {
  const pendingKey = groupSettingKey(site.id, group.id);
  state.pendingModelTests.add(pendingKey);
  try {
    const response = await fetch(
      `/api/sites/${encodeURIComponent(site.id)}/group-model-test`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: group.id, platform: normalizePlatformDisplay(group.platform).key }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `测试模型失败: HTTP ${response.status}`);
    state.groupModelSettings[groupSettingKey(payload.setting.siteId, payload.setting.groupId)] = payload.setting;
    return payload.result;
  } finally {
    state.pendingModelTests.delete(pendingKey);
  }
}

async function testGroupModel(site, group) {
  const setting = getGroupModelSetting(site.id, group.id);
  const model = setting?.testModel || setting?.selectedModel || '';
  if (!model) {
    showToast({
      type: 'warning',
      title: '未选择模型',
      message: '先在分组编辑里选择或手动添加一个测试模型。',
      duration: 4000,
    });
    return;
  }

  const pendingKey = groupSettingKey(site.id, group.id);
  if (state.pendingModelTests.has(pendingKey)) {
    showToast({
      type: 'warning',
      title: '测速进行中',
      message: `${site.name} / ${group.name} 正在测速，完成后会自动通知。`,
      duration: 3000,
    });
    return;
  }

  try {
    const testing = runGroupModelTest(site, group);
    renderGroupsTable();
    const result = await testing;
    showToast({
      type: result.success ? 'success' : 'warning',
      title: result.success ? '模型测试完成' : '模型测试失败',
      message: `${site.name} / ${group.name} · ${result.modelUsed}: ${result.responseTimeMs ?? '-'} ms`,
      duration: 4000,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '模型测试失败',
      message: `${site.name} / ${group.name} · ${error.message}`,
      duration: 5000,
    });
  } finally {
    renderGroupsTable();
  }
}

async function testAllFilteredGroupModels() {
  if (state.batchModelTestPending) return;
  const candidates = filteredGroups().filter(({ site, group }) => {
    const setting = getGroupModelSetting(site.id, group.id);
    return Boolean(setting?.testModel || setting?.selectedModel)
      && !state.pendingModelTests.has(groupSettingKey(site.id, group.id));
  });
  if (candidates.length === 0) {
    showToast({
      type: 'warning',
      title: '无可测速分组',
      message: '当前筛选结果里没有已配置测试模型的分组。',
      duration: 4000,
    });
    return;
  }

  state.batchModelTestPending = true;
  syncTestAllButton();
  showToast({
    type: 'success',
    title: '批量测速开始',
    message: `将测试当前筛选出的 ${candidates.length} 个分组。`,
    duration: 3000,
  });

  const results = await runWithConcurrency(candidates, 3, async ({ site, group }) => {
    try {
      const result = await runGroupModelTest(site, group);
      return { ok: Boolean(result.success) };
    } catch {
      return { ok: false };
    } finally {
      renderGroupsTable();
    }
  });

  const okCount = results.filter((result) => result.ok).length;
  state.batchModelTestPending = false;
  syncTestAllButton();
  renderGroupsTable();
  showToast({
    type: okCount === results.length ? 'success' : 'warning',
    title: '批量测速完成',
    message: `成功 ${okCount}/${results.length} 个分组。`,
    duration: 5000,
  });
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function syncTestAllButton() {
  const button = elements.testAllFilteredModels;
  if (!button) return;
  button.disabled = state.batchModelTestPending;
  button.classList.toggle('is-refreshing', state.batchModelTestPending);
}

function renderGroupModelSelects({ selectedModel = '', testModel = '' } = {}) {
  const editing = state.editingGroupModel;
  if (!editing) return;
  const options = mergeModelOptions(editing.modelOptions, selectedModel, testModel);
  editing.modelOptions = options;
  const optionNodes = [
    optionElement('', '未选择'),
    ...options.map((model) => optionElement(model.id, model.id)),
  ];
  elements.groupModelSelect.replaceChildren(...optionNodes.map((option) => option.cloneNode(true)));
  elements.groupTestModelSelect.replaceChildren(...optionNodes.map((option) => option.cloneNode(true)));
  elements.groupModelSelect.value = selectedModel || '';
  elements.groupTestModelSelect.value = testModel || selectedModel || '';
}

function openSiteModal(site = null) {
  state.editingSiteId = site?.id ?? null;
  elements.modalTitle.textContent = site ? '编辑站点' : '新增站点';
  elements.modalSubmit.textContent = site ? '保存修改' : '保存站点';
  elements.siteForm.reset();
  renderSiteProxyOptions();
  const form = elements.siteForm.elements;
  form.name.value = site?.name ?? '';
  form.url.value = site?.url ?? '';
  form.base_url.value = site?.baseUrl ?? '';
  form.type.value = site?.type ?? 'sub2api';
  form.sync_variant.value = site?.syncVariant ?? 'standard';
  form.username.value = site?.username ?? '';
  form.new_api_user_id.value = site?.newApiUserId ?? '';
  form.password.value = site?.password ?? '';
  form.auth_token.value = site?.authToken ?? '';
  form.refresh_token.value = site?.refreshToken ?? '';
  form.usd_to_cny_rate.value = site?.usdToCnyRate ?? 1;
  form.balance_alert.value = site?.balanceAlert ?? 0;
  form.depletion_alert_hours.value = site?.depletionAlertHours ?? 1;
  form.proxy_id.value = site?.proxyId ?? '';
  updateSiteFormRequirements();
  elements.siteModal.showModal();
  form.name.focus();
}

function closeSiteModal() {
  state.editingSiteId = null;
  elements.siteModal.close();
}

async function saveSiteFromModal() {
  const input = readSiteFormInput();
  if (input.type === 'new-api' && !input.new_api_user_id) {
    window.alert('User id is required for new-api');
    return;
  }
  if (input.type === 'sub2api' && input.sync_variant === 'credential-flow' && (!input.username || !input.password)) {
    window.alert('Login username and password are required for credential-flow sub2api');
    return;
  }
  try {
    if (state.editingSiteId) {
      await updateSite(state.editingSiteId, input);
    } else {
      await createSite(input);
    }
    closeSiteModal();
    await loadSitesFromApi();
  } catch (error) {
    window.alert(error.message);
  }
}

function resetProxyForm() {
  state.editingProxyId = null;
  elements.proxyForm.reset();
  elements.proxyForm.elements.protocol.value = 'http';
  elements.proxyForm.elements.status.value = 'active';
  elements.proxyFormTitle.textContent = '代理配置';
  elements.proxySubmit.textContent = '保存代理';
}

async function saveProxyFromModal() {
  const input = readProxyFormInput();
  try {
    if (state.editingProxyId) {
      await updateProxy(state.editingProxyId, input);
    } else {
      await createProxy(input);
    }
    resetProxyForm();
    await loadProxiesFromApi();
    await loadSitesFromApi();
    showToast({
      type: 'success',
      title: '代理配置已保存',
      message: input.name,
      duration: 2500,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '保存代理失败',
      message: error.message,
      duration: 5000,
    });
  }
}

function readProxyFormInput(form = elements.proxyForm) {
  const formData = new FormData(form);
  return {
    name: String(formData.get('name') ?? '').trim(),
    provider: String(formData.get('provider') ?? '').trim(),
    protocol: String(formData.get('protocol') ?? 'http'),
    host: String(formData.get('host') ?? '').trim(),
    port: Number(formData.get('port')),
    username: String(formData.get('username') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
    status: String(formData.get('status') ?? 'active'),
    expiresAt: String(formData.get('expires_at') ?? ''),
  };
}

function readSiteFormInput() {
  const formData = new FormData(elements.siteForm);
  const type = String(formData.get('type'));
  return {
    name: String(formData.get('name')).trim(),
    url: normalizeSiteUrl(formData.get('url')),
    base_url: normalizeSiteUrl(formData.get('base_url')),
    type,
    username: String(formData.get('username')).trim(),
    new_api_user_id: String(formData.get('new_api_user_id') ?? '').trim(),
    sync_variant: type === 'sub2api'
      ? String(formData.get('sync_variant') ?? 'standard').trim()
      : 'standard',
    password: String(formData.get('password')),
    auth_token: String(formData.get('auth_token') ?? '').trim(),
    refresh_token: String(formData.get('refresh_token') ?? '').trim(),
    usd_to_cny_rate: Number(formData.get('usd_to_cny_rate') ?? 1),
    balance_alert: Number(formData.get('balance_alert') ?? 0),
    depletion_alert_hours: Number(formData.get('depletion_alert_hours') ?? 1),
    proxy_id: String(formData.get('proxy_id') ?? '').trim(),
  };
}

async function createProxy(input) {
  const response = await fetch('/api/proxies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `新增代理失败: HTTP ${response.status}`);
  return payload.proxy;
}

async function updateProxy(id, input) {
  const response = await fetch(`/api/proxies/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `编辑代理失败: HTTP ${response.status}`);
  return payload.proxy;
}

async function deleteProxy(proxy) {
  const confirmed = window.confirm(`删除代理「${proxy.name}」？关联站点会改为直连。`);
  if (!confirmed) return;
  const response = await fetch(`/api/proxies/${encodeURIComponent(proxy.id)}`, { method: 'DELETE' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    showToast({
      type: 'error',
      title: '删除代理失败',
      message: payload.error ?? `HTTP ${response.status}`,
      duration: 5000,
    });
    return;
  }
  await loadProxiesFromApi();
  await loadSitesFromApi();
}

// 批量导入：弹窗内实时解析统计（参考 sub2api 的批量模式），提交后按服务端去重结果反馈
function openProxyImportModal() {
  renderProxyProviderOptions();
  // 统一到期时间默认当前时间 +30 天（用户可改可清空）
  if (!elements.proxyImportExpiresAt.value) {
    elements.proxyImportExpiresAt.value = toDatetimeLocalValue(
      new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    );
  }
  renderProxyImportStats();
  elements.proxyImportModal.showModal();
  elements.proxyImportInput.focus();
}

function closeProxyImportModal() {
  elements.proxyImportModal.close();
}

function renderProxyImportStats() {
  const result = parseProxyImportText(elements.proxyImportInput.value, state.proxies);
  let provider;
  try {
    provider = normalizeProxyProvider(elements.proxyImportProvider.value);
    const examples = allocateProxyProviderNames(provider, state.proxies, Math.min(result.valid, 3));
    elements.proxyImportNaming.textContent = provider
      ? (examples.length ? `命名示例：${examples.join('、')}。先去重再补号，实际以保存时为准。` : '没有待导入的新代理；重复代理跳过且不占编号。')
      : '留空沿用原命名方式；填写后按「服务商-001」命名，自动优先补齐空号。';
    elements.proxyImportProvider.setCustomValidity('');
  } catch (error) {
    elements.proxyImportNaming.textContent = error.message;
    elements.proxyImportProvider.setCustomValidity(error.message);
  }
  if (result.total === 0) {
    elements.proxyImportStats.textContent = '等待输入…';
    elements.proxyImportSubmit.disabled = true;
    elements.proxyImportSubmit.textContent = '导入';
    return;
  }
  elements.proxyImportStats.textContent = `共 ${result.total} 行：待导入 ${result.valid} · 重复（含已有）${result.duplicate} · 无效 ${result.invalid}`;
  elements.proxyImportSubmit.disabled = result.valid === 0 || provider === undefined || proxyImportPending;
  elements.proxyImportSubmit.textContent = result.valid > 0 ? `导入 ${result.valid} 个代理` : '导入';
}

let proxyImportPending = false;
async function importProxiesFromText() {
  if (proxyImportPending) return;
  const result = parseProxyImportText(elements.proxyImportInput.value, state.proxies);
  if (result.valid === 0) return;
  proxyImportPending = true;
  elements.proxyImportSubmit.disabled = true;
  try {
    const provider = normalizeProxyProvider(elements.proxyImportProvider.value);
    const expiresAt = elements.proxyImportExpiresAt.value
      ? new Date(elements.proxyImportExpiresAt.value).toISOString()
      : null;
    const proxies = result.proxies.map((proxy) => ({ ...proxy, expiresAt }));
    const response = await fetch('/api/proxies/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proxies, provider }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `批量导入失败: HTTP ${response.status}`);
    await loadProxiesFromApi();
    elements.proxyImportInput.value = '';
    renderProxyImportStats();
    const details = [`新增 ${payload.created ?? 0} 个`];
    if (payload.skipped > 0) details.push(`已存在跳过 ${payload.skipped} 个`);
    if (result.duplicate > 0) details.push(`预先去重 ${result.duplicate} 个`);
    if (result.invalid > 0) details.push(`格式无效 ${result.invalid} 行`);
    showToast({
      type: payload.created > 0 ? 'success' : 'warning',
      title: '批量导入完成',
      message: details.join('，'),
      duration: 4000,
    });
    closeProxyImportModal();
  } catch (error) {
    showToast({ type: 'error', title: '批量导入失败', message: error.message, duration: 5000 });
  } finally {
    proxyImportPending = false;
    renderProxyImportStats();
  }
}

function resetMySiteForm() {
  state.editingMySiteId = null;
  elements.mySiteForm.reset();
  elements.mySiteForm.elements.type.value = 'sub2api';
  elements.mySiteFormTitle.textContent = '新增站点';
  elements.mySiteSubmit.textContent = '保存站点';
}

async function saveMySiteFromForm() {
  const input = readMySiteFormInput();
  try {
    if (state.editingMySiteId) {
      await updateMySite(state.editingMySiteId, input);
    } else {
      await createMySite(input);
    }
    resetMySiteForm();
    await loadMySites();
    showToast({
      type: 'success',
      title: '站点已保存',
      message: input.name,
      duration: 2500,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '保存站点失败',
      message: error.message,
      duration: 5000,
    });
  }
}

function readMySiteFormInput() {
  const formData = new FormData(elements.mySiteForm);
  return {
    name: String(formData.get('name') ?? '').trim(),
    type: String(formData.get('type') ?? 'sub2api'),
    url: String(formData.get('url') ?? '').trim(),
    adminKey: String(formData.get('admin_key') ?? '').trim(),
  };
}

async function createMySite(input) {
  const response = await fetch('/api/my-sites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `新增站点失败: HTTP ${response.status}`);
  return payload.mySite;
}

async function updateMySite(id, input) {
  const response = await fetch(`/api/my-sites/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `编辑站点失败: HTTP ${response.status}`);
  return payload.mySite;
}

async function deleteMySite(mySite) {
  const confirmed = window.confirm('确定删除该站点吗？');
  if (!confirmed) return;
  const response = await fetch(`/api/my-sites/${encodeURIComponent(mySite.id)}`, { method: 'DELETE' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    showToast({
      type: 'error',
      title: '删除站点失败',
      message: payload.error ?? `HTTP ${response.status}`,
      duration: 5000,
    });
    return;
  }
  if (state.editingMySiteId === mySite.id) resetMySiteForm();
  await loadMySites();
}

function updateSiteFormRequirements() {
  const type = elements.siteType.value;
  const syncVariant = elements.siteSyncVariant?.value ?? 'standard';
  const isCredentialFlow = type === 'sub2api' && syncVariant === 'credential-flow';
  setFormFieldRequired('name', true);
  setFormFieldRequired('url', true);
  setFormFieldRequired('username', isCredentialFlow);
  setFormFieldRequired('password', isCredentialFlow);
  setFormFieldRequired('new_api_user_id', type === 'new-api');
  setFormFieldRequired('auth_token', (type === 'sub2api' && !isCredentialFlow) || type === 'new-api');
  const userIdLabel = elements.siteForm.querySelector('[data-field="new_api_user_id"]');
  if (userIdLabel) userIdLabel.hidden = type !== 'new-api';
  const syncVariantLabel = elements.siteForm.querySelector('[data-field="sync_variant"]');
  if (syncVariantLabel) syncVariantLabel.hidden = type !== 'sub2api';
  updateAuthTokenHint(isCredentialFlow);
}

function updateAuthTokenHint(isCredentialFlow) {
  const authTokenInput = elements.siteForm.elements.namedItem('auth_token');
  if (!authTokenInput) return;
  authTokenInput.placeholder = isCredentialFlow
    ? '可留空，首次同步自动登录获取'
    : 'sub2api 填 Bearer Token，new-api 填整段 Cookie 或 Access Token';
}

function setFormFieldRequired(name, required) {
  const input = elements.siteForm.elements.namedItem(name);
  const label = elements.siteForm.querySelector(`[data-field="${name}"]`);
  if (!input || !label) return;
  input.required = required;
  label.classList.toggle('is-required', required);
}

function render() {
  renderTabs();
  renderSummary();
  renderGroupFilters();
  renderGroupSortButtons();
  renderSiteFilterControl();
  renderSitesTable();
  renderGroupsTable();
}

function renderTabs() {
  document.querySelector('#fleet-summary').classList.toggle('oauth-summary-hidden', ['oauth-accounts', 'oauth-tasks'].includes(state.activeTab));
  for (const button of elements.tabButtons) {
    const isActive = button.dataset.tab === state.activeRouteId;
    button.classList.toggle('active', isActive);
    setAriaCurrent(button, isActive);
  }
  const route = resolveAppRoute(window.location.pathname);
  const isSettingsRoute = route?.section === 'settings';
  elements.configMenu.open = isSettingsRoute;
  elements.configManagementLink.classList.toggle('active', isSettingsRoute);
  setAriaCurrent(elements.configManagementLink, isSettingsRoute);
  for (const link of elements.settingRouteLinks) {
    const isActive = link.dataset.settingRoute === route?.setting;
    link.classList.toggle('active', isActive);
    setAriaCurrent(link, isActive);
  }
  elements.sitesPanel.classList.toggle('hidden', state.activeTab !== 'sites');
  elements.groupsPanel.classList.toggle('hidden', state.activeTab !== 'groups');
  elements.settingsProxiesPanel.classList.toggle('hidden', state.activeSetting !== 'proxies');
  elements.ipManagementPanel.classList.toggle('hidden', state.activeTab !== 'ip-management');
  document.querySelector('#oauth-tasks-panel').classList.toggle('hidden', state.activeTab !== 'oauth-tasks');
  document.querySelector('#oauth-accounts-panel').classList.toggle('hidden', state.activeTab !== 'oauth-accounts');
  document.querySelector('#settings-oauth-onboarding-panel').classList.toggle('hidden', state.activeSetting !== 'oauth-onboarding');
  elements.settingsAutoRefreshPanel.classList.toggle('hidden', state.activeSetting !== 'auto-refresh');
  elements.settingsMySitesPanel.classList.toggle('hidden', state.activeSetting !== 'my-sites');
  elements.openSiteModal.hidden = state.activeTab !== 'sites';
}

function setAriaCurrent(element, isCurrent) {
  if (isCurrent) {
    element.setAttribute('aria-current', 'page');
  } else {
    element.removeAttribute('aria-current');
  }
}

function renderSummary() {
  const summary = summarizeFleet(state.sites, state.snapshots);
  elements.metricSites.textContent = String(summary.siteCount);
  elements.metricBalance.textContent = formatCurrency(summary.balanceCny);
  elements.metricBalanceAlerts.textContent = `余额不足：${summary.balanceAlertCount}`;
  elements.metricBalanceAlerts.disabled = summary.balanceAlertCount === 0;
  elements.metricBalanceAlerts.classList.toggle('active', summary.balanceAlertCount > 0);
}

// 点"余额不足：N"跳到站点管理并打开余额不足筛选；筛选状态跟着 URL 查询串走，刷新/分享不丢
function setSiteBalanceAlertOnly(enabled, { navigate = false } = {}) {
  const query = enabled ? '?balance-alert=1' : '';
  if (navigate) {
    window.history.pushState({}, '', `${APP_PATHS.sites}${query}`);
    applyLocationRoute();
    return;
  }
  state.siteBalanceAlertOnly = enabled;
  if (resolveAppRoute(window.location.pathname)?.section === 'sites') {
    window.history.replaceState(window.history.state ?? {}, '', `${APP_PATHS.sites}${query}`);
  }
  render();
}

function renderSiteProxyOptions() {
  const options = [
    optionElement('', '直连'),
    ...state.proxies
      .filter((proxy) => proxy.status === 'active')
      .map((proxy) => optionElement(proxy.id, `${proxy.name} (${proxy.protocol}://${proxy.host}:${proxy.port})`)),
  ];
  elements.siteProxyId.replaceChildren(...options);
}

function renderProxyProviderOptions() {
  const providers = [...new Set(state.proxies.map((proxy) => proxy.provider).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  elements.proxyProviderOptions.replaceChildren(...providers.map((provider) => optionElement(provider, provider)));
}

// 代理池同时渲染在「IP 管理」（多选/导入/导出）和「代理配置」（手动维护）两个页面
function renderProxiesTable() {
  for (const config of [
    { tbody: elements.proxiesTable, selectable: false, colSpan: 11 },
    { tbody: elements.ipManagementTable, selectable: true, colSpan: 12 },
  ]) {
    if (!config.tbody) continue;
    if (state.proxies.length === 0) {
      showTableError(config.tbody, config.colSpan, '暂无代理配置');
      continue;
    }
    config.tbody.replaceChildren(...state.proxies.map((proxy) => buildProxyRow(proxy, config)));
  }
  syncProxySelectionUI();
}

function buildProxyRow(proxy, { selectable = false } = {}) {
  const link = state.mySiteProxyLinks.find((item) => item.proxyId === proxy.id);
  const row = document.createElement('tr');
  row.innerHTML = `
    ${selectable ? '<td class="checkbox-cell"><input type="checkbox" data-action="select-proxy" aria-label="选择代理" /></td>' : ''}
    <td>
      <div class="site-name">
        <span class="site-url-cell">
          <strong>${escapeHtml(proxy.name)}</strong>
          <button
            class="model-action copy-site-url"
            type="button"
            data-action="copy-proxy-address"
            title="复制代理地址"
            aria-label="复制代理地址"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 8h11v11H8zM5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" />
            </svg>
          </button>
        </span>
        <span class="site-id">${escapeHtml(shortId(proxy.id))}</span>
      </div>
    </td>
    <td class="proxy-provider-cell">${escapeHtml(proxy.provider || '—')}</td>
    <td><span class="type-pill ${proxy.protocol}">${escapeHtml(proxy.protocol)}</span></td>
    <td><code class="proxy-url">${escapeHtml(proxy.protocol)}://${escapeHtml(proxy.host)}:${Number(proxy.port)}</code></td>
    <td>${proxyProbeCellHtml(proxy)}</td>
    <td>${proxyLocationCellHtml(proxy)}</td>
    <td>${proxy.username || proxy.password ? '有' : '-'}</td>
    <td>${Number(proxy.siteCount ?? 0)}</td>
    <td><span class="enabled-pill ${proxy.status === 'active' ? 'on' : 'off'}">${proxy.status === 'active' ? '启用' : '停用'}</span></td>
    <td>${proxyExpiryCellHtml(proxy.expiresAt)}</td>
    <td>
      <div class="actions-cell">
        ${selectable ? (link
          ? `<button class="text-button" type="button" data-action="unlink-proxy" title="解除与我站点的映射">已映射 #${escapeHtml(link.myProxyId)}</button>`
          : '<button class="text-button" type="button" data-action="link-proxy">映射</button>') : ''}
        <button class="text-button" type="button" data-action="test-proxy" ${pendingProxyTests.has(proxy.id) ? 'disabled' : ''}>${pendingProxyTests.has(proxy.id) ? '测试中…' : '测试'}</button>
        <button class="text-button" type="button" data-action="edit-proxy">编辑</button>
        <button class="text-button danger" type="button" data-action="delete-proxy">删除</button>
      </div>
    </td>
  `;
  if (selectable) {
    const checkbox = row.querySelector('[data-action="select-proxy"]');
    checkbox.checked = state.selectedProxyIds.has(proxy.id);
    checkbox.addEventListener('change', () => toggleProxySelection(proxy.id, checkbox.checked));
    row.querySelector('[data-action="link-proxy"]')?.addEventListener('click', () => linkProxyToMySite(proxy));
    row.querySelector('[data-action="unlink-proxy"]')?.addEventListener('click', () => unlinkProxyFromMySite(link, proxy));
  }
  row.querySelector('[data-action="test-proxy"]').addEventListener('click', () => testOneProxy(proxy));
  row.querySelector('[data-action="copy-proxy-address"]').addEventListener('click', () => copyProxyAddress(proxy));
  // 「IP 管理」表格编辑走弹窗；「代理配置」表格编辑载入本页内联表单
  const onEdit = selectable ? () => editProxyInModal(proxy) : () => editProxy(proxy);
  row.querySelector('[data-action="edit-proxy"]').addEventListener('click', onEdit);
  row.querySelector('[data-action="delete-proxy"]').addEventListener('click', () => deleteProxy(proxy));
  return row;
}

function proxyProbeCellHtml(proxy) {
  const result = proxy.probeResult;
  if (pendingProxyTests.has(proxy.id)) return '<span class="proxy-probe pending">测试中…</span>';
  if (!result) return '<span class="model-empty">未测试</span>';
  const title = `${result.error || '通过代理完成探测'} · ${formatTime(result.checkedAt)}`;
  return `<span class="proxy-probe ${result.ok ? 'ok' : 'failed'}" title="${escapeAttribute(title)}">${result.ok ? `可用 · ${Number(result.latencyMs)} ms` : '不可用'}</span>
    <span class="proxy-probe-time">${formatTime(result.checkedAt)}</span>`;
}

function proxyLocationCellHtml(proxy) {
  const result = proxy.probeResult;
  if (!result?.ok) return '<span class="model-empty">—</span>';
  const location = [...new Set([result.country, result.region, result.city].filter(Boolean))].join(' · ') || '地区未知';
  return `<div class="proxy-location"><span title="${escapeAttribute(location)}">${escapeHtml(location)}</span><code>${escapeHtml(result.ip)}</code></div>`;
}

async function testOneProxy(proxy, { quiet = false } = {}) {
  if (pendingProxyTests.has(proxy.id)) return null;
  pendingProxyTests.add(proxy.id);
  renderProxiesTable();
  try {
    const response = await fetch(`/api/proxies/${encodeURIComponent(proxy.id)}/test`, { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `测试失败: HTTP ${response.status}`);
    const current = state.proxies.find((item) => item.id === proxy.id);
    if (current && current.protocol === proxy.protocol && proxyDedupeKey(current) === proxyDedupeKey(proxy)) current.probeResult = payload.result;
    if (!quiet) showToast({ type: payload.result.ok ? 'success' : 'warning', title: payload.result.ok ? '代理测试通过' : '代理测试失败', message: payload.result.ok ? `${proxy.name} · ${payload.result.latencyMs} ms` : payload.result.error, duration: 4000 });
    return payload.result.ok;
  } catch (error) {
    if (!quiet) showToast({ type: 'error', title: '代理测试失败', message: error.message, duration: 5000 });
    return false;
  } finally {
    pendingProxyTests.delete(proxy.id);
    renderProxiesTable();
  }
}

async function testSelectedProxies() {
  const proxies = selectedProxies().filter((proxy) => !pendingProxyTests.has(proxy.id));
  if (!proxies.length || state.proxyBulkAction) return;
  state.proxyBulkAction = 'test';
  syncProxySelectionUI();
  let next = 0;
  let succeeded = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, proxies.length) }, async () => {
      while (next < proxies.length) {
        const proxy = proxies[next++];
        if (await testOneProxy(proxy, { quiet: true })) succeeded++;
      }
    }));
    showToast({ type: succeeded === proxies.length ? 'success' : 'warning', title: '批量测试完成', message: `可用 ${succeeded} 个，失败 ${proxies.length - succeeded} 个`, duration: 5000 });
  } finally {
    state.proxyBulkAction = null;
    renderProxiesTable();
  }
}

// 复制完整代理地址（带认证信息），与站点管理的 URL 复制一致
function proxyAddressText(proxy) {
  const auth = proxy.username || proxy.password ? `${proxy.username}:${proxy.password}@` : '';
  return `${proxy.protocol}://${auth}${proxy.host}:${Number(proxy.port)}`;
}

// 到期时间单元格：YYYY-MM-DD，已过期标红
function proxyExpiryCellHtml(expiresAt) {
  if (!expiresAt) return '<span class="proxy-expiry none">长期</span>';
  const date = new Date(expiresAt);
  const expired = date.getTime() < Date.now();
  const text = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `<span class="proxy-expiry ${expired ? 'expired' : ''}">${text}</span>`;
}

// ISO → datetime-local 输入框值（本地时区 YYYY-MM-DDTHH:mm）
function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function copyProxyAddress(proxy) {
  const value = proxyAddressText(proxy);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
    await navigator.clipboard.writeText(value);
    showToast({ type: 'success', title: '代理地址已复制', message: value, duration: 2500 });
  } catch (error) {
    showToast({ type: 'error', title: '复制代理地址失败', message: error.message, duration: 5000 });
  }
}

// 创建映射：sub2 侧已有同连接信息的代理时直接采用并把名称对齐，否则新建
async function linkProxyToMySite(proxy) {
  try {
    const response = await fetch('/api/my-site-proxies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proxyId: proxy.id }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `创建映射失败: HTTP ${response.status}`);
    await loadMySiteProxyLinks();
    showToast({
      type: 'success',
      title: payload.adopted ? '已关联 sub2 侧现有代理' : '已在我站点创建代理',
      message: `${proxy.name} → #${payload.link?.myProxyId ?? ''}`,
      duration: 3000,
    });
  } catch (error) {
    showToast({ type: 'error', title: '创建映射失败', message: error.message, duration: 5000 });
  }
}

async function unlinkProxyFromMySite(link, proxy) {
  const confirmed = window.confirm(`解除代理「${proxy.name}」与我站点的映射？sub2 侧的代理记录保留。`);
  if (!confirmed) return;
  try {
    const response = await fetch(`/api/my-site-proxies/${encodeURIComponent(link.id)}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `解除映射失败: HTTP ${response.status}`);
    await loadMySiteProxyLinks();
    showToast({ type: 'success', title: '映射已解除', message: proxy.name, duration: 2500 });
  } catch (error) {
    showToast({ type: 'error', title: '解除映射失败', message: error.message, duration: 5000 });
  }
}

function editProxyInModal(proxy) {
  state.editingProxyId = proxy.id;
  elements.proxyEditContext.textContent = `${proxy.protocol}://${proxy.host}:${Number(proxy.port)}`;
  const form = elements.proxyEditForm.elements;
  form.name.value = proxy.name ?? '';
  form.provider.value = proxy.provider ?? '';
  form.protocol.value = proxy.protocol ?? 'http';
  form.host.value = proxy.host ?? '';
  form.port.value = proxy.port ?? '';
  form.username.value = proxy.username ?? '';
  form.password.value = proxy.password ?? '';
  form.status.value = proxy.status ?? 'active';
  form.expires_at.value = toDatetimeLocalValue(proxy.expiresAt);
  elements.proxyEditModal.showModal();
  form.name.focus();
}

function closeProxyEditModal() {
  elements.proxyEditModal.close();
}

async function saveProxyEditFromModal() {
  if (!state.editingProxyId) return;
  const input = readProxyFormInput(elements.proxyEditForm);
  try {
    await updateProxy(state.editingProxyId, input);
    closeProxyEditModal();
    await loadProxiesFromApi();
    await loadSitesFromApi();
    showToast({
      type: 'success',
      title: '代理已保存',
      message: input.name,
      duration: 2500,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '保存代理失败',
      message: error.message,
      duration: 5000,
    });
  }
}

function toggleProxySelection(proxyId, selected) {
  if (selected) {
    state.selectedProxyIds.add(proxyId);
  } else {
    state.selectedProxyIds.delete(proxyId);
  }
  syncProxySelectionUI();
}

function toggleSelectAllProxies() {
  const selectAll = elements.proxySelectAll.checked && state.proxies.length > 0;
  state.selectedProxyIds = selectAll ? new Set(state.proxies.map((proxy) => proxy.id)) : new Set();
  for (const checkbox of elements.ipManagementTable?.querySelectorAll('[data-action="select-proxy"]') ?? []) {
    checkbox.checked = selectAll;
  }
  syncProxySelectionUI();
}

// 全选框状态 + 导出按钮文案/可用性，跟随选择集变化
function syncProxySelectionUI() {
  const selectedCount = state.selectedProxyIds.size;
  if (elements.proxySelectAll) {
    elements.proxySelectAll.checked = selectedCount > 0 && selectedCount === state.proxies.length;
    elements.proxySelectAll.indeterminate = selectedCount > 0 && selectedCount < state.proxies.length;
  }
  for (const button of [elements.bulkProxyTest, elements.bulkProxyMap, elements.openProxyExport, elements.bulkProxyDelete]) {
    button.hidden = selectedCount === 0;
    button.disabled = selectedCount === 0 || Boolean(state.proxyBulkAction);
  }
  elements.bulkProxyTest.textContent = state.proxyBulkAction === 'test' ? '测试中…' : `批量测试 ${selectedCount} 个`;
  elements.bulkProxyMap.textContent = state.proxyBulkAction === 'map' ? '映射中…' : `批量映射 ${selectedCount} 个`;
  elements.openProxyExport.textContent = `导出 ${selectedCount} 个`;
  elements.bulkProxyDelete.textContent = state.proxyBulkAction === 'delete' ? '删除中…' : `批量删除 ${selectedCount} 个`;
}

function selectedProxies() {
  return state.proxies.filter((proxy) => state.selectedProxyIds.has(proxy.id));
}

async function mapSelectedProxies() {
  const proxies = selectedProxies();
  if (proxies.length === 0 || state.proxyBulkAction) return;
  state.proxyBulkAction = 'map';
  syncProxySelectionUI();
  try {
    const response = await fetch('/api/my-site-proxies/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proxyIds: proxies.map((proxy) => proxy.id) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `批量映射失败: HTTP ${response.status}`);
    const failures = payload.results.filter((result) => result.outcome === 'failed');
    const updated = payload.results.filter((result) => result.outcome === 'updated').length;
    const added = payload.results.length - updated - failures.length;
    await loadMySiteProxyLinks();
    showToast({
      type: failures.length ? 'error' : 'success',
      title: `映射完成：新增 ${added}，同步 ${updated}，失败 ${failures.length}`,
      message: failures.length ? `失败：${failures.map(({ proxyId }) => proxies.find((proxy) => proxy.id === proxyId)?.name ?? proxyId).join('、')}` : '',
      duration: failures.length ? 6000 : 3000,
    });
  } catch (error) {
    showToast({ type: 'error', title: '批量映射失败', message: error.message, duration: 5000 });
  } finally {
    state.proxyBulkAction = null;
    syncProxySelectionUI();
  }
}

async function deleteSelectedProxies() {
  const proxies = selectedProxies();
  if (proxies.length === 0 || state.proxyBulkAction) return;
  if (!window.confirm(`删除选中的 ${proxies.length} 个代理？关联站点会改为直连，已映射的 sub2 侧代理记录保留。`)) return;
  state.proxyBulkAction = 'delete';
  syncProxySelectionUI();
  try {
    const response = await fetch('/api/proxies/batch', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proxyIds: proxies.map((proxy) => proxy.id) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `批量删除失败: HTTP ${response.status}`);
    await loadProxiesFromApi();
    await loadMySiteProxyLinks();
    await loadSitesFromApi();
    showToast({ type: 'success', title: `已删除 ${payload.deletedIds.length} 个代理`, duration: 3000 });
  } catch (error) {
    showToast({ type: 'error', title: '批量删除失败', message: error.message, duration: 5000 });
  } finally {
    state.proxyBulkAction = null;
    syncProxySelectionUI();
  }
}

function openProxyExportModal() {
  const proxies = selectedProxies();
  if (proxies.length === 0) return;
  elements.proxyExportContext.textContent = `已选 ${proxies.length} 个代理，选择导出格式后可预览、复制或下载。`;
  renderProxyExportFormats();
  updateProxyExportPreview();
  elements.proxyExportModal.showModal();
}

function closeProxyExportModal() {
  elements.proxyExportModal.close();
}

// 每个格式选项一行：radio + 格式样例 + 复制图标按钮（不选中也能直接复制该格式）
function renderProxyExportFormats() {
  elements.proxyExportFormats.replaceChildren(
    ...PROXY_EXPORT_FORMATS.map((format) => {
      const item = document.createElement('label');
      item.className = 'proxy-export-format';
      item.innerHTML = `
        <input type="radio" name="proxy-export-format" value="${format.id}" />
        <code>${escapeHtml(format.label)}</code>
        <button class="model-action copy-site-url" type="button" data-format="${format.id}" title="复制该格式" aria-label="复制 ${escapeHtml(format.label)} 格式">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 8h11v11H8zM5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" />
          </svg>
        </button>
      `;
      const radio = item.querySelector('input[type="radio"]');
      radio.checked = format.id === state.proxyExportFormatId;
      radio.addEventListener('change', () => {
        state.proxyExportFormatId = format.id;
        updateProxyExportPreview();
      });
      item.querySelector('button[data-format]').addEventListener('click', (event) => {
        event.preventDefault();
        copyProxyExportContent(format.id);
      });
      return item;
    }),
  );
}

function updateProxyExportPreview() {
  elements.proxyExportPreview.value = buildProxyExportContent(selectedProxies(), state.proxyExportFormatId);
}

async function copyProxyExportContent(formatId) {
  const content = buildProxyExportContent(selectedProxies(), formatId);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
    await navigator.clipboard.writeText(content);
    showToast({
      type: 'success',
      title: '导出内容已复制',
      message: proxyExportFormat(formatId).label,
      duration: 2500,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '复制失败',
      message: error.message,
      duration: 5000,
    });
  }
}

function downloadProxyExport() {
  const format = proxyExportFormat(state.proxyExportFormatId);
  const content = buildProxyExportContent(selectedProxies(), format.id);
  const timestamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const blob = new Blob([content], { type: `${format.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `proxies-${timestamp}.${format.extension}`;
  link.click();
  URL.revokeObjectURL(url);
}

function editProxy(proxy) {
  state.editingProxyId = proxy.id;
  elements.proxyFormTitle.textContent = '编辑代理';
  elements.proxySubmit.textContent = '保存修改';
  const form = elements.proxyForm.elements;
  form.name.value = proxy.name ?? '';
  form.provider.value = proxy.provider ?? '';
  form.protocol.value = proxy.protocol ?? 'http';
  form.host.value = proxy.host ?? '';
  form.port.value = proxy.port ?? '';
  form.username.value = proxy.username ?? '';
  form.password.value = proxy.password ?? '';
  form.status.value = proxy.status ?? 'active';
  form.expires_at.value = toDatetimeLocalValue(proxy.expiresAt);
  form.name.focus();
}

function renderMySitesTable() {
  if (!elements.mySitesTable) return;
  if (state.mySites.length === 0) {
    showTableError(elements.mySitesTable, 6, '暂无我的站点');
    return;
  }

  elements.mySitesTable.replaceChildren(
    ...state.mySites.map((mySite) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>
          <div class="site-name">
            <strong>${escapeHtml(mySite.name)}</strong>
            <span class="site-id">${escapeHtml(shortId(mySite.id))}</span>
          </div>
        </td>
        <td><span class="type-pill ${siteTypeClass(mySite.type)}">${escapeHtml(mySite.type)}</span></td>
        <td><code class="proxy-url">${escapeHtml(mySite.url)}</code></td>
        <td>
          <div class="model-cell">
            <code class="credential-token">${escapeHtml(maskAdminKey(mySite.adminKey))}</code>
            <button
              class="model-action"
              type="button"
              data-action="copy-admin-key"
              data-key="${escapeAttribute(mySite.adminKey)}"
              title="复制管理员 Key"
              aria-label="复制管理员 Key"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 8h11v11H8zM5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" />
              </svg>
            </button>
          </div>
        </td>
        <td><span class="time-line">${formatTime(mySite.createdAt)}</span></td>
        <td>
          <div class="actions-cell">
            <button class="text-button" type="button" data-action="edit-my-site">编辑</button>
            <button class="text-button danger" type="button" data-action="delete-my-site">删除</button>
          </div>
        </td>
      `;
      row.querySelector('[data-action="copy-admin-key"]').addEventListener('click', () => {
        copyAdminKey(mySite.adminKey);
      });
      row.querySelector('[data-action="edit-my-site"]').addEventListener('click', () => editMySite(mySite));
      row.querySelector('[data-action="delete-my-site"]').addEventListener('click', () => deleteMySite(mySite));
      return row;
    }),
  );
}

function maskAdminKey(key) {
  const text = String(key ?? '');
  return text.length > 4 ? `••••${text.slice(-4)}` : '••••';
}

function editMySite(mySite) {
  state.editingMySiteId = mySite.id;
  elements.mySiteFormTitle.textContent = '编辑站点';
  elements.mySiteSubmit.textContent = '保存修改';
  const form = elements.mySiteForm.elements;
  form.name.value = mySite.name ?? '';
  form.type.value = mySite.type ?? 'sub2api';
  form.url.value = mySite.url ?? '';
  form.admin_key.value = mySite.adminKey ?? '';
  form.name.focus();
}

async function copyAdminKey(key) {
  const value = String(key ?? '');
  if (!value) {
    showToast({
      type: 'warning',
      title: '没有可复制的管理员 Key',
      message: '当前行没有管理员 Key。',
      duration: 3000,
    });
    return;
  }

  try {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
    await navigator.clipboard.writeText(value);
    showToast({
      type: 'success',
      title: '管理员 Key 已复制',
      message: '已复制到剪贴板。',
      duration: 2500,
    });
  } catch (error) {
    showToast({
      type: 'error',
      title: '复制管理员 Key 失败',
      message: error.message,
      duration: 5000,
    });
  }
}

function renderSitesTable() {
  if (state.sites.length === 0) {
    showTableError(elements.sitesTable, 11, '暂无站点，先新增一个上游。');
    return;
  }

  elements.sitesBalanceAlertFilter.checked = state.siteBalanceAlertOnly;
  elements.sitesWatchFilter.value = state.sitesWatchFilter;
  let visibleSites = state.sites;
  if (state.sitesSiteFilter.length > 0) {
    const selected = new Set(state.sitesSiteFilter);
    visibleSites = visibleSites.filter((site) => selected.has(site.id));
  }
  if (state.sitesWatchFilter === '1') {
    visibleSites = visibleSites.filter((site) => site.watched);
  } else if (state.sitesWatchFilter === '0') {
    visibleSites = visibleSites.filter((site) => !site.watched);
  }
  if (state.siteBalanceAlertOnly) {
    visibleSites = visibleSites.filter((site) => isBalanceAlert(site, displayBalance({
      site,
      snapshot: state.snapshots[site.id] ?? createPendingSnapshot(site),
    })));
  }
  if (visibleSites.length === 0) {
    const emptyMessage = state.siteBalanceAlertOnly ? '没有余额不足的站点。' : '没有匹配筛选条件的站点。';
    showTableError(elements.sitesTable, 11, emptyMessage);
    return;
  }

  const rows = visibleSites.map((site) => {
    const snapshot = state.snapshots[site.id] ?? createPendingSnapshot(site);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="watch-cell">
        <button class="watch-toggle${site.watched ? ' active' : ''}" type="button" data-action="watch"
          aria-pressed="${site.watched ? 'true' : 'false'}" title="${site.watched ? '取消关注' : '关注'}"
          aria-label="${site.watched ? '取消关注' : '关注'}">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.5l2.95 5.98 6.6.96-4.78 4.65 1.13 6.58L12 17.57l-5.9 3.1 1.13-6.58L2.45 9.44l6.6-.96z" />
          </svg>
        </button>
      </td>
      <td>
        <div class="site-name">
          <strong>${escapeHtml(site.name)}</strong>
          <span class="site-id site-url-cell">${externalLinkHtml(site.url)}${copySiteUrlButtonHtml(site.url)}</span>
        </div>
      </td>
      <td><span class="type-pill ${siteTypeClass(site.type)}">${escapeHtml(site.type)}</span></td>
      <td>${proxyCellHtml(site.proxy)}</td>
      <td>${balanceCellHtml(site, snapshot)}</td>
      <td><span class="time-line${isDepletionAlert({ site, snapshot }) ? ' depletion-alert' : ''}">${depletionEtaDisplay({ site, snapshot })}</span></td>
      <td>${groupMetricHtml(snapshot)}</td>
      <td>${keyMetricHtml(snapshot)}</td>
      <td>${probeCellHtml(snapshot)}</td>
      <td><span class="time-line">${formatTime(snapshot.refreshedAt)}</span></td>
      <td>
        <div class="actions-cell">
          <button class="text-button" type="button" data-action="refresh">同步</button>
          <button class="text-button" type="button" data-action="edit">编辑</button>
          <button class="text-button danger" type="button" data-action="delete">删除</button>
        </div>
      </td>
    `;

    row.querySelector('[data-action="refresh"]').addEventListener('click', (event) => {
      refreshOneSiteAndReload(site, event.currentTarget);
    });
    row.querySelector('[data-action="watch"]').addEventListener('click', () => {
      toggleSiteWatched(site);
    });
    row.querySelector('.balance-refresh').addEventListener('click', (event) => {
      refreshOneSiteAndReload(site, event.currentTarget);
    });
    row.querySelector('[data-action="edit"]').addEventListener('click', () => {
      openSiteModal(site);
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      deleteSiteFromApi(site);
    });
    row.querySelector('[data-action="show-groups"]').addEventListener('click', () => {
      openSiteGroups(site);
    });
    row.querySelector('[data-action="show-keys"]').addEventListener('click', () => {
      openSiteGroups(site, { hasKeyOnly: true });
    });
    row.querySelector('[data-action="copy-site-url"]').addEventListener('click', (event) => {
      event.stopPropagation();
      copySiteUrl(site.url);
    });
    configureExternalLink(row.querySelector('a'), site.url);
    return row;
  });
  elements.sitesTable.replaceChildren(...rows);
}

// 点行首五角星切换关注；关注状态存在站点记录里，与筛选栏「关注」联动
async function toggleSiteWatched(site) {
  try {
    const response = await fetch(`/api/sites/${encodeURIComponent(site.id)}/watched`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watched: !site.watched }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `更新关注状态失败: HTTP ${response.status}`);
    const target = state.sites.find((item) => item.id === site.id);
    if (target) target.watched = Boolean(payload.site?.watched);
    renderSitesTable();
  } catch (error) {
    showToast({ type: 'error', title: '更新关注状态失败', message: error.message, duration: 5000 });
  }
}

function renderGroupFilters() {
  const siteSelect = groupFilterControls.groupSiteFilter.main;
  const modelSelect = groupFilterControls.groupModelFilter.main;
  siteSelect.replaceChildren(
    optionElement('all', '全部站点'),
    ...state.sites.map((site) => optionElement(site.id, site.name)),
  );
  siteSelect.value = state.sites.some((site) => site.id === state.groupSiteFilter) ? state.groupSiteFilter : 'all';
  state.groupSiteFilter = siteSelect.value;
  const displayModels = savedDisplayModels();
  modelSelect.replaceChildren(
    optionElement('all', '全部模型'),
    ...displayModels.map((model) => optionElement(model, model)),
  );
  modelSelect.value = displayModels.includes(state.groupModelFilter) ? state.groupModelFilter : 'all';
  state.groupModelFilter = modelSelect.value;
  for (const { field, main } of Object.values(groupFilterControls)) {
    if (field.control === 'multiselect') continue;
    main.value = String(state[field.key]);
  }
  renderMyGroupFilterControl();
  renderGroupPresetMenu();
}

function renderGroupPresetMenu() {
  if (!state.groupFilterPresets.some((preset) => preset.name === state.groupPresetName)) {
    state.groupPresetName = '';
  }
  const items = state.groupFilterPresets.map((preset) => {
    const item = document.createElement('li');
    item.className = 'preset-item';
    item.classList.toggle('active', preset.name === state.groupPresetName);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', preset.name === state.groupPresetName ? 'true' : 'false');
    item.textContent = preset.name;
    item.addEventListener('click', () => {
      closeGroupPresetMenu();
      applyGroupFilterPreset(preset.name);
    });
    return item;
  });
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'preset-empty';
    empty.textContent = '暂无预设，点击右侧 + 保存';
    elements.groupPresetMenu.replaceChildren(empty);
  } else {
    elements.groupPresetMenu.replaceChildren(...items);
  }
  elements.groupPresetLabel.textContent = state.groupPresetName || '选择预设';
  elements.groupPresetLabel.classList.toggle('placeholder', !state.groupPresetName);
  elements.editGroupFilterPreset.disabled = !state.groupPresetName;
  elements.deleteGroupFilterPreset.disabled = !state.groupPresetName;
}

function setActiveGroupPreset(name) {
  state.groupPresetName = name;
  renderGroupPresetMenu();
}

function toggleGroupPresetMenu() {
  const willOpen = elements.groupPresetMenu.hidden;
  elements.groupPresetMenu.hidden = !willOpen;
  elements.groupPresetTrigger.setAttribute('aria-expanded', String(willOpen));
  elements.groupPresetDropdown.classList.toggle('open', willOpen);
}

function closeGroupPresetMenu() {
  if (elements.groupPresetMenu.hidden) return;
  elements.groupPresetMenu.hidden = true;
  elements.groupPresetTrigger.setAttribute('aria-expanded', 'false');
  elements.groupPresetDropdown.classList.remove('open');
}

// "分组"多选下拉：选项 = 固定的"未分组" + 我站点（sub2api）的实时分组
function myGroupFilterParts() {
  const container = groupFilterControls.groupMyGroupFilter.main;
  return {
    container,
    trigger: container.querySelector('#group-my-group-filter-trigger'),
    label: container.querySelector('#group-my-group-filter-label'),
    menu: container.querySelector('#group-my-group-filter-menu'),
    selection: container.querySelector('#group-my-group-filter-selection'),
    count: container.querySelector('#group-my-group-filter-count'),
    chips: container.querySelector('#group-my-group-filter-chips'),
    clear: container.querySelector('#group-my-group-filter-clear'),
    search: container.querySelector('#group-my-group-filter-search'),
    options: container.querySelector('#group-my-group-filter-options'),
  };
}

function myGroupFilterOptions() {
  return [
    { value: UNGROUPED_FILTER_VALUE, label: '未分组' },
    ...state.mySiteGroupOptions,
  ];
}

function setupMyGroupFilterControl() {
  const { container, trigger, menu, search, clear } = myGroupFilterParts();
  trigger.addEventListener('click', () => {
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
    container.classList.toggle('open', willOpen);
    container.closest('.panel-view')?.classList.toggle('has-open-multi-select', willOpen);
    if (willOpen) {
      positionMultiSelectMenu(container, trigger);
      search.value = '';
      renderMyGroupFilterControl();
      search.focus();
    }
  });
  search.addEventListener('input', () => renderMyGroupFilterControl());
  clear.addEventListener('click', () => updateMyGroupFilterSelection([]));
  window.addEventListener('resize', () => {
    if (!menu.hidden) positionMultiSelectMenu(container, trigger);
  });
  document.addEventListener('click', (event) => {
    if (!container.contains(event.target)) closeMyGroupFilterMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMyGroupFilterMenu();
  });
}

function updateMyGroupFilterSelection(values) {
  state.groupMyGroupFilter = [...new Set(values)];
  setActiveGroupPreset('');
  renderMyGroupFilterControl();
  renderGroupsTable();
  saveGroupViewPreferences();
}

function closeMyGroupFilterMenu() {
  const { container, trigger, menu } = myGroupFilterParts();
  if (menu.hidden) return;
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  container.classList.remove('open');
  container.closest('.panel-view')?.classList.remove('has-open-multi-select');
}

function renderMyGroupFilterControl() {
  const { label, selection, count, chips, search, options } = myGroupFilterParts();
  const allOptions = myGroupFilterOptions();
  // 远端分组可能已删除：清掉失效的选中项
  const validValues = new Set(allOptions.map((option) => option.value));
  const selected = state.groupMyGroupFilter.filter((value) => validValues.has(value));
  if (selected.length !== state.groupMyGroupFilter.length) state.groupMyGroupFilter = selected;

  const query = search.value;
  const visibleOptions = allOptions.filter((option) => matchesSearchText(option.label, query));
  const items = visibleOptions.map((option) => {
    const item = document.createElement('label');
    item.className = 'multi-select-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.includes(option.value);
    item.classList.toggle('is-selected', checkbox.checked);
    checkbox.addEventListener('change', () => {
      const next = new Set(selected);
      if (checkbox.checked) next.add(option.value);
      else next.delete(option.value);
      updateMyGroupFilterSelection([...next]);
    });
    const text = document.createElement('span');
    text.textContent = option.label;
    item.append(checkbox, text);
    return item;
  });
  if (items.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'multi-select-empty';
    empty.textContent = allOptions.length === 0 ? '暂无可选项' : '无匹配项';
    items.push(empty);
  }
  options.replaceChildren(...items);
  renderMultiSelectSelection({
    selection,
    count,
    chips,
    selected,
    allOptions,
    itemType: '分组',
    onRemove: (value) => updateMyGroupFilterSelection(
      selected.filter((selectedValue) => selectedValue !== value),
    ),
  });

  if (selected.length === 0) {
    label.textContent = '全部分组';
  } else {
    const names = selected.map(
      (value) => allOptions.find((option) => option.value === value)?.label ?? value,
    );
    label.textContent = names.length <= 2 ? names.join('、') : `已选 ${names.length} 项`;
  }
}

// "站点"多选下拉（站点管理页）：选项 = 当前全部站点，交互与分组管理的多选筛选一致
function siteFilterParts() {
  const container = document.querySelector('#sites-site-filter');
  return {
    container,
    trigger: container.querySelector('#sites-site-filter-trigger'),
    label: container.querySelector('#sites-site-filter-label'),
    menu: container.querySelector('#sites-site-filter-menu'),
    selection: container.querySelector('#sites-site-filter-selection'),
    count: container.querySelector('#sites-site-filter-count'),
    chips: container.querySelector('#sites-site-filter-chips'),
    clear: container.querySelector('#sites-site-filter-clear'),
    search: container.querySelector('#sites-site-filter-search'),
    options: container.querySelector('#sites-site-filter-options'),
  };
}

function setupSiteFilterControl() {
  const { container, trigger, menu, search, clear } = siteFilterParts();
  trigger.addEventListener('click', () => {
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
    container.classList.toggle('open', willOpen);
    container.closest('.panel-view')?.classList.toggle('has-open-multi-select', willOpen);
    if (willOpen) {
      positionMultiSelectMenu(container, trigger);
      search.value = '';
      renderSiteFilterControl();
      search.focus();
    }
  });
  search.addEventListener('input', () => renderSiteFilterControl());
  clear.addEventListener('click', () => updateSiteFilterSelection([]));
  window.addEventListener('resize', () => {
    if (!menu.hidden) positionMultiSelectMenu(container, trigger);
  });
  document.addEventListener('click', (event) => {
    if (!container.contains(event.target)) closeSiteFilterMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSiteFilterMenu();
  });
}

function updateSiteFilterSelection(values) {
  state.sitesSiteFilter = [...new Set(values)];
  renderSiteFilterControl();
  renderSitesTable();
  saveSiteViewPreferences();
}

function closeSiteFilterMenu() {
  const { container, trigger, menu } = siteFilterParts();
  if (menu.hidden) return;
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  container.classList.remove('open');
  container.closest('.panel-view')?.classList.remove('has-open-multi-select');
}

function renderSiteFilterControl() {
  const { label, selection, count, chips, search, options } = siteFilterParts();
  const allOptions = state.sites.map((site) => ({ value: site.id, label: site.name }));
  // 站点可能已删除：清掉失效的选中项
  const validValues = new Set(allOptions.map((option) => option.value));
  const selected = state.sitesSiteFilter.filter((value) => validValues.has(value));
  if (selected.length !== state.sitesSiteFilter.length) state.sitesSiteFilter = selected;

  const query = search.value;
  const visibleOptions = allOptions.filter((option) => matchesSearchText(option.label, query));
  const items = visibleOptions.map((option) => {
    const item = document.createElement('label');
    item.className = 'multi-select-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.includes(option.value);
    item.classList.toggle('is-selected', checkbox.checked);
    checkbox.addEventListener('change', () => {
      const next = new Set(selected);
      if (checkbox.checked) next.add(option.value);
      else next.delete(option.value);
      updateSiteFilterSelection([...next]);
    });
    const text = document.createElement('span');
    text.textContent = option.label;
    item.append(checkbox, text);
    return item;
  });
  if (items.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'multi-select-empty';
    empty.textContent = allOptions.length === 0 ? '暂无可选项' : '无匹配项';
    items.push(empty);
  }
  options.replaceChildren(...items);
  renderMultiSelectSelection({
    selection,
    count,
    chips,
    selected,
    allOptions,
    itemType: '站点',
    onRemove: (value) => updateSiteFilterSelection(
      selected.filter((selectedValue) => selectedValue !== value),
    ),
  });

  if (selected.length === 0) {
    label.textContent = '全部站点';
  } else {
    const names = selected.map(
      (value) => allOptions.find((option) => option.value === value)?.label ?? value,
    );
    label.textContent = names.length <= 2 ? names.join('、') : `已选 ${names.length} 项`;
  }
}

function renderMultiSelectSelection({ selection, count, chips, selected, allOptions, itemType, onRemove }) {
  const labels = new Map(allOptions.map((option) => [option.value, option.label]));
  const chipItems = selected.map((value) => {
    const itemLabel = labels.get(value) ?? value;
    const chip = document.createElement('span');
    chip.className = 'multi-select-chip';

    const text = document.createElement('span');
    text.className = 'multi-select-chip-label';
    text.textContent = itemLabel;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'multi-select-chip-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `移除${itemType}：${itemLabel}`);
    remove.title = `移除${itemType}：${itemLabel}`;
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      onRemove(value);
    });

    chip.append(text, remove);
    return chip;
  });

  count.textContent = `已选 ${selected.length} 项`;
  chips.replaceChildren(...chipItems);
  selection.hidden = selected.length === 0;
}

function positionMultiSelectMenu(container, trigger) {
  const menu = container.querySelector('.multi-select-menu');
  let triggerRect = trigger.getBoundingClientRect();
  // 概览卡在窄屏堆叠后，resize 时已有菜单的锚点可能落到视口外。先恢复可见锚点，再计算向上空间。
  if (triggerRect.bottom > window.innerHeight || triggerRect.top < 0) {
    trigger.scrollIntoView({ block: 'nearest' });
    triggerRect = trigger.getBoundingClientRect();
  }
  const workspaceTop = container.closest('.workspace')?.getBoundingClientRect().top ?? 0;
  const topBoundary = Math.max(8, workspaceTop + 8);
  const availableAbove = triggerRect.top - topBoundary - 6;
  const availableBelow = window.innerHeight - triggerRect.bottom - 14;
  const opensUp = availableBelow < 320 && availableAbove > availableBelow;
  const availableHeight = opensUp ? availableAbove : availableBelow;
  container.classList.toggle('opens-up', opensUp);
  menu.style.maxHeight = `${Math.max(120, Math.min(420, Math.floor(availableHeight)))}px`;
}

// "可调度"筛选需要映射账号在我站点的实时可调度状态，按需拉取（接口本身逐账号容错）
async function ensureMySiteAccountSchedulable({ force = false } = {}) {
  if (state.groupSchedulableFilter === 'all') return;
  if (state.mySiteAccountSchedulableLoaded && !force) return;
  try {
    const response = await fetch('/api/my-site-accounts/remote', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `读取映射账号状态失败: HTTP ${response.status}`);
    // remote 拉取失败（remoteError）的账号记 null = 状态未知，两个选项都不匹配
    state.mySiteAccountSchedulable = Object.fromEntries(
      (payload.accounts ?? []).map((account) => [
        account.id,
        account.remote ? Boolean(account.remote.schedulable) : null,
      ]),
    );
    state.mySiteAccountSchedulableLoaded = true;
  } catch (error) {
    console.warn(error);
  }
  renderGroupsTable();
}

// 分组筛选选项：逐个我站点（sub2api）实时拉分组，单站点失败不拖垮其余
async function loadMySiteGroupOptions() {
  try {
    const response = await fetch('/api/my-sites', { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取我的站点失败: HTTP ${response.status}`);
    const payload = await response.json().catch(() => ({}));
    const mySites = (payload.mySites ?? []).filter((site) => site.type === 'sub2api');
    const results = await Promise.all(mySites.map(async (site) => {
      try {
        const groupsResponse = await fetch(
          `/api/my-sites/${encodeURIComponent(site.id)}/groups`,
          { cache: 'no-store' },
        );
        if (!groupsResponse.ok) return [];
        const groupsPayload = await groupsResponse.json().catch(() => ({}));
        return (groupsPayload.groups ?? []).map((group) => ({
          value: `${site.id}:${group.id}`,
          label: mySites.length > 1 ? `${site.name} · ${group.name}` : group.name,
        }));
      } catch {
        return [];
      }
    }));
    state.mySiteGroupOptions = results
      .flat()
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  } catch (error) {
    state.mySiteGroupOptions = [];
    console.warn(error);
  }
  renderMyGroupFilterControl();
}

function renderGroupSortButtons() {
  for (const button of elements.groupSortButtons) {
    const isActive = button.dataset.groupSort === state.groupSortKey;
    button.classList.toggle('active', isActive);
    button.dataset.direction = isActive ? state.groupSortDirection : 'none';
    const path = button.querySelector('path');
    if (path) {
      path.setAttribute('d', sortIconPath(isActive ? state.groupSortDirection : 'none'));
    }
    button.setAttribute(
      'aria-sort',
      isActive ? (state.groupSortDirection === 'asc' ? 'ascending' : 'descending') : 'none',
    );
  }
}

function sortIconPath(direction) {
  if (direction === 'asc') return 'M8 14l4-4 4 4';
  if (direction === 'desc') return 'M8 10l4 4 4-4';
  return 'M8 9l4-4 4 4M16 15l-4 4-4-4';
}

function renderGroupsTable() {
  const groups = filteredGroups();
  if (groups.length === 0) {
    showTableError(elements.groupsTable, 13, '暂无匹配分组');
    return;
  }

  elements.groupsTable.replaceChildren(
    ...groups.map(({ site, snapshot, group, token, keyCount }) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>
          <div class="site-name">
            <strong>${escapeHtml(site.name)}</strong>
            <span class="site-id site-url-cell">${externalLinkHtml(site.url)}${copySiteUrlButtonHtml(site.url)}</span>
          </div>
        </td>
        <td>${escapeHtml(group.name)}</td>
        <td>${platformBadgeHtml(group.platform)}</td>
        <td>${rateCellHtml(group.multiplier)}</td>
        <td>${Number(keyCount ?? 0)}</td>
        <td>${apiKeyCellHtml(token)}</td>
        <td>${groupBalanceCellHtml(site, snapshot)}</td>
        <td>${modelSelectionCellHtml(site, group)}</td>
        <td>${modelTestCellHtml(site, group)}</td>
        <td><span class="enabled-pill ${group.enabled ? 'on' : 'off'}">${group.enabled ? '启用' : '停用'}</span></td>
        <td>${groupScoreCellHtml(site, group)}</td>
        <td><span class="time-line">${formatTime(snapshot.refreshedAt)}</span></td>
        <td>${mySiteAccountCellHtml(site, group)}</td>
      `;
      row.querySelector('.balance-refresh').addEventListener('click', (event) => {
        refreshOneSiteAndReload(site, event.currentTarget);
      });
      row.querySelector('[data-action="copy-api-key"]')?.addEventListener('click', (event) => {
        copyApiKey(token?.key ?? '', event.currentTarget);
      });
      row.querySelector('[data-action="copy-site-url"]').addEventListener('click', (event) => {
        event.stopPropagation();
        copySiteUrl(site.url);
      });
      row.querySelector('[data-action="edit-group-model"]').addEventListener('click', () => {
        openGroupModelModal(site, group);
      });
      row.querySelector('[data-action="test-group-model"]').addEventListener('click', () => {
        testGroupModel(site, group);
      });
      row.querySelector('.group-score-input').addEventListener('change', (event) => {
        saveGroupScore(site, group, event.currentTarget);
      });
      row.querySelector('[data-action="open-create-account"]').addEventListener('click', () => {
        openCreateAccountModal(site, group);
      });
      row.querySelector('[data-action="open-linked-accounts"]')?.addEventListener('click', () => {
        openLinkedAccountsModal(site, group);
      });
      configureExternalLink(row.querySelector('.external-link'), site.url);
      return row;
    }),
  );
}

function groupScoreCellHtml(site, group) {
  const score = Number(getGroupModelSetting(site.id, group.id)?.score ?? 0);
  return `
    <input
      class="group-score-input"
      type="number"
      min="0"
      max="100"
      step="1"
      value="${score}"
      aria-label="hvoy_score"
    />
  `;
}

// 分数内联直改：失焦/回车即保存，失败回退旧值
async function saveGroupScore(site, group, input) {
  const previous = Number(getGroupModelSetting(site.id, group.id)?.score ?? 0);
  const score = Number(input.value);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    input.value = String(previous);
    showToast({ type: 'warning', title: '分数无效', message: 'hvoy_score 只接受 0-100 的数字。', duration: 3000 });
    return;
  }
  input.disabled = true;
  try {
    const response = await fetch(`/api/sites/${encodeURIComponent(site.id)}/group-score`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId: group.id, score }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `保存分数失败: HTTP ${response.status}`);
    state.groupModelSettings[groupSettingKey(payload.setting.siteId, payload.setting.groupId)] = payload.setting;
    input.value = String(Number(payload.setting.score ?? score));
  } catch (error) {
    input.value = String(previous);
    showToast({ type: 'error', title: '保存分数失败', message: error.message, duration: 4000 });
  } finally {
    input.disabled = false;
  }
}

function allGroups() {
  return buildGroupRows(state.sites, state.snapshots);
}

function mySiteAccountCellHtml(site, group) {
  const linkedCount = state.mySiteAccounts.filter((account) => (
    account.upstreamSiteId === site.id && String(account.upstreamGroupId) === String(group.id)
  )).length;
  return `
    <div class="model-cell">
      <button class="model-action" type="button" data-action="open-create-account" title="创建账号" aria-label="创建账号">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      ${linkedCount > 0 ? `<button class="my-site-account-count" type="button" data-action="open-linked-accounts" title="查看映射账号">×${linkedCount}</button>` : ''}
    </div>
  `;
}

function openLinkedAccountsModal(site, group) {
  state.linkedAccountsContext = { site, group };
  elements.linkedAccountsContext.textContent = `上游：${site.name} · ${group.name}`;
  elements.linkedAccountsList.replaceChildren(linkedAccountsMessage('加载中…'));
  elements.linkedAccountsModal.showModal();
  void loadLinkedAccounts();
}

function closeLinkedAccountsModal() {
  state.linkedAccountsContext = null;
  elements.linkedAccountsModal.close();
}

function linkedAccountsMessage(text) {
  const line = document.createElement('p');
  line.className = 'page-subtitle';
  line.textContent = text;
  return line;
}

async function loadLinkedAccounts() {
  const context = state.linkedAccountsContext;
  if (!context) return;
  try {
    const params = new URLSearchParams({
      upstreamSiteId: context.site.id,
      upstreamGroupId: String(context.group.id),
    });
    const response = await fetch(`/api/my-site-accounts/remote?${params}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `读取映射账号失败: HTTP ${response.status}`);
    // 弹窗已切到别的分组或已关闭时不重绘
    if (state.linkedAccountsContext !== context) return;
    renderLinkedAccounts(payload.accounts ?? []);
  } catch (error) {
    if (state.linkedAccountsContext !== context) return;
    elements.linkedAccountsList.replaceChildren(linkedAccountsMessage(`读取映射账号失败：${error.message}`));
  }
}

function renderLinkedAccounts(accounts) {
  if (accounts.length === 0) {
    elements.linkedAccountsList.replaceChildren(linkedAccountsMessage('暂无映射账号'));
    return;
  }
  elements.linkedAccountsList.replaceChildren(
    ...accounts.map((account) => {
      const row = document.createElement('div');
      row.className = 'linked-account-row';
      const remote = account.remote;
      const infoLine = remote
        ? `${remote.name}（账号 #${account.myAccountId}）`
        : (account.remoteError ? `状态读取失败：${account.remoteError}` : `账号 #${account.myAccountId}`);
      row.innerHTML = `
        <div class="linked-account-info">
          <strong>${escapeHtml(account.mySiteName)} · ${escapeHtml(account.myGroupName || account.myGroupId)}</strong>
          <span class="page-subtitle">${escapeHtml(infoLine)}</span>
        </div>
        <label class="linked-account-toggle">
          <input type="checkbox" data-field="schedulable" ${remote?.schedulable ? 'checked' : ''} ${remote ? '' : 'disabled'} />
          可调度
        </label>
        <label class="linked-account-priority">
          优先级
          <input type="number" data-field="priority" min="0" step="1" value="${Number(remote?.priority ?? 0)}" ${remote ? '' : 'disabled'} />
        </label>
      `;
      row.querySelector('[data-field="schedulable"]').addEventListener('change', (event) => {
        void saveLinkedAccountField(account, { schedulable: event.currentTarget.checked }, event.currentTarget);
      });
      row.querySelector('[data-field="priority"]').addEventListener('change', (event) => {
        void saveLinkedAccountField(account, { priority: Number(event.currentTarget.value) }, event.currentTarget);
      });
      return row;
    }),
  );
}

// 直改直存：失败后重拉列表回退到我站点真实状态
async function saveLinkedAccountField(account, patch, input) {
  input.disabled = true;
  try {
    const response = await fetch(`/api/my-site-accounts/${encodeURIComponent(account.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `保存失败: HTTP ${response.status}`);
    account.remote = payload.remote ?? account.remote;
    if (account.remote) state.mySiteAccountSchedulable[account.id] = Boolean(account.remote.schedulable);
    if (Object.hasOwn(patch, 'schedulable')) input.checked = Boolean(account.remote?.schedulable);
    if (Object.hasOwn(patch, 'priority')) input.value = String(Number(account.remote?.priority ?? 0));
  } catch (error) {
    showToast({ type: 'error', title: '保存失败', message: error.message, duration: 4000 });
    await loadLinkedAccounts();
  } finally {
    input.disabled = false;
  }
}

const DEFAULT_EXCLUDED_MODELS_TEXT = 'gpt-5.6-luna gpt-image-1 gpt-image-2 gpt-image-1.5';

function openCreateAccountModal(site, group) {
  const context = { site, group };
  state.createAccountContext = context;
  state.createAccountRemoteGroups = [];
  state.createAccountGroupsRequest = null;
  elements.createAccountContext.textContent = `上游：${site.name} · ${group.name}`;
  // 每次打开恢复默认：池模式开、重试 3 次、强制 Responses、默认排除模型
  elements.createAccountPoolMode.checked = true;
  elements.createAccountPoolRetryCount.value = '3';
  elements.createAccountResponsesMode.value = 'force_responses';
  elements.createAccountExcludedModels.value = DEFAULT_EXCLUDED_MODELS_TEXT;
  renderCreateAccountExisting();
  renderCreateAccountMySiteOptions();
  renderCreateAccountMyGroupOptions();
  elements.createAccountModal.showModal();
  elements.createAccountMySite.focus();
  // 直达分组管理页时站点清单可能还没拉过，开弹窗时刷新一次再重绘下拉框
  void loadMySites().then(() => {
    if (state.createAccountContext !== context || !elements.createAccountModal.open) return;
    renderCreateAccountExisting();
    renderCreateAccountMySiteOptions();
    if (state.createAccountGroupsRequest?.mySiteId !== elements.createAccountMySite.value) {
      void loadCreateAccountRemoteGroups(elements.createAccountMySite.value);
    }
  });
}

function closeCreateAccountModal() {
  state.createAccountContext = null;
  state.createAccountRemoteGroups = [];
  state.createAccountGroupsRequest = null;
  elements.createAccountSubmit.disabled = true;
  elements.createAccountModal.close();
}

function renderCreateAccountExisting() {
  const context = state.createAccountContext;
  const accounts = context
    ? state.mySiteAccounts.filter((account) => (
      account.upstreamSiteId === context.site.id && String(account.upstreamGroupId) === String(context.group.id)
    ))
    : [];
  if (accounts.length === 0) {
    elements.createAccountExisting.hidden = true;
    elements.createAccountExisting.replaceChildren();
    return;
  }
  const mySiteNames = new Map(state.mySites.map((mySite) => [mySite.id, mySite.name]));
  elements.createAccountExisting.hidden = false;
  elements.createAccountExisting.replaceChildren(
    ...accounts.map((account) => {
      const line = document.createElement('p');
      const mySiteName = mySiteNames.get(account.mySiteId) ?? account.mySiteId;
      line.textContent = `已创建：${mySiteName} · ${account.myGroupName ?? account.myGroupId}`;
      return line;
    }),
  );
}

function renderCreateAccountMySiteOptions() {
  const selectedId = elements.createAccountMySite.value;
  if (state.mySites.length === 0) {
    const empty = optionElement('', '请先在 配置管理 › 我的站点 中添加');
    empty.disabled = true;
    elements.createAccountMySite.replaceChildren(empty);
    return;
  }
  elements.createAccountMySite.replaceChildren(
    ...state.mySites.map((mySite) => optionElement(mySite.id, mySite.name)),
  );
  if (state.mySites.some((mySite) => String(mySite.id) === selectedId)) {
    elements.createAccountMySite.value = selectedId;
  }
}

function renderCreateAccountMyGroupOptions() {
  const mySiteId = elements.createAccountMySite.value;
  const groups = state.createAccountRemoteGroups;
  if (!mySiteId || state.mySites.length === 0) {
    const empty = optionElement('', '请先选择我的站点');
    empty.disabled = true;
    elements.createAccountMyGroup.replaceChildren(empty);
    updateCreateAccountOptionsVisibility();
    return;
  }
  if (groups.length === 0) {
    const empty = optionElement('', '暂无可选分组');
    empty.disabled = true;
    elements.createAccountMyGroup.replaceChildren(empty);
    updateCreateAccountOptionsVisibility();
    return;
  }
  const context = state.createAccountContext;
  const linkedGroupIds = new Set(
    state.mySiteAccounts
      .filter((account) => (
        account.mySiteId === mySiteId
        && account.upstreamSiteId === context?.site.id
        && String(account.upstreamGroupId) === String(context?.group.id ?? '')
      ))
      .map((account) => String(account.myGroupId)),
  );
  elements.createAccountMyGroup.replaceChildren(
    ...groups.map((group) => {
      const linked = linkedGroupIds.has(String(group.id));
      const option = optionElement(
        group.id,
        `${group.name} · ${group.rateMultiplier}x${linked ? '（已创建）' : ''}`,
      );
      option.disabled = linked;
      return option;
    }),
  );
  updateCreateAccountOptionsVisibility();
}

function isCurrentCreateAccountGroupsRequest(request) {
  return state.createAccountGroupsRequest === request
    && state.createAccountContext === request.context
    && elements.createAccountModal.open
    && elements.createAccountMySite.value === request.mySiteId;
}

function selectedCreateAccountGroup() {
  const request = state.createAccountGroupsRequest;
  if (!request || request.status !== 'ready' || !isCurrentCreateAccountGroupsRequest(request)) return null;
  const option = elements.createAccountMyGroup.selectedOptions[0];
  if (!option || option.disabled) return null;
  return state.createAccountRemoteGroups.find((group) => String(group.id) === option.value) ?? null;
}

// Responses API 模式只对目标（我站点）openai 分组有意义，其余平台隐藏该选项
function updateCreateAccountOptionsVisibility() {
  const selected = selectedCreateAccountGroup();
  elements.createAccountResponsesField.hidden = selected?.platform !== 'openai';
  elements.createAccountSubmit.disabled = !selected;
}

async function loadCreateAccountRemoteGroups(mySiteId) {
  // 请求对象同时绑定弹窗会话、站点和本次代际，切回同一站点也不能接收旧响应。
  const request = { context: state.createAccountContext, mySiteId, status: 'loading' };
  state.createAccountGroupsRequest = request;
  state.createAccountRemoteGroups = [];
  updateCreateAccountOptionsVisibility();
  if (!mySiteId) {
    renderCreateAccountMyGroupOptions();
    return;
  }
  const loading = optionElement('', '加载中…');
  loading.disabled = true;
  elements.createAccountMyGroup.replaceChildren(loading);
  try {
    const response = await fetch(`/api/my-sites/${encodeURIComponent(mySiteId)}/groups`, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!isCurrentCreateAccountGroupsRequest(request)) return;
    if (!response.ok) throw new Error(payload.error ?? `读取我的站点分组失败: HTTP ${response.status}`);
    state.createAccountRemoteGroups = payload.groups ?? [];
    request.status = 'ready';
  } catch (error) {
    if (!isCurrentCreateAccountGroupsRequest(request)) return;
    request.status = 'error';
    state.createAccountRemoteGroups = [];
    showToast({
      type: 'error',
      title: '读取我的站点分组失败',
      message: error.message,
      duration: 5000,
    });
  }
  renderCreateAccountMyGroupOptions();
}

async function saveMySiteAccountFromModal() {
  const context = state.createAccountContext;
  if (!context || !selectedCreateAccountGroup()) return;
  const formData = new FormData(elements.createAccountForm);
  const responsesVisible = !elements.createAccountResponsesField.hidden;
  const input = {
    mySiteId: String(formData.get('my_site_id') ?? ''),
    myGroupId: String(formData.get('my_group_id') ?? ''),
    upstreamSiteId: context.site.id,
    upstreamGroupId: context.group.id,
    poolMode: elements.createAccountPoolMode.checked,
    poolModeRetryCount: Number(elements.createAccountPoolRetryCount.value || 3),
    responsesMode: responsesVisible ? String(formData.get('responses_mode') ?? 'force_responses') : null,
    excludedModels: String(formData.get('excluded_models') ?? '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean),
  };
  try {
    const response = await fetch('/api/my-site-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `创建账号失败: HTTP ${response.status}`);
    closeCreateAccountModal();
    showToast({
      type: 'success',
      title: '账号已创建',
      message: payload.account?.myGroupName ?? input.myGroupId,
      duration: 2500,
    });
    await loadMySiteAccounts();
    state.mySiteAccountSchedulableLoaded = false;
    await ensureMySiteAccountSchedulable();
    renderGroupsTable();
  } catch (error) {
    showToast({
      type: 'error',
      title: '创建账号失败',
      message: error.message,
      duration: 5000,
    });
  }
}

function filteredGroups() {
  const groups = allGroups().filter(({ site, group, keyCount }) => {
    const setting = getGroupModelSetting(site.id, group.id);
    if (state.groupSiteFilter !== 'all' && site.id !== state.groupSiteFilter) return false;
    if (state.groupModelFilter !== 'all' && (setting?.selectedModel ?? '') !== state.groupModelFilter) return false;
    if (
      state.groupPlatformFilter !== 'all'
      && normalizePlatformDisplay(group.platform).key !== state.groupPlatformFilter
    ) return false;
    if (state.groupKeyFilter === '1' && Number(keyCount ?? 0) <= 0) return false;
    const multiplier = Number(group.multiplier ?? 0);
    if (multiplier < state.groupMultiplierMin || multiplier > state.groupMultiplierMax) return false;
    const accountLinks = groupAccountLinks(site.id, group.id);
    if (state.groupMyGroupFilter.length > 0) {
      const selected = new Set(state.groupMyGroupFilter);
      const matchesUngrouped = selected.has(UNGROUPED_FILTER_VALUE) && accountLinks.length === 0;
      const matchesGroup = accountLinks.some(
        (link) => selected.has(`${link.mySiteId}:${link.myGroupId}`),
      );
      if (!matchesUngrouped && !matchesGroup) return false;
    }
    if (state.groupSchedulableFilter !== 'all') {
      // 可调度 = 任一映射账号在我站点 schedulable=true；状态未知（未拉取/拉取失败）两边都不算
      const schedulableStates = accountLinks
        .map((link) => state.mySiteAccountSchedulable[link.id])
        .filter((value) => value !== null && value !== undefined);
      const hasSchedulable = schedulableStates.some((value) => value === true);
      if (state.groupSchedulableFilter === '1' && !hasSchedulable) return false;
      if (
        state.groupSchedulableFilter === '0'
        && (accountLinks.length === 0 || schedulableStates.length === 0 || hasSchedulable)
      ) return false;
    }
    return true;
  });
  return sortGroups(groups);
}

function groupAccountLinks(siteId, groupId) {
  return state.mySiteAccounts.filter((account) => (
    account.upstreamSiteId === siteId && String(account.upstreamGroupId) === String(groupId)
  ));
}

function savedDisplayModels() {
  const models = Object.values(state.groupModelSettings)
    .map((setting) => String(setting?.selectedModel ?? '').trim())
    .filter(Boolean);
  return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

function sortGroups(groups) {
  if (!state.groupSortKey) return groups;
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const direction = state.groupSortDirection === 'desc' ? -1 : 1;
  return [...groups].sort((left, right) => {
    let result = 0;
    if (state.groupSortKey === 'site') {
      result = collator.compare(left.site.name, right.site.name)
        || collator.compare(left.group.name, right.group.name);
    }
    if (state.groupSortKey === 'multiplier') {
      result = Number(left.group.multiplier ?? 0) - Number(right.group.multiplier ?? 0)
        || collator.compare(left.site.name, right.site.name)
        || collator.compare(left.group.name, right.group.name);
    }
    return result * direction;
  });
}

function buildEmptySnapshots(sites, existing = {}) {
  return Object.fromEntries(
    sites.map((site) => [site.id, existing[site.id] ?? createPendingSnapshot(site)]),
  );
}

function createPendingSnapshot(site, message = '') {
  return {
    siteId: site.id,
    balanceAmount: 0,
    balanceCurrency: 'USD',
    balanceCny: 0,
    balanceUsd: 0,
    token: '',
    tokens: [],
    groups: [],
    probe: {
      ok: false,
      latencyMs: null,
      status: 'unknown',
      checkedAt: new Date().toISOString(),
    },
    error: message,
    refreshedAt: new Date().toISOString(),
  };
}

function createErrorSnapshot(site, message) {
  return {
    ...createPendingSnapshot(site, message),
    probe: {
      ok: false,
      latencyMs: null,
      status: 'down',
      checkedAt: new Date().toISOString(),
    },
  };
}

function isSnapshotSupported(site) {
  return site.type === 'sub2api' || site.type === 'new-api';
}

function siteTypeClass(type) {
  if (type === 'sub2api') return 'sub2api';
  if (type === 'new-api') return 'new-api';
  return 'other';
}

function showTableError(tbody, colspan, message) {
  const row = document.createElement('tr');
  row.innerHTML = `<td colspan="${colspan}" class="empty-cell">${escapeHtml(message)}</td>`;
  tbody.replaceChildren(row);
}

function optionElement(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function externalLinkHtml(url) {
  return `<a class="external-link" href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
}

function proxyCellHtml(proxy) {
  if (!proxy) return '<span class="model-empty">直连</span>';
  return `
    <div class="proxy-cell">
      <strong>${escapeHtml(proxy.name)}</strong>
      <span>${escapeHtml(proxy.protocol)}://${escapeHtml(proxy.host)}:${Number(proxy.port)}</span>
    </div>
  `;
}

// 阈值按展示口径比较：站点配了 USD→CNY 换算时，balance.amount 已是换算后的 CNY
function isBalanceAlert(site, balance) {
  const threshold = Number(site?.balanceAlert ?? 0);
  return Number.isFinite(threshold) && threshold > 0 && Number(balance.amount) < threshold;
}

function balanceCellHtml(site, snapshot) {
  const balance = displayBalance({ site, snapshot });
  const alertClass = isBalanceAlert(site, balance) ? ' balance-alert' : '';
  return `
    <div class="balance-cell">
      <div class="balance-amount${alertClass}">
        <strong>${formatBalance(balance.amount)}</strong>
        <span>${escapeHtml(balance.currency)}</span>
      </div>
      ${balanceRefreshButtonHtml()}
    </div>
  `;
}

function groupBalanceCellHtml(site, snapshot) {
  const balance = displayBalance({ site, snapshot });
  const alertClass = isBalanceAlert(site, balance) ? ' balance-alert' : '';
  return `
    <div class="group-balance-cell">
      <div class="balance-amount${alertClass}">
        <strong>${formatBalance(balance.amount)}</strong>
        <span>${escapeHtml(balance.currency)}</span>
      </div>
      ${balanceRefreshButtonHtml()}
    </div>
  `;
}

function apiKeyCellHtml(token) {
  if (!token) return '<span class="model-empty">-</span>';
  const canCopy = Boolean(String(token.key ?? '').trim());
  return `
    <button
      class="model-action api-key-copy"
      type="button"
      data-action="copy-api-key"
      title="${canCopy ? '复制 API Key' : '未获取到 API Key 明文'}"
      aria-label="${canCopy ? '复制 API Key' : '未获取到 API Key 明文'}"
      ${canCopy ? '' : 'disabled'}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 8h11v11H8zM5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" />
      </svg>
    </button>
  `;
}

function modelSelectionCellHtml(site, group) {
  const setting = getGroupModelSetting(site.id, group.id);
  const selected = setting?.selectedModel ?? '';
  return `
    <div class="model-cell">
      <span class="${selected ? 'model-name' : 'model-empty'}" title="${escapeAttribute(selected || '未选择')}">
        ${escapeHtml(selected || '未选择')}
      </span>
      <button class="model-action" type="button" data-action="edit-group-model" title="编辑分组模型" aria-label="编辑分组模型">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
    </div>
  `;
}

function modelTestCellHtml(site, group) {
  const setting = getGroupModelSetting(site.id, group.id);
  const lastTest = setting?.lastTest;
  const latency = lastTest?.responseTimeMs;
  const display = modelTestDisplay(lastTest);
  const pending = state.pendingModelTests.has(groupSettingKey(site.id, group.id));
  const meta = pending ? '测速中…' : `${display.label} · ${formatTime(lastTest?.testedAt)}`;
  return `
    <div class="model-test-cell ${escapeAttribute(display.tone)}">
      <div>
        <strong>${latency === null || latency === undefined ? '-' : `${latency} ms`}</strong>
        <div class="model-test-meta">${escapeHtml(meta)}</div>
      </div>
      <button class="model-action ${pending ? 'is-refreshing' : ''}" type="button" data-action="test-group-model"
        title="${pending ? '测速进行中' : '测试选中模型'}" aria-label="${pending ? '测速进行中' : '测试选中模型'}" ${pending ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 12a9 9 0 0 1-15 6.7M3 12a9 9 0 0 1 15-6.7M21 4v6h-6M3 20v-6h6" />
        </svg>
      </button>
    </div>
  `;
}

function balanceRefreshButtonHtml() {
  return `
    <button class="balance-refresh" type="button" title="同步该站点（余额、分组、Key、模型）" aria-label="同步该站点">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 12a9 9 0 0 1-15 6.7M3 12a9 9 0 0 1 15-6.7M21 4v6h-6M3 20v-6h6" />
      </svg>
    </button>
  `;
}

function groupMetricHtml(snapshot) {
  const groups = snapshot.groups ?? [];
  return `
    <button class="metric-pill" type="button" data-action="show-groups"
      title="在分组管理中查看该站点的分组" aria-label="查看该站点的分组">${groups.length} 组</button>
  `;
}

function keyMetricHtml(snapshot) {
  const groups = snapshot.groups ?? [];
  const keyCount = groups.reduce((sum, group) => sum + Number(group.keyCount ?? 0), 0);
  return `
    <button class="metric-pill" type="button" data-action="show-keys"
      title="在分组管理中查看该站点有 Key 的分组" aria-label="查看该站点有 Key 的分组">${keyCount} Key</button>
  `;
}

// 点站点行的"分组 / Key"数字跳到分组管理：锁定该站点、倍率 0-100，其余筛选恢复默认（全选）；
// 点 Key 时再叠加"有 Key"筛选
function openSiteGroups(site, { hasKeyOnly = false } = {}) {
  Object.assign(state, DEFAULT_GROUP_FILTERS, {
    groupSiteFilter: site.id,
    groupKeyFilter: hasKeyOnly ? '1' : 'all',
  });
  setActiveGroupPreset('');
  saveGroupViewPreferences();
  navigateToPath(APP_PATHS.groups);
}

function probeCellHtml(snapshot) {
  const status = snapshot.probe?.status ?? 'unknown';
  const latency = snapshot.probe?.latencyMs;
  const note = snapshot.error || `checked ${formatTime(snapshot.probe?.checkedAt)}`;
  return `
    <div class="probe-cell">
      <span class="status-pill ${statusClass(status)}">${statusLabel(status)}</span>
      <span class="time-line">${latency ? `${latency} ms` : '-'} · ${escapeHtml(note)}</span>
    </div>
  `;
}

function rateCellHtml(multiplier) {
  return `
    <div class="rate-cell">
      <span>${formatMultiplier(multiplier)}x</span>
    </div>
  `;
}

function platformBadgeHtml(platform) {
  const display = normalizePlatformDisplay(platform);
  return `
    <span class="platform-badge ${display.key}">
      ${platformIconHtml(display.key)}
      <span>${escapeHtml(display.label)}</span>
    </span>
  `;
}

function platformIconHtml(platformKey) {
  if (platformKey === 'openai') {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
      </svg>
    `;
  }
  if (platformKey === 'anthropic') {
    return `
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z" />
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 2.3L6 8.7v6.6l6 3.4 6-3.4V8.7l-6-3.4z" />
    </svg>
  `;
}

function getGroupModelSetting(siteId, groupId) {
  return state.groupModelSettings[groupSettingKey(siteId, groupId)] ?? null;
}

function groupSettingKey(siteId, groupId) {
  return `${siteId}::${groupId}`;
}

function mergeModelOptions(...sources) {
  const byId = new Map();
  for (const source of sources) {
    const items = Array.isArray(source) ? source : [source];
    for (const item of items) {
      const id = String(item?.id ?? item ?? '').trim();
      if (!id) continue;
      byId.set(id, {
        id,
        ownedBy: item?.ownedBy ? String(item.ownedBy) : '',
      });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function formatCurrency(value) {
  return `${formatBalance(value)} CNY`;
}

function formatBalance(value) {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value ?? 0));
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function statusLabel(status) {
  return {
    healthy: '正常',
    slow: '慢',
    down: '不通',
    operational: '正常',
    degraded: '慢',
    failed: '失败',
    unknown: '未知',
  }[status] ?? '未知';
}

function statusClass(status) {
  return {
    healthy: 'healthy',
    slow: 'slow',
    down: 'down',
  }[status] ?? 'neutral';
}

function shortId(id) {
  const text = String(id ?? '');
  return text.length > 8 ? `#${text.slice(0, 8)}` : text || '-';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char];
  });
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
