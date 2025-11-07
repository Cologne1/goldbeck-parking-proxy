// public/app.js

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const € = (v) => (v==null || v==='') ? '' : `${String(v).replace('.', ',')}${String(v).includes('€')?'':' €'}`;

function pickArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.results)) return json.results;
  if (json && Array.isArray(json.content)) return json.content;
  if (json && typeof json === 'object') {
    const firstArr = Object.values(json).find(v => Array.isArray(v));
    if (Array.isArray(firstArr)) return firstArr;
  }
  return [];
}
function safeJson(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function toLowerJsonStr(x) { try { return JSON.stringify(x).toLowerCase(); } catch { return ''; } }

function collectAttributes(obj) {
  return Array.isArray(obj?.attributes) ? obj.attributes : [];
}
function attrVal(attrs, keys) {
  const lower = keys.map(k => String(k).toLowerCase());
  const hit = attrs.find(a => lower.includes(String(a?.key).toLowerCase()));
  return hit?.value ?? '';
}
function parsePostalAddressBlock(block) {
  const lines = String(block).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  const street = lines[0] || '';
  let zip = '', city = '', country = '';
  for (let i=1;i<lines.length;i++) {
    const L = lines[i];
    if (/^\d{4,6}$/.test(L)) { zip=L; continue; }
    if (/^[A-Z]{2,3}$/.test(L)) { country=L; continue; }
    if (!city) city=L;
  }
  const line2 = [zip, city].filter(Boolean).join(' ');
  const c = country==='DEU' ? 'DE' : country;
  return [street, line2, c].filter(Boolean).join(', ');
}
function extractAddressFromAttributes(obj) {
  const attrs = collectAttributes(obj);
  const postal = attrs.find(a => String(a?.key).toUpperCase()==='POSTAL_ADDRESS')?.value;
  if (postal) return parsePostalAddressBlock(postal);
  const street = attrVal(attrs, ['STREET','straße','strasse']);
  const house  = attrVal(attrs, ['HOUSE_NO','houseNo','houseNumber']);
  const zip    = attrVal(attrs, ['ZIP','PLZ','postalCode']);
  const city   = attrVal(attrs, ['CITY','Ort','city']);
  const l1 = [street, house].filter(Boolean).join(' ').trim();
  const l2 = [zip, city].filter(Boolean).join(' ').trim();
  return [l1, l2].filter(Boolean).join(', ');
}
function splitLines(v) {
  return String(v||'').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function boolFromString(v) {
  if (v===true) return true;
  if (v===false) return false;
  const s = String(v||'').trim().toLowerCase();
  if (!s) return null;
  if (['true','yes','ja','1'].includes(s)) return true;
  if (['false','no','nein','0'].includes(s)) return false;
  return null;
}

// Kombinierter Status aus Counters
function combinedStatusFromOccupancy(occ) {
  if (!occ || !Array.isArray(occ.counters) || !occ.counters.length) return 'unknown';
  const rank = { full:3, tight:2, free:1, unknown:0 };
  let best = 'unknown';
  for (const c of occ.counters) {
    const s = String(c.status||'').toLowerCase();
    if (rank[s] > rank[best]) best = s;
  }
  if (best !== 'unknown') return best;
  let max=0, free=0;
  for (const c of occ.counters) {
    if (typeof c.maxPlaces === 'number') max += c.maxPlaces;
    if (typeof c.freePlaces === 'number') free += c.freePlaces;
  }
  if (max <= 0) return 'unknown';
  const ratio = (max - free) / max;
  if (ratio <= 0.60) return 'free';
  if (ratio <= 0.90) return 'tight';
  return 'full';
}

// Tarife heuristisch aus Attributes extrahieren (falls vorhanden)
function extractRates(detail) {
  const attrs = collectAttributes(detail);
  const hourly  = attrVal(attrs, ['HOURLY_RATE','hourly','pro_stunde','STUNDENPREIS']);
  const daymax  = attrVal(attrs, ['DAY_MAX','day_max','tageshöchstsatz','TAGESMAX']);
  const monthly = attrVal(attrs, ['MONTHLY','DAUERSTELLPLATZ','MONTHLY_LONG_TERM']);
  const bits = [];
  if (hourly) bits.push(`Stunde: ${€(hourly)}`);
  if (daymax) bits.push(`Tag: ${€(daymax)}`);
  if (monthly) bits.push(`Monat: ${€(monthly)}`);
  return bits.join(' · ');
}

function extractClearance(detail) {
  const attrs = collectAttributes(detail);
  const m = attrVal(attrs, ['CLEARANCE_METERS','EINFRAITTSHOEHE_M','EINFAHRTSHOEHE_M']);
  const cm = attrVal(attrs, ['HEIGHT_LIMIT_CM','EINFAHRTSHOEHE_CM']);
  if (m) return `${String(m).replace('.', ',')} m`;
  if (cm) return `${(Number(cm)/100).toFixed(2).replace('.', ',')} m`;
  return '';
}
function extractCapacity(detail) {
  return detail.capacityTotal ?? detail.totalCapacity ?? attrVal(collectAttributes(detail), ['CAPACITY_TOTAL','TOTAL_CAPACITY']) || '';
}
function extractFeatures(detail) {
  const attrs = collectAttributes(detail);
  // Feature-Namen direkt als Tags, wenn vorhanden
  const features = (detail.features || []).map(f => f?.name).filter(Boolean);
  // plus einzelne Attribute, falls gewünscht
  const extras = [];
  if (attrVal(attrs, ['ELEVATOR','AUFZUG'])) extras.push('Aufzug');
  if (attrVal(attrs, ['ROOFED','UEBERDACHT','ÜBERDACHT'])) extras.push('Überdacht');
  if (attrVal(attrs, ['RESTROOMS','WC'])) extras.push('WCs');
  if (attrVal(attrs, ['GUIDANCE_SYSTEM','LEITSYSTEM'])) extras.push('Leitsystem');
  return Array.from(new Set([...features, ...extras]));
}
function extractPayments(detail) {
  const payKeys = ['PAYPAL','PAY_PAL','VISA','MASTER_CARD','MASTERCARD','AMERICAN_EXPRESS','GIRO_CARD','CASH','DEBIT_CARD','EC_CARD','APPLE_PAY','GOOGLE_PAY','PARKINGCARD'];
  const attrs = collectAttributes(detail);
  const names = new Set();
  for (const f of (detail.features||[])) {
    if (String(f?.type).toUpperCase()==='PAYMENT' && f?.name) names.add(f.name);
  }
  for (const k of payKeys) {
    const v = attrVal(attrs, [k]);
    if (v) names.add(k.replaceAll('_',' '));
  }
  return Array.from(names);
}

// ---------- API ----------
async function apiJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const ct = (r.headers.get('content-type')||'').toLowerCase();
  return ct.includes('json') ? r.json() : r.text();
}
const loadFacilityDefinitions = () => apiJSON('/api/facility-definitions');
const loadFacilities = () => apiJSON('/api/facilities');
const loadFacility = (id) => apiJSON(`/api/facilities/${encodeURIComponent(id)}`);
const loadFacilityOccupancies = (id) => apiJSON(`/api/occupancies/facilities/${encodeURIComponent(id)}`);
const loadChargingStations = () => apiJSON('/api/charging-stations');
const loadChargingStation = (id) => apiJSON(`/api/charging-stations/${encodeURIComponent(id)}`);

// ---------- Rendering: Liste ----------
let FAC_ALL = [];
let FAC_FILTERED = [];
let CS_ALL = [];

function renderFacilitiesTable(rows) {
  const tbody = $('#facilitiesTbody');
  tbody.innerHTML = rows.map(f => `
    <tr>
      <td><a class="id-link" href="#" data-fid="${String(f.id)}">${String(f.id)}</a></td>
      <td>${String(f.name || '')}</td>
      <td class="muted">${String(f.definitionId ?? '')}</td>
    </tr>
  `).join('');
  // click
  $$('#facilitiesTbody .id-link').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = a.getAttribute('data-fid');
      await showFacilityDetails(id);
    });
  });
  $('#countBadge').textContent = `${rows.length} Treffer`;
}

function filterFacilities() {
  const needle = ($('#filterText').value || '').toLowerCase();
  const defSel = $('#definitionId').value || '';
  FAC_FILTERED = FAC_ALL.filter(f => {
    if (defSel && String(f.definitionId) !== defSel) return false;
    if (!needle) return true;
    const s = toLowerJsonStr({ id:f.id, name:f.name, city:f.city, def:f.definitionId });
    return s.includes(needle);
  });
  renderFacilitiesTable(FAC_FILTERED);
}

// ---------- Rendering: Parkhaus Detail ----------
let CURRENT_FAC = null;

function setOverviewTab(tab) {
  $('#viewOverview').style.display = (tab==='overview') ? '' : 'none';
  $('#viewOccupancy').style.display = (tab==='occ') ? '' : 'none';
  $('#viewRaw').style.display = (tab==='raw') ? '' : 'none';
}
$('#tabOverview').addEventListener('click', ()=> setOverviewTab('overview'));
$('#tabOccupancy').addEventListener('click', ()=> setOverviewTab('occ'));
$('#tabRaw').addEventListener('click', ()=> setOverviewTab('raw'));
setOverviewTab('overview');

function chips(container, items) {
  container.innerHTML = (items||[]).filter(Boolean).map(x => `<span class="tag">${String(x)}</span>`).join('') || '–';
}

function renderFacilityOverview(detail, occ) {
  $('#facName').textContent = detail?.name || '–';
  $('#facAddress').textContent = extractAddressFromAttributes(detail) || '–';
  $('#facClearance').textContent = extractClearance(detail) || '–';
  $('#facCapacity').textContent = extractCapacity(detail) || '–';
  $('#facRates').textContent = extractRates(detail) || '–';

  const combined = occ && Array.isArray(occ) && occ.length
    ? combinedStatusFromOccupancy(occ[0])
    : (detail._occ ? combinedStatusFromOccupancy(detail._occ) : 'unknown');
  $('#facStatus').textContent = combined || 'unknown';

  chips($('#facFeatures'), extractFeatures(detail));
  chips($('#facPayments'), extractPayments(detail));
}
function renderFacilityRaw(detail) {
  $('#facRaw').textContent = safeJson(detail);
}
function renderOccupancyTable(occ) {
  const tbody = $('#occTable');
  const rows = [];
  if (Array.isArray(occ) && occ.length && Array.isArray(occ[0].counters)) {
    for (const c of occ[0].counters) {
      rows.push(`
        <tr>
          <td>${String(c.name || c.key || '')}</td>
          <td>${String(c.type?.type || '')}</td>
          <td>${c.maxPlaces ?? ''}</td>
          <td>${c.occupiedPlaces ?? ''}</td>
          <td>${c.freePlaces ?? ''}</td>
          <td>${String(c.status || '')}</td>
        </tr>
      `);
    }
  }
  tbody.innerHTML = rows.join('') || `<tr><td colspan="6">Keine Zählstellen vorhanden.</td></tr>`;
}

async function showFacilityDetails(id) {
  try {
    const [detail, occ] = await Promise.all([
      loadFacility(id),                    // /api/facilities/:id
      loadFacilityOccupancies(id).catch(()=>[]) // nur diese ID
    ]);
    CURRENT_FAC = detail;
    $('#occFacId').textContent = String(id);
    $('#occCombined').textContent = (Array.isArray(occ)&&occ.length) ? combinedStatusFromOccupancy(occ[0]) : 'unknown';

    renderFacilityOverview(detail, occ);
    renderOccupancyTable(occ);
    renderFacilityRaw(detail);
    setOverviewTab('overview');
  } catch (e) {
    CURRENT_FAC = null;
    $('#facName').textContent = 'Fehler';
    $('#facRaw').textContent = safeJson({ error:String(e?.message||e) });
    $('#occTable').innerHTML = `<tr><td colspan="6">–</td></tr>`;
  }
}

// ---------- E-Ladestationen ----------
function renderChargingList(list) {
  const tbody = $('#chargeTbody');
  tbody.innerHTML = list.map(x => `
    <tr>
      <td><a class="id-link" href="#" data-csid="${String(x.id)}">${String(x.id)}</a></td>
      <td>${String(x.name || x.label || 'Ladestation')}</td>
    </tr>
  `).join('');
  $$('#chargeTbody .id-link').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = a.getAttribute('data-csid');
      const d = await loadChargingStation(id);
      renderChargingDetail(d);
    });
  });
}
function getAttr(attrs, key) {
  const K = String(key).toUpperCase();
  const hit = (attrs||[]).find(a => String(a?.key).toUpperCase() === K);
  return hit?.value ?? '';
}
function renderChargingDetail(detail) {
  const attrs = collectAttributes(detail);
  $('#csName').textContent = detail?.name || detail?.label || '–';
  $('#csAddress').textContent = extractAddressFromAttributes(detail) || detail?.addressLine || '–';

  const renewable = boolFromString(getAttr(attrs,'RENEWABLE_ENERGY'));
  $('#csRenewable').textContent = renewable===null ? '–' : (renewable ? 'Ja' : 'Nein');

  const dyn = boolFromString(getAttr(attrs,'DYNAMIC_POWER_LEVEL'));
  $('#csDynPower').textContent = dyn===null ? '–' : (dyn ? 'Ja' : 'Nein');

  const auth = splitLines(getAttr(attrs,'AUTHENTICATION_MODES'));
  const pay  = splitLines(getAttr(attrs,'PAYMENT_OPTIONS'));
  chips($('#csAuth'), auth);
  chips($('#csPay'), pay);

  $('#csAccess').textContent = getAttr(attrs,'ACCESSIBILITY') || '–';
  $('#csCalLaw').textContent = getAttr(attrs,'CALIBRATION_LAW_DATA_AVAILABILITY') || '–';
  $('#csDev').textContent = getAttr(attrs,'DEVICE_ID') || '–';

  $('#csRaw').textContent = safeJson(detail);
}

// ---------- Boot ----------
async function boot() {
  // Definitionen laden → Select füllen
  try {
    const defs = await loadFacilityDefinitions().catch(() => []);
    const sel = $('#definitionId');
    sel.innerHTML = `<option value="">– alle –</option>` + pickArray(defs).map(d => {
      const id = d?.id ?? d?.definitionId;
      const name = d?.name || d?.label || `Definition ${id}`;
      return `<option value="${String(id)}">${String(id)} – ${String(name)}</option>`;
    }).join('');
  } catch {}

  // Liste initial laden
  await reloadFacilities();

  // Events
  $('#btnLoadFacilities').addEventListener('click', reloadFacilities);
  $('#filterText').addEventListener('input', filterFacilities);
  $('#definitionId').addEventListener('change', filterFacilities);

  // Charging
  $('#btnLoadCharging').addEventListener('click', async () => {
    const all = await loadChargingStations();
    CS_ALL = pickArray(all);
    renderChargingList(CS_ALL);
    // Filter beim Tippen
    $('#chargeFilter').addEventListener('input', () => {
      const q = ($('#chargeFilter').value||'').toLowerCase();
      const rows = CS_ALL.filter(x => toLowerJsonStr(x).includes(q));
      renderChargingList(rows);
    });
  });
}

async function reloadFacilities() {
  const data = await loadFacilities();
  FAC_ALL = pickArray(data);
  filterFacilities();
}

window.addEventListener('DOMContentLoaded', boot);