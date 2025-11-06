// Helper
const $ = (id) => document.getElementById(id);
const out = $('out');
const count = $('count');
const detailsOut = document.getElementById('details');
const detailsId = document.getElementById('details-id');

function pickArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const keys = ['items','results','content','data','list',
    'facilities','features','filecontent',
    'occupancies','counters','attributes',
    'methods','devices','status','deviceStatus','contactData'];
  for (const k of keys) if (Array.isArray(json[k])) return json[k];
  const first = Object.values(json).find(Array.isArray);
  return Array.isArray(first) ? first : [];
}
function show(data) {
  const arr = pickArray(data);
  count.textContent = String(Array.isArray(arr) ? arr.length : 0);
  out.textContent = JSON.stringify(data, null, 2);
}
function clientFilter(arr, q) {
  if (!q) return arr;
  const n = q.toLowerCase();
  try { return arr.filter(x => JSON.stringify(x).toLowerCase().includes(n)); }
  catch { return arr; }
}

// Feld-Logik
function syncFieldState() {
  const ep = $('endpoint').value;
  const defEl = $('def');
  const standortEl = $('standort');

  defEl.disabled = false;
  standortEl.disabled = false;

  if (ep === '/api/facilities' || ep === '/api/features' || ep === '/api/facility-definitions') {
    defEl.disabled = false; standortEl.disabled = true; standortEl.value = '';
  } else if (ep === '/api/charging-stations') {
    defEl.disabled = false; standortEl.disabled = false;
  } else if (ep === '/api/occupancies') {
    defEl.disabled = true; defEl.value = ''; standortEl.disabled = false;
  }
}
$('endpoint').addEventListener('change', syncFieldState);

// Dropdown „Typen“
async function hydrateDefinitionsSelect() {
  const sel = $('def');
  sel.innerHTML = `<option value="">– alle –</option>`;
  try {
    const res = await fetch('/api/facility-definitions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const defs = pickArray(await res.json());
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
  } catch {}
}

// Hauptliste laden
$('btn-load').onclick = async function handleLoad() {
  const ep   = $('endpoint').value;
  const q    = $('q').value.trim();
  const def  = $('def').value;
  const fid  = $('standort').value.trim();

  const params = new URLSearchParams();
  if (def && (ep === '/api/facilities' || ep === '/api/features' || ep === '/api/facility-definitions' || ep === '/api/charging-stations')) {
    params.set('definitionId', def);
  }
  if (fid && (ep === '/api/occupancies' || ep === '/api/charging-stations' || ep === '/api/features')) {
    params.set('facilityId', fid);
  }

  if (ep === '/api/occupancies' && !fid) {
    out.textContent = 'Hinweis: Für „Belegung“ eine Standort-ID eingeben.';
    count.textContent = '0';
    return;
  }

  const url = ep + (params.toString() ? `?${params}` : '');
  out.textContent = 'Lade ' + url + ' …';
  count.textContent = '…';

  try {
    const res = await fetch(url);
    if (!res.ok) {
      const t = await res.text().catch(()=> '');
      show({ error:`HTTP ${res.status}`, body: t });
      return;
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const payload = /\bjson\b/.test(ct) ? await res.json() : await res.text();
    const arr = typeof payload === 'string' ? [{hinweis:'Nicht-JSON', body: payload.slice(0,1000)}] : pickArray(payload);
    show(clientFilter(arr, q));
  } catch (e) {
    show({ error: String(e?.message || e) });
  }
};

// Katalog rechts
const tblBody = document.querySelector('#catalog tbody');
function renderCatalog(rows) {
  tblBody.innerHTML = rows.map((r) => {
    const id = (r.id ?? ''); const name = (r.name ?? ''); const extra = (r.extra ?? ''); const type = (r.type ?? '');
    return `<tr>
      <td>${type}</td>
      <td>${id ? `<a href="#" data-fid="${String(id)}" class="fac-link">${String(id)}</a>` : ''}</td>
      <td>${String(name)}</td>
      <td class="muted">${String(extra)}</td>
    </tr>`;
  }).join('');

  Array.from(tblBody.querySelectorAll('.fac-link')).forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); const id = a.getAttribute('data-fid'); if (id) loadFacilityDetails(id); });
  });
}

document.getElementById('btn-load-defs').onclick = async function () {
  await hydrateDefinitionsSelect();
  try {
    const res = await fetch('/api/facility-definitions');
    const arr = pickArray(await res.json());
    renderCatalog(arr.map(d => ({
      type:'Typ', id: d?.id ?? d?.definitionId, name: d?.name || d?.label || '', extra: d?.description || ''
    })));
  } catch (e) {
    renderCatalog([{ type:'Fehler', name:'Laden der Typen fehlgeschlagen', extra:String(e)}]);
  }
};

document.getElementById('btn-load-fac').onclick = async function () {
  const filterText = (document.getElementById('catalog-def').value || '').trim().toLowerCase();
  const defSel = $('def').value;
  const params = new URLSearchParams(); if (defSel) params.set('definitionId', defSel);
  const url = '/api/facilities' + (params.toString() ? `?${params}` : '');

  try {
    const res = await fetch(url);
    let arr = pickArray(await res.json());
    if (filterText) {
      arr = arr.filter((x) => { try { return JSON.stringify(x).toLowerCase().includes(filterText); } catch { return true; } });
    }
    renderCatalog(arr.map(f => ({
      type:'Standort', id: f?.id || f?.facilityId, name: f?.name || f?.label || '', extra: (f?.definitionId!=null) ? `Typ-ID: ${f.definitionId}` : ''
    })));
  } catch (e) {
    renderCatalog([{ type:'Fehler', name:'Laden der Standorte fehlgeschlagen', extra:String(e)}]);
  }
};

// ►► WICHTIG: Einzel-Fetch statt embed
const EMBED_ORDER = [
  'attributes',
  'contactData',
  'methods',
  'devices',
  'fileAttachments',
  'facilityStatus',
  'deviceStatus',
  'facilityOccupancies',
];

async function loadFacilityDetails(facilityId) {
  detailsId.value = facilityId;

  // 1) Basisdatensatz
  detailsOut.textContent = `Lade Standort ${facilityId} …`;
  let base = {};
  try {
    const res = await fetch(`/api/facilities/${encodeURIComponent(facilityId)}`);
    if (res.ok) {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      base = /\bjson\b/.test(ct) ? await res.json() : { note:'Nicht-JSON', raw: await res.text() };
    } else {
      const t = await res.text().catch(()=> '');
      detailsOut.textContent = JSON.stringify({ error:`HTTP ${res.status}`, body:t }, null, 2);
      return;
    }
  } catch (e) {
    detailsOut.textContent = JSON.stringify({ error: String(e?.message || e) }, null, 2);
    return;
  }

  // 2) Welche „Einzel-Teile“ sind angehakt?
  const wanted = [...document.querySelectorAll('[data-embed]:checked')].map(i => i.value);
  const toFetch = EMBED_ORDER.filter(k => wanted.includes(k));

  // 3) Parallel laden und mergen – JEWEILS gefiltert auf facilityId
  const results = {};
  await Promise.all(toFetch.map(async (kind) => {
    try {
      const resp = await fetch(`/api/embed/${encodeURIComponent(kind)}?facilityId=${encodeURIComponent(facilityId)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const json = /\bjson\b/.test(ct) ? await resp.json() : [];
      results[kind] = json; // bereits serverseitig gefiltert
    } catch (e) {
      results[kind] = { error: String(e?.message || e) };
    }
  }));

  // 4) Endobjekt zusammenbauen – konsistente Keys
  const merged = {
    ...base,
    attributes:          results.attributes ?? undefined,
    contactData:         results.contactData ?? undefined,
    methods:             results.methods ?? undefined,
    devices:             results.devices ?? undefined,
    fileAttachments:     results.fileAttachments ?? undefined,
    facilityStatus:      results.facilityStatus ?? undefined,
    deviceStatus:        results.deviceStatus ?? undefined,
    facilityOccupancies: results.facilityOccupancies ?? undefined,
  };

  detailsOut.textContent = JSON.stringify(merged, null, 2);
}

// Buttons
document.getElementById('btn-fac-details').onclick = function () {
  const id = (detailsId.value || '').trim();
  if (id) loadFacilityDetails(id);
};

// Init
syncFieldState();
hydrateDefinitionsSelect();
