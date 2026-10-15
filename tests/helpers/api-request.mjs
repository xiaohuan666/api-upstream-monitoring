/** Adapt a fetch fixture to Playwright's browser-free APIRequestContext contract. */
export function createApiRequest(fetchImpl, events = []) {
  return {
    async newContext(options) {
      events.push({ type: 'context', options });
      return {
        async fetch(url, init) {
          events.push({ type: 'request', url, init });
          const response = await fetchImpl(url, { ...init, body: init.data });
          return {
            ok: () => response.ok,
            status: () => response.status,
            statusText: () => response.statusText,
            headersArray: () => response.headers ? [...response.headers].map(([name, value]) => ({ name, value })) : [],
            text: () => response.text(),
            dispose: async () => { events.push({ type: 'response-disposed' }); },
          };
        },
        async dispose() { events.push({ type: 'disposed' }); },
      };
    },
  };
}
