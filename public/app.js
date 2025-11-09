// public/app.js

// ---------- Mini-Helpers ----------
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function safeJson(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function toLowerJsonStr(x) { try { return JSON.stringify(x).toLowerCase(); } catch { return ''; } }
function splitLines(v) { return String(v || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }

const euro = (v) => {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (s.includes('€')) return s;
  // einfache Deutsch-Formatierung für Komma
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

  // Aus Features mit type === PAYMENT
  if (detail && Array.isArray(detail.features)) {
    for (let i = 0; i < detail.features.length; i++) {
      const f = detail.features[i];
      if (!f) continue;
      if (String(f.type || '').toUpperCase() === 'PAYMENT' && f.name) {
        namesSet[f.name] = true;
      }
    }
  }

  // Aus Attributes anhand Keys
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

// iPCM liefert je nach System ein Array oder ein einzelnes Objekt.
// Wir normalisieren auf ein Objekt der gewünschten facilityId.
function normalizeOccForFacility(res, facId) {
  if (!res) return null;
  const fid = String(facId);

  // iPCM liefert teils ein Array auf Top-Level
  if (Array.isArray(res)) {
    const match = res.find(x => String(x?.facilityId) === fid);
    if (match) return match;
    if (res.length === 1 && res[0]?.counters) return res[0];
    return null;
    // (falls du mehrere Einträge pro Facility hast, kannst du hier auch mergen)
  }

  // Einzelobjekt?
  if (String(res.facilityId || '') === fid) return res;

  // Container-Varianten abdecken
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

  // Fallback über Summierung
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

// Summenzeile „von / belegt / frei / (reserviert max / ohne Res. max)“
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
// Charging (unverändert):
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
  $('#viewOccupancy').style.display = (tab === 'occ')      ? '' : 'none';
  $('#viewRaw').style.display       = (tab === 'raw')      ? '' : 'none';
}
$('#tabOverview').addEventListener('click', function () { setOverviewTab('overview'); });
$('#tabOccupancy').addEventListener('click', function () { setOverviewTab('occ'); });
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
  try {
    // 1) Stammdaten (iPAW)
    const detail = await loadFacility(id);

    // 2) REST: Occupancies + Devices nur für diese Facility
    const occPromise = loadOccupanciesForFacility(id).catch(() => null);
    const devPromise = loadDevicesForFacility(id).catch(() => null);

    const occRaw     = await occPromise;

// Robust: iPCM liefert teils ein Array – sicher auf das Objekt der Facility mappen
    let occJson = normalizeOccForFacility(occRaw, id);
    if (!occJson && Array.isArray(occRaw)) {
      occJson = occRaw.find(x => String(x?.facilityId) === String(id)) || null;
    }

    const devicesRaw = await devPromise;


    CURRENT_FAC = detail;

    // Übersicht
    $('#facName').textContent      = (detail && detail.name) || '–';
    $('#facAddress').textContent   = extractAddressFromAttributes(detail) || '–';
    $('#facClearance').textContent = extractClearance(detail) || '–';
    $('#facCapacity').textContent  = extractCapacity(detail) || '–';
    $('#facRates').textContent     = extractRates(detail) || '–';

    const devices = pickArray(devicesRaw);
    chips($('#facFeatures'), extractFeatures(detail, devices));
    chips($('#facPayments'), extractPayments(detail));

    // Belegung
    // Belegung: Header + Tabelle rendern + Tab sichtbar machen
    $('#occFacId').textContent = String(id);

    const combined = occJson ? combinedStatusFromRest(occJson) : 'unknown';
    const sum = summarizeCounters(occJson ? occJson.counters : []);
    $('#occCombined').textContent =
      `${combined} · ${sum.occ}/${sum.max} belegt · ${sum.free} frei` +
      (sum.resOnlyMax ? ` · reserviert (max): ${sum.resOnlyMax}` : '') +
      (sum.noResMax  ? ` · ohne Reservierung (max): ${sum.noResMax}` : '');

    renderOccupancyTableFromRest(occJson || { counters: [] });

// Für die Fehlersuche erstmal den Tab „Belegung“ aktivieren
    if (occJson?.counters?.length > 0) setOverviewTab('occ');

    // Rohdaten (Facility)
    $('#facRaw').textContent = safeJson(detail);

    setOverviewTab('overview');
  } catch (e) {
    CURRENT_FAC = null;
    $('#facName').textContent = 'Fehler';
    $('#facRaw').textContent  = safeJson({ error: String(e && e.message ? e.message : e) });
    $('#occTable').innerHTML  = '<tr><td colspan="6">–</td></tr>';
  }
}

// ---------- E-Ladestationen ----------
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

function getAttr(attrs, key) {
  const K = String(key).toUpperCase();
  const arr = attrs || [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a && String(a.key).toUpperCase() === K) return a.value != null ? a.value : '';
  }
  return '';
}

function renderChargingDetail(detail) {
  const attrs = collectAttributes(detail);

  $('#csName').textContent    = (detail && (detail.name || detail.label)) || '–';
  $('#csAddress').textContent = extractAddressFromAttributes(detail) || (detail && detail.addressLine) || '–';

  const renewable = boolFromString(getAttr(attrs, 'RENEWABLE_ENERGY'));
  $('#csRenewable').textContent = renewable === null ? '–' : (renewable ? 'Ja' : 'Nein');

  const dyn = boolFromString(getAttr(attrs, 'DYNAMIC_POWER_LEVEL'));
  $('#csDynPower').textContent = dyn === null ? '–' : (dyn ? 'Ja' : 'Nein');

  const auth = splitLines(getAttr(attrs, 'AUTHENTICATION_MODES'));
  const pay  = splitLines(getAttr(attrs, 'PAYMENT_OPTIONS'));
  chips($('#csAuth'), auth);
  chips($('#csPay'),  pay);

  $('#csAccess').textContent = getAttr(attrs, 'ACCESSIBILITY') || '–';
  $('#csCalLaw').textContent = getAttr(attrs, 'CALIBRATION_LAW_DATA_AVAILABILITY') || '–';
  $('#csDev').textContent    = getAttr(attrs, 'DEVICE_ID') || '–';

  $('#csRaw').textContent = safeJson(detail);
}

// ---------- Boot ----------
async function reloadFacilities() {
  const data = await loadFacilities();
  FAC_ALL = pickArray(data);
  filterFacilities();
}

async function boot() {
  // Definitionen ins Select
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
  } catch (e) {
    // still ok
  }

  await reloadFacilities();

  // Events
  $('#btnLoadFacilities').addEventListener('click', reloadFacilities);
  $('#filterText').addEventListener('input', filterFacilities);
  $('#definitionId').addEventListener('change', filterFacilities);

  // Charging
  $('#btnLoadCharging').addEventListener('click', async function () {
    try {
      const all = await loadChargingStations();
      CS_ALL = pickArray(all);
      renderChargingList(CS_ALL);

      $('#chargeFilter').addEventListener('input', function () {
        const q = ( $('#chargeFilter').value || '' ).toLowerCase();
        const rows = CS_ALL.filter((x) => toLowerJsonStr(x).indexOf(q) !== -1);
        renderChargingList(rows);
      });
    } catch (e) {
      $('#csRaw').textContent = safeJson({ error: String(e && e.message ? e.message : e) });
    }
  });
}

window.addEventListener('DOMContentLoaded', boot);