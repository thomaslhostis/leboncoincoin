const KEY_MONITORS = 'monitors';
const KEY_SNAPSHOTS = 'snapshots';
const KEY_NOTIF = 'notif_urls'; // maps notifId → URL to open on click
const KEY_CAPTCHA_NOTIF = 'captcha_global_notified'; // notif captcha unique (globale)
const MAX_SEEN_IDS = 1000; // borne mémoire des ids d'annonces déjà notifiés par surveillance

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(recreateAlarms);
chrome.runtime.onStartup.addListener(recreateAlarms);

// ── Alarms ────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => checkPage(alarm.name));

async function recreateAlarms() {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  await chrome.alarms.clearAll();
  for (const m of monitors) {
    if (m.enabled !== false) {
      chrome.alarms.create(m.id, { periodInMinutes: m.frequency, delayInMinutes: 0.1 });
    }
  }
  await refreshCaptchaState();
}

// ── Notifications ─────────────────────────────────────────────────────────────

chrome.notifications.onClicked.addListener(async (notifId) => {
  chrome.notifications.clear(notifId);
  const { [KEY_NOTIF]: notifUrls = {} } = await chrome.storage.local.get(KEY_NOTIF);
  const url = notifUrls[notifId];
  if (url) {
    try {
      await chrome.tabs.create({ url });
    } catch (e) {
      if (e.message && e.message.toLowerCase().includes('no current window')) {
        await chrome.windows.create({ url, focused: true });
      }
    }
    delete notifUrls[notifId];
    await chrome.storage.local.set({ [KEY_NOTIF]: notifUrls });
  }
});

// ── Messages from popup ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handlers = {
    ADD_MONITOR:      () => addMonitor(msg.monitor),
    REMOVE_MONITOR:   () => removeMonitor(msg.monitorId),
    TOGGLE_MONITOR:   () => toggleMonitor(msg.monitorId, msg.enabled),
    UPDATE_FREQUENCY: () => updateFrequency(msg.monitorId, msg.frequency),
    CHECK_NOW:        () => checkPage(msg.monitorId),
  };
  const fn = handlers[msg.type];
  if (!fn) return;
  fn().then(() => reply({ ok: true })).catch((e) => reply({ ok: false, error: e.message }));
  return true; // async response
});

// Signal du content-script : un onglet leboncoin réel est accessible (par ex.
// après résolution manuelle du captcha) → on retire l'avertissement peu après.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'LBC_ACCESSIBLE') onLeboncoinAccessible();
});

// ── CRUD helpers ──────────────────────────────────────────────────────────────

async function addMonitor(monitor) {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  if (monitors.some((m) => m.url === monitor.url)) throw new Error('URL déjà surveillée');
  monitors.push(monitor);
  await chrome.storage.local.set({ [KEY_MONITORS]: monitors });
  chrome.alarms.create(monitor.id, { periodInMinutes: monitor.frequency });
  // Déclenche immédiatement le premier check sans attendre l'alarme
  // (le service worker peut se mettre en veille avant que l'alarme de 6s fire)
  checkPage(monitor.id);
}

async function removeMonitor(monitorId) {
  const { monitors = [], [KEY_SNAPSHOTS]: snapshots = {} } = await chrome.storage.local.get([
    KEY_MONITORS,
    KEY_SNAPSHOTS,
  ]);
  await chrome.storage.local.set({
    [KEY_MONITORS]: monitors.filter((m) => m.id !== monitorId),
    [KEY_SNAPSHOTS]: Object.fromEntries(Object.entries(snapshots).filter(([k]) => k !== monitorId)),
  });
  chrome.alarms.clear(monitorId);
  await refreshCaptchaState();
}

async function toggleMonitor(monitorId, enabled) {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  const updated = monitors.map((m) => (m.id === monitorId ? { ...m, enabled } : m));
  await chrome.storage.local.set({ [KEY_MONITORS]: updated });
  if (enabled) {
    const monitor = updated.find((m) => m.id === monitorId);
    chrome.alarms.create(monitorId, { periodInMinutes: monitor.frequency, delayInMinutes: 0.1 });
  } else {
    chrome.alarms.clear(monitorId);
  }
  await refreshCaptchaState();
}

async function updateFrequency(monitorId, frequency) {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  const updated = monitors.map((m) => (m.id === monitorId ? { ...m, frequency } : m));
  await chrome.storage.local.set({ [KEY_MONITORS]: updated });
  // Recrée l'alarme avec la nouvelle fréquence si le monitor est actif
  const monitor = updated.find((m) => m.id === monitorId);
  if (monitor && monitor.enabled !== false) {
    await chrome.alarms.clear(monitorId);
    chrome.alarms.create(monitorId, { periodInMinutes: frequency, delayInMinutes: 0.1 });
  }
}

// ── Page checking ─────────────────────────────────────────────────────────────

async function checkPage(monitorId) {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  const monitor = monitors.find((m) => m.id === monitorId);
  if (!monitor || monitor.enabled === false) return;

  const now = Date.now();
  let patch;

  try {
    const ads = await fetchLeboncoinAds(monitor.url);

    const { [KEY_SNAPSHOTS]: snapshots = {} } = await chrome.storage.local.get(KEY_SNAPSHOTS);
    const prev = snapshots[monitorId];
    const isFirstCheck = !prev;
    // Ids DÉJÀ vus/notifiés (et non plus seulement ceux du dernier check) : une
    // annonce qui disparaît puis réapparaît ne redéclenche donc pas de notification.
    // (rétrocompat : ancien format `ids`.)
    const seen = prev?.seen ?? prev?.ids ?? [];
    const seenSet = new Set(seen);
    const currentIds = ads.map((a) => a.id);

    if (isFirstCheck) {
      // Première vérification : juste confirmer que la surveillance est active
      await sendNotification(
        monitor.id,
        `✅ Surveillance activée`,
        monitor.name,
        monitor.url,
      );
    } else {
      const newAds = ads.filter((ad) => !seenSet.has(ad.id));
      if (newAds.length > 0) {
        const message =
          newAds.length === 1 ? `1 nouvelle annonce` : `${newAds.length} nouvelles annonces`;
        // Toujours ouvrir la page de recherche au clic ; son uniquement ici.
        await sendNotification(monitor.id, `🔔 ${monitor.name}`, message, monitor.url, { sound: true });
      }
    }

    // Met à jour la liste des ids connus : ids courants poussés en fin (récence),
    // dédupliqués, tronqués aux MAX_SEEN_IDS plus récents (borne mémoire). Les ids
    // retirés dérivent vers l'avant et finissent par sortir bien plus tard.
    const merged = [...seen.filter((id) => !currentIds.includes(id)), ...currentIds];
    snapshots[monitorId] = { seen: merged.slice(-MAX_SEEN_IDS), updatedAt: now };
    await chrome.storage.local.set({ [KEY_SNAPSHOTS]: snapshots });

    patch = { lastCheck: now, lastCount: ads.length, lastError: null, captchaNotified: false };
  } catch (err) {
    if (err.captcha) {
      // Captcha requis : on marque la surveillance bloquée. L'icône et l'UNIQUE
      // notification (globale, pour toutes les alertes) sont gérées par
      // refreshCaptchaState() appelé en fin de checkPage.
      console.log(`[LBC] 🔐 captcha requis (${monitor.name})`);
      patch = { lastCheck: now, lastError: err.message, captchaNotified: true };
    } else {
      // Erreurs transitoires (réseau, timeout, page inattendue…) : aucune notification.
      console.warn(`[LBC] erreur silencieuse (${monitor.name}) : ${err.message}`);
      patch = { lastCheck: now, lastError: err.message };
    }
  }

  const { monitors: fresh = [] } = await chrome.storage.local.get(KEY_MONITORS);
  await chrome.storage.local.set({
    [KEY_MONITORS]: fresh.map((m) => (m.id === monitorId ? { ...m, ...patch } : m)),
  });

  await refreshCaptchaState();
}

async function sendNotification(monitorId, title, message, targetUrl, { sound = false } = {}) {
  // ID unique par notification pour éviter qu'une notification existante bloque l'affichage
  const notifId = `notif-${monitorId}-${Date.now()}`;
  const { [KEY_NOTIF]: notifUrls = {} } = await chrome.storage.local.get(KEY_NOTIF);
  notifUrls[notifId] = targetUrl;
  await chrome.storage.local.set({ [KEY_NOTIF]: notifUrls });

  const now = new Date();
  const hh = now.getHours().toString().padStart(2, '0');
  const mm = now.getMinutes().toString().padStart(2, '0');
  const time = `${hh}h${mm}`;
  const messageWithTime = `${time} : ${message}`;

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message: messageWithTime,
    requireInteraction: false,
  });

  // Son canard : uniquement pour les nouvelles annonces (sound) et si non muté
  if (sound) {
    const { soundMuted = false } = await chrome.storage.local.get('soundMuted');
    if (!soundMuted) {
      ensureOffscreenDocument()
        .then(() => chrome.runtime.sendMessage({ type: 'PLAY_QUACK' }))
        .catch(() => {});
    }
  }
}

// ── Icône de la barre d'outils ──────────────────────────────────────────────────
// Quand au moins une surveillance active attend la résolution d'un captcha, on
// superpose un triangle d'avertissement à l'icône de l'extension.

const DEFAULT_ICON_PATHS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

/**
 * Recalcule l'état global à partir des surveillances :
 *  • icône d'avertissement dès qu'une surveillance active est en échec (leboncoin
 *    injoignable, quelle qu'en soit la raison : captcha, réseau, erreur serveur) ;
 *  • UNE SEULE notification pour l'ensemble des alertes, réservée au cas captcha
 *    (dédup via un flag global).
 */
async function refreshCaptchaState() {
  const { monitors = [], [KEY_CAPTCHA_NOTIF]: alreadyNotified = false } =
    await chrome.storage.local.get([KEY_MONITORS, KEY_CAPTCHA_NOTIF]);
  const active = monitors.filter((m) => m.enabled !== false);
  const blocked = active.filter((m) => m.captchaNotified);
  const anyBlocked = blocked.length > 0;
  // Triangle d'avertissement dès que leboncoin est injoignable, QUELLE QU'EN SOIT
  // la raison (captcha, réseau, erreur serveur…), c.-à-d. dernière vérif en échec.
  const anyError = active.some((m) => m.lastError);

  await setActionWarning(anyError);

  // La notification, elle, reste réservée au seul cas captcha (et globale/unique).
  if (anyBlocked && !alreadyNotified) {
    await sendNotification(
      'captcha',
      '⚠️ Leboncoincoin',
      'Veuillez ouvrir leboncoin.fr et résoudre le captcha',
      blocked[0].url ?? 'https://www.leboncoin.fr',
    );
    await chrome.storage.local.set({ [KEY_CAPTCHA_NOTIF]: true });
  } else if (!anyBlocked && alreadyNotified) {
    await chrome.storage.local.set({ [KEY_CAPTCHA_NOTIF]: false });
  }
}

// Efface l'avertissement quelques secondes après que leboncoin redevient
// accessible (signal envoyé par le content-script depuis un onglet leboncoin réel).
let clearCaptchaTimer = null;

async function onLeboncoinAccessible() {
  if (clearCaptchaTimer) return; // effacement déjà programmé
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  // Rien à faire si aucune surveillance active n'est en erreur/captcha.
  if (!monitors.some((m) => m.enabled !== false && (m.lastError || m.captchaNotified))) return;
  clearCaptchaTimer = setTimeout(() => {
    clearCaptchaTimer = null;
    clearWarningState().catch(() => {});
  }, 4000);
}

async function clearWarningState() {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  if (monitors.some((m) => m.captchaNotified || m.lastError)) {
    await chrome.storage.local.set({
      [KEY_MONITORS]: monitors.map((m) =>
        (m.captchaNotified || m.lastError) ? { ...m, captchaNotified: false, lastError: null } : m),
    });
  }
  await refreshCaptchaState(); // retire l'icône + remet le flag global à false
}

async function setActionWarning(on) {
  if (!on) {
    chrome.action.setIcon({ path: DEFAULT_ICON_PATHS }).catch(() => {});
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    return;
  }
  try {
    // Dessine l'icône de base + un triangle d'avertissement dans chaque taille.
    const imageData = {};
    for (const size of [16, 32, 48, 128]) {
      const resp = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`));
      const bitmap = await createImageBitmap(await resp.blob());
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, size, size);
      drawWarningTriangle(ctx, size);
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    await chrome.action.setIcon({ imageData });
  } catch (e) {
    // Repli si OffscreenCanvas indisponible : un badge « ! » orange.
    console.warn('[LBC] icône warning via canvas échouée, repli badge :', e.message);
    chrome.action.setBadgeText({ text: '!' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#E11900' }).catch(() => {});
  }
}

/**
 * Pastille d'avertissement moderne dans le coin bas-droit de l'icône :
 * triangle aux coins arrondis, halo blanc pour le détacher du fond, « ! » blanc.
 */
function drawWarningTriangle(ctx, S) {
  const m = S * 0.05;
  const w = S * 0.62;
  const h = w * 0.88;
  const right = S - m;
  const bottom = S - m;
  const left = right - w;
  const top = bottom - h;
  const apexX = (left + right) / 2;

  const pts = [
    { x: apexX, y: top },     // sommet haut
    { x: right, y: bottom },  // bas-droit
    { x: left, y: bottom },   // bas-gauche
  ];
  const r = S * 0.14; // rayon des coins arrondis

  roundedPolygonPath(ctx, pts, r);

  // Halo blanc (contour épais centré sur le tracé → moitié visible à l'extérieur).
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = Math.max(1.5, S * 0.14);
  ctx.stroke();

  // Remplissage ambre/orange moderne.
  const grad = ctx.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, '#FFB020');
  grad.addColorStop(1, '#FF8A00');
  ctx.fillStyle = grad;
  ctx.fill();

  // Point d'exclamation blanc (capsule + point), à partir de 32 px.
  if (S >= 32) {
    ctx.fillStyle = '#FFFFFF';
    const barW = S * 0.075;
    const barTop = top + h * 0.32;
    const barBot = bottom - h * 0.34;
    fillVerticalCapsule(ctx, apexX, barTop, barBot, barW);
    ctx.beginPath();
    ctx.arc(apexX, bottom - h * 0.16, barW * 0.62, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Trace un polygone à coins arrondis (via les milieux d'arêtes + arcTo). */
function roundedPolygonPath(ctx, pts, r) {
  const n = pts.length;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const p0 = pts[i % n];
    const p1 = pts[(i + 1) % n];
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    if (i === 0) ctx.moveTo(mid.x, mid.y);
    else ctx.arcTo(p0.x, p0.y, mid.x, mid.y, r);
  }
  ctx.closePath();
}

/** Remplit une capsule verticale (rectangle à bouts arrondis) centrée en cx. */
function fillVerticalCapsule(ctx, cx, top, bottom, width) {
  const r = width / 2;
  ctx.beginPath();
  ctx.arc(cx, top + r, r, Math.PI, 0);
  ctx.arc(cx, bottom - r, r, 0, Math.PI);
  ctx.closePath();
  ctx.fill();
}

// ── Leboncoin fetching ────────────────────────────────────────────────────────
// Stratégie en trois temps, de la moins à la plus intrusive :
//  1. fetch() offscreen : page HTML invisible (pas d'onglet, pas de fenêtre),
//     fetch() avec credentials:'include' → envoie __cf_clearance automatiquement.
//     Fonctionne tant que le cookie Cloudflare est valide.
//  2. iframe offscreen : si le cookie a expiré, on charge leboncoin dans une
//     <iframe> invisible (toujours pas de fenêtre). Le JS de challenge Cloudflare
//     s'y exécute et renouvelle le cookie, puis on relit via fetch(). Expérimental :
//     Cloudflare peut refuser d'émettre la clearance dans un contexte framé.
//  3. rendu réel : filet de sécurité. Onglet d'arrière-plan dans une fenêtre
//     déjà ouverte (sinon une nouvelle fenêtre, non minimisée et sans focus) ;
//     la navigation renouvelle le cookie / lit la page / détecte le captcha,
//     puis l'onglet est refermé aussitôt.

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_SCRAPING', 'AUDIO_PLAYBACK'],
    justification: 'Fetching leboncoin pages without a visible tab, and playing duck notification sounds',
  });
}

async function fetchLeboncoinAds(url) {
  // ── 1. Voie rapide : fetch offscreen (cookie Cloudflare encore valide) ────
  try {
    const data = await fetchViaOffscreen(url);
    console.log('[LBC] ✓ fetch offscreen (sans fenêtre)');
    return data;
  } catch (e) {
    // Problème réseau/internet → on N'escalade PAS (inutile d'ouvrir un onglet
    // et surtout pas de fausse alerte captcha). Erreur transitoire silencieuse.
    if (isNetworkError(e)) {
      console.warn(`[LBC] problème réseau (${e.message}) → aucune escalade`);
      throw e;
    }
    console.warn(`[LBC] fetch offscreen échoué (${e.message}) → renouvellement cookie via iframe`);
  }

  // ── 2. Renouveler le cookie via iframe offscreen (sans fenêtre) ───────────
  try {
    const data = await renewViaIframeAndFetch(url);
    console.log('[LBC] ✓ renouvellement iframe offscreen (sans fenêtre)');
    return data;
  } catch (e) {
    // Captcha confirmé par le content-script DANS l'iframe → notif sans ouvrir d'onglet.
    if (e.captcha) {
      console.log('[LBC] 🔐 captcha détecté via iframe (sans onglet)');
      throw e;
    }
    if (isNetworkError(e)) {
      console.warn(`[LBC] problème réseau (${e.message}) → aucune escalade`);
      throw e;
    }
    console.warn(`[LBC] renouvellement iframe échoué (${e.message}) → rendu réel`);
  }

  // ── 3. Rendu réel (onglet/fenêtre) : lève une erreur taguée {captcha:true}
  //      UNIQUEMENT si une page de challenge est positivement détectée. ──────
  const data = await fetchLeboncoinAdsViaTab(url);
  console.log('[LBC] ✓ rendu réel');
  return data;
}

/** Le message/état évoque-t-il une coupure réseau plutôt qu'un blocage Cloudflare ? */
function isNetworkError(e) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const m = (e?.message ?? '').toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('networkerror') ||
    m.includes('load failed') ||
    m.includes('net::') ||
    m.includes('err_internet') ||
    m.includes('err_network') ||
    m.includes('err_connection') ||
    m.includes('err_name_not_resolved')
  );
}

async function fetchViaOffscreen(url) {
  const DELAYS = [0, 800]; // 2 essais : immédiat, 800 ms (couvre les aléas réseau)
  let lastError;
  for (const delay of DELAYS) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      await ensureOffscreenDocument();
      const result = await chrome.runtime.sendMessage({ type: 'FETCH_LBC', url });
      if (result?.ok && result.data) return result.data;
      throw new Error(result?.error ?? 'Réponse invalide du document offscreen');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('fetch offscreen échoué');
}

async function renewViaIframeAndFetch(url) {
  await enableIframeHeaderStripping();
  try {
    await ensureOffscreenDocument();
    const result = await chrome.runtime.sendMessage({ type: 'RENEW_VIA_IFRAME', url });
    if (result?.ok && result.data) return result.data;
    const err = new Error(result?.error ?? 'Réponse invalide du document offscreen');
    if (result?.captcha) err.captcha = true; // captcha détecté dans l'iframe (sans onglet)
    throw err;
  } finally {
    await disableIframeHeaderStripping();
  }
}

// ── declarativeNetRequest : retire les protections anti-iframe de leboncoin ──
// Uniquement pour les sous-cadres (resourceTypes:['sub_frame']) et seulement le
// temps du renouvellement, donc la navigation normale sur leboncoin est intacte.
const IFRAME_RULE_ID = 1001;

async function enableIframeHeaderStripping() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [IFRAME_RULE_ID],
    addRules: [{
      id: IFRAME_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' },
        ],
      },
      condition: {
        urlFilter: '||leboncoin.fr',
        resourceTypes: ['sub_frame'],
      },
    }],
  });
}

async function disableIframeHeaderStripping() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [IFRAME_RULE_ID] });
  } catch (_) { /* rien à nettoyer */ }
}

// File d'attente : les vérifications par rendu s'exécutent l'une après l'autre
// pour ne jamais ouvrir plusieurs onglets/fenêtres simultanément.
let checkerQueue = Promise.resolve();

async function fetchLeboncoinAdsViaTab(url) {
  const result = await (checkerQueue = checkerQueue.then(() => runInCheckerContext(url)));
  return result;
}

/** Choisit une fenêtre « normale » existante (focalisée et non minimisée en priorité). */
async function pickHostWindow() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  if (wins.length === 0) return null;
  return (
    wins.find((w) => w.focused && w.state !== 'minimized') ??
    wins.find((w) => w.state !== 'minimized') ??
    wins[0]
  );
}

async function runInCheckerContext(url) {
  // Rendu de la page (renouvelle le cookie + permet de lire/détecter le captcha) :
  //  • si une fenêtre est déjà ouverte → onglet d'arrière-plan (aucune fenêtre en plus) ;
  //  • sinon → une fenêtre, NON minimisée et sans voler le focus.
  // L'onglet de vérification est fermé à la fin (ce qui ferme la fenêtre si on l'a
  // créée juste pour lui).
  const host = await pickHostWindow();

  let tabId;
  if (host) {
    const tab = await chrome.tabs.create({ windowId: host.id, url, active: false });
    tabId = tab.id;
  } else {
    const win = await chrome.windows.create({ url, focused: false });
    tabId = win.tabs[0].id;
  }

  try {
    // On sonde même en cas de timeout : une page de captcha peut rester "loading".
    let timedOut = false;
    try {
      await waitForTabComplete(tabId, 30_000);
    } catch (_) {
      timedOut = true;
    }

    let injected = false;
    let data = null;
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractLeboncoinDataFromPage,
      });
      injected = true;
      data = result?.result ?? null;
    } catch (_) { /* page non injectable (erreur réseau, about:blank) → injected=false */ }

    if (injected && Array.isArray(data)) return data;
    // Page de challenge Cloudflare positivement détectée → captcha à résoudre.
    if (injected && data && data.__challenge) {
      throw Object.assign(new Error('Captcha leboncoin requis'), { captcha: true });
    }
    // Sinon (injection impossible, page d'erreur, timeout) → transitoire, pas un captcha.
    if (timedOut) throw new Error('Timeout de chargement de la page (30 s)');
    throw new Error('Impossible de lire les données leboncoin (page inattendue ?)');
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

/** Attend que l'onglet atteigne le statut "complete" ou lève une erreur en cas de timeout. */
async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Onglet fermé de manière inattendue');
    if (tab.status === 'complete') return;
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error('Timeout de chargement de la page (30 s)');
}

/**
 * Fonction injectée dans l'onglet leboncoin (fallback uniquement).
 * Lit __NEXT_DATA__ et retourne le tableau des annonces normalisées.
 * IMPORTANT : cette fonction s'exécute dans le contexte de la page,
 * pas dans celui de l'extension — pas d'accès aux API chrome ici.
 */
function extractLeboncoinDataFromPage() {
  const el = document.getElementById('__NEXT_DATA__');
  if (el) {
    try {
      const data = JSON.parse(el.textContent);
      const ads = data?.props?.pageProps?.searchData?.ads;
      if (Array.isArray(ads)) {
        return ads.map((ad) => ({
          id: String(ad.list_id),
          url: `https://www.leboncoin.fr${ad.url}`,
          title: ad.subject ?? 'Sans titre',
          price: ad.price?.[0] ?? null,
        }));
      }
    } catch (_) { /* données illisibles → traité comme un challenge ci-dessous */ }
  }

  // Page leboncoin chargée (injectable) mais SANS __NEXT_DATA__ exploitable : la
  // vraie page de recherche en contient toujours, et les coupures réseau sont déjà
  // filtrées en amont (isNetworkError). C'est donc une page de blocage/captcha,
  // quel que soit le fournisseur (Cloudflare, DataDome…).
  return { __challenge: true };
}
