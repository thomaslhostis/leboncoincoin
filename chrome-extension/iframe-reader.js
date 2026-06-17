/**
 * Content-script injecté dans CHAQUE frame leboncoin (all_frames).
 *
 * Deux rôles selon le contexte :
 *  • Frame de premier niveau (onglet réel) : si la page leboncoin est accessible
 *    (présence de __NEXT_DATA__, donc challenge Cloudflare franchi), on le signale
 *    au background pour qu'il retire l'avertissement captcha. Sinon, inerte.
 *  • Sous-cadre (iframe invisible du document offscreen) : on lit __NEXT_DATA__ et
 *    on renvoie les annonces (ou une erreur), ce qui contourne le partitionnement
 *    des cookies en lisant la page là où elle s'est chargée.
 */

(() => {
  const el = document.getElementById('__NEXT_DATA__');

  // ── Onglet réel ───────────────────────────────────────────────────────────
  if (window.top === window.self) {
    if (el) {
      // __NEXT_DATA__ présent = vraie page leboncoin (pas une page de challenge).
      try {
        chrome.runtime.sendMessage({ type: 'LBC_ACCESSIBLE' });
      } catch (_) { /* contexte d'extension indisponible — ignorer */ }
    }
    return;
  }

  // ── Sous-cadre (iframe offscreen de renouvellement) ─────────────────────────
  const send = (payload) => {
    try {
      chrome.runtime.sendMessage({ type: 'LBC_IFRAME_RESULT', ...payload });
    } catch (_) {
      /* contexte d'extension indisponible — ignorer */
    }
  };

  if (!el) {
    // Page chargée dans l'iframe mais sans __NEXT_DATA__ = page de challenge/captcha
    // (Cloudflare, DataDome…). On le signale explicitement (challenge:true).
    send({ ok: false, challenge: true, error: 'pas de __NEXT_DATA__ (page de challenge/captcha)' });
    return;
  }

  let json;
  try {
    json = JSON.parse(el.textContent);
  } catch (_) {
    send({ ok: false, error: 'parse __NEXT_DATA__ échoué' });
    return;
  }

  const ads = json?.props?.pageProps?.searchData?.ads;
  if (!Array.isArray(ads)) {
    send({ ok: false, error: 'structure des annonces inattendue' });
    return;
  }

  send({
    ok: true,
    data: ads.map((ad) => ({
      id: String(ad.list_id),
      url: `https://www.leboncoin.fr${ad.url}`,
      title: ad.subject ?? 'Sans titre',
      price: ad.price?.[0] ?? null,
    })),
  });
})();
