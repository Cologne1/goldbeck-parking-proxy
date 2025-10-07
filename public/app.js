// public/app.js

// kleine Helpers
const $ = (id) => document.getElementById(id);
const out = $('out');
const count = $('count');

// sichere JSON-Ausgabe
const show = (data) => {
  let n = 0;
  if (Array.isArray(data)) n = data.length;
  else if (data && Array.isArray(data.items)) n = data.items.length;
  else if (data && Array.isArray(data.results)) n = data.results.length;
  count.textContent = String(n);
  try {
    out.textContent = JSON.stringify(data, null, 2);
  } catch {
    out.textContent = String(data);
  }
};

// flexibel Array aus API picken
function pickArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.results)) return json.results;
  return [];
}

// einfacher Client-Volltextfilter
function clientFilter(arr, q) {
  if (!q) return arr;
  const needle = q.toLowerCase();
  try {
    return arr.filter((x) => JSON.stringify(x).toLowerCase().includes(needle));
  } catch {
    return arr;
  }
}

// --- Detailsuche: Felder je Endpoint aktivieren/deaktivieren ---
function syncFieldState() {
  const ep = $('endpoint').value;
  const defEl = $('def');
  const facEl = $('facility');

  // default
  defEl.disabled = false;
  facEl.disabled = false;

  if (ep === '/api/facilities' || ep === '/api/features' || ep === '/api/facility-definitions') {
    defEl.disabled = false;
    facEl.disabled = true;   // wird hier nicht genutzt
    facEl.value = '';
  } else if (ep === '/api/charging-stations') {
    defEl.disabled = false;  // optional sinnvoll
    facEl.disabled = false;  // optional facilityId
  } else if (ep === '/api/occupancies') {
    defEl.disabled = true;   // nicht genutzt
    defEl.value = '';
    facEl.disabled = false;  // hier oft erforderlich
  }
}

$('endpoint').addEventListener('change', syncFieldState);

// Haupt-Laden
$('btn-load').onclick = async function handleLoad() {
  const ep = $('endpoint').value;
  const q = $('q').value.trim();
  const def = $('def').value;
  const facilityId = $('facility').value.trim();

  const params = new URLSearchParams();

  if (def && (ep === '/api/facilities' || ep === '/api/features' || ep === '/api/facility-definitions' || ep === '/api/charging-stations')) {
    params.set('definitionId', def);
  }
  if (facilityId && (ep === '/api/occupancies' || ep === '/api/charging-stations')) {
    params.set('facilityId', facilityId);
  }

  if (ep === '/api/occupancies' && !facilityId) {
    out.textContent = 'Tipp: Für Occupancies eine facilityId setzen (sonst kommt evtl. nichts / sehr viel).';
  }

  const url = ep + (params.toString() ? `?${params.toString()}` : '');

  out.textContent = 'Lade ' + url + ' ...';
  count.textContent = '…';

  try {
    const res = await fetch(url);
    const ct = (res.headers.get('content-type') || '').toLowerCase();

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      show({ error: `${res.status} ${res.statusText}`, body: text });
      return;
    }

    const payload = ct.includes('application/json') ? await res.json() : await res.text();
    const arr = typeof payload === 'string'
      ? [{ note: 'Non-JSON response', body: payload.slice(0, 1000) }]
      : pickArray(payload);

    const filtered = clientFilter(arr, q);
    show(filtered);
  } catch (e) {
    show({ error: String(e && e.message ? e.message : e) });
  }
};

// --- ID-Katalog (rechte Spalte) ---
const tblBody = document.querySelector('#catalog tbody');
const detailsOut = document.getElementById('details');
const detailsId = document.getElementById('details-id');

function renderCatalog(rows) {
  tblBody.innerHTML = rows.map((r) => {
    const id = (r.id !== undefined && r.id !== null) ? r.id : '';
    const name = (r.name !== undefined && r.name !== null) ? r.name : '';
    const extra = (r.extra !== undefined && r.extra !== null) ? r.extra : '';
    const type = (r.type !== undefined && r.type !== null) ? r.type : '';
    return `
      <tr>
        <td>${type}</td>
        <td>${id ? `<a href="#" data-fid="${String(id)}" class="fac-link">${String(id)}</a>` : ''}</td>
        <td>${String(name)}</td>
        <td class="muted">${String(extra)}</td>
      </tr>
    `;
  }).join('');

  // Klick auf ID → Details laden
  Array.from(tblBody.querySelectorAll('.fac-link')).forEach((a) => {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      const id = this.getAttribute('data-fid');
      if (id) loadFacilityDetails(id);
    });
  });
}

document.getElementById('btn-load-defs').onclick = async function loadDefs() {
  try {
    const res = await fetch('/api/facility-definitions');
    const json = await res.json();
    const arr = pickArray(json);
    const rows = arr.map((d) => ({
      type: 'def',
      id: d && (d.id ?? d.definitionId),
      name: d && (d.name || d.label || ''),
      extra: d && (d.description || '')
    }));
    renderCatalog(rows);
  } catch (e) {
    renderCatalog([{ type: 'err', name: 'Fehler beim Laden der Definitions', extra: String(e) }]);
  }
};

document.getElementById('btn-load-fac').onclick = async function loadFacs() {
  const filterText = (document.getElementById('catalog-def').value || '').trim().toLowerCase();
  const defSel = $('def').value; // optional
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
      type: 'fac',
      id: f && (f.id || f.facilityId),
      name: f && (f.name || f.label || ''),
      extra: `definitionId: ${f && (f.definitionId !== undefined ? f.definitionId : '–')}`
    }));
    renderCatalog(rows);
  } catch (e) {
    renderCatalog([{ type: 'err', name: 'Fehler beim Laden der Facilities', extra: String(e) }]);
  }
};

// Facility-Details laden
async function loadFacilityDetails(facilityId) {
  detailsId.value = facilityId;
  detailsOut.textContent = `Lade /api/facilities/${facilityId} …`;
  try {
    const res = await fetch(`/api/facilities/${encodeURIComponent(facilityId)}`);
    const json = await res.json();
    const arr = pickArray(json);
    const data = (Array.isArray(arr) && arr.length === 1) ? arr[0] : (arr.length ? arr : json);
    detailsOut.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    detailsOut.textContent = JSON.stringify({ error: String(e && e.message ? e.message : e) }, null, 2);
  }
}

document.getElementById('btn-fac-details').onclick = function () {
  const id = (detailsId.value || '').trim();
  if (id) loadFacilityDetails(id);
};

// Initialisieren
syncFieldState();
document.getElementById('btn-load').click();
