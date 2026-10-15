/* Adapted from zc-zhangchen/any-auto-register, commit
 * 44c27a8a2ae5e08d37bb68ab007a335782b43467. See NOTICE.
 * vm provides browser compatibility only; OS restrictions and Node permissions
 * are separate controls. SDK bytes arrive only via stdin, never a local file.
 */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const cryptoMod = require('node:crypto');
// macOS launch infrastructure may add __CF_USER_TEXT_ENCODING after exec.
// Scrub runtime-added environment too, before remote bytes are evaluated.
for (const key of Object.keys(process.env)) {
  if (key !== 'PATH') delete process.env[key];
}
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (typeof input.sdk !== 'string' || !['requirements', 'solve'].includes(input.action)) {
  process.exit(1);
}
// This single declaration adaptation is required by the fixed upstream SDK.
// No private debug hooks, enforcement-token fallback or synthetic success token.
const sdk = input.sdk.replace('var SentinelSDK=', 'globalThis.SentinelSDK=');

// ─── Helpers ───────────────────────────────────────────────────

function createStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    key(index) { return [...map.keys()][index] || null; },
  };
}

function genericElement(tagName) {
  const tag = String(tagName || 'div').toLowerCase();
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    style: {},
    children: [],
    childNodes: [],
    src: '',
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    parentNode: null,
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children = this.children.filter(x => x !== child); return child; },
    insertBefore(n) { this.children.push(n); return n; },
    setAttribute() {},
    getAttribute() { return null; },
    hasAttribute() { return false; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    cloneNode() { return genericElement(tagName); },
    contains() { return false; },
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    },
    focus() {},
    blur() {},
    click() {},
  };
}

function canvasElement() {
  const el = genericElement('canvas');
  el.width = 300;
  el.height = 150;
  el.toDataURL = () => 'data:image/png;base64,';
  el.toBlob = (cb) => { if (cb) cb(new Uint8Array(0)); };
  el.getContext = (kind) => {
    if (kind === '2d') {
      return {
        fillRect() {}, clearRect() {}, strokeRect() {},
        getImageData() { return { data: new Uint8Array(0) }; },
        putImageData() {}, createImageData() { return { data: new Uint8Array(0) }; },
        setTransform() {}, resetTransform() {}, drawImage() {},
        save() {}, restore() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, clip() {}, quadraticCurveTo() {},
        bezierCurveTo() {}, arc() {}, arcTo() {}, rect() {},
        fill() {}, stroke() {}, measureText() { return { width: 0 }; },
        fillText() {}, strokeText() {},
        scale() {}, rotate() {}, translate() {},
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
        canvas: el,
        fillStyle: '', strokeStyle: '', lineWidth: 1, font: '10px sans-serif',
        textAlign: 'start', textBaseline: 'alphabetic',
        globalAlpha: 1, globalCompositeOperation: 'source-over',
      };
    }
    if (!['webgl', 'experimental-webgl', 'webgl2'].includes(kind)) return null;
    const dbg = { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
    return {
      VENDOR: 0x1F00, RENDERER: 0x1F01,
      getExtension(name) { return name === 'WEBGL_debug_renderer_info' ? dbg : null; },
      getParameter(p) {
        if (p === dbg.UNMASKED_VENDOR_WEBGL || p === 0x1F00) return 'Google Inc. (Intel)';
        if (p === dbg.UNMASKED_RENDERER_WEBGL || p === 0x1F01)
          return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return 0;
      },
      getSupportedExtensions() { return ['WEBGL_debug_renderer_info']; },
      createBuffer() { return {}; }, createTexture() { return {}; },
      createShader() { return {}; }, createProgram() { return {}; },
      bindBuffer() {}, bufferData() {}, bindTexture() {},
      viewport() {}, clear() {}, enable() {}, disable() {},
      drawArrays() {}, drawElements() {},
      canvas: el,
    };
  };
  return el;
}

// ─── Event listener infrastructure (shared between main & VM) ─

const _listeners = new Map();

function addListener(type, callback) {
  if (typeof callback !== 'function') return;
  const bucket = _listeners.get(type) || [];
  bucket.push(callback);
  _listeners.set(type, bucket);
}

function removeListener(type, callback) {
  const bucket = _listeners.get(type) || [];
  _listeners.set(type, bucket.filter(fn => fn !== callback));
}

async function dispatch(type, init) {
  const event = {
    type,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    timeStamp: performance.now(),
    target: null,
    currentTarget: null,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() {},
    ...(init || {}),
  };
  for (const cb of [...(_listeners.get(type) || [])]) {
    try { await cb(event); } catch (_) {}
  }
}

// ─── iframe mock ───────────────────────────────────────────────

let iframeObject = null;
let capturedProof = null;


// ─── Build the VM context ──────────────────────────────────────

const screenW = Number(input.screen_width || 1920);
const screenH = Number(input.screen_height || 1080);
const scripts = [];

const documentElement = genericElement('html');
documentElement.clientWidth = screenW;
documentElement.clientHeight = screenH;

const bodyEl = genericElement('body');
bodyEl.appendChild = function (child) {
  this.children.push(child);
  child.parentNode = this;
  if (child === iframeObject) {
    setTimeout(() => {
      for (const cb of (iframeObject._load || [])) {
        try { cb(); } catch (_) {}
      }
    }, 1);
  }
  return child;
};

const navPlatform = input.platform != null ? String(input.platform) : 'Win32';
const navVendor = input.vendor != null ? String(input.vendor) : 'Google Inc.';

const targetTz = String(input.timezone || 'UTC');
const OrigDTF = Intl.DateTimeFormat;
const PatchedDTF = function (locales, options) {
  const inst = new OrigDTF(locales, options);
  const orig = inst.resolvedOptions.bind(inst);
  inst.resolvedOptions = function () { const r = orig(); r.timeZone = targetTz; return r; };
  return inst;
};
Object.setPrototypeOf(PatchedDTF, OrigDTF);
PatchedDTF.prototype = OrigDTF.prototype;
PatchedDTF.supportedLocalesOf = OrigDTF.supportedLocalesOf;

const navigatorObj = {
  userAgent: String(input.user_agent || 'Mozilla/5.0'),
  language: String(input.language || 'en-US'),
  languages: Array.isArray(input.languages) ? input.languages : ['en-US', 'en'],
  hardwareConcurrency: Number(input.hardware_concurrency || 8),
  platform: navPlatform,
  vendor: navVendor,
  maxTouchPoints: Number(input.max_touch_points || 0),
  webdriver: false,
  onLine: true,
  cookieEnabled: true,
  doNotTrack: null,
  appCodeName: 'Mozilla',
  appName: 'Netscape',
  appVersion: '5.0',
  product: 'Gecko',
  productSub: '20030107',
  vendorSub: '',
  connection: { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false },
  plugins: { length: 5 },
  mimeTypes: { length: 2 },
  mediaDevices: { enumerateDevices: async () => [] },
  getBattery: async () => ({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 }),
  sendBeacon: () => { throw new Error('network disabled'); },
  permissions: { query: async () => ({ state: 'prompt' }) },
};
if (input.device_memory != null && !Number.isNaN(Number(input.device_memory))) {
  navigatorObj.deviceMemory = Number(input.device_memory);
}

const cryptoObj = {
  getRandomValues: (arr) => { cryptoMod.randomFillSync(arr); return arr; },
};
if (typeof cryptoMod.randomUUID === 'function') {
  cryptoObj.randomUUID = () => cryptoMod.randomUUID();
}
if (cryptoMod.webcrypto && cryptoMod.webcrypto.subtle) {
  cryptoObj.subtle = cryptoMod.webcrypto.subtle;
}

const context = {
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  Promise,
  URL,
  URLSearchParams,
  Math,
  Date,
  JSON,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp,
  Function,
  Symbol,
  Reflect,
  Proxy,
  Error,
  TypeError,
  RangeError,
  ReferenceError,
  SyntaxError,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  ArrayBuffer,
  DataView,
  TextEncoder,
  TextDecoder,

  btoa: (s) => Buffer.from(String(s || ''), 'binary').toString('base64'),
  atob: (s) => Buffer.from(String(s || ''), 'base64').toString('binary'),
  unescape,
  encodeURIComponent,
  decodeURIComponent,
  encodeURI,
  decodeURI,
  parseInt,
  parseFloat,
  isFinite,
  isNaN,
  NaN,
  Infinity,
  undefined,
  Intl: { ...Intl, DateTimeFormat: PatchedDTF },

  crypto: cryptoObj,

  performance: {
    now: () => performance.now(),
    timeOrigin: performance.timeOrigin,
    memory: { jsHeapSizeLimit: 4294967296 },
    getEntriesByType: () => [],
    getEntriesByName: () => [],
    mark: () => {},
    measure: () => {},
  },

  screen: {
    width: screenW,
    height: screenH,
    availWidth: screenW,
    availHeight: screenH,
    colorDepth: 24,
    pixelDepth: 24,
    orientation: { type: 'landscape-primary', angle: 0 },
  },

  navigator: navigatorObj,

  history: {
    length: 1, state: null,
    back() {}, forward() {}, go() {},
    pushState() {}, replaceState() {},
  },

  localStorage: createStorage(),
  sessionStorage: createStorage(),

  innerWidth: screenW,
  innerHeight: screenH,
  outerWidth: screenW,
  outerHeight: screenH + 80,
  devicePixelRatio: Number(input.device_pixel_ratio || 1),
  scrollX: 0,
  scrollY: 0,
  pageXOffset: 0,
  pageYOffset: 0,

  requestAnimationFrame: (cb) => { setTimeout(cb, 16); return 1; },
  cancelAnimationFrame: () => {},
  requestIdleCallback: (cb) => {
    if (typeof cb === 'function') cb({ didTimeout: false, timeRemaining: () => 50 });
    return 1;
  },
  cancelIdleCallback: () => {},

  getComputedStyle: () => ({ getPropertyValue() { return ''; } }),
  matchMedia: (query) => ({
    media: String(query || ''),
    matches: false,
    onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  }),

  Event: class Event {
    constructor(type, init) {
      this.type = type;
      this.bubbles = (init && init.bubbles) || false;
      this.cancelable = (init && init.cancelable) || false;
    }
  },
  CustomEvent: class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && Object.prototype.hasOwnProperty.call(init, 'detail') ? init.detail : null;
    }
  },
  MessageChannel: class MessageChannel {
    constructor() {
      this.port1 = { postMessage() {}, addEventListener() {}, removeEventListener() {}, start() {}, close() {} };
      this.port2 = { postMessage() {}, addEventListener() {}, removeEventListener() {}, start() {}, close() {} };
    }
  },

  chrome: { runtime: {}, app: {} },
  CSS: { supports() { return true; } },
  indexedDB: {
    open() { return { onerror: null, onsuccess: null, onupgradeneeded: null, result: {}, error: null }; },
    deleteDatabase() { return {}; },
  },

  fetch: async () => { throw new Error('fetch should not be called'); },
  postMessage: () => {},

  addEventListener: addListener,
  removeEventListener: removeListener,
  dispatchEvent: (event) => { dispatch(event.type, event); return true; },

  origin: 'https://auth.openai.com',

  location: {
    href: 'https://auth.openai.com/',
    origin: 'https://auth.openai.com',
    protocol: 'https:',
    host: 'auth.openai.com',
    hostname: 'auth.openai.com',
    pathname: '/',
    search: '',
    hash: '',
    assign() {},
    replace() {},
    reload() {},
  },

  document: {
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    referrer: 'https://auth.openai.com/',
    URL: 'https://auth.openai.com/',
    documentURI: 'https://auth.openai.com/',
    location: {
      href: 'https://auth.openai.com/',
      origin: 'https://auth.openai.com',
      pathname: '/',
      search: '',
    },
    cookie: 'oai-did=' + encodeURIComponent(input.device_id || ''),
    title: '',
    characterSet: 'UTF-8',
    contentType: 'text/html',
    scripts,
    currentScript: {
      src: 'https://sentinel.openai.com/sentinel/20260219f9f6/sdk.js',
      getAttribute() { return null; },
    },
    documentElement,
    body: bodyEl,
    head: genericElement('head'),
    createElement(tag) {
      const t = String(tag || '').toLowerCase();
      if (t === 'canvas') return canvasElement();
      if (t === 'iframe') {
        iframeObject = genericElement('iframe');
        iframeObject._load = [];
        iframeObject.addEventListener = (type, cb) => {
          if (type === 'load') iframeObject._load.push(cb);
        };
        iframeObject.removeEventListener = () => {};
        iframeObject.contentWindow = {
          postMessage(message, origin) {
            capturedProof = message.p;
            const result = input.action === 'solve'
              ? { cachedChatReq: input.challenge, cachedProof: input.request_p || message.p }
              : null;
            const ev = {
              source: iframeObject.contentWindow,
              data: { type: 'response', requestId: message.requestId, result },
              origin,
            };
            setTimeout(() => {
              for (const cb of [...(_listeners.get('message') || [])]) {
                try { cb(ev); } catch (_) {}
              }
            }, 0);
          },
        };
        return iframeObject;
      }
      const el = genericElement(tag);
      if (t === 'script') scripts.push(el);
      return el;
    },
    createElementNS(_ns, tag) { return this.createElement(tag); },
    createDocumentFragment() { return genericElement('fragment'); },
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
    createComment(text) { return { nodeType: 8, textContent: text }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    getElementsByTagName(tag) { return tag === 'script' ? scripts : []; },
    getElementsByClassName() { return []; },
    addEventListener: addListener,
    removeEventListener: removeListener,
    dispatchEvent(event) { dispatch(event.type, event); return true; },
  },
};

context.window = context;
context.globalThis = context;
context.self = context;
context.top = context;
context.parent = context;

// ─── VM browser compatibility context (not a security sandbox) & load SDK ──────────────────────────────

vm.createContext(context);
vm.runInContext(sdk, context, { timeout: 2000 });
if (!context.SentinelSDK) throw new Error('missing SDK');

// ─── Behavior simulation ──────────────────────────────────────

function _rng(min, max) {
  return min + Math.floor(Math.random() * Math.max(1, max - min + 1));
}

async function dispatchBehavior(durationMs) {
  const started = Date.now();
  const moves = _rng(12, 16);
  let x = _rng(260, 420);
  let y = _rng(180, 300);
  for (let i = 0; i < moves; i++) {
    const dx = _rng(5, 18);
    const dy = _rng(-4, 12);
    x += dx;
    y += dy;
    await new Promise(r => setTimeout(r, _rng(70, 145)));
    await dispatch('pointermove', {
      clientX: x, clientY: y, screenX: x, screenY: y,
      movementX: dx, movementY: dy, buttons: 0,
    });
  }
  await new Promise(r => setTimeout(r, _rng(90, 220)));
  await dispatch('click', {
    clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 0,
  });
  for (let i = 0; i < _rng(3, 4); i++) {
    await new Promise(r => setTimeout(r, _rng(80, 180)));
    context.scrollY = (context.scrollY || 0) + _rng(35, 120);
    context.pageYOffset = context.scrollY;
    await dispatch('scroll', { scrollX: 0, scrollY: context.scrollY });
  }
  await new Promise(r => setTimeout(r, _rng(80, 160)));
  await dispatch('wheel', {
    deltaX: 0, deltaY: _rng(70, 140), clientX: x, clientY: y,
  });
  const keys = ['L', 'u', 'Tab'];
  for (const key of keys) {
    await new Promise(r => setTimeout(r, _rng(90, 210)));
    await dispatch('keydown', {
      key,
      code: key === 'Tab' ? 'Tab' : 'Key' + key.toUpperCase(),
      repeat: false, altKey: false, ctrlKey: false, metaKey: false,
    });
  }
  const remaining = Math.max(0, Number(durationMs || 0) - (Date.now() - started));
  if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
}

// ─── Main ──────────────────────────────────────────────────────
async function bounded(call, ms) {
  let timer;
  try {
    return await Promise.race([
      call(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

(async () => {
  const flow = input.flow;
  let result;
  if (input.action === 'requirements') {
    await bounded(() => context.SentinelSDK.init(flow), 6000);
    const requestP = capturedProof;
    if (typeof requestP !== 'string' || !requestP.trim()) throw new Error('missing proof');
    result = { request_p: requestP };
  } else {
    const token = await bounded(() => context.SentinelSDK.token(flow), 8000);
    if (typeof token !== 'string' || !token.trim()) throw new Error('missing token');
    const soRequired = input.challenge?.so?.required === true;
    let soToken = '';
    if (soRequired) {
      await dispatchBehavior(4200);
      soToken = await bounded(() => context.SentinelSDK.sessionObserverToken(flow), 5000);
      if (typeof soToken !== 'string' || !soToken.trim()) throw new Error('missing observer token');
    }
    result = { token, so_token: soToken };
  }
  // Exit after flushing so SDK timers cannot extend process lifetime.
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
})().catch(() => {
  // Never expose SDK exception text/stack or challenge/proof material.
  process.stderr.write('Sentinel runner failed\n', () => process.exit(1));
});
