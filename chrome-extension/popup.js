// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return (str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FREQ_OPTIONS = [
  { value: 1,  label: '1 min' },
  { value: 5,  label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 h' },
];

function freqOptions(current) {
  return FREQ_OPTIONS.map(
    ({ value, label }) =>
      `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`
  ).join('');
}

function relTime(ts) {
  if (!ts) return 'jamais';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'à l\'instant';
  if (diff < 3_600_000) return `il y a ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `il y a ${Math.floor(diff / 3_600_000)} h`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function showError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

/** Renvoie un message d'erreur si l'URL n'est pas une URL leboncoin.fr valide, sinon null. */
function leboncoinUrlError(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('leboncoin.fr')) return 'Seules les URLs leboncoin.fr sont supportées.';
    return null;
  } catch (_) {
    return 'URL invalide.';
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderMonitor(m) {
  const isEnabled = m.enabled !== false;
  const hasError = Boolean(m.lastError);

  const statusClass = hasError ? 'status-error' : isEnabled ? 'status-active' : 'status-paused';
  const statusLabel = hasError ? '⚠ Erreur' : isEnabled ? '✓ Actif' : '⏸ Pausé';

  const itemClass = ['monitor-item', hasError ? 'has-error' : '', !isEnabled ? 'is-disabled' : '']
    .filter(Boolean)
    .join(' ');

  return `
    <div class="${itemClass}" data-id="${esc(m.id)}" data-url="${esc(m.url)}">
      <div class="item-header">
        <span class="item-name">${esc(m.name)}</span>
        <span class="status-pill ${statusClass}">${statusLabel}</span>
        <label class="toggle" title="${isEnabled ? 'Désactiver' : 'Activer'}">
          <input type="checkbox" class="js-toggle" ${isEnabled ? 'checked' : ''} />
          <span class="slider"></span>
        </label>
      </div>

      <div class="item-url js-open-url" title="Ouvrir la recherche">${esc(m.url)}</div>

      <div class="item-meta">
        <span class="freq-row">⏱ <select class="freq-select js-freq" title="Modifier la fréquence">${freqOptions(m.frequency)}</select></span>
        <span>🕒 ${relTime(m.lastCheck)}</span>
      </div>

      ${hasError ? `<div class="item-error">⚠ ${esc(m.lastError)}</div>` : ''}

      <div class="item-actions">
        <button class="btn-sm btn-check js-check">Vérifier</button>
        <button class="btn-sm btn-edit js-edit-url">Modifier l'URL</button>
        <button class="btn-sm btn-delete js-delete">Supprimer</button>
      </div>
    </div>
  `;
}

async function loadMonitors() {
  const { monitors = [] } = await chrome.storage.local.get('monitors');

  document.getElementById('monitorCount').textContent = monitors.length;

  const container = document.getElementById('monitorsList');
  if (monitors.length === 0) {
    container.innerHTML = '<p class="empty">Aucune surveillance configurée.</p>';
    return;
  }

  container.innerHTML = monitors.map(renderMonitor).join('');

  // Attach events per item
  container.querySelectorAll('.monitor-item').forEach((el) => {
    const id = el.dataset.id;

    el.querySelector('.js-open-url').addEventListener('click', () => {
      chrome.tabs.create({ url: el.dataset.url });
    });

    el.querySelector('.js-toggle').addEventListener('change', async (e) => {
      await chrome.runtime.sendMessage({ type: 'TOGGLE_MONITOR', monitorId: id, enabled: e.target.checked });
      loadMonitors();
    });

    el.querySelector('.js-check').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '…';
      await chrome.runtime.sendMessage({ type: 'CHECK_NOW', monitorId: id });
      setTimeout(loadMonitors, 1500);
    });

    el.querySelector('.js-freq').addEventListener('change', async (e) => {
      const frequency = parseInt(e.target.value, 10);
      await chrome.runtime.sendMessage({ type: 'UPDATE_FREQUENCY', monitorId: id, frequency });
      // Pas de reload : le select est déjà à jour visuellement
    });

    el.querySelector('.js-edit-url').addEventListener('click', async () => {
      const next = prompt('Nouvelle URL de la recherche :', el.dataset.url);
      if (next === null) return; // annulé
      const url = next.trim();
      if (!url || url === el.dataset.url) return; // inchangé
      const err = leboncoinUrlError(url);
      if (err) { showError(err); return; }
      const res = await chrome.runtime.sendMessage({ type: 'UPDATE_URL', monitorId: id, url });
      if (res?.ok === false) { showError(res.error ?? 'Erreur lors de la modification.'); return; }
      loadMonitors();
    });

    el.querySelector('.js-delete').addEventListener('click', async () => {
      if (!confirm('Supprimer cette surveillance ?')) return;
      await chrome.runtime.sendMessage({ type: 'REMOVE_MONITOR', monitorId: id });
      loadMonitors();
    });
  });
}

// ── Form ──────────────────────────────────────────────────────────────────────

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');

  const url = document.getElementById('url').value.trim();

  const urlError = leboncoinUrlError(url);
  if (urlError) {
    showError(urlError);
    return;
  }

  btn.disabled = true;

  const monitor = {
    id: `m-${Date.now()}`,
    name: document.getElementById('name').value.trim(),
    url,
    frequency: parseInt(document.getElementById('frequency').value, 10),
    enabled: true,
    createdAt: Date.now(),
  };

  const res = await chrome.runtime.sendMessage({ type: 'ADD_MONITOR', monitor });
  btn.disabled = false;

  if (res?.ok === false) {
    showError(res.error ?? 'Erreur lors de l\'ajout.');
    return;
  }

  e.target.reset();
  document.getElementById('formError').classList.add('hidden');
  loadMonitors();
});

// ── "Use current tab" button ─────────────────────────────────────────────────

async function initCurrentTabBtn() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;

    const btn = document.getElementById('useCurrentUrl');
    btn.addEventListener('click', () => {
      document.getElementById('url').value = tab.url;
      if (!document.getElementById('name').value && tab.title) {
        document.getElementById('name').value = tab.title.slice(0, 60);
      }
      document.getElementById('url').focus();
    });
  } catch (_) { /* activeTab not available in this context */ }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function initSoundToggle() {
  const { soundMuted = false } = await chrome.storage.local.get('soundMuted');
  const toggle = document.getElementById('soundToggle');
  toggle.checked = !soundMuted;
  toggle.addEventListener('change', (e) => {
    chrome.storage.local.set({ soundMuted: !e.target.checked });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadMonitors();
  initCurrentTabBtn();
  initSoundToggle();
  // Auto-refresh every 5 s so status stays current while popup is open
  setInterval(loadMonitors, 5000);
});
