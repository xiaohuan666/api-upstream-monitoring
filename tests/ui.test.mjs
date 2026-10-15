import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('site modal exposes refresh token field for add and edit forms', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  assert.match(html, /name="refresh_token"/);
  assert.match(html, /Refresh Token（自动续期）/);
  assert.match(html, /rt_ 开头/);
});

test('site modal splits new-api login username and numeric user id', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(html, /data-field="new_api_user_id"/);
  assert.match(html, /name="new_api_user_id"/);
  assert.match(html, /用户 ID/);
  assert.match(html, /数字 ID，用于 new-api-user 请求头/);
  assert.match(html, /placeholder="邮箱，用于会话过期自动重登"/);
  assert.doesNotMatch(html, /New-Api-User，例如/);
  assert.match(app, /form\.new_api_user_id\.value = site\?\.newApiUserId/);
  assert.match(app, /new_api_user_id: String\(formData\.get\('new_api_user_id'\)/);
  assert.match(app, /setFormFieldRequired\('new_api_user_id', type === 'new-api'\)/);
  assert.match(app, /User id is required for new-api/);
});

test('site modal exposes a sub2api sync variant select with dynamic requirements', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(html, /data-field="sync_variant"/);
  assert.match(html, /name="sync_variant" id="site-sync-variant"/);
  assert.match(html, /<option value="standard">标准<\/option>/);
  assert.match(html, /<option value="credential-flow">凭据流（加密登录\+验证码）<\/option>/);
  assert.match(html, /data-field="password"/);
  assert.match(app, /form\.sync_variant\.value = site\?\.syncVariant/);
  assert.match(app, /sync_variant: type === 'sub2api'/);
  assert.match(app, /isCredentialFlow/);
  assert.match(app, /setFormFieldRequired\('username', isCredentialFlow\)/);
  assert.match(app, /setFormFieldRequired\('password', isCredentialFlow\)/);
  assert.match(app, /setFormFieldRequired\('auth_token', \(type === 'sub2api' && !isCredentialFlow\) \|\| type === 'new-api'\)/);
  assert.match(app, /Login username and password are required for credential-flow sub2api/);
  assert.match(app, /可留空，首次同步自动登录获取/);
  assert.match(app, /siteSyncVariant\.addEventListener\('change', updateSiteFormRequirements\)/);
});

test('site modal exposes an unambiguous USD to CNY rate field', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(html, /name="usd_to_cny_rate"/);
  assert.match(html, /1 USD =/);
  assert.match(html, /CNY/);
  assert.match(html, /min="0\.000001"/);
  assert.match(app, /usdToCnyRate/);
  assert.match(app, /usd_to_cny_rate/);
});

test('balance alert threshold renders a red blinking balance when below the threshold', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

  assert.match(html, /name="balance_alert"/);
  assert.match(html, /余额预警/);
  assert.match(app, /balanceAlert/);
  assert.match(app, /balance_alert/);
  assert.match(app, /isBalanceAlert/);
  assert.match(css, /\.balance-alert strong/);
  assert.match(css, /@keyframes balance-alert-blink/);
});

test('site form keeps an independent hourly depletion alert and the ETA cell blinks on alert', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(html, /name="depletion_alert_hours"[\s\S]*?value="1"/);
  assert.match(app, /form\.depletion_alert_hours\.value = site\?\.depletionAlertHours \?\? 1/);
  assert.match(app, /depletion_alert_hours: Number\(formData\.get\('depletion_alert_hours'\)/);
  assert.match(app, /isDepletionAlert\(\{ site, snapshot \}\)/);
  assert.match(css, /\.depletion-alert[\s\S]*?balance-alert-blink/);
});

test('site form collects a separate base URL used for model probes', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const http = await readFile(new URL('../src/http.mjs', import.meta.url), 'utf8');

  assert.match(html, /data-field="base_url"/);
  assert.match(html, /name="base_url"/);
  assert.match(html, /留空同站点 URL/);
  assert.match(app, /form\.base_url\.value = site\?\.baseUrl/);
  assert.match(app, /base_url: normalizeSiteUrl\(formData\.get\('base_url'\)\)/);
  assert.match(http, /site\.baseUrl \|\| site\.url/);
});

test('groups table exposes an inline editable hvoy_score column', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

  assert.match(html, /<th>hvoy_score<\/th>/);
  assert.match(app, /group-score-input/);
  assert.match(app, /saveGroupScore/);
  assert.match(app, /\/group-score/);
  assert.match(css, /\.group-score-input/);
});

test('wide tables flex content columns instead of leaving empty space on the right', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

  // 站点列钉基准宽，多余空间按列宽比例分配，不会吞掉全部剩余宽度
  assert.match(css, /#sites-panel th:nth-child\(2\),\s*#sites-panel td:nth-child\(2\) \{\s*width: 180px;/);
  // 分组表内容列（站点/分组/模型选择）不写宽度，由 fixed 布局分配剩余空间
  assert.doesNotMatch(css, /#groups-panel (th|td):nth-child\([128]\),/);
  // 小列和末列保持固定宽度，防止被压垮
  assert.match(css, /#groups-panel th:nth-child\(13\),\s*#groups-panel td:nth-child\(13\) \{\s*width: 96px;/);
  assert.match(css, /#groups-panel th:nth-child\(12\),\s*#groups-panel td:nth-child\(12\) \{\s*width: 110px;/);
  assert.match(css, /#groups-panel th:nth-child\(11\),\s*#groups-panel td:nth-child\(11\) \{\s*width: 110px;/);
  assert.match(css, /#sites-panel th:nth-child\(11\),[^]*?width: 150px;/);
});

test('summary cards show CNY total and a balance-alert link that filters the sites table', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

  assert.match(html, /id="metric-balance-alerts"/);
  assert.match(html, /余额不足：0/);
  assert.match(html, /id="sites-balance-alert-filter"/);
  assert.match(html, />0\.00 CNY</);
  assert.match(app, /balanceAlertCount/);
  assert.match(app, /setSiteBalanceAlertOnly/);
  assert.match(app, /balance-alert=1/);
  assert.match(app, /siteBalanceAlertOnly/);
  assert.match(css, /\.metric-alert-link\.active/);
  assert.match(css, /\.filter-toggle/);
});

test('page exposes a top-right toast region for sync notifications', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

  assert.match(html, /id="toast-region"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(css, /\.toast-region/);
  assert.match(css, /position:\s*fixed/);
  assert.match(css, /right:\s*18px/);
  assert.match(css, /\.toast\.success/);
  assert.match(css, /toast-progress-shrink/);
});

test('group management exposes model selection and model test columns with an edit modal', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(html, /模型选择/);
  assert.match(html, /测试模型/);
  assert.match(html, /API Key/);
  assert.match(html, /id="group-model-filter"/);
  assert.match(html, /id="group-model-modal"/);
  assert.match(html, /id="group-model-select"/);
  assert.match(html, /id="group-test-model-select"/);
  assert.match(html, /id="group-model-manual"/);
  assert.match(html, /id="fetch-group-models"/);
  assert.match(css, /\.model-cell/);
  assert.match(css, /\.model-test-cell/);
  assert.match(css, /\.model-test-cell\.down/);
  assert.match(css, /\.model-test-cell\.slow/);
  assert.match(css, /\.model-test-cell\.normal/);
  assert.match(css, /\.model-test-cell\.fast/);
  assert.match(app, /\/models\?groupId=/);
  assert.match(app, /testModel/);
  assert.match(app, /modelTestDisplay/);
  assert.match(app, /groupModelFilter/);
  assert.match(app, /buildGroupRows/);
  assert.match(app, /data-action="copy-api-key"/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(app, /pendingModelTests/);
  assert.match(app, /测速中…/);
  assert.doesNotMatch(app, /--rate:/);
});

test('page exposes proxy management and site proxy selection', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(html, /配置管理/);
  assert.match(html, /代理配置/);
  assert.match(html, /id="settings-proxies-panel"/);
  assert.match(html, /id="site-proxy-id"/);
  assert.match(html, /id="proxies-table"/);
  // 批量导入独立为主菜单「IP 管理」页，导入走弹窗，代理池表格两页同渲染
  assert.match(html, /IP 管理/);
  assert.match(html, /href="\/ip-management"[^>]*data-route-link[^>]*data-tab="ip-management"/);
  assert.match(html, /<section id="ip-management-panel" class="panel-view hidden"/);
  assert.match(html, /id="ip-management-table"/);
  assert.match(html, /id="open-proxy-import"[^>]*>批量导入</);
  assert.match(html, /<dialog id="proxy-import-modal"/);
  assert.match(html, /id="proxy-import-modal"[\s\S]*id="proxy-import-input"[\s\S]*id="proxy-import-stats"[\s\S]*id="proxy-import-submit"[^>]*disabled/);
  assert.doesNotMatch(html, /id="toggle-proxy-import"/);
  assert.match(css, /\.proxy-import-panel/);
  assert.match(app, /openProxyImportModal/);
  assert.match(app, /parseProxyImportText/);
  assert.match(app, /\/api\/proxies\/batch/);
  assert.match(app, /importProxiesFromText/);
  // 多选导出：复选列 + 导出弹窗（四种导入格式 + sub2api JSON），每项带复制按钮，可预览与下载
  assert.match(html, /id="open-proxy-export"[^>]*hidden>导出</);
  assert.match(html, /id="proxy-select-all" type="checkbox"/);
  assert.match(html, /<dialog id="proxy-export-modal"/);
  assert.match(html, /id="proxy-export-formats"/);
  assert.match(html, /id="proxy-export-preview"[^>]*readonly/);
  assert.match(html, /id="proxy-export-download"[^>]*>下载</);
  assert.match(css, /\.proxy-export-format/);
  assert.match(css, /\.checkbox-cell/);
  assert.match(app, /selectedProxyIds/);
  assert.match(app, /buildProxyExportContent/);
  assert.match(app, /openProxyExportModal/);
  assert.match(app, /downloadProxyExport/);
  assert.match(app, /syncProxySelectionUI/);
  // 编辑走弹窗：名称可改，批量导入默认命名 default
  assert.match(html, /<dialog id="proxy-edit-modal"/);
  assert.match(html, /id="proxy-edit-form"/);
  assert.match(html, /id="proxy-edit-context"/);
  assert.match(app, /editProxyInModal/);
  assert.match(app, /saveProxyEditFromModal/);
  // 名称旁复制按钮 + IP 映射（sub2 侧存在则采用并对齐名称，否则新建）
  assert.match(app, /data-action="copy-proxy-address"/);
  assert.match(app, /copyProxyAddress/);
  assert.match(app, /data-action="link-proxy"/);
  assert.match(app, /linkProxyToMySite/);
  assert.match(app, /unlinkProxyFromMySite/);
  assert.match(app, /\/api\/my-site-proxies/);
  assert.match(app, /loadMySiteProxyLinks/);
  // 到期时间：导入弹窗统一选期（默认 +30 天）、编辑弹窗/内联表单字段、表格「到期」列
  assert.match(html, /id="proxy-import-expires-at" type="datetime-local"/);
  assert.ok((html.match(/name="expires_at" type="datetime-local"/g) ?? []).length >= 2);
  assert.match(html, /<th>到期<\/th>/);
  assert.match(css, /\.proxy-expiry/);
  assert.match(css, /\.proxy-import-expiry/);
  assert.match(app, /proxyExpiryCellHtml/);
  assert.match(app, /toDatetimeLocalValue/);
  assert.match(css, /\.config-menu/);
  assert.match(app, /\/api\/proxies/);
  assert.match(app, /proxy_id/);
  assert.match(app, /renderProxiesTable/);
  assert.match(app, /ipManagementPanel/);
  assert.match(app, /ipManagementTable/);
});

test('page exposes auto refresh settings next to proxy management', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(html, /定时拉取/);
  assert.match(html, /id="settings-auto-refresh-link"/);
  assert.match(html, /id="settings-auto-refresh-panel"/);
  assert.match(html, /name="enabled"/);
  assert.match(html, /name="interval_value"/);
  assert.match(html, /name="interval_unit"/);
  assert.match(html, /value="minutes"/);
  assert.match(html, /value="hours"/);
  assert.match(html, /value="days"/);
  assert.match(app, /\/api\/auto-refresh-settings/);
  assert.match(app, /loadAutoRefreshSettings/);
  assert.match(app, /saveAutoRefreshSettings/);
});

test('page exposes my sites management and create account flow', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const route = await readFile(new URL('../src/client-route.mjs', import.meta.url), 'utf8');

  assert.match(html, /我的站点/);
  assert.match(html, /id="settings-my-sites-panel"/);
  assert.match(html, /id="my-site-form"/);
  assert.match(html, /id="my-sites-table"/);
  assert.match(html, /id="create-account-modal"/);
  assert.match(html, /data-setting-route="my-sites"/);
  assert.match(html, /href="\/settings\/my-sites"/);
  assert.match(app, /\/api\/my-sites/);
  assert.match(app, /\/api\/my-site-accounts/);
  assert.match(app, /renderMySitesTable/);
  assert.match(app, /openCreateAccountModal/);
  assert.match(route, /settings\/my-sites/);
});

test('create account dialog exposes pool mode and responses mode options', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(html, /id="create-account-pool-mode"/);
  assert.match(html, /name="pool_mode"[^>]*checked/);
  assert.match(html, /id="create-account-pool-retry-count"/);
  assert.match(html, /name="pool_mode_retry_count"[^>]*value="3"/);
  assert.match(html, /id="create-account-responses-mode"/);
  assert.match(html, /value="force_responses" selected/);
  assert.match(html, /value="force_chat_completions"/);
  assert.match(app, /updateCreateAccountOptionsVisibility/);
  assert.match(app, /poolModeRetryCount/);
  assert.match(app, /responsesMode/);
});

test('group management persists filters and sorting through the preferences API', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(app, /\/api\/ui-preferences\/group-management/);
  assert.match(app, /loadGroupViewPreferences/);
  assert.match(app, /saveGroupViewPreferences/);
  assert.match(app, /applyGroupViewPreferences/);
  assert.match(app, /currentGroupViewPreferences/);
  assert.match(app, /saveGroupViewPreferences\(\)/);
});

test('main tabs and settings children expose independent route URLs', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(html, /href="\/sites"[^>]*data-route-link/);
  assert.match(html, /href="\/groups"[^>]*data-route-link/);
  assert.match(html, /href="\/rate-changes"[^>]*data-route-link/);
  assert.match(html, /href="\/settings\/my-sites"[^>]*data-route-link/);
  assert.match(html, /href="\/oauth-accounts"[^>]*data-route-link/);
  assert.match(html, /href="\/oauth-tasks"[^>]*data-route-link/);
  assert.doesNotMatch(html, /data-tab="(?:pricing|benchmarks)"|id="(?:pricing|benchmarks)-/);
  assert.doesNotMatch(app, /\/api\/(?:pricing|benchmarks)|benchmark-display|pricing-view/);
  assert.match(html, /href="\/settings"[^>]*data-route-link/);
  assert.match(html, /href="\/settings\/proxies"[^>]*data-route-link/);
  assert.match(html, /href="\/settings\/auto-refresh"[^>]*data-route-link/);
  assert.match(html, /href="\/ip-management"[^>]*data-route-link/);
  assert.match(html, /href="\/styles\.css\?v=20261003-rate-history-columns"/);
  assert.match(html, /src="\/src\/app\.mjs\?v=\d{8}-[a-z-]+"/);
  assert.match(app, /resolveAppRoute/);
  assert.match(app, /history\.pushState/);
  assert.match(app, /history\.replaceState/);
  assert.match(app, /popstate/);
  assert.match(app, /settingsProxiesPanel/);
  assert.match(app, /settingsAutoRefreshPanel/);
});

test('settings children are standalone pages without dialog tabs', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(html, /<section id="settings-proxies-panel" class="panel-view hidden"/);
  assert.match(html, /<section id="settings-auto-refresh-panel" class="panel-view hidden"/);
  assert.doesNotMatch(html, /id="proxy-modal"/);
  assert.doesNotMatch(html, /id="auto-refresh-modal"/);
  assert.doesNotMatch(html, /settings-dialog-tabs/);
  assert.doesNotMatch(app, /leaveSettingsRoute|proxyModal\b|autoRefreshModal\b/);

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('config menu exposes an expand-collapse chevron', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

  assert.match(html, /<svg class="config-menu-chevron"/);
  assert.match(css, /\.config-menu summary \.config-menu-chevron/);
  assert.match(css, /\.config-menu\[open\] > summary \.config-menu-chevron \{\s*transform: rotate\(90deg\);/);
});

test('site and group tables expose database-only refresh controls', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(html, /id="refresh-sites-table"/);
  assert.match(html, /id="refresh-groups-table"/);
  assert.match(html, />\s*刷新表格\s*</);
  assert.match(app, /reloadTablesFromDatabase/);
  assert.match(app, /readSites:\s*readSitesFromApi/);
  assert.match(app, /readGroupSettingsForSite:\s*readGroupModelSettingsForSite/);
  assert.match(app, /readSnapshotForSite:\s*readStoredSnapshotFromApi/);
  assert.match(app, /buildReplacement:\s*buildTolerantTableReplacement/);
  assert.match(app, /applyStoredData:\s*applyLoadedTables/);
});

test('group panel exposes icon-only refresh button and filter preset controls', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  // 分组管理工具栏：刷新按钮只保留图标
  assert.match(html, /id="refresh-groups-table"[^>]*aria-label="刷新表格"/);
  assert.doesNotMatch(html, /id="refresh-groups-table"[\s\S]*?<\/svg>\s*刷新表格\s*<\/button>/);

  // 预设下拉框（自定义样式）+ 加号保存按钮 + 保存弹窗
  assert.match(html, /id="group-preset-dropdown"/);
  assert.match(html, /id="group-preset-trigger"/);
  assert.match(html, /id="group-preset-menu"[^>]*role="listbox"/);
  assert.match(html, /id="save-group-filter-preset"[^>]*aria-label="保存筛选预设"/);
  assert.match(html, /id="group-preset-modal"/);
  assert.match(html, /id="group-preset-name"/);
  assert.match(html, /id="group-preset-fields"/);

  // 修改/删除按钮：针对当前选中的预设，未选中时禁用
  assert.match(html, /id="edit-group-filter-preset"[^>]*aria-label="修改筛选预设"[^>]*disabled/);
  assert.match(html, /id="delete-group-filter-preset"[^>]*aria-label="删除筛选预设"[^>]*disabled/);

  // 预设走独立接口按名粒度读写，不再随筛选/排序保存整体覆写偏好 blob
  assert.match(app, /GROUP_FILTER_PRESETS_ENDPOINT = '\/api\/group-filter-presets'/);
  assert.match(app, /fetch\(GROUP_FILTER_PRESETS_ENDPOINT/);
  assert.doesNotMatch(app, /currentGroupViewPreferences[\s\S]*?filterPresets: state\.groupFilterPresets/);

  assert.match(app, /applyGroupFilterPreset/);
  assert.match(app, /saveGroupFilterPresetFromModal/);
  assert.match(app, /deleteGroupFilterPreset/);
  assert.match(app, /openGroupPresetModal/);
  assert.match(app, /renderGroupPresetMenu/);
  assert.match(app, /toggleGroupPresetMenu/);
  assert.match(app, /setActiveGroupPreset/);
});

test('group filters are driven by a single field registry shared with presets', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const prefs = await readFile(new URL('../src/group-view-preferences.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

  // 倍率范围筛选：默认 0-100
  assert.match(html, /id="group-multiplier-min"[^>]*value="0"/);
  assert.match(html, /id="group-multiplier-max"[^>]*value="100"/);
  assert.match(app, /multiplier < state\.groupMultiplierMin \|\| multiplier > state\.groupMultiplierMax/);

  // 单一注册表：归一化、预设、弹窗字段、控件布线都由 GROUP_FILTER_FIELDS 驱动
  assert.match(prefs, /export const GROUP_FILTER_FIELDS/);
  assert.match(prefs, /export function normalizeGroupFilters/);
  assert.match(app, /GROUP_FILTER_FIELDS/);
  assert.match(app, /groupFilterControls/);
  assert.match(app, /renderGroupPresetFields/);
  assert.match(app, /normalizeGroupFilters\(preset\)/);
  assert.doesNotMatch(app, /syncPresetModalSelect/);

  // 我的站点分组多选筛选：固定"未分组"选项 + 实时分组选项 + 映射账号可调度状态筛选
  assert.match(html, /id="group-my-group-filter"/);
  assert.match(html, /id="group-my-group-filter-menu"/);
  assert.match(html, /id="group-my-group-filter-selection"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(html, /id="group-my-group-filter-chips"/);
  assert.match(html, /id="group-my-group-filter-clear"[^>]*>清空全部<\/button>/);
  assert.match(html, /id="sites-site-filter-selection"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(html, /id="sites-site-filter-chips"/);
  assert.match(html, /id="sites-site-filter-clear"[^>]*>清空全部<\/button>/);
  assert.match(html, /id="group-schedulable-filter"/);
  assert.match(prefs, /control: 'multiselect'/);
  assert.match(app, /UNGROUPED_FILTER_VALUE/);
  assert.match(app, /loadMySiteGroupOptions/);
  assert.match(app, /ensureMySiteAccountSchedulable/);
  assert.match(app, /\/api\/my-site-accounts\/remote/);
  assert.match(app, /renderMultiSelectSelection/);
  assert.match(app, /updateSiteFilterSelection/);
  assert.match(app, /updateMyGroupFilterSelection/);
  assert.match(app, /positionMultiSelectMenu/);
  assert.match(css, /\.multi-select-menu/);
  assert.match(css, /\.multi-select-selection/);
  assert.match(css, /\.multi-select-chip-remove/);
  assert.match(css, /\.multi-select-option\.is-selected/);
  assert.match(css, /\.panel-view\.has-open-multi-select/);
  assert.match(css, /\.multi-select\.opens-up \.multi-select-menu/);
});

test('group table header exposes a batch model test button for filtered rows', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

  assert.match(html, /id="test-all-filtered-models"[^>]*aria-label="测试当前筛选出的全部分组"/);
  assert.match(css, /\.test-all-header/);
  // 只测当前筛选结果，且跳过未配置模型的分组
  assert.match(app, /testAllFilteredGroupModels/);
  assert.match(app, /const candidates = filteredGroups\(\)\.filter/);
  assert.match(app, /runWithConcurrency\(candidates, 3/);
  assert.match(app, /runGroupModelTest/);
  assert.match(app, /syncTestAllButton/);
});

test('site and group tables expose copy link buttons for site urls', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');

  assert.match(app, /copySiteUrlButtonHtml/);
  assert.match(app, /data-action="copy-site-url"/);
  assert.match(app, /data-url="\$\{escapeAttribute\(url\)\}"/);
  assert.match(app, /event\.stopPropagation\(\);\s*\n\s*copySiteUrl\(site\.url\)/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(app, /链接已复制/);
  assert.match(app, /site-url-cell/);
  assert.match(css, /\.site-url-cell/);
  assert.match(css, /\.site-url-cell \.copy-site-url/);
  // 站点表格与分组表格的站点列共用同一组合单元格（站点名 + 地址 + 复制按钮）
  assert.match(app, /<span class="site-id site-url-cell">\$\{externalLinkHtml\(site\.url\)\}\$\{copySiteUrlButtonHtml\(site\.url\)\}<\/span>/);
  assert.doesNotMatch(app, /<td><div class="site-url-cell">/);
});

test('rate changes use an isolated controller and a three-card sites layout without an empty topbar row', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const view = await readFile(new URL('../src/group-rate-view.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /class="topbar/);
  assert.match(html, /<div class="panel-actions">[\s\S]*?id="open-site-modal"[\s\S]*?id="refresh-sites-table"[\s\S]*?id="refresh-sites"/);
  assert.match(html, /href="\/rate-changes" data-route-link data-tab="rate-changes"/);
  assert.match(css, /grid-template-rows: auto minmax\(0, 1fr\)/);
  assert.match(css, /\.summary-grid\.has-rate-changes[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /height: 144px/);
  assert.match(app, /createGroupRateView/);
  assert.match(app, /groupRateView\.refreshAfterSnapshots\(\)/);
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|method: 'POST'/);
});
