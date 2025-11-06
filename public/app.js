// kleine Helpers
const $ = (id) => document.getElementById(id);
const out = $('out');
const count = $('count');

// sichere Ausgabe
const show = (data) => {
  const arr = pickArray(data);
  count.textContent = String(Array.isArray(arr) ? arr.length : 0);
  try { out.textContent = JSON.stringify(data, null, 2); }
  catch { out.textContent = String(data); }
};

// flexibel Array aus API picken
function pickArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const keys = ['items','results','facilities','features','content','data','list'];
  for (const k of keys) {
    if (Array.isArray(json[k])) return json[k];
    if (json[k] && typeof json[k] === 'object') {
      const arr = Object.values(json[k]).find(v => Array.isArray(v));
      if (arr) return arr;
    }
  }
  const firstArr = Object.values(json).find(v => Array.isArray(v));
  if (firstArr) return firstArr;
  if (json.id || json.facilityId) return [json];
  return [];
}

// Volltextfilter
function clientFilter(arr, q) {
  if (!q) return arr;
  const needle = q.toLowerCase();
  try { return arr.filter((x) => JSON.stringify(x).toLowerCase().includes(needle)); }
  catch { return arr; }
}

// Felder je Bereich aktivieren/deaktivieren
function syncFieldState() {
  const ep = $('endpoint').value;
  const defEl = $('def');
  const standortEl = $('standort');

  defEl.disabled = false;
  standortEl.disabled = false;

  if (ep === '/api/facilities' || ep === '/api/features' || ep === '/api/facility-definitions') {
    defEl.disabled = false;
    standortEl.disabled = true;
    standortEl.value = '';
  } else if (ep === '/api/charging-stations') {
    defEl.disabled = false;
    standortEl.disabled = false; // optional facilityId
  } else if (ep === '/api/occupancies') {
    defEl.disabled = true;
    defEl.value = '';
    standortEl.disabled = false; // meist erforderlich
  }
}
$('endpoint').addEventListener('change', syncFieldState);

// Dropdown „Standort-Typ“ dynamisch befüllen (keine Defaults!)
async function hydrateDefinitionsSelect() {
  const sel = $('def');
  sel.innerHTML = `<option value="">– alle –</option>`;
  try {
    const res = await fetch('/api/facility-definitions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const defs = pickArray(data);
    defs.forEach(d => {
      const id = d?.id ?? d?.definitionId;
      const name = d?.name || d?.label || String(id ?? '');
      if (id != null) {
        const opt = document.createElement('option');
        opt.value = String(id);
        opt.textContent = `${id} — ${name}`;
        sel.appendChild(opt);
      }
    });
  } catch (e) {
    // minimaler Hinweis, kein Default
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '– Fehler beim Laden –';
    sel.appendChild(opt);
  }
}

// Haupt-Laden
$('btn-load').onclick = async function handleLoad() {
  const ep = $('endpoint').value;
  const q = $('q').value.trim();
  const def = $('def').value;
  const standortId = $('standort').value.trim();

  const params = new URLSearchParams();

  // UI → API-Parameter (nur setzen, wenn vorhanden)
  if (def && (ep === '/api/facilities' || ep === '/api/features' || ep === '/api/facility-definitions' || ep === '/api/charging-stations')) {
    params.set('definitionId', def);
  }
  if (standortId && (ep === '/api/occupancies' || ep === '/api/charging-stations' || ep === '/api/features')) {
    params.set('facilityId', standortId);
  }

  if (ep === '/api/occupancies' && !standortId) {
    out.textContent = 'Tipp: Für „Belegung“ eine Standort-ID setzen (sonst sehr viel/leer).';
  }

  const url = ep + (params.toString() ? `?${params.toString()}` : '');
  out.textContent = 'Lade ' + url + ' …';
  count.textContent = '…';

  try {
    const res = await fetch(url);
    const ct = (res.headers.get('content-type') || '').toLowerCase();

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      show({ error: `${res.status} ${res.statusText}`, body: text });
      return;
    }

    const payload = /\bjson\b/i.test(ct) ? await res.json() : await res.text();
    const arr = typeof payload === 'string'
      ? [{ hinweis: 'Nicht-JSON Antwort', ausschnitt: payload.slice(0, 1000) }]
      : pickArray(payload);

    const filtered = clientFilter(arr, q);
    show(filtered);
  } catch (e) {
    show({ error: String(e?.message || e) });
  }
};

// ------ ID-Katalog (rechte Spalte) ------
const tblBody = document.querySelector('#catalog tbody');
const detailsOut = document.getElementById('details');
const detailsId = document.getElementById('details-id');

function renderCatalog(rows) {
  tblBody.innerHTML = rows.map((r) => {
    const id = (r.id ?? '');
    const name = (r.name ?? '');
    const extra = (r.extra ?? '');
    const type = (r.type ?? '');
    return `
      <tr>
        <td>${type}</td>
        <td>${id ? `<a href="#" data-fid="${String(id)}" class="fac-link">${String(id)}</a>` : ''}</td>
        <td>${String(name)}</td>
        <td class="muted">${String(extra)}</td>
      </tr>
    `;
  }).join('');

  Array.from(tblBody.querySelectorAll('.fac-link')).forEach((a) => {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      const id = this.getAttribute('data-fid');
      if (id) loadFacilityDetails(id);
    });
  });
}

document.getElementById('btn-load-defs').onclick = async function loadDefs() {
  // befüllt Dropdown UND Tabelle
  await hydrateDefinitionsSelect();
  try {
    const res = await fetch('/api/facility-definitions');
    const json = await res.json();
    const arr = pickArray(json);
    const rows = arr.map((d) => ({
      type: 'Typ',
      id: d && (d.id ?? d.definitionId),
      name: d && (d.name || d.label || ''),
      extra: d && (d.description || '')
    }));
    renderCatalog(rows);
  } catch (e) {
    renderCatalog([{ type: 'Fehler', name: 'Laden der Typen fehlgeschlagen', extra: String(e) }]);
  }
};

document.getElementById('btn-load-fac').onclick = async function loadFacs() {
  const filterText = (document.getElementById('catalog-def').value || '').trim().toLowerCase();
  const defSel = $('def').value;
  const params = new URLSearchParams();
  if (defSel) params.set('definitionId', defSel);

  try {
    const res = await fetch('/api/facilities' + (params.toString() ? `?${params.toString()}` : ''));
    const json = await res.json();
    let arr = pickArray(json);

    if (filterText) {
      arr = arr.filter((x) => {
        try { return JSON.stringify(x).toLowerCase().includes(filterText); }
        catch { return true; }
      });
    }

    const rows = arr.map((f) => ({
      type: 'Standort',
      id: f && (f.id || f.facilityId),
      name: f && (f.name || f.label || ''),
      extra: (f && f.definitionId !== undefined) ? `Typ-ID: ${f.definitionId}` : ''
    }));
    renderCatalog(rows);
  } catch (e) {
    renderCatalog([{ type: 'Fehler', name: 'Laden der Standorte fehlgeschlagen', extra: String(e) }]);
  }
};

// Details mit optionalen Embed-Teilen (nur echte Daten)
async function loadFacilityDetails(facilityId) {
  detailsId.value = facilityId;
  detailsOut.textContent = `Lade Standort ${facilityId} …`;
  try {
    const parts = [...document.querySelectorAll('[data-embed]:checked')].map(i => i.value);
    const qs = parts.length ? `?embed=${encodeURIComponent(parts.join(','))}` : '';
    const res = await fetch(`/api/facilities/${encodeURIComponent(facilityId)}${qs}`);

    if (!res.ok) {
      const t = await res.text().catch(()=> '');
      detailsOut.textContent = JSON.stringify({ error:`HTTP ${res.status}`, body:t }, null, 2);
      return;
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const json = /\bjson\b/i.test(ct) ? await res.json() : { hinweis:'Nicht-JSON', body: await res.text() };

    const arr = pickArray(json);
    const data = (Array.isArray(arr) && arr.length === 1) ? arr[0] : (arr.length ? arr : json);

    detailsOut.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    detailsOut.textContent = JSON.stringify({ error: String(e?.message || e) }, null, 2);
  }
}

document.getElementById('btn-fac-details').onclick = function () {
  const id = (detailsId.value || '').trim();
  if (id) loadFacilityDetails(id);
};

// Init: nur UI-Zustand setzen, keine Auto-Loads
syncFieldState();
// Definitions-Dropdown beim Start befüllen (keine statischen Optionen)
hydrateDefinitionsSelect();
