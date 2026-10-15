import { connect } from 'node:http2';
import { Readable } from 'node:stream';

const CONNECTION_HEADERS = new Set(['connection', 'host', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

/** A per-sync HTTP/2 client. Sessions and credentials never cross sync boundaries. */
export function createHttp2Fetch({ timeoutMs = 20_000, connectSession = connect } = {}) {
  const sessions = new Map();
  let closed = false;

  function sessionFor(origin) {
    if (closed) throw new Error('HTTP/2 client is closed');
    if (!sessions.has(origin)) {
      const session = connectSession(origin, { minVersion: 'TLSv1.2' });
      // Streams receive connection errors too; this listener prevents an unhandled event.
      session.on('error', () => {});
      sessions.set(origin, session);
    }
    return sessions.get(origin);
  }

  return {
    async fetch(input, init = {}) {
      const url = new URL(input);
      if (url.protocol !== 'https:') throw new Error('HTTP/2 requires HTTPS');
      const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      signal.throwIfAborted();
      const headers = {
        ':method': init.method ?? 'GET',
        ':path': `${url.pathname}${url.search}`,
        'accept-encoding': 'identity',
      };
      for (const [name, value] of new Headers(init.headers)) {
        if (!CONNECTION_HEADERS.has(name) && name !== 'accept-encoding') headers[name] = value;
      }
      // Do not follow redirects: an API transport must not forward credentials to a new origin.
      return await new Promise((resolve, reject) => {
        const stream = sessionFor(url.origin).request(headers);
        let receivedHeaders = false;
        const abort = () => stream.destroy(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        stream.once('error', reject);
        stream.once('response', (responseHeaders) => {
          try {
            receivedHeaders = true;
            const status = Number(responseHeaders[':status']);
            const response = new Headers();
            for (const [name, value] of Object.entries(responseHeaders)) {
              if (name.startsWith(':')) continue;
              for (const item of Array.isArray(value) ? value : [value]) response.append(name, String(item));
            }
            const emptyBody = [204, 205, 304].includes(status);
            if (emptyBody) stream.resume();
            // Return at headers, keep timeout through body consumption, and let cancel
            // close only this stream so latency probes need not wait for generation.
            resolve(new Response(emptyBody ? null : Readable.toWeb(stream), { status, headers: response }));
          } catch (error) {
            stream.destroy();
            reject(error);
          }
        });
        stream.once('close', () => {
          signal.removeEventListener('abort', abort);
          if (!receivedHeaders) reject(new Error('HTTP/2 stream closed before response headers'));
        });
        stream.end(init.body);
      });
    },
    close() {
      closed = true;
      for (const session of sessions.values()) session.destroy();
      sessions.clear();
    },
  };
}
