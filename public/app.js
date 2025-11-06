// ===== Helpers =====
const $ = (id) => document.getElementById(id);

function pickArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const keys = ['items','results','content','data','list','facilities','features','filecontent','occupancies','counters','attributes','methods','devices','status','deviceStatus','contactData','contacts','outlets'];
  for (const k of keys) if (Array.isArray(json[k])) return json[k];
  const first = Object.values(json).find(Array.isArray);
  return Array.isArray(first) ? first : [];
}
function safeLower(s){ try{return String(s).toLowerCase()}catch{return''} }
function matches(obj, needle){
  const n = safeLower(needle);
  if(!n) return true;
  try { return JSON.stringify(obj).toLowerCase().includes(n); }
  catch { return true; }
}
function fmtAddress(f) {
  const street = f?.address?.street || f?.postalAddress?.street;
  const house  = f?.address?.houseNo;
  const zip    = f?.address?.zip || f?.postalAddress?.zip;
  const city   = f?.address?.city || f?.postalAddress?.city;
  const line1 = [street, house].filter(Boolean).join(' ').trim();
  const line2 = [zip, city].filter(Boolean).join(' ').trim();
  return [line1, line2].filter(Boolean).join(', ');
}
function combinedStatusFromOccupancy(occ) {
  if (!occ) return 'unknown';
  const arr = Array.isArray(occ) ? occ : pickArray(occ);
  const rank = { full:3, tight:2, free:1, unknown:0 };
  let best = 'unknown';
  for (const c of arr) {
    const s = String(c.status || c.counterStatus || '').toLowerCase();
    if (rank[s] > rank[best]) best = s;
  }
  if (best !== 'unknown') return best;
  let max=0, free=0;
  for (const c of arr) {
    if (typeof c.maxPlaces === 'number') max += c.maxPlaces;
    if (typeof c.freePlaces === 'number') free += c.freePlaces;
  }
  if (max<=0) return 'unknown';
  const ratio = (max-free)/max;
  if (ratio <= 0.60) return 'free';
  if (ratio <= 0.90) return 'tight';
  return 'full';
}
function clsForStatus(s){ return s==='free'?'badge status-free':s==='tight'?'badge status-tight':s==='full'?'badge status-full':'badge'; }
function renderBadges(el, list){ el.innerHTML = (list||[]).map(b=>`<span class="badge">${b}</span>`).join(''); }
function mapPaymentBadges(features=[]){
  const keys = features.map(x => (x.key||x.type||x.name||'').toString().toLowerCase());
  const out=[];
  if(keys.includes('payment_cash')) out.push('Bar');
  if(keys.includes('payment_ec')||keys.includes('payment_girocard')) out.push('EC');
  if(keys.includes('payment_visa')) out.push('VISA');
  if(keys.includes('payment_mastercard')) out.push('Mastercard');
  if(keys.includes('payment_easypark')) out.push('EasyPark');
  if(keys.includes('payment_paybyphone')) out.push('PayByPhone');
  return out;
}
function mapFeatureBadges(features=[]){
  const keys = features.map(x => (x.key||x.type||x.name||'').toString().toLowerCase());
  const out=[];
  if(keys.includes('elevator')) out.push('Aufzug');
  if(keys.includes('video_surveillance')) out.push('Videoüberwachung');
  if(keys.includes('disabled_parking_spaces')) out.push('Behindertenparkplätze');
  if(keys.includes('bicycle')) out.push('Fahrradstellplätze');
  if(keys.includes('roofed')||keys.includes('indoor')) out.push('Überdacht');
  if(keys.includes('guidance_system')) out.push('Leitsystem');
  return out;
}
function kv(container, entries){ container.innerHTML = entries.filter(([,v]) => v!=null && v!=='').map(([k,v]) => `<div>${k}</div><div>${v}</div>`).join(''); }

// ===== Preis-Helfer =====
// generischer Attribut-Lookup (Facilities/Charging)
function getAttr(attributes=[], keys=[]){
  if(!Array.isArray(attributes)) return null;
  const lowerKeys = keys.map(k=>k.toLowerCase());
  let hit = attributes.find(a => lowerKeys.includes(String(a?.key||a?.name).toLowerCase()));
  if (hit && (hit.value!=null && hit.value!=="")) return hit.value;
  // manchmal als {key, values:[{value,label}]}
  if (hit && Array.isArray(hit.values) && hit.values.length) return hit.values.map(v=>v.value ?? v.label ?? '').filter(Boolean).join(' / ');
  // als map in attributes?
  const obj = Object.fromEntries(attributes.map(a=>[String(a?.key||a?.name).toLowerCase(), a?.value ?? a?.values]));
  for (const k of lowerKeys) if (obj[k]!=null) return obj[k];
  return null;
}
// string format
const euro = (v) => {
  if (v == null || v === '') return '';
  const s = String(v).toString().replace('.', ',');
  return s.includes('€') ? s : s + ' €';
};
// Preise Parken (Facilities)
function extractParkingPrices(detail){
  const attrs = detail.attributes || [];
  const hourly = getAttr(attrs, ['hourly','price_hour','rate_hour','hour_price','pro_stunde']);
  const dayMax = getAttr(attrs, ['dayMax','price_day_max','rate_day_max','tageshöchstsatz','day_max']);
  const monthly = getAttr(attrs, ['monthlyLongTerm','long_term_monthly','dauerparkplatz_monat','monthly']);
  // häufig sind values schon formatiert (z. B. "1,50 €")
  return {
    hourly: hourly || detail.hourly || null,
    dayMax: dayMax || detail.dayMax || null,
    monthly: monthly || detail.monthly || null,
  };
}

// Preise Laden (Charging)
function extractChargingPrices(detail){
  const attrs = detail.attributes || [];
  const perKwh = getAttr(attrs, ['pricePerKwh','price_per_kwh','kwh_price','preis_kwh']);
  const sessionFee = getAttr(attrs, ['sessionFee','startFee','startgebühr','session_fee']);
  const parkingWhileCharging = getAttr(attrs, ['parkingFeeWhileCharging','parking_fee_while_charging','parkentgelt_während_laden']);
  const minPrice = getAttr(attrs, ['minPrice','minimum_price','mindespreis','min_preis']);
  return { perKwh, sessionFee, parkingWhileCharging, minPrice };
}

// ===== Facility LIST =====
const facDefSel = $('facDef');
const facQuery  = $('facQuery');
const facTableBody = document.querySelector('#facTable tbody');
const facListCount = $('facListCount');

async function hydrateDefinitionsSelect() {
  try {
    const res = await fetch('/api/facility-definitions');
    const arr = pickArray(await res.json());
    facDefSel.innerHTML = `<option value="">– alle –</option>` + arr.map(d=>{
      const id = d?.id ?? d?.definitionId;
      const name = d?.name || d?.label || id || '';
      return `<option value="${String(id)}">${id} — ${name}</option>`;
    }).join('');
  } catch {}
}

async function loadFacilityList() {
  const params = new URLSearchParams();
  if (facDefSel.value) params.set('definitionId', facDefSel.value);
  const url = '/api/facilities' + (params.toString()?`?${params}`:'');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Facilities: HTTP ${res.status}`);
  let arr = pickArray(await res.json());
  const needle = (facQuery.value||'').trim();
  if (needle) arr = arr.filter(x=>matches(x, needle));
  facListCount.textContent = String(arr.length);

  facTableBody.innerHTML = arr.map(f=>{
    const id = f?.id || f?.facilityId;
    const name = f?.name || f?.label || '';
    const def = (f?.definitionId!=null)? f.definitionId : '–';
    const city = f?.address?.city || f?.city || '';
    return `<tr>
      <td><a class="rowlink" data-id="${String(id)}">${String(id)}</a></td>
      <td>${name}</td>
      <td>${def}</td>
      <td>${city}</td>
    </tr>`;
  }).join('');

  facTableBody.querySelectorAll('a.rowlink').forEach(a=>{
    a.addEventListener('click', (e)=>{
      e.preventDefault();
      const id = a.getAttribute('data-id');
      $('facilityId').value = id;
      document.getElementById('btnFacility').click();
    });
  });
}

$('btnFacList').onclick = async ()=>{
  try { await loadFacilityList(); } catch(e){ console.error(e); facTableBody.innerHTML = `<tr><td colspan="4">Fehler: ${e.message}</td></tr>`; }
};

// ===== Facility DETAILS =====
function renderFacility(detail) {
  const status = combinedStatusFromOccupancy(detail.facilityOccupancies);
  const payBadges = mapPaymentBadges(detail.features || []);
  const featBadges = mapFeatureBadges(detail.features || []);
  const prices = extractParkingPrices(detail);

  const priceLine = [
    prices.hourly ? `pro Stunde: ${prices.hourly}` : '',
    prices.dayMax ? `Tageshöchstsatz: ${prices.dayMax}` : '',
    prices.monthly ? `Dauerparken/Monat: ${prices.monthly}` : ''
  ].filter(Boolean).join(' · ');

  kv(document.getElementById('facRendered'), [
    ['Name', detail.name || '–'],
    ['Adresse', fmtAddress(detail)],
    ['Tarife', priceLine || '–'],
    ['Einfahrtshöhe', detail.clearanceMeters ? `${detail.clearanceMeters.toFixed(2).replace('.',',')} m` :
      (detail.heightLimitCm ? `${(detail.heightLimitCm/100).toFixed(2).replace('.',',')} m` : '–')],
    ['Gesamtplätze', (detail.capacityTotal ?? detail.totalCapacity ?? '–')],
    ['Belegung', `<span class="${clsForStatus(status)}">${status}</span>`],
  ]);
  renderBadges(document.getElementById('facBadges'), [...payBadges, ...featBadges]);
  document.getElementById('facJson').textContent = JSON.stringify(detail, null, 2);
  document.getElementById('facCount').textContent = '1';
}

async function loadFacilityDetailObject(id, extras = []) {
  const baseRes = await fetch(`/api/facilities/${encodeURIComponent(id)}`);
  if (!baseRes.ok) throw new Error(`Facility ${id}: HTTP ${baseRes.status}`);
  const facility = await baseRes.json();

  const wants = new Set(extras);
  const promises = [];

  if (wants.has('facilityOccupancies')) {
    promises.push(fetch(`/api/occupancies?facilityId=${encodeURIComponent(id)}`).then(r=>r.ok?r.json():[]).then(d=>['facilityOccupancies', d]));
  }
  if (wants.has('features')) {
    promises.push(fetch(`/api/features?facilityId=${encodeURIComponent(id)}`).then(r=>r.ok?r.json():[]).then(d=>['features', d]));
  }
  ['contactData','methods','fileAttachments','facilityStatus','deviceStatus','attributes'].forEach(kind=>{
    if (wants.has(kind) || kind==='attributes') { // attributes oft nötig für Tarife
      promises.push(fetch(`/api/embed/${encodeURIComponent(kind)}?facilityId=${encodeURIComponent(id)}`).then(r=>r.ok?r.json():[]).then(d=>[kind, d]));
    }
  });

  const extraObj = Object.fromEntries(await Promise.all(promises));
  // tarife brauchen attributes → im Detailobjekt verfügbar halten
  return { ...facility, ...extraObj };
}

document.getElementById('btnFacility').onclick = async ()=>{
  const id = (document.getElementById('facilityId').value||'').trim();
  if (!id) { document.getElementById('facJson').textContent = JSON.stringify({error:'Bitte eine Standort-ID eingeben.'},null,2); return; }
  const extras = [...document.querySelectorAll('.fac-extra:checked')].map(i=>i.value);
  // für Preise: attributes sicherstellen, auch wenn nicht angehakt
  if (!extras.includes('attributes')) extras.push('attributes');

  document.getElementById('facJson').textContent = 'Lade …';
  try {
    const detail = await loadFacilityDetailObject(id, extras);
    renderFacility(detail);
  } catch(e){
    document.getElementById('facJson').textContent = JSON.stringify({error:String(e?.message||e)},null,2);
    document.getElementById('facRendered').innerHTML = '';
    document.getElementById('facBadges').innerHTML = '';
    document.getElementById('facCount').textContent = '0';
  }
};

// ===== Charging LIST =====
const chgQuery = $('chgQuery');
const chgTableBody = document.querySelector('#chgTable tbody');
const chgListCount = $('chgListCount');

async function loadChargingList() {
  const params = new URLSearchParams();
  const locale = $('chgLocale').value || 'de-DE';
  params.set('locale', locale);
  const url = '/api/charging-stations' + `?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Charging list: HTTP ${res.status}`);
  let arr = pickArray(await res.json());
  const needle = (chgQuery.value||'').trim();
  if (needle) arr = arr.filter(x=>matches(x, needle));
  chgListCount.textContent = String(arr.length);

  chgTableBody.innerHTML = arr.map(s=>{
    const id = s?.id;
    const name = s?.name || '';
    const addr = fmtAddress(s);
    const plugs = Array.isArray(s?.outlets) ? s.outlets.map(o=>o.type).filter(Boolean).join(', ') : '';
    return `<tr>
      <td><a class="rowlink" data-id="${String(id)}">${String(id)}</a></td>
      <td>${name}</td>
      <td>${addr}</td>
      <td>${plugs}</td>
    </tr>`;
  }).join('');

  chgTableBody.querySelectorAll('a.rowlink').forEach(a=>{
    a.addEventListener('click',(e)=>{
      e.preventDefault();
      const id = a.getAttribute('data-id');
      $('chargeId').value = id;
      document.getElementById('btnCharge').click();
    });
  });
}

$('btnChgList').onclick = async ()=>{
  try { await loadChargingList(); } catch(e){ console.error(e); chgTableBody.innerHTML = `<tr><td colspan="4">Fehler: ${e.message}</td></tr>`; }
};

// ===== Charging DETAILS =====
function renderCharging(detail) {
  const outletInfo = Array.isArray(detail.outlets) && detail.outlets.length
    ? detail.outlets.map(o => `${o.type||'Outlet'}${o.powerKw?` (${o.powerKw} kW)`:''}`).join(', ')
    : '–';
  const featBadges = (detail.features||[]).map(f=>f.name||f.key).filter(Boolean);
  const prices = extractChargingPrices(detail);

  const priceLine = [
    prices.perKwh ? `pro kWh: ${prices.perKwh}` : '',
    prices.sessionFee ? `Startgebühr: ${prices.sessionFee}` : '',
    prices.parkingWhileCharging ? `Parkentgelt: ${prices.parkingWhileCharging}` : '',
    prices.minPrice ? `Mindestpreis: ${prices.minPrice}` : ''
  ].filter(Boolean).join(' · ');

  kv(document.getElementById('chgRendered'), [
    ['Name', detail.name || '–'],
    ['Adresse', fmtAddress(detail)],
    ['Ladepreise', priceLine || '–'],
    ['Steckertypen', outletInfo],
    ['Öffnungszeiten', Array.isArray(detail.openingHours)&&detail.openingHours.length ? 'siehe Daten' : '–'],
    ['Kontakt', Array.isArray(detail.contactData)&&detail.contactData.length ? 'vorhanden' : '–'],
  ]);
  renderBadges(document.getElementById('chgBadges'), featBadges);
  document.getElementById('chgJson').textContent = JSON.stringify(detail, null, 2);
  document.getElementById('chgCount').textContent = '1';
}

async function loadChargingDetailObject(id, locale='de-DE') {
  const res = await fetch(`/api/charging-stations/${encodeURIComponent(id)}?locale=${encodeURIComponent(locale)}`);
  if (!res.ok) throw new Error(`Charging ${id}: HTTP ${res.status}`);
  return res.json();
}

document.getElementById('btnCharge').onclick = async ()=>{
  const id = (document.getElementById('chargeId').value||'').trim();
  const loc = (document.getElementById('chargeLocale').value||'de-DE');
  if(!id){ document.getElementById('chgJson').textContent = JSON.stringify({error:'Bitte eine Ladepunkt-ID eingeben.'},null,2); return; }
  document.getElementById('chgJson').textContent = 'Lade …';
  try {
    const detail = await loadChargingDetailObject(id, loc);
    renderCharging(detail);
  } catch(e){
    document.getElementById('chgJson').textContent = JSON.stringify({error:String(e?.message||e)},null,2);
    document.getElementById('chgRendered').innerHTML = '';
    document.getElementById('chgBadges').innerHTML = '';
    document.getElementById('chgCount').textContent = '0';
  }
};

// ===== Init =====
(async function init(){
  await hydrateDefinitionsSelect();
})();
