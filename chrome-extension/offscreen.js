/**
 * Offscreen document — s'exécute dans un contexte navigateur réel (invisible,
 * pas d'onglet dans la barre), ce qui permet de faire des fetch() avec les
 * cookies leboncoin (credentials: 'include') et un vrai TLS fingerprint,
 * contrairement à un service worker bloqué par Cloudflare.
 */

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'FETCH_LBC') {
    fetchAndParse(msg.url)
      .then((data) => reply({ ok: true, data }))
      .catch((e) => reply({ ok: false, error: e.message }));
    return true; // réponse asynchrone
  }

  if (msg.type === 'RENEW_VIA_IFRAME') {
    renewViaIframe(msg.url)
      .then((data) => reply({ ok: true, data }))
      .catch((e) => reply({ ok: false, error: e.message, captcha: !!e.captcha }));
    return true; // réponse asynchrone
  }

  if (msg.type === 'PLAY_QUACK') {
    playQuack();
    reply({ ok: true });
    return false;
  }

  return false;
});

// ── Renouvellement du cookie Cloudflare via iframe invisible ────────────────────
// Charge leboncoin dans une <iframe> hors écran : le JS de challenge Cloudflare
// s'y exécute (comme dans un onglet) et pose un __cf_clearance frais. On relit
// ensuite via fetch(), qui réutilise ce cookie. Aucune fenêtre ni onglet visible.
// (background.js retire au préalable X-Frame-Options/CSP via declarativeNetRequest,
//  sans quoi leboncoin refuserait d'être embarqué.)

// Sérialise les renouvellements : un seul iframe à la fois dans le document offscreen.
let iframeQueue = Promise.resolve();

function renewViaIframe(url) {
  return (iframeQueue = iframeQueue.then(() => doRenewViaIframe(url)));
}

async function doRenewViaIframe(url) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:1024px;height:768px;position:absolute;left:-10000px;top:0;border:0;';

  // Priorité : le content-script (iframe-reader.js) lit __NEXT_DATA__ DANS l'iframe
  // et nous renvoie le résultat — ça contourne le partitionnement des cookies.
  const csResultPromise = waitForIframeContentScript(15000);

  let loadCount = 0;
  iframe.addEventListener('load', () => { loadCount++; });
  iframe.src = url;
  document.body.appendChild(iframe);

  try {
    const cs = await csResultPromise;

    if (cs?.ok && cs.data) {
      console.log(`[LBC][iframe] ✓ lu via content-script (loads=${loadCount}) — l'iframe a chargé la vraie page leboncoin`);
      return cs.data;
    }

    // Repli : le cookie a peut-être quand même été renouvelé → re-fetch direct.
    try {
      const data = await fetchAndParse(url);
      console.log('[LBC][iframe] ✓ lu via re-fetch après passage iframe');
      return data;
    } catch (e) {
      if (cs && cs.challenge) {
        // Le content-script a chargé la page DANS l'iframe mais sans __NEXT_DATA__ :
        // c'est une page de challenge/captcha. Détecté SANS aucun onglet.
        console.warn(`[LBC][iframe] challenge détecté via content-script (loads=${loadCount}) — captcha à résoudre`);
        const err = new Error(`challenge détecté dans l'iframe (${cs.error})`);
        err.captcha = true;
        throw err;
      }
      // Pas de content-script du tout → non concluant : on laisse le rendu réel décider.
      console.warn(`[LBC][iframe] aucun message du content-script (loads=${loadCount}) ; re-fetch: ${e.message}`);
      throw new Error(`iframe inopérante (pas de content-script) ; re-fetch: ${e.message}`);
    }
  } finally {
    setTimeout(() => iframe.remove(), 500); // libère la mémoire
  }
}

/** Attend le 1er message LBC_IFRAME_RESULT (émis par iframe-reader.js), ou null au timeout. */
function waitForIframeContentScript(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      chrome.runtime.onMessage.removeListener(handler);
      clearTimeout(timer);
      resolve(val);
    };
    const handler = (msg) => {
      if (msg?.type === 'LBC_IFRAME_RESULT') finish(msg);
    };
    chrome.runtime.onMessage.addListener(handler);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

// ── Audio ─────────────────────────────────────────────────────────────────────

let audioCtx = null;
let quackBuffer = null;

async function getQuackBuffer() {
  if (quackBuffer) return quackBuffer;
  if (!audioCtx) audioCtx = new AudioContext();
  const response = await fetch('sounds/quack.wav');
  const arrayBuffer = await response.arrayBuffer();
  quackBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  return quackBuffer;
}

async function playQuack() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    const buffer = await getQuackBuffer();

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 1.15; // légèrement plus aigu

    const gain = audioCtx.createGain();
    gain.gain.value = 0.05; // atténué

    source.connect(gain);
    gain.connect(audioCtx.destination);
    source.start();
  } catch (e) {
    console.warn('[audio] playQuack failed', e);
  }
}

async function fetchAndParse(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      // Simule une navigation directe plutôt qu'un fetch programmatique
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  if (!res.ok) {
    const hint = (res.status === 403 || res.status === 503)
      ? ' — cookie Cloudflare expiré, visitez leboncoin.fr pour le renouveler'
      : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }

  const html = await res.text();

  // Cloudflare renvoie parfois un 200 avec une page de challenge
  if (
    html.includes('cf-browser-verification') ||
    html.includes('challenge-form') ||
    (html.includes('__cf_chl') && !html.includes('__NEXT_DATA__'))
  ) {
    throw new Error('Page de challenge Cloudflare reçue — cookie expiré');
  }

  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('__NEXT_DATA__ introuvable dans la réponse HTML');

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (_) {
    throw new Error('Impossible de parser __NEXT_DATA__');
  }

  const ads = data?.props?.pageProps?.searchData?.ads;
  if (!Array.isArray(ads)) throw new Error('Structure des annonces inattendue');

  return ads.map((ad) => ({
    id: String(ad.list_id),
    url: `https://www.leboncoin.fr${ad.url}`,
    title: ad.subject ?? 'Sans titre',
    price: ad.price?.[0] ?? null,
  }));
}
