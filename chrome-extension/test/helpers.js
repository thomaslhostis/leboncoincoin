'use strict';

// Utilitaires de test : chargent background.js / iframe-reader.js dans un contexte
// `vm` isolé, avec une API chrome.* mockée et configurable. Aucune dépendance externe.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT_DIR = path.join(__dirname, '..');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Construit un mock de l'API chrome.* + des compteurs d'appels. */
function makeChrome(opts = {}) {
  const store = Object.assign({}, opts.store || {});
  const calls = {
    sendMessage: [], notifications: [], setIcon: [], badgeText: [], badgeColor: [],
    tabsCreated: [], tabsRemoved: [], windowsCreated: [], executeScript: [], alarms: [],
  };
  const sendMessageImpl = opts.sendMessage || (async () => ({}));
  const listener = () => ({ addListener() {} });

  const chrome = {
    runtime: {
      getURL: (p) => 'chrome-extension://test/' + p,
      getContexts: async () => [],
      onInstalled: listener(),
      onStartup: listener(),
      onMessage: listener(),
      sendMessage: async (msg) => {
        calls.sendMessage.push(msg);
        return sendMessageImpl(msg, { store, calls });
      },
    },
    alarms: {
      onAlarm: listener(),
      create: (id, o) => { calls.alarms.push(Object.assign({ id }, o)); },
      clear: async () => {},
      clearAll: async () => {},
    },
    notifications: {
      onClicked: listener(),
      create: (id, o) => { calls.notifications.push(Object.assign({ id }, o)); },
      clear: () => {},
    },
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === 'string') return (keys in store) ? { [keys]: store[keys] } : {};
          if (Array.isArray(keys)) {
            const r = {};
            for (const k of keys) if (k in store) r[k] = store[k];
            return r;
          }
          if (keys && typeof keys === 'object') {
            const r = {};
            for (const k of Object.keys(keys)) r[k] = (k in store) ? store[k] : keys[k];
            return r;
          }
          return Object.assign({}, store);
        },
        set: async (obj) => { Object.assign(store, obj); },
      },
    },
    action: {
      setIcon: async (o) => { calls.setIcon.push(o); },
      setBadgeText: async (o) => { calls.badgeText.push(o.text); },
      setBadgeBackgroundColor: async (o) => { calls.badgeColor.push(o.color); },
    },
    tabs: {
      create: async (o) => { calls.tabsCreated.push(o); return Object.assign({ id: 200 }, o); },
      get: async (id) => (opts.tabGet ? opts.tabGet(id) : { id, status: 'complete' }),
      update: async () => {},
      remove: async (id) => { calls.tabsRemoved.push(id); },
    },
    windows: {
      getAll: async () => (opts.windows || []),
      create: async (o) => { calls.windowsCreated.push(o); return { id: 100, tabs: [{ id: 200 }] }; },
      update: async () => {},
      remove: async () => {},
      get: async () => ({}),
    },
    scripting: {
      executeScript: async (o) => {
        calls.executeScript.push(o);
        return opts.executeScript ? opts.executeScript(o) : [{ result: null }];
      },
    },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  };
  return { chrome, store, calls };
}

/** Charge background.js dans un contexte vm ; renvoie ctx (globals) + mocks. */
function loadBackground(env = {}) {
  const mock = env.mock || makeChrome(env.chromeOpts);
  const sandbox = {
    chrome: mock.chrome,
    console: env.console || { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => setTimeout(fn, 0), // 4 s / 800 ms → immédiat dans les tests
    clearTimeout: (id) => clearTimeout(id),
    navigator: env.navigator || { onLine: true },
    fetch: env.fetch || (async () => { throw new Error('fetch indisponible'); }),
    createImageBitmap: env.createImageBitmap || (async () => { throw new Error('createImageBitmap indisponible'); }),
    OffscreenCanvas: env.OffscreenCanvas,
    document: env.document,
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'background.js' });
  return { ctx: sandbox, chrome: mock.chrome, store: mock.store, calls: mock.calls };
}

/** Charge et exécute iframe-reader.js (IIFE) ; renvoie les messages envoyés. */
function loadIframeReader(env) {
  const calls = { sendMessage: [] };
  const sandbox = {
    chrome: { runtime: { sendMessage: (m) => { calls.sendMessage.push(m); } } },
    window: env.window,
    document: env.document,
    console: { log() {}, warn() {} },
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(EXT_DIR, 'iframe-reader.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'iframe-reader.js' });
  return { calls };
}

/** Faux document : __NEXT_DATA__ présent (objet ou chaîne) si `nextData` fourni. */
function fakeDoc({ nextData } = {}) {
  return {
    title: '',
    body: { innerText: '' },
    documentElement: { innerHTML: '' },
    getElementById: (id) =>
      (id === '__NEXT_DATA__' && nextData !== undefined)
        ? { textContent: typeof nextData === 'string' ? nextData : JSON.stringify(nextData) }
        : null,
  };
}

/** Fausse fenêtre : top===self pour un onglet réel, top!==self pour un sous-cadre. */
function fakeWindow(isTop) {
  if (isTop) { const w = {}; w.self = w; w.top = w; return w; }
  return { self: {}, top: {} };
}

module.exports = { makeChrome, loadBackground, loadIframeReader, fakeDoc, fakeWindow, delay };
