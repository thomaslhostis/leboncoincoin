'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeChrome, loadBackground, fakeDoc, delay } = require('./helpers');

const URL1 = 'https://www.leboncoin.fr/recherche?text=hellfest';

/** Réponses de chrome.runtime.sendMessage par type de message. */
function scenario(map) {
  return async (msg) => {
    if (msg.type === 'PLAY_QUACK') return { ok: true };
    const v = map[msg.type];
    return typeof v === 'function' ? v(msg) : (v ?? {});
  };
}

function monitorsStore(extra = {}) {
  return Object.assign(
    { monitors: [{ id: 'm1', name: 'Hellfest', url: URL1, enabled: true, frequency: 5 }] },
    extra,
  );
}

// ── isNetworkError ─────────────────────────────────────────────────────────────

test('isNetworkError : messages réseau vs blocage Cloudflare', () => {
  const { ctx } = loadBackground();
  assert.equal(ctx.isNetworkError(new Error('Failed to fetch')), true);
  assert.equal(ctx.isNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED')), true);
  assert.equal(ctx.isNetworkError(new Error('NetworkError when attempting to fetch')), true);
  assert.equal(ctx.isNetworkError(new Error('HTTP 403 — cookie Cloudflare expiré')), false);
  assert.equal(ctx.isNetworkError(new Error('Timeout de chargement de la page (30 s)')), false);
});

test('isNetworkError : navigator hors ligne ⇒ toujours réseau', () => {
  const { ctx } = loadBackground({ navigator: { onLine: false } });
  assert.equal(ctx.isNetworkError(new Error('HTTP 403')), true);
});

// ── extractLeboncoinDataFromPage ────────────────────────────────────────────────

test('extractLeboncoinDataFromPage : page réelle → annonces normalisées', () => {
  const { ctx } = loadBackground();
  ctx.document = fakeDoc({ nextData: { props: { pageProps: { searchData: { ads: [
    { list_id: 42, url: '/x/42', subject: 'Billet', price: [120] },
  ] } } } } });
  const res = ctx.extractLeboncoinDataFromPage();
  assert.ok(Array.isArray(res));
  assert.equal(res[0].id, '42');
  assert.equal(res[0].url, 'https://www.leboncoin.fr/x/42');
  assert.equal(res[0].price, 120);
});

test('extractLeboncoinDataFromPage : zéro résultat → tableau vide (pas un challenge)', () => {
  const { ctx } = loadBackground();
  ctx.document = fakeDoc({ nextData: { props: { pageProps: { searchData: { ads: [] } } } } });
  assert.deepEqual(ctx.extractLeboncoinDataFromPage(), []);
});

test('extractLeboncoinDataFromPage : pas de __NEXT_DATA__ → challenge', () => {
  const { ctx } = loadBackground();
  ctx.document = fakeDoc({});
  assert.deepEqual(ctx.extractLeboncoinDataFromPage(), { __challenge: true });
});

// ── fetchLeboncoinAds : escalade ────────────────────────────────────────────────

test('fetchLeboncoinAds : cookie valide → fetch offscreen, aucune escalade', async () => {
  const mock = makeChrome({ sendMessage: scenario({ FETCH_LBC: { ok: true, data: [{ id: '1' }] } }) });
  const { ctx, calls } = loadBackground({ mock });
  const data = await ctx.fetchLeboncoinAds(URL1);
  assert.deepEqual(data, [{ id: '1' }]);
  assert.ok(!calls.sendMessage.some((m) => m.type === 'RENEW_VIA_IFRAME'));
  assert.equal(calls.tabsCreated.length, 0);
  assert.equal(calls.windowsCreated.length, 0);
});

test('fetchLeboncoinAds : erreur réseau → aucune escalade (ni iframe ni onglet)', async () => {
  const mock = makeChrome({ sendMessage: scenario({ FETCH_LBC: { ok: false, error: 'Failed to fetch' } }) });
  const { ctx, calls } = loadBackground({ mock });
  await assert.rejects(() => ctx.fetchLeboncoinAds(URL1), /Failed to fetch/);
  assert.ok(!calls.sendMessage.some((m) => m.type === 'RENEW_VIA_IFRAME'), 'pas de niveau 2');
  assert.equal(calls.tabsCreated.length, 0, 'pas d’onglet');
  assert.equal(calls.windowsCreated.length, 0, 'pas de fenêtre');
});

test('fetchLeboncoinAds : captcha détecté dans l’iframe → erreur captcha, sans onglet', async () => {
  const mock = makeChrome({ sendMessage: scenario({
    FETCH_LBC: { ok: false, error: 'HTTP 403 — cookie Cloudflare expiré' },
    RENEW_VIA_IFRAME: { ok: false, error: 'challenge détecté dans l’iframe', captcha: true },
  }) });
  const { ctx, calls } = loadBackground({ mock });
  await assert.rejects(() => ctx.fetchLeboncoinAds(URL1), (e) => e.captcha === true);
  assert.equal(calls.tabsCreated.length, 0, 'aucun onglet');
  assert.equal(calls.windowsCreated.length, 0, 'aucune fenêtre');
});

test('fetchLeboncoinAds : iframe renouvelle le cookie → succès sans onglet', async () => {
  const mock = makeChrome({ sendMessage: scenario({
    FETCH_LBC: { ok: false, error: 'HTTP 403' },
    RENEW_VIA_IFRAME: { ok: true, data: [{ id: '9' }] },
  }) });
  const { ctx, calls } = loadBackground({ mock });
  const data = await ctx.fetchLeboncoinAds(URL1);
  assert.deepEqual(data, [{ id: '9' }]);
  assert.equal(calls.tabsCreated.length, 0);
});

test('fetchLeboncoinAds : filet onglet (fenêtre existante) + captcha détecté au rendu', async () => {
  const mock = makeChrome({
    windows: [{ id: 1, focused: true, state: 'normal' }],
    sendMessage: scenario({
      FETCH_LBC: { ok: false, error: 'HTTP 403' },
      RENEW_VIA_IFRAME: { ok: false, error: 'iframe inopérante (pas de content-script) ; re-fetch: HTTP 403' },
    }),
    executeScript: () => [{ result: { __challenge: true } }],
  });
  const { ctx, calls } = loadBackground({ mock });
  await assert.rejects(() => ctx.fetchLeboncoinAds(URL1), (e) => e.captcha === true);
  assert.equal(calls.tabsCreated.length, 1, 'onglet d’arrière-plan dans la fenêtre existante');
  assert.equal(calls.tabsCreated[0].active, false, 'onglet en arrière-plan');
  assert.equal(calls.windowsCreated.length, 0, 'pas de nouvelle fenêtre');
  assert.equal(calls.tabsRemoved.length, 1, 'onglet refermé');
});

test('fetchLeboncoinAds : aucune fenêtre → nouvelle fenêtre non focalisée, lecture OK', async () => {
  const mock = makeChrome({
    windows: [],
    sendMessage: scenario({
      FETCH_LBC: { ok: false, error: 'HTTP 403' },
      RENEW_VIA_IFRAME: { ok: false, error: 'iframe inopérante (pas de content-script) ; re-fetch: HTTP 403' },
    }),
    executeScript: () => [{ result: [{ id: '7' }] }],
  });
  const { ctx, calls } = loadBackground({ mock });
  const data = await ctx.fetchLeboncoinAds(URL1);
  assert.deepEqual(data, [{ id: '7' }]);
  assert.equal(calls.windowsCreated.length, 1, 'une fenêtre créée');
  assert.equal(calls.windowsCreated[0].focused, false, 'sans voler le focus');
  assert.equal(calls.tabsCreated.length, 0);
});

// ── checkPage : notifications, son, icône ───────────────────────────────────────

test('checkPage : première vérif → notif "Surveillance activée", sans son ni icône warning', async () => {
  const mock = makeChrome({ store: monitorsStore(), sendMessage: scenario({ FETCH_LBC: { ok: true, data: [{ id: '1' }] } }) });
  const { ctx, store, calls } = loadBackground({ mock });
  await ctx.checkPage('m1');
  assert.ok(calls.notifications.some((n) => n.title.includes('Surveillance activée')));
  assert.ok(!calls.sendMessage.some((m) => m.type === 'PLAY_QUACK'), 'pas de son');
  assert.equal(store.monitors[0].lastError, null);
  assert.equal(calls.badgeText.at(-1), '', 'icône normale');
});

test('checkPage : nouvelles annonces → notif avec son', async () => {
  const mock = makeChrome({
    store: monitorsStore({ snapshots: { m1: { ids: ['1'] } } }),
    sendMessage: scenario({ FETCH_LBC: { ok: true, data: [{ id: '1' }, { id: '2' }] } }),
  });
  const { ctx, calls } = loadBackground({ mock });
  await ctx.checkPage('m1');
  assert.ok(calls.notifications.some((n) => n.title.includes('Hellfest') && /nouvelle/.test(n.message)));
  assert.ok(calls.sendMessage.some((m) => m.type === 'PLAY_QUACK'), 'son joué');
});

test('checkPage : captcha → notif unique "⚠️ Leboncoincoin" + icône warning, sans onglet', async () => {
  const mock = makeChrome({
    store: monitorsStore({ snapshots: { m1: { ids: ['1'] } } }),
    sendMessage: scenario({
      FETCH_LBC: { ok: false, error: 'HTTP 403' },
      RENEW_VIA_IFRAME: { ok: false, error: 'challenge', captcha: true },
    }),
  });
  const { ctx, store, calls } = loadBackground({ mock });
  await ctx.checkPage('m1');
  const captchaNotifs = calls.notifications.filter((n) => n.title.includes('Leboncoincoin'));
  assert.equal(captchaNotifs.length, 1);
  assert.match(captchaNotifs[0].message, /captcha/i);
  assert.equal(store.monitors[0].captchaNotified, true);
  assert.equal(store['captcha_global_notified'], true);
  assert.equal(calls.badgeText.at(-1), '!', 'icône warning');
  assert.equal(calls.tabsCreated.length, 0);
  assert.equal(calls.windowsCreated.length, 0);
});

test('checkPage : erreur réseau → aucune notif MAIS icône warning', async () => {
  const mock = makeChrome({
    store: monitorsStore({ snapshots: { m1: { ids: ['1'] } } }),
    sendMessage: scenario({ FETCH_LBC: { ok: false, error: 'Failed to fetch' } }),
  });
  const { ctx, store, calls } = loadBackground({ mock });
  await ctx.checkPage('m1');
  assert.equal(calls.notifications.length, 0, 'aucune notification');
  assert.ok(store.monitors[0].lastError, 'erreur enregistrée');
  assert.ok(!store.monitors[0].captchaNotified, 'pas marqué captcha');
  assert.equal(calls.badgeText.at(-1), '!', 'icône warning pour erreur réseau aussi');
});

test('checkPage : une SEULE notification captcha pour plusieurs surveillances', async () => {
  const mock = makeChrome({
    store: {
      monitors: [
        { id: 'm1', name: 'A', url: URL1, enabled: true, frequency: 5 },
        { id: 'm2', name: 'B', url: URL1 + '&p=2', enabled: true, frequency: 5 },
      ],
      snapshots: { m1: { ids: [] }, m2: { ids: [] } },
    },
    sendMessage: scenario({
      FETCH_LBC: { ok: false, error: 'HTTP 403' },
      RENEW_VIA_IFRAME: { ok: false, error: 'challenge', captcha: true },
    }),
  });
  const { ctx, calls } = loadBackground({ mock });
  await ctx.checkPage('m1');
  await ctx.checkPage('m2');
  const captchaNotifs = calls.notifications.filter((n) => n.title.includes('Leboncoincoin'));
  assert.equal(captchaNotifs.length, 1, 'notification globale unique');
});

test('checkPage : rétablissement → icône normale, flag reset, pas de notif "de nouveau accessible"', async () => {
  const mock = makeChrome({
    store: {
      monitors: [{ id: 'm1', name: 'A', url: URL1, enabled: true, frequency: 5, captchaNotified: true, lastError: 'HTTP 403' }],
      snapshots: { m1: { ids: ['1'] } },
      captcha_global_notified: true,
    },
    sendMessage: scenario({ FETCH_LBC: { ok: true, data: [{ id: '1' }] } }),
  });
  const { ctx, store, calls } = loadBackground({ mock });
  await ctx.checkPage('m1');
  assert.equal(store.monitors[0].captchaNotified, false);
  assert.equal(store.monitors[0].lastError, null);
  assert.equal(store['captcha_global_notified'], false);
  assert.equal(calls.badgeText.at(-1), '', 'icône normale');
  assert.ok(!calls.notifications.some((n) => /de nouveau accessible/i.test(n.message)), 'pas de notif de récupération');
});

// ── onLeboncoinAccessible ───────────────────────────────────────────────────────

test('onLeboncoinAccessible : efface l’avertissement (icône + état) après le signal', async () => {
  const mock = makeChrome({
    store: {
      monitors: [{ id: 'm1', name: 'A', url: URL1, enabled: true, frequency: 5, captchaNotified: true, lastError: 'HTTP 403' }],
      captcha_global_notified: true,
    },
  });
  const { ctx, store, calls } = loadBackground({ mock });
  await ctx.onLeboncoinAccessible();
  await delay(20); // le timer (4 s → 0 ms en test) se déclenche
  assert.equal(store.monitors[0].captchaNotified, false);
  assert.equal(store.monitors[0].lastError, null);
  assert.equal(store['captcha_global_notified'], false);
  assert.equal(calls.badgeText.at(-1), '');
});

test('onLeboncoinAccessible : ne fait rien si aucune surveillance en erreur', async () => {
  const mock = makeChrome({ store: monitorsStore() });
  const { ctx, calls } = loadBackground({ mock });
  await ctx.onLeboncoinAccessible();
  await delay(20);
  assert.equal(calls.setIcon.length, 0);
  assert.equal(calls.badgeText.length, 0);
});
