// public/app.js

// ---------- Mini-Helpers ----------
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const ALLOWED_FAC_DEFS = new Set(['14']);
function safeJson(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function toLowerJsonStr(x) { try { return JSON.stringify(x).toLowerCase(); } catch { return ''; } }
function splitLines(v) { return String(v || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }

const euro = (v) => {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (s.includes('€')) return s;
  return s.replace('.', ',') + ' €';
};

function pickArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.results)) return json.results;
  if (json && Array.isArray(json.content)) return json.content;
  if (json && typeof json === 'object') {
    const firstArr = Object.values(json).find((v) => Array.isArray(v));
    if (Array.isArray(firstArr)) return firstArr;
  }
  return [];
}

function collectAttributes(obj) {
  return Array.isArray(obj && obj.attributes) ? obj.attributes : [];
}

function attrVal(attrs, keys) {
  const lower = keys.map((k) => String(k).toLowerCase());
  for (let i = 0; i < (attrs || []).length; i++) {
    const a = attrs[i];
    if (!a) continue;
    const k = String(a.key || '').toLowerCase();
    if (lower.includes(k)) return a.value != null ? a.value : '';
  }
  return '';
}

// POSTAL_ADDRESS: "Straße\nPLZ\nOrt\nLändercode"
function parsePostalAddressBlock(block) {
  const lines = String(block).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
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

function extractAddressFromAttributes(obj) {
  const attrs = collectAttributes(obj);
  const postal = attrs.find((a) => String(a && a.key).toUpperCase() === 'POSTAL_ADDRESS');
  if (postal && postal.value) return parsePostalAddressBlock(postal.value);

  const street = attrVal(attrs, ['STREET', 'straße', 'strasse']);
  const house  = attrVal(attrs, ['HOUSE_NO', 'houseno', 'housenumber']);
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
  if (s === 'true' || s === 'yes' || s === 'ja' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === 'nein' || s === '0') return false;
  return null;
}

// ---------- Tarife/Details-Heuristiken ----------
function extractRates(detail) {
  const attrs = collectAttributes(detail);
  const hourly  = attrVal(attrs, ['HOURLY_RATE', 'hourly', 'pro_stunde', 'STUNDENPREIS']);
  const daymax  = attrVal(attrs, ['DAY_MAX', 'day_max', 'tageshöchstsatz', 'TAGESMAX']);
  const monthly = attrVal(attrs, ['MONTHLY', 'DAUERSTELLPLATZ', 'MONTHLY_LONG_TERM']);
  const bits = [];
  if (hourly) bits.push('Stunde: ' + euro(hourly));
  if (daymax) bits.push('Tag: ' + euro(daymax));
  if (monthly) bits.push('Monat: ' + euro(monthly));
  return bits.join(' · ');
}

function extractClearance(detail) {
  const attrs = collectAttributes(detail);
  const m  = attrVal(attrs, ['CLEARANCE_METERS', 'EINFAHRTSHOEHE_M', 'EINFAHRTSHÖHE_M']);
  const cm = attrVal(attrs, ['HEIGHT_LIMIT_CM', 'EINFAHRTSHOEHE_CM', 'EINFAHRTSHÖHE_CM']);
  if (m) return String(m).replace('.', ',') + ' m';
  if (cm) {
    const n = Number(cm);
    if (!isNaN(n)) return (n / 100).toFixed(2).replace('.', ',') + ' m';
  }
  return '';
}

function extractCapacity(detail) {
  const attrs = collectAttributes(detail);
  const a = detail && (detail.capacityTotal != null ? detail.capacityTotal : detail.totalCapacity);
  if (a != null && a !== '') return a;
  const attrCap = attrVal(attrs, ['CAPACITY_TOTAL', 'TOTAL_CAPACITY']);
  return attrCap || '';
}

// Optionales Label-Mapping für Devices
const DEVICE_LABELS = {
  BARRIER: 'Schranke',
  CASH_DESK: 'Kasse',
  TICKET_MACHINE: 'Ticketautomat',
  CAMERA: 'Kamera'
};

// Devices in Features einmischen
function extractFeatures(detail, devices) {
  const attrs = collectAttributes(detail);

  const featNames = (detail && Array.isArray(detail.features) ? detail.features : [])
    .map((f) => f && f.name)
    .filter(Boolean);

  const deviceNames = (Array.isArray(devices) ? devices : [])
    .map((d) => {
      const t = String(d && d.type || '').toUpperCase();
      return DEVICE_LABELS[t] || d?.name || d?.type || d?.key;
    })
    .filter(Boolean);

  const extras = [];
  if (attrVal(attrs, ['ELEVATOR', 'AUFZUG'])) extras.push('Aufzug');
  if (attrVal(attrs, ['ROOFED', 'UEBERDACHT', 'ÜBERDACHT'])) extras.push('Überdacht');
  if (attrVal(attrs, ['RESTROOMS', 'WC'])) extras.push('WCs');
  if (attrVal(attrs, ['GUIDANCE_SYSTEM', 'LEITSYSTEM'])) extras.push('Leitsystem');

  const all = [].concat(featNames, deviceNames, extras).filter(Boolean);
  const set = {};
  for (let i = 0; i < all.length; i++) set[all[i]] = true;
  return Object.keys(set);
}

function extractPayments(detail) {
  const attrs = collectAttributes(detail);
  const namesSet = {};

  if (detail && Array.isArray(detail.features)) {
    for (let i = 0; i < detail.features.length; i++) {
      const f = detail.features[i];
      if (!f) continue;
      if (String(f.type || '').toUpperCase() === 'PAYMENT' && f.name) {
        namesSet[f.name] = true;
      }
    }
  }

  const payKeys = [
    'PAYPAL', 'PAY_PAL', 'VISA', 'MASTER_CARD', 'MASTERCARD',
    'AMERICAN_EXPRESS', 'GIRO_CARD', 'CASH', 'DEBIT_CARD',
    'EC_CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'PARKINGCARD'
  ];
  for (let i = 0; i < payKeys.length; i++) {
    const k = payKeys[i];
    const v = attrVal(attrs, [k]);
    if (v) {
      namesSet[k.replace(/_/g, ' ')] = true;
    }
  }

  return Object.keys(namesSet);
}

// ---------- Belegung (REST /iPCM) ----------
function normalizeOccForFacility(res, facId) {
  if (!res) return null;
  const fid = String(facId);

  if (Array.isArray(res)) {
    const match = res.find(x => String(x?.facilityId) === fid);
    if (match) return match;
    if (res.length === 1 && res[0]?.counters) return res[0];
    return null;
  }

  if (String(res.facilityId || '') === fid) return res;

  const arr = Array.isArray(res.items) ? res.items
    : Array.isArray(res.results) ? res.results
      : Array.isArray(res.content) ? res.content
        : [];
  return arr.find(x => String(x?.facilityId) === fid) || null;
}

function renderOccupancyTableFromRest(occJson) {
  const tbody = $('#occTable');
  const counters = (occJson && Array.isArray(occJson.counters)) ? occJson.counters : [];

  if (!counters.length) {
    tbody.innerHTML = '<tr><td colspan="6">Keine Zählstellen vorhanden.</td></tr>';
    return;
  }

  const rows = counters.map(c => {
    const keyOrName =
      c.name ||
      (c.nativeId && (c.nativeId.value || c.nativeId.id)) ||
      (c.counterType && Array.isArray(c.counterType.translations) && c.counterType.translations[0]?.value) ||
      c.key || '';

    const typ =
      (c.counterType && c.counterType.type) ||
      (c.type && c.type.type) ||
      '';

    const rsv = c.counterType?.reservationStatus ? ' · ' + c.counterType.reservationStatus : '';
    const statusCell = String(c.status || '') + rsv;

    return (
      '<tr>' +
      '<td>' + keyOrName + '</td>' +
      '<td>' + typ + '</td>' +
      '<td>' + (c.maxPlaces != null ? c.maxPlaces : '') + '</td>' +
      '<td>' + (c.occupiedPlaces != null ? c.occupiedPlaces : '') + '</td>' +
      '<td>' + (c.freePlaces != null ? c.freePlaces : '') + '</td>' +
      '<td>' + statusCell + '</td>' +
      '</tr>'
    );
  });

  tbody.innerHTML = rows.join('');
}

function combinedStatusFromRest(occJson) {
  const counters = (occJson && Array.isArray(occJson.counters)) ? occJson.counters : [];
  if (!counters.length) return 'unknown';

  const rank = { full: 3, tight: 2, free: 1, unknown: 0 };
  let best = 'unknown';

  for (let i = 0; i < counters.length; i++) {
    const s = String(counters[i].status || '').toLowerCase();
    if (rank[s] > rank[best]) best = s;
  }
  if (best !== 'unknown') return best;

  let max = 0, free = 0;
  for (let i = 0; i < counters.length; i++) {
    const c = counters[i];
    if (typeof c.maxPlaces === 'number') max += c.maxPlaces;
    if (typeof c.freePlaces === 'number') free += c.freePlaces;
  }
  if (max <= 0) return 'unknown';
  const ratio = (max - free) / max;
  if (ratio <= 0.60) return 'free';
  if (ratio <= 0.90) return 'tight';
  return 'full';
}

function summarizeCounters(counters = []) {
  let max = 0, occ = 0, free = 0, resOnlyMax = 0, noResMax = 0;
  for (const c of counters) {
    const m = Number(c.maxPlaces || 0);
    const o = Number(c.occupiedPlaces || 0);
    const f = Number(c.freePlaces || 0);
    max  += m;
    occ  += o;
    free += f;
    const r = c.counterType && c.counterType.reservationStatus;
    if (r === 'ONLY_RESERVATIONS') resOnlyMax += m;
    if (r === 'NO_RESERVATIONS')   noResMax  += m;
  }
  return { max, occ, free, resOnlyMax, noResMax };
}

// ===== Real Attribute Filters – Caches & Utils =====
const FAC_DETAIL_CACHE = new Map();
const FAC_DEV_CACHE    = new Map();
const CS_DETAIL_CACHE  = new Map();

const upKey = (k) => String(k || '').toUpperCase();
const toAttrsMap = (obj) => {
  const m = new Map();
  const attrs = collectAttributes(obj);
  for (const a of (attrs || [])) {
    if (!a) continue;
    const key = upKey(a.key);
    const val = a.value == null ? '' : String(a.value);
    m.set(key, val);
  }
  return m;
};
const attrHas = (attrsMap, key, needle) => {
  const v = attrsMap.get(upKey(key)) || '';
  return v && (needle ? v.toLowerCase().includes(String(needle).toLowerCase()) : true);
};
const anyAttrHas = (attrsMap, keys=[], predicate=(v)=>!!v) => {
  for (const k of keys) {
    const v = attrsMap.get(upKey(k));
    if (v != null && predicate(String(v))) return true;
  }
  return false;
};

async function getFacilityRich(id) {
  id = String(id);
  if (FAC_DETAIL_CACHE.has(id)) return FAC_DETAIL_CACHE.get(id);

  const [detail, devices] = await Promise.all([
    loadFacility(id).catch(()=>null),
    loadDevicesForFacility(id).then(pickArray).catch(()=>[])
  ]);

  const attrsMap = detail ? toAttrsMap(detail) : new Map();
  const deviceTypes = new Set(
    (devices || []).map(d => upKey(d?.type || d?.key || d?.name || ''))
  );

  const rich = { detail, attrsMap, devices, deviceTypes };
  FAC_DETAIL_CACHE.set(id, rich);
  return rich;
}

async function getChargingRich(id) {
  id = String(id);
  if (CS_DETAIL_CACHE.has(id)) return CS_DETAIL_CACHE.get(id);
  const detail = await loadChargingStation(id);
  const attrsMap = toAttrsMap(detail);
  const rich = { detail, attrsMap };
  CS_DETAIL_CACHE.set(id, rich);
  return rich;
}

// ---------- API ----------
async function apiJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  return ct.indexOf('json') !== -1 ? r.json() : r.text();
}

// iPAW Services:
const loadFacilityDefinitions = () => apiJSON('/api/facility-definitions');
const loadFacilities         = () => apiJSON('/api/facilities');
const loadFacility           = (id) => apiJSON('/api/facilities/' + encodeURIComponent(id));
// iPCM REST:
const loadOccupanciesForFacility = (id) => apiJSON('/api/occupancies/facility/' + encodeURIComponent(id));
const loadDevicesForFacility     = (id) => apiJSON('/api/devices/facility/' + encodeURIComponent(id));
// Charging:
const loadChargingStations   = () => apiJSON('/api/charging-stations');
const loadChargingStation    = (id) => apiJSON('/api/charging-stations/' + encodeURIComponent(id));

// ---------- State ----------
let FAC_ALL = [];
let FAC_FILTERED = [];
let CURRENT_FAC = null;
let CS_ALL = [];

// ---------- Rendering: Liste ----------
function renderFacilitiesTable(rows) {
  const tbody = $('#facilitiesTbody');
  const out = [];

  for (let i = 0; i < rows.length; i++) {
    const f = rows[i] || {};
    const id = f.id != null ? String(f.id) : '';
    const name = f.name || '';
    const def = f.definitionId != null ? String(f.definitionId) : '';
    out.push(
      '<tr>' +
      '<td><a class="id-link" href="#" data-fid="' + id + '">' + id + '</a></td>' +
      '<td>' + name + '</td>' +
      '<td class="muted">' + def + '</td>' +
      '</tr>'
    );
  }
  tbody.innerHTML = out.join('');

  $$('#facilitiesTbody .id-link').forEach((a) => {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      const id = this.getAttribute('data-fid');
      if (id) showFacilityDetails(id);
    });
  });

  $('#countBadge').textContent = rows.length + ' Treffer';
}

function filterFacilities() {
  const needle = ( $('#filterText').value || '' ).toLowerCase();
  const defSel = $('#definitionId').value || '';

  FAC_FILTERED = FAC_ALL.filter((f) => {
    // harte Schranke: nur Typ 14
    if (!ALLOWED_FAC_DEFS.has(String(f?.definitionId))) return false;

    if (defSel && String(f.definitionId) !== String(defSel)) return false;
    if (!needle) return true;
    const s = toLowerJsonStr({ id: f.id, name: f.name, city: f.city, def: f.definitionId });
    return s.indexOf(needle) !== -1;
  });

  renderFacilitiesTable(FAC_FILTERED);
}
// ---------- Rendering: Parkhaus Detail ----------
function setOverviewTab(tab) {
  $('#viewOverview').style.display  = (tab === 'overview') ? '' : 'none';
  $('#viewRaw').style.display       = (tab === 'raw')      ? '' : 'none';
}
$('#tabOverview').addEventListener('click', function () { setOverviewTab('overview'); });
$('#tabRaw').addEventListener('click', function () { setOverviewTab('raw'); });
setOverviewTab('overview');

function chips(container, items) {
  const arr = (items || []).filter(Boolean);
  if (!arr.length) {
    container.innerHTML = '–';
    return;
  }
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    out.push('<span class="tag">' + String(arr[i]) + '</span>');
  }
  container.innerHTML = out.join('');
}

async function showFacilityDetails(id) {
  // --- lokale Helfer nur für diese Funktion ---
  function findTotalCounter(occJson) {
    const counters = (occJson && Array.isArray(occJson.counters)) ? occJson.counters : [];
    if (!counters.length) return null;

    // robuste Erkennung der "total"-Zeile
    return counters.find(c => {
      const key   = (c.key || c.name || '').toString().toLowerCase();
      const nId   = (c.nativeId && (c.nativeId.value || c.nativeId.id) || '').toString().toLowerCase();
      const ctype = (c.counterType && (c.counterType.type || '') || '').toString().toLowerCase();
      const label = (Array.isArray(c.counterType?.translations) ? (c.counterType.translations[0]?.value || '') : '').toString().toLowerCase();
      return key === 'total' || nId === 'total' || ctype === 'total' || label === 'total';
    }) || null;
  }

  function formatOccFromTotalRow(totalRow) {
    if (!totalRow) return '–';
    const max  = (typeof totalRow.maxPlaces === 'number') ? totalRow.maxPlaces : null;
    const occ  = (typeof totalRow.occupiedPlaces === 'number') ? totalRow.occupiedPlaces : null;
    const free = (typeof totalRow.freePlaces === 'number')
      ? totalRow.freePlaces
      : (max != null && occ != null ? (max - occ) : null);

    let status = (totalRow.status || '').toString().toLowerCase();
    if (!status && max && (occ != null)) {
      const ratio = occ / max;
      status = (ratio <= 0.60) ? 'free' : (ratio <= 0.90 ? 'tight' : 'full');
    }
    const statusDe = status === 'free' ? 'frei'
      : status === 'tight' ? 'angespannt'
        : status === 'full' ? 'voll'
          : 'unbekannt';

    const parts = [];
    parts.push(statusDe);
    if (occ != null && max != null) parts.push(`${occ}/${max} belegt`);
    if (free != null) parts.push(`${free} frei`);
    return parts.join(' · ');
  }

  try {
    // 1) Stammdaten iPAW
    const detail = await loadFacility(id);

    // 2) Devices & (nur) Belegung für diese Facility
    const [devicesRaw, occRaw] = await Promise.all([
      loadDevicesForFacility(id).catch(() => null),
      loadOccupanciesForFacility(id).catch(() => null),
    ]);

    // --- UI: Stammdaten ---
    $('#facName').textContent      = (detail && detail.name) || '–';
    $('#facAddress').textContent   = extractAddressFromAttributes(detail) || '–';
    $('#facClearance').textContent = extractClearance(detail) || '–';
    $('#facCapacity').textContent  = extractCapacity(detail) || '–';
    $('#facRates').textContent     = extractRates(detail) || '–';

    const devices = pickArray(devicesRaw);
    chips($('#facFeatures'), extractFeatures(detail, devices));
    chips($('#facPayments'), extractPayments(detail));

    // --- Belegung: nur "total"-Zeile in facStatus ---
    let occJson = null;
    if (occRaw) {
      occJson = normalizeOccForFacility(occRaw, id)
        || (Array.isArray(occRaw) ? occRaw.find(x => String(x?.facilityId) === String(id)) : null);
    }
    const totalRow = findTotalCounter(occJson);
    $('#facStatus').textContent = formatOccFromTotalRow(totalRow);

    // --- Rohdaten (Facility) ---
    $('#facRaw').textContent = safeJson(detail);

    // immer Übersicht zeigen
    setOverviewTab('overview');
  } catch (e) {
    $('#facName').textContent = 'Fehler';
    $('#facRaw').textContent  = safeJson({ error: String(e && e.message ? e.message : e) });
    $('#facStatus').textContent = '–';
  }
}
// ---------- E-Ladestationen ----------

// Basic attribute getter (used below)
function getAttr(attrs, key) {
  const K = String(key).toUpperCase();
  const arr = attrs || [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a && String(a.key).toUpperCase() === K) return a.value != null ? a.value : '';
  }
  return '';
}

// === Charging helpers (plug type, power, payment) ===
function stationPlugType(station) {
  const outlets = Array.isArray(station?.outlets) ? station.outlets : [];
  for (const o of outlets) {
    const oa = Array.isArray(o?.attributes) ? o.attributes : [];
    const t = (getAttr(oa, 'OUTLET_TYPE') || '').toUpperCase();
    if (t.includes('CCS')) return 'CCS';
  }
  // Default: map unknown/Sonstige to Type 2
  return 'Type 2';
}

function stationMaxPowerKw(station) {
  // Bestimme die stärkste Outlet-Leistung einer Station in kW.
  // Quelle 1: MAX_ELECTRIC_POWER (W) -> kW
  // Quelle 2: OUTLET_TYPE-Suffix …KW (z. B. ARCS_CHARGING_OUTLET_CCS_CABLE_DC_150KW)
  let maxKW = 0;
  const outlets = Array.isArray(station?.outlets) ? station.outlets : [];
  for (const o of outlets) {
    const kw = getOutletPowerKW(o); // nutzt MAX_ELECTRIC_POWER ODER …KW-Suffix
    if (kw != null && kw > maxKW) maxKW = kw;
  }
  return maxKW || null;
}

function stationHasPayment(station, needle /* 'Direct' | 'Contract' */) {
  const attrs = collectAttributes(station);
  const raw = getAttr(attrs, 'PAYMENT_OPTIONS'); // e.g. "Direct\nContract"
  if (!raw) return false;
  const parts = raw.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean);
  return parts.includes(String(needle).toLowerCase());
}

function renderChargingList(list) {
  const tbody = $('#chargeTbody');
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const x = list[i] || {};
    const id = x.id != null ? String(x.id) : '';
    const nm = x.name || x.label || 'Ladestation';
    out.push(
      '<tr>' +
      '<td><a class="id-link" href="#" data-csid="' + id + '">' + id + '</a></td>' +
      '<td>' + nm + '</td>' +
      '</tr>'
    );
  }
  tbody.innerHTML = out.join('');

  $$('#chargeTbody .id-link').forEach((a) => {
    a.addEventListener('click', async function (e) {
      e.preventDefault();
      const id = this.getAttribute('data-csid');
      try {
        const d = await loadChargingStation(id);
        renderChargingDetail(d);
      } catch (err) {
        $('#csRaw').textContent = safeJson({ error: String(err && err.message ? err.message : err) });
      }
    });
  });
}
async function loadChargingAndWire() {
  const all = await loadChargingStations();
  CS_ALL = pickArray(all);

  // initial mit aktuellen Häkchen rendern
  applyChargingFilters();

  const bind = (sel, ev = 'change') => {
    const el = document.querySelector(sel);
    if (el) el.addEventListener(ev, applyChargingFilters);
  };
  bind('#chargeFilter', 'input');

  // Payment
  bind('#csPayDirect');
  bind('#csPayContract');

  // Steckertyp
  bind('#ef-conn-type2');
  bind('#ef-conn-ccs');

  // Leistung
  bind('#ef-pwr-50');
  bind('#ef-pwr-100');
  bind('#ef-pwr-150');
}
// Apply all charging filters (text, payment, connector, power)
function applyChargingFilters() {
  const q = ($('#chargeFilter').value || '').toLowerCase();

  const wantDirect   = $('#csPayDirect')?.checked || false;
  const wantContract = $('#csPayContract')?.checked || false;

  const fType2 = $('#ef-conn-type2')?.checked || false;
  const fCCS   = $('#ef-conn-ccs')?.checked || false;

  const p50  = $('#ef-pwr-50')?.checked || false;
  const p100 = $('#ef-pwr-100')?.checked || false;
  const p150 = $('#ef-pwr-150')?.checked || false;

  let minKw = 0;
  if (p150) minKw = 150; else if (p100) minKw = 100; else if (p50) minKw = 50;

  const rows = CS_ALL.filter(st => {
    // text filter
    if (q) {
      const blob = toLowerJsonStr(st);
      if (blob.indexOf(q) === -1) return false;
    }

    // payment filters
    if (wantDirect && !stationHasPayment(st, 'Direct')) return false;
    if (wantContract && !stationHasPayment(st, 'Contract')) return false;

    // connector filters
    const plug = stationPlugType(st); // 'CCS' | 'Type 2'
    if (fType2 && plug !== 'Type 2') return false;
    if (fCCS && plug !== 'CCS') return false;

    // power filters
    const kw = stationMaxPowerKw(st) || 0;
    if (minKw && kw < minKw) return false;

    return true;
  });

  renderChargingList(rows);
}
function outletAttr(outlet, key) {
  const K = String(key).toUpperCase();
  const arr = outlet?.attributes || [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a && String(a.key).toUpperCase() === K) return a.value != null ? String(a.value) : '';
  }
  return '';
}

function inferPlugTypeFromOutletType(otVal = '') {
  const s = String(otVal).toUpperCase();
  if (s.includes('CCS')) return 'CCS';
  // Sonstige & alles andere => Type 2
  return 'Type 2';
}

function parseKWFromOutletType(otVal = '') {
  const m = String(otVal).match(/(\d+(?:[.,]\d+)?)\s*KW/i);
  if (!m) return null;
  const n = Number(String(m[1]).replace(',', '.'));
  return isNaN(n) ? null : n;
}

function getOutletPowerKW(outlet) {
  // 1) MAX_ELECTRIC_POWER (W) -> kW
  const maxW = outletAttr(outlet, 'MAX_ELECTRIC_POWER');
  if (maxW) {
    const n = Number(String(maxW).replace(',', '.'));
    if (!isNaN(n) && n > 0) return +(n / 1000).toFixed(1);
  }
  // 2) am Ende von OUTLET_TYPE …KW
  const ot = outletAttr(outlet, 'OUTLET_TYPE');
  const kw = parseKWFromOutletType(ot);
  if (kw) return kw;
  return null;
}

function buildOutletsView(detail) {
  const outlets = Array.isArray(detail?.outlets) ? detail.outlets : [];
  return outlets.map((o) => {
    const otVal   = outletAttr(o, 'OUTLET_TYPE');
    const type    = inferPlugTypeFromOutletType(otVal);
    const powerKW = getOutletPowerKW(o);
    return { type, powerKW };
  });
}
function renderChargingDetail(detail) {
  const attrs = collectAttributes(detail);

  $('#csName').textContent    = (detail && (detail.name || detail.label)) || '–';
  $('#csAddress').textContent = extractAddressFromAttributes(detail) || (detail && detail.addressLine) || '–';

  const pay  = splitLines(getAttr(attrs, 'PAYMENT_OPTIONS'));
  chips($('#csPay'),  pay);

  $('#csAccess').textContent = getAttr(attrs, 'ACCESSIBILITY') || '–';


  // ---- Outlets (Steckertyp & Leistung je Outlet) ----
  const views = buildOutletsView(detail);

  // Steckertyp (unique)
  const typesUnique = Array.from(new Set(views.map(v => v.type))).filter(Boolean);
  $('#csPlugType').textContent = typesUnique.length ? typesUnique.join(', ') : '–';

  // Leistung (alle Outlets, Zeile je EVSE)
  if (views.length) {
    const lines = views.map(v => {
      const p = (v.powerKW != null) ? (v.powerKW + ' kW') : '–';
      return `${p} (${v.type})`;
    });
    $('#csPower').innerHTML = lines.join('<br>');
  } else {
    $('#csPower').textContent = '–';
  }

  $('#csRaw').textContent = safeJson(detail);
}
// ---------- Boot ----------
async function reloadFacilities() {
  const data = await loadFacilities();
  const all = pickArray(data);

  // Nur Typ/Definition 14
  FAC_ALL = all.filter(f => ALLOWED_FAC_DEFS.has(String(f?.definitionId)));

  filterFacilities();
}
function setModeUI(mode) {
  const m = mode || ($('#modeSelect')?.value || 'parkhaus');
  // Nur die Filter-Sektionen umschalten
  $('#pfContainer').style.display = (m === 'parkhaus') ? 'grid' : 'none';
  $('#efContainer').style.display = (m === 'eladen')   ? 'grid' : 'none';
}

function resetFilters(mode) {
  const m = mode || ($('#modeSelect')?.value || 'parkhaus');
  const box = (m === 'eladen') ? $('#efContainer') : $('#pfContainer');
  if (!box) return;
  box.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  if (m === 'eladen') {
    const cf = $('#chargeFilter'); if (cf) cf.value = '';
  } else {
    const ft = $('#filterText'); if (ft) ft.value = '';
  }
}
function findTotalCounter(occJson) {
  const counters = (occJson && Array.isArray(occJson.counters)) ? occJson.counters : [];
  if (!counters.length) return null;

  // robuste Erkennung „total“
  return counters.find(c => {
    const key   = (c.key || c.name || '').toString().toLowerCase();
    const nId   = (c.nativeId && (c.nativeId.value || c.nativeId.id) || '').toString().toLowerCase();
    const ctype = (c.counterType && (c.counterType.type || '') || '').toString().toLowerCase();
    const label = (Array.isArray(c.counterType?.translations) ? (c.counterType.translations[0]?.value || '') : '').toString().toLowerCase();

    return key === 'total' || nId === 'total' || ctype === 'total' || label === 'total';
  }) || null;
}

function formatOccFromTotalRow(totalRow) {
  if (!totalRow) return '–';
  const max = (typeof totalRow.maxPlaces === 'number') ? totalRow.maxPlaces : null;
  const occ = (typeof totalRow.occupiedPlaces === 'number') ? totalRow.occupiedPlaces : null;
  const free = (typeof totalRow.freePlaces === 'number') ? totalRow.freePlaces : (max != null && occ != null ? (max - occ) : null);

  // Status: nimm, wenn vorhanden; sonst heuristisch aus Verhältnis
  let status = (totalRow.status || '').toString().toLowerCase();
  if (!status && max && (occ != null)) {
    const ratio = occ / max;
    status = (ratio <= 0.60) ? 'free' : (ratio <= 0.90 ? 'tight' : 'full');
  }
  const statusDe = status === 'free' ? 'frei' : status === 'tight' ? 'angespannt' : status === 'full' ? 'voll' : 'unbekannt';

  const parts = [];
  parts.push(statusDe);
  if (occ != null && max != null) parts.push(`${occ}/${max} belegt`);
  if (free != null) parts.push(`${free} frei`);
  return parts.join(' · ');
}
function applyTopFilters() {
  const m = ($('#modeSelect')?.value || 'parkhaus');
  if (m === 'eladen') {
    // rechts: E-Ladestationen filtern
    applyChargingFilters();
  } else {
    // links: Parkhäuser filtern (wir nutzen deinen Volltext-/Definition-Filter)
    filterFacilities();
  }
}
async function boot() {
  try {
    const defs = await loadFacilityDefinitions().catch(function () { return []; });
    const sel = $('#definitionId');
    let options = '<option value="">– alle –</option>';
    const list = pickArray(defs);
    for (let i = 0; i < list.length; i++) {
      const d = list[i] || {};
      const id = (d.id != null ? d.id : d.definitionId);
      const name = d.name || d.label || ('Definition ' + id);
      options += '<option value="' + String(id) + '">' + String(id) + ' – ' + String(name) + '</option>';
    }
    sel.innerHTML = options;
  } catch (e) {}

  await reloadFacilities();

  // Events Parkhäuser
  $('#btnLoadFacilities').addEventListener('click', reloadFacilities);
  $('#filterText').addEventListener('input', filterFacilities);
  $('#definitionId').addEventListener('change', filterFacilities);

  // Mode-Schalter
  $('#modeSelect').addEventListener('change', () => {
    setModeUI();
    applyTopFilters();
  });
  setModeUI();

  // Globale Filterknöpfe
  $('#btnApplyFilters').addEventListener('click', applyTopFilters);
  $('#btnResetFilters').addEventListener('click', () => {
    resetFilters();
    applyTopFilters();
  });

  // 🔹 Ladestationen: initial laden & verdrahten
  try {
    await loadChargingAndWire();
  } catch (e) {
    $('#csRaw').textContent = safeJson({ error: String(e && e.message ? e.message : e) });
  }

  // Button bleibt als „manuell neu laden“
  $('#btnLoadCharging').addEventListener('click', async function () {
    try { await loadChargingAndWire(); }
    catch (e) { $('#csRaw').textContent = safeJson({ error: String(e && e.message ? e.message : e) }); }
  });
}

window.addEventListener('DOMContentLoaded', boot);