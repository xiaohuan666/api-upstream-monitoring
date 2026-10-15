// Only browser entrypoints and their dependencies belong to the HTTP public surface.
export const PUBLIC_ASSET_PATHS = Object.freeze([
  '/index.html',
  '/src/app.mjs',
  '/src/auto-refresh-rule-editor.mjs',
  '/src/auto-refresh-settings.mjs',
  '/src/client-links.mjs',
  '/src/client-refresh.mjs',
  '/src/client-route.mjs',
  '/src/currency-display.mjs',
  '/src/domain.mjs',
  '/src/group-rate-view.mjs',
  '/src/group-rows.mjs',
  '/src/group-view-preferences.mjs',
  '/src/model-test-display.mjs',
  '/src/oauth-credential-input.mjs',
  '/src/oauth-import-options-view.mjs',
  '/src/oauth-import-options.mjs',
  '/src/oauth-onboarding-view.mjs',
  '/src/oauth-onboarding.css',
  '/src/oauth-settings-view.mjs',
  '/src/oauth-settings.css',
  '/src/oauth-tasks-layout.css',
  '/src/oauth-tasks-view.mjs',
  '/src/proxy-export.mjs',
  '/src/proxy-identity.mjs',
  '/src/proxy-import.mjs',
  '/src/proxy-provider.mjs',
  '/src/rate-history-column-state.mjs',
  '/src/rate-history-preferences.mjs',
  '/src/rate-history-table.mjs',
  '/src/searchable-select.mjs',
  '/src/site-view-preferences.mjs',
  '/styles.css',
]);

export function isPublicAssetPath(pathname) {
  return PUBLIC_ASSET_PATHS.includes(pathname);
}
