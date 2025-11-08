// public/app.js

// ---------- Mini-DOM ----------
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const setText = (el, v) => { if (el) el.textContent = v; };
const setHTML = (el, v) => { if (el) el.innerHTML = v; };

// ---------- Formatting ----------
const euro = (v) => {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (s.includes('€')) return s;
  return s.replace('.', ',') + ' €';
};
const safeJson = (v) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
const splitLines = (v) => String(v || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

// ---------- JSON Helpers ----------
function pickArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items))   return json.items;
  if (json && Array.isArray(json.results)) return json.results;
  if (json && Array.isArray(json.content)) return json.content;
  if (json && typeof json === 'object') {
    const firstArr = Object.values(json).find(v => Array.isArray(v));
    if (Array.isArray(firstArr)) return firstArr;
  }
  return [];
}
function toLowerJsonStr(x) { try { return JSON.stringify(x).toLowerCase(); } catch { return ''; } }

// ---------- Attribute Helpers ----------
function collectAttributes(obj) {
  return Array.isArray(obj?.attributes) ? obj.attributes : [];
}
function attrVal(attrsOrDetail, keys) {
  const attrs = Array.isArray(attrsOrDetail) ? attrsOrDetail : collectAttributes(attrsOrDetail);
  const lower = keys.map(k => String(k).toLowerCase());
  const hit = (attrs || []).find(a => lower.includes(String(a?.key).toLowerCase()));
  return hit?.value ?? '';
}
function parsePostalAddressBlock(block) {
  const lines = String(block).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  const street = lines[0] || '';
  let zip = '', city = '', country = '';
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i];
    if (/^\d{4,6}$/.test(L)) { zip = L; continue; }
    if (/^[A-Z]{2,3}$/.test(L)) { country = L; continue; }
    if (!city) city = L;
  }
  const line2 = [zip, city].filter(Boolean).join(' ');
  const c = country === 'DEU' ? 'DE' : country;
  return [street, line2, c].filter(Boolean).join(', ');
}
function extractAddressFromAttributes(detail) {
  const attrs = collectAttributes(detail);
  const postal = attrs.find(a => String(a?.key).toUpperCase() === 'POSTAL_ADDRESS')?.value;
  if (postal) return parsePostalAddressBlock(postal);
  const street = attrVal(attrs, ['STREET', 'straße', 'strasse']);
  const house  = attrVal(attrs, ['HOUSE_NO', 'houseNo', 'houseNumber']);
  const zip    = attrVal(attrs, ['ZIP', 'PLZ', 'postalCode']);
  const city   = attrVal(attrs, ['CITY', 'Ort', 'city']);
  const l1 = [street, house].filter(Boolean).join(' ').trim();
  const l2 = [zip, city].filter(Boolean).join(' ').trim();
  return [l1, l2].filter(Boolean).join(', ');
}
function boolFromString(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (['true', 'yes', 'ja', '1'].includes(s)) return true;
  if (['false', 'no', 'nein', '0'].includes(s)) return false;
  return null;
}

// ---------- Domain Logic ----------
function combinedStatusFromOccupancy(occEntry) {
  if (!occEntry || !Array.isArray(occEntry.counters) || !occEntry.counters.length) return 'unknown';
  const rank = { full: 3, tight: 2, free: 1, unknown: 0 };
  let best = 'unknown';
  for (const c of occEntry.counters) {
    const s = String(c.status || '').toLowerCase();
    if (rank[s] > rank[best]) best = s;
  }
  if (best !== 'unknown') return best;

  // Fallback: Ratio auf Basis max/free
  let max = 0, free = 0;
  for (const c of occEntry.counters) {
    if (typeof c.maxPlaces === 'number')  max  += c.maxPlaces;
    if (typeof c.freePlaces === 'number') free += c.freePlaces;
  }
  if (max <= 0) return 'unknown';
  const ratio = (max - free) / max;
  if (ratio <= 0.60) return 'free';
  if (ratio <= 0.90) return 'tight';
  return 'full';
}
function extractClearance(detail) {
  const attrs = collectAttributes(detail);
  const m  = attrVal(attrs, ['CLEARANCE_METERS', 'EINFAHRTSHOEHE_M', 'EINFAHRTSHÖHE_M']);
  const cm = attrVal(attrs, ['HEIGHT_LIMIT_CM', 'EINFAHRTSHOEHE_CM', 'EINFAHRTSHÖHE_CM']);
  if (m)  return `${String(m).replace('.', ',')} m`;
  if (cm) return `${(Number(cm) / 100).toFixed(2).replace('.', ',')} m`;
  return '';
}
function extractCapacity(detail) {
  const attrs = collectAttributes(detail);
  const val = (detail?.capacityTotal ?? detail?.totalCapacity ?? attrVal(attrs, ['CAPACITY_TOTAL', 'TOTAL_CAPACITY']));
  return val || '';
}
function extractRates(detail) {
  const attrs   = collectAttributes(detail);
  const hourly  = attrVal(attrs, ['HOURLY_RATE', 'hourly', 'pro_stunde', 'STUNDENPREIS']);
  const daymax  = attrVal(attrs, ['DAY_MAX', 'day_max', 'tageshöchstsatz', 'TAGESMAX', 'TAGESHOECHSTSATZ', 'TAGESHÖCHSTSATZ']);
  const monthly = attrVal(attrs, ['MONTHLY', 'DAUERSTELLPLATZ', 'MONTHLY_LONG_TERM']);
  const bits = [];
  if (hourly)  bits.push(`Stunde: ${euro(hourly)}`);
  if (daymax)  bits.push(`Tag: ${euro(daymax)}`);
  if (monthly) bits.push(`Monat: ${euro(monthly)}`);
  return bits.join(' · ');
}
function extractFeatures(detail) {
  const attrs = collectAttributes(detail);
  const features = (detail?.features || []).map(f => f?.name).filter(Boolean);
  const extras = [];
  if (attrVal(attrs, ['ELEVATOR', 'AUFZUG']))              extras.push('Aufzug');
  if (attrVal(attrs, ['ROOFED', 'UEBERDACHT', 'ÜBERDACHT'])) extras.push('Überdacht');
  if (attrVal(attrs, ['RESTROOMS', 'WC']))                 extras.push('WCs');
  if (attrVal(attrs, ['GUIDANCE_SYSTEM', 'LEITSYSTEM']))   extras.push('Leitsystem');
  return Array.from(new Set([...features, ...extras]));
}
function extractPayments(detail) {
  const attrs = collectAttributes(detail);
  const names = new Set();
  for (const f of (detail?.features || [])) {
    if (String(f?.type).toUpperCase() === 'PAYMENT' && f?.name) names.add(f.name);
  }
  const payKeys = ['PAY_PAL', 'PAYPAL', 'VISA', 'MASTER_CARD', 'MASTERCARD', 'AMERICAN_EXPRESS', 'GIRO_CARD', 'CASH', 'DEBIT_CARD', 'EC_CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'PARKINGCARD'];
  for (const k of payKeys) {
    const v = attrVal(attrs, [k]);
    if (v) names.add(k.replace(/_/g, ' '));
  }
  return Array.from(names);
}
function coords(detail) {
  const lat = detail?.lat ?? detail?.latitude;
  const lng = detail?.lng ?? detail?.longitude;
  return (lat != null && lng != null) ? `${lat}, ${lng}` : '';
}
function countryFromAttrs(detail) {
  const attrs = collectAttributes(detail);
  const postal = attrs.find(a => String(a?.key).toUpperCase() === 'POSTAL_ADDRESS')?.value || '';
  if (/DEU\b/.test(postal)) return 'DE';
  return attrVal(attrs, ['COUNTRY', 'country']) || '';
}
function contactFromDetail(detail) {
  const attrs = collectAttributes(detail);
  return attrVal(attrs, ['CONTACT', 'KONTAKT', 'CONTACT_EMAIL', 'CONTACT_PHONE']) || '–';
}

// ---------- API ----------
async function apiJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  return ct.includes('json') ? r.json() : r.text();
}
const loadFacilityDefinitions = () => apiJSON('/api/facility-definitions');
const loadFacilities         = () => apiJSON('/api/facilities');
const loadFacility           = (id) => apiJSON(`/api/facilities/${encodeURIComponent(id)}`);
const loadAllOccupancies     = () => apiJSON('/api/occupancies'); // komplett, Client filtert
const loadFacilityDevices    = (id) => apiJSON(`/api/devices/facility/${encodeURIComponent(id)}`);
const loadChargingStations   = () => apiJSON('/api/charging-stations');
const loadChargingStation    = (id) => apiJSON(`/api/charging-stations/${encodeURIComponent(id)}`);

// ---------- State ----------
let FAC_ALL = [];
let FAC_FILTERED = [];
let CS_ALL = [];
let OCC_ALL = null;
let CURRENT_FAC = null;

// ---------- Occupancies ----------
async function ensureOccupanciesLoaded() {
  if (OCC_ALL) return OCC_ALL;
  const data = await loadAllOccupancies();
  OCC_ALL = pickArray(data);
  return OCC_ALL;
}
function occForFacility(id) {
  const fid = String(id);
  const arr = Array.isArray(OCC_ALL) ? OCC_ALL.filter(x => String(x?.facilityId) === fid) : [];
  return arr;
}

// ---------- Rendering Helpers ----------
function chips(container, items) {
  if (!container) return;
  container.innerHTML = (items || []).filter(Boolean).map(x => `<span class="tag">${String(x)}</span>`).join('') || '–';
}

// ---------- Liste Parkhäuser ----------
function renderFacilitiesTable(rows) {
  const tbody = $('#facilitiesTbody');
  if (!tbody) return;
  tbody.innerHTML = rows.map(f => `
    <tr>
      <td><a class="id-link" href="#" data-fid="${String(f.id)}">${String(f.id)}</a></td>
      <td>${String(f.name || '')}</td>
      <td class="muted">${String(f.definitionId ?? '')}</td>
    </tr>
  `).join('');

  $$('#facilitiesTbody .id-link').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = a.getAttribute('data-fid');
      await showFacilityDetails(id);
    });
  });

  setText($('#countBadge'), `${rows.length} Treffer`);
}
function filterFacilities() {
  const needle = ($('#filterText')?.value || '').toLowerCase();
  const defSel = $('#definitionId')?.value || '';
  FAC_FILTERED = FAC_ALL.filter(f => {
    if (defSel && String(f.definitionId) !== defSel) return false;
    if (!needle) return true;
    const s = toLowerJsonStr({ id: f.id, name: f.name, city: f.city, def: f.definitionId });
    return s.includes(needle);
  });
  renderFacilitiesTable(FAC_FILTERED);
}

// ---------- Tabs ----------
function setTab(tab) {
  const views = {
    overview: $('#viewOverview'),
    occ:      $('#viewOccupancy'),
    dev:      $('#viewDevices'),
    price:    $('#viewPrices'),
    raw:      $('#viewRaw'),
  };
  Object.entries(views).forEach(([k, el]) => { if (el) el.style.display = (k === tab) ? '' : 'none'; });
}
function bindTabs() {
  $('#tabOverview')  && $('#tabOverview').addEventListener('click', () => setTab('overview'));
  $('#tabOccupancy') && $('#tabOccupancy').addEventListener('click', () => setTab('occ'));
  $('#tabDevices')   && $('#tabDevices').addEventListener('click', () => setTab('dev'));
  $('#tabPrices')    && $('#tabPrices').addEventListener('click', () => setTab('price'));
  $('#tabRaw')       && $('#tabRaw').addEventListener('click', () => setTab('raw'));
  setTab('overview');
}

// ---------- Detail Parkhaus ----------
function renderFacilityOverview(detail, occEntryArr) {
  const occEntry = (Array.isArray(occEntryArr) && occEntryArr.length) ? occEntryArr[0] : null;

  setText($('#facName'), detail?.name || '–');
  setText($('#facAddress'), extractAddressFromAttributes(detail) || '–');
  setText($('#facClearance'), extractClearance(detail) || '–');
  setText($('#facCapacity'), extractCapacity(detail) || '–');
  setText($('#facRates'), extractRates(detail) || '–');

  const combined = occEntry ? combinedStatusFromOccupancy(occEntry) : 'unknown';
  setText($('#facStatus'), combined || 'unknown');

  chips($('#facFeatures'), extractFeatures(detail));
  chips($('#facPayments'), extractPayments(detail));
}
function renderFacilityRaw(detail) {
  setText($('#facRaw'), safeJson(detail));
}
function renderOccupancyTable(occEntryArr) {
  const tbody = $('#occTable');
  if (!tbody) return;
  const rows = [];
  const occEntry = (Array.isArray(occEntryArr) && occEntryArr.length) ? occEntryArr[0] : null;

  if (occEntry && Array.isArray(occEntry.counters)) {
    for (const c of occEntry.counters) {
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
function renderDevicesTable(list) {
  const tbody = $('#devicesTbody');
  if (!tbody) return;
  const arr = pickArray(list);
  const rows = arr.map(d => `
    <tr>
      <td>${String(d.name || d.label || '–')}</td>
      <td>${String(d.type || d.deviceType || '–')}</td>
      <td>${String(d.zone || d.area || '–')}</td>
      <td>${String(d.status || d.state || '–')}</td>
      <td class="muted">${String(d.id || d.deviceId || '')}</td>
    </tr>
  `);
  tbody.innerHTML = rows.join('') || `<tr><td colspan="5">Keine Geräte gefunden.</td></tr>`;
}
function renderFeatureTags(detail) {
  chips($('#facFeatTags'), (detail?.features || []).map(f => f?.name).filter(Boolean));
}
function renderAttributesTable(detail) {
  const attrs = collectAttributes(detail);
  const tbody = $('#facAttrTbody');
  if (!tbody) return;
  if (!attrs.length) {
    tbody.innerHTML = `<tr><td colspan="2">–</td></tr>`;
    return;
  }
  tbody.innerHTML = attrs.map(a => `
    <tr>
      <td>${String(a?.key ?? '')}</td>
      <td>${String(a?.value ?? '')}</td>
    </tr>
  `).join('');
}
function renderPrices(detail) {
  // Parken aus Attributen
  const attrs = collectAttributes(detail);
  const hourly  = attrVal(attrs, ['HOURLY_RATE', 'hourly', 'pro_stunde', 'STUNDENPREIS']);
  const dayMax  = attrVal(attrs, ['DAY_MAX', 'day_max', 'tageshöchstsatz', 'TAGESMAX', 'TAGESHOECHSTSATZ', 'TAGESHÖCHSTSATZ']);
  const monthly = attrVal(attrs, ['MONTHLY', 'DAUERSTELLPLATZ', 'MONTHLY_LONG_TERM']);

  setHTML($('#priceParking'),
    [hourly && `Stunde: ${euro(hourly)}`, dayMax && `Tag: ${euro(dayMax)}`, monthly && `Monat: ${euro(monthly)}`]
      .filter(Boolean).join(' · ') || '–'
  );
  setText($('#priceTimeBased'),
    [hourly && `pro Stunde ${euro(hourly)}`, dayMax && `Tageshöchstsatz ${euro(dayMax)}`]
      .filter(Boolean).join(' | ') || '–'
  );
  setText($('#priceLongTerm'), monthly ? `Dauerstellplatz: ${euro(monthly)}` : '–');

  // Optionale Ladepreise, falls im selben Objekt gepflegt
  const chargeH   = attrVal(attrs, ['CHARGING_HOURLY', 'EV_HOURLY', 'LADEN_STUNDE']);
  const chargeKwh = attrVal(attrs, ['CHARGING_PER_KWH', 'EV_PER_KWH', 'LADEN_KWH']);
  setHTML($('#priceCharging'),
    [chargeH && `Zeit: ${euro(chargeH)}`, chargeKwh && `kWh: ${euro(chargeKwh)}`]
      .filter(Boolean).join(' · ') || '–'
  );
}

async function showFacilityDetails(id) {
  try {
    const [detail] = await Promise.all([
      loadFacility(id),
      ensureOccupanciesLoaded()
    ]);
    const occArr = occForFacility(id);

    CURRENT_FAC = detail;

    // Header/Meta
    setText($('#facHdrId'), `ID ${String(id)}`);
    setText($('#facGeo'), coords(detail) || '–');
    setText($('#facCountry'), countryFromAttrs(detail) || '–');
    setText($('#facContact'), contactFromDetail(detail) || '–');

    // Overview
    renderFacilityOverview(detail, occArr);
    renderFacilityRaw(detail);

    // Occupancy
    renderOccupancyTable(occArr);
    const occEntry = (occArr && occArr.length) ? occArr[0] : null;
    setText($('#occFacId'), String(id));
    setText($('#occCombined'), occEntry ? combinedStatusFromOccupancy(occEntry) : 'unknown');
    setText($('#occUpdated'), occEntry?.valuesFrom ? String(occEntry.valuesFrom) : '–');

    // Devices
    try {
      const dev = await loadFacilityDevices(id);
      renderDevicesTable(dev);
    } catch (e) {
      setHTML($('#devicesTbody'), `<tr><td colspan="5">Geräte konnten nicht geladen werden: ${String(e?.message || e)}</td></tr>`);
    }

    // Features & Attributes
    renderFeatureTags(detail);
    renderAttributesTable(detail);

    // Prices
    renderPrices(detail);

    setTab('overview');
  } catch (e) {
    CURRENT_FAC = null;
    setText($('#facName'), 'Fehler');
    setText($('#facRaw'), safeJson({ error: String(e?.message || e) }));
    setHTML($('#occTable'), `<tr><td colspan="6">–</td></tr>`);
  }
}

// ---------- E-Ladestationen ----------
function renderChargingList(list) {
  const tbody = $('#chargeTbody');
  if (!tbody) return;
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
  const hit = (attrs || []).find(a => String(a?.key).toUpperCase() === K);
  return hit?.value ?? '';
}
function renderChargingDetail(detail) {
  const attrs = collectAttributes(detail);
  setText($('#csName'), detail?.name || detail?.label || '–');
  setText($('#csAddress'), extractAddressFromAttributes(detail) || detail?.addressLine || '–');

  const renewable = boolFromString(getAttr(attrs, 'RENEWABLE_ENERGY'));
  setText($('#csRenewable'), renewable === null ? '–' : (renewable ? 'Ja' : 'Nein'));

  const dyn = boolFromString(getAttr(attrs, 'DYNAMIC_POWER_LEVEL'));
  setText($('#csDynPower'), dyn === null ? '–' : (dyn ? 'Ja' : 'Nein'));

  const auth = splitLines(getAttr(attrs, 'AUTHENTICATION_MODES'));
  const pay  = splitLines(getAttr(attrs, 'PAYMENT_OPTIONS'));
  chips($('#csAuth'), auth);
  chips($('#csPay'), pay);

  setText($('#csAccess'), getAttr(attrs, 'ACCESSIBILITY') || '–');
  setText($('#csCalLaw'), getAttr(attrs, 'CALIBRATION_LAW_DATA_AVAILABILITY') || '–');
  setText($('#csDev'), getAttr(attrs, 'DEVICE_ID') || '–');

  setText($('#csRaw'), safeJson(detail));
}

// ---------- Boot ----------
async function reloadFacilities() {
  const data = await loadFacilities();
  FAC_ALL = pickArray(data);
  filterFacilities();
}

async function boot() {
  // Tabs binden
  bindTabs();

  // Definitions → Select
  try {
    const defs = await loadFacilityDefinitions().catch(() => []);
    const sel = $('#definitionId');
    if (sel) {
      sel.innerHTML = `<option value="">– alle –</option>` + pickArray(defs).map(d => {
        const id = d?.id ?? d?.definitionId;
        const name = d?.name || d?.label || `Definition ${id}`;
        return `<option value="${String(id)}">${String(id)} – ${String(name)}</option>`;
      }).join('');
    }
  } catch {}

  // Erste Liste
  await reloadFacilities();

  // Events – Liste
  $('#btnLoadFacilities') && $('#btnLoadFacilities').addEventListener('click', reloadFacilities);
  $('#filterText')        && $('#filterText').addEventListener('input', filterFacilities);
  $('#definitionId')      && $('#definitionId').addEventListener('change', filterFacilities);

  // Charging
  $('#btnLoadCharging') && $('#btnLoadCharging').addEventListener('click', async () => {
    const all = await loadChargingStations();
    CS_ALL = pickArray(all);
    renderChargingList(CS_ALL);
    const input = $('#chargeFilter');
    if (input) {
      input.addEventListener('input', () => {
        const q = (input.value || '').toLowerCase();
        const rows = CS_ALL.filter(x => toLowerJsonStr(x).includes(q));
        renderChargingList(rows);
      });
    }
  });
}

window.addEventListener('DOMContentLoaded', boot);