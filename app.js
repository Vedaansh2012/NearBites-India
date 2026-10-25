const $ = s => document.querySelector(s);
const DATA_PATH = 'data/swiggy_file.csv.gz';
let dataset = null, dsError = null, last = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const num = v => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n; };
const km = m => m < 1000 ? [Math.round(m), 'm'] : [(m / 1000).toFixed(1), 'km'];

function haversine(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/* ---------- Dataset ---------- */
async function loadDataset() {
  try {
    const r = await fetch(DATA_PATH);
    if (!r.ok) throw new Error('The server answered HTTP ' + r.status + ' for ' + DATA_PATH);
    const buf = new Uint8Array(await r.arrayBuffer());
    // Real gzip files start with bytes 1f 8b. If a server already decompressed it, parse as-is.
    const bytes = (buf[0] === 0x1f && buf[1] === 0x8b) ? fflate.gunzipSync(buf) : buf;
    const text = new TextDecoder().decode(bytes);
    if (text.trimStart().startsWith('<')) throw new Error('Received a web page instead of CSV data.');
    const p = Papa.parse(text, { header: true, skipEmptyLines: true });
    const get = (row, ...keys) => { for (const k in row) if (keys.includes(norm(k))) return row[k]; return ''; };
    dataset = p.data.map(row => {
      const veg = norm(get(row, 'pureveg'));
      return {
        name: get(row, 'restaurantname', 'name').trim(),
        cuisine: get(row, 'cuisine', 'cuisines').trim(),
        rating: num(get(row, 'rating')),
        ratings: get(row, 'numberofratings', 'ratings').trim(),
        price: num(get(row, 'averageprice', 'price')),
        offerCount: num(get(row, 'numberofoffers')),
        offer: get(row, 'offername').trim(),
        area: get(row, 'area').trim(),
        location: get(row, 'location', 'city').trim(),
        pureVeg: veg === '' ? null : ['1', 'true', 'yes', 'y', 'pureveg'].includes(veg)
      };
    }).filter(r => r.name);
    if (!dataset.length) throw new Error('The file loaded but no rows with a restaurant name were found. Check the column headers.');
  } catch (e) {
    dsError = e.message;
  }
}

function datasetErrorHtml() {
  return `<div class="note"><b>Saved dataset not loaded.</b> ${esc(dsError)}<br>
  Expected file: <code>${DATA_PATH}</code> (in the <code>data</code> folder at the top level of your GitHub repo).<br>
  Check: (1) the file name is exactly <code>swiggy_file.csv.gz</code>, (2) it is inside <code>data/</code>, not another folder, (3) Netlify finished redeploying after your upload, (4) the file opens as a CSV when unzipped on your computer.<br>
  Live nearby search still works without it.</div>`;
}

/* ---------- Geocoding and live places (with simple caching) ---------- */
const cacheGet = k => { try { const o = JSON.parse(localStorage.getItem(k)); if (o && Date.now() - o.t < 6e5) return o.v; } catch (_) {} return null; };
const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), v })); } catch (_) {} };

async function geocode(f) {
  const q = [f.landmark, f.road, f.city, f.state, f.country].filter(Boolean).join(', ');
  const key = 'geo:' + q.toLowerCase();
  let hit = cacheGet(key);
  if (!hit) {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q));
    if (!r.ok) throw new Error('The location service (Nominatim) returned HTTP ' + r.status + '.');
    const j = await r.json();
    if (!j.length) return { q, none: true };
    hit = { lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name };
    cacheSet(key, hit);
  }
  return { q, ...hit };
}

async function overpass(lat, lon, rad) {
  const key = `ov:${lat.toFixed(4)},${lon.toFixed(4)},${rad}`;
  let els = cacheGet(key);
  if (!els) {
    const a = `(around:${rad},${lat},${lon})`;
    const ql = `[out:json][timeout:25];(nwr["amenity"~"^(restaurant|cafe|fast_food|ice_cream|food_court)$"]${a};nwr["shop"~"^(bakery|confectionery|pastry)$"]${a};);out center tags 400;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(ql), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!r.ok) throw new Error('The places service (Overpass) returned HTTP ' + r.status + '. It may be busy.');
    els = (await r.json()).elements;
    cacheSet(key, els);
  }
  return els;
}

function toPlace(e, lat, lon) {
  const t = e.tags || {}, pl = e.center || e;
  if (!t.name || pl.lat == null) return null;
  const kind = t.amenity || t.shop;
  const category = kind === 'cafe' ? 'Café' : ['bakery', 'ice_cream', 'confectionery', 'pastry'].includes(kind) ? 'Bakery & dessert' : 'Restaurant';
  const suburb = t['addr:suburb'] || t['addr:neighbourhood'] || '';
  const addr = [t['addr:housenumber'], t['addr:street'], suburb, t['addr:city']].filter(Boolean).join(', ');
  const diet = t['diet:vegetarian'];
  return {
    live: true, name: t.name, category, addr, suburb,
    cuisine: (t.cuisine || '').replace(/;/g, ', ').replace(/_/g, ' '),
    hours: t.opening_hours || '',
    dist: haversine(lat, lon, pl.lat, pl.lon),
    pureVeg: diet === 'only' ? true : null, vegOptions: diet === 'yes',
    ds: null
  };
}

/* ---------- Confident matching: same name + same city + same area text ---------- */
function matchDataset(p, city) {
  if (!dataset) return null;
  const n = norm(p.name), c = norm(city), where = norm(p.addr);
  const cands = dataset.filter(r => norm(r.name) === n && norm(r.location) && (norm(r.location).includes(c) || c.includes(norm(r.location))) &&
    norm(r.area) && where.includes(norm(r.area)));
  return cands.length === 1 ? cands[0] : null;
}

/* ---------- Filters, sorting ---------- */
function readFilters() {
  return { q: $('#q').value.trim().toLowerCase(), cuisine: $('#cuisine').value.trim().toLowerCase(), cat: $('#cat').value,
    minr: num($('#minr').value), maxp: num($('#maxp').value), veg: $('#veg').checked, offers: $('#offers').checked };
}
const rating = p => p.ds ? p.ds.rating : p.rating ?? null;
const price = p => p.ds ? p.ds.price : p.price ?? null;
const isVeg = p => p.pureVeg === true || (p.ds && p.ds.pureVeg === true);
const hasOffer = p => { const d = p.ds || p; return (d.offerCount || 0) > 0 || !!d.offer; };
const cuisineOf = p => (p.cuisine || (p.ds && p.ds.cuisine) || '');

function passes(p, f, hidden) {
  if (f.cat !== 'all' && p.live && p.category !== f.cat) return false;
  if (f.q && !(p.name + ' ' + cuisineOf(p) + ' ' + (p.addr || p.area || '')).toLowerCase().includes(f.q)) return false;
  if (f.cuisine && !cuisineOf(p).toLowerCase().includes(f.cuisine)) { if (cuisineOf(p)) return false; hidden.cuisine++; return false; }
  if (f.minr != null && (rating(p) == null || rating(p) < f.minr)) { if (rating(p) == null) hidden.rating++; return false; }
  if (f.maxp != null && (price(p) == null || price(p) > f.maxp)) { if (price(p) == null) hidden.price++; return false; }
  if (f.veg && !isVeg(p)) return false;
  if (f.offers && !hasOffer(p)) return false;
  return true;
}

function score(p, rad) {
  const parts = [];
  if (p.dist != null) parts.push([0.5, 1 - Math.min(p.dist / rad, 1)]);
  if (rating(p) != null) parts.push([0.4, rating(p) / 5]);
  parts.push([0.1, ([p.cuisine || (p.ds && p.ds.cuisine), p.addr || p.area, rating(p), price(p)].filter(v => v).length) / 4]);
  const w = parts.reduce((s, x) => s + x[0], 0);
  return parts.reduce((s, x) => s + x[0] * x[1], 0) / w;
}

function sorter(mode, rad) {
  const nz = (a, b) => (a == null) - (b == null);
  return {
    best: (a, b) => score(b, rad) - score(a, rad),
    near: (a, b) => (a.dist ?? 1e12) - (b.dist ?? 1e12),
    rating: (a, b) => nz(rating(a), rating(b)) || rating(b) - rating(a),
    price: (a, b) => nz(price(a), price(b)) || price(a) - price(b)
  }[mode];
}

/* ---------- Rendering ---------- */
function card(p) {
  const d = p.live ? p.ds : p, r = rating(p), pr = price(p), cu = cuisineOf(p);
  const [dv, du] = p.dist != null ? km(p.dist) : [null, null];
  const na = '<span class="na">Not available</span>';
  const left = dv != null ? `<div class="dist">${dv}<small>${du} away</small></div>` : `<div class="dist" style="font-size:1rem">Distance<small>not available</small></div>`;
  const offer = d && (d.offer || d.offerCount) ? esc(d.offer || (d.offerCount + ' offer(s)')) : null;
  const vegTxt = isVeg(p) ? 'Pure vegetarian' : (p.vegOptions ? 'Has vegetarian options' : (d && d.pureVeg === false ? 'Not pure vegetarian' : null));
  const src = p.live
    ? 'Live place data from OpenStreetMap' + (p.ds ? '. Ratings, price and offers come from the saved dataset (matched by name, city and area) and may be outdated.' : '. No matching dataset record.')
    : 'Saved dataset only. Location not verified, so no distance is shown. Rating, price and offers may be outdated.';
  return `<article class="card">${left}<div>
    <h3>${esc(p.name)}</h3>
    <div class="meta"><span>${esc(p.live ? p.category : 'Dataset listing')}</span><span>${esc(p.live ? (p.addr || 'Address not available') : (p.area || 'Area not available'))}</span></div>
    <div class="meta"><span>Cuisine: ${cu ? esc(cu) : na}</span>
      <span>${r != null ? `<span class="rate">${r.toFixed(1)}</span>` : 'Rating: ' + na}${d && d.ratings ? ` (${esc(d.ratings)} ratings)` : ''}</span>
      <span>Price for two: ${pr != null ? '₹' + pr : na}</span></div>
    <div class="meta">${vegTxt ? `<span>${vegTxt}</span>` : ''}${offer ? `<span>Offer: ${offer}</span>` : ''}${p.hours ? `<span>Listed hours: ${esc(p.hours)}</span>` : ''}</div>
    <div class="src">${src}</div></div></article>`;
}

function render() {
  if (!last) return;
  const f = readFilters(), mode = $('#sort').value, rad = last.rad, hidden = { rating: 0, price: 0, cuisine: 0 };
  const live = last.places.filter(p => passes(p, f, hidden)).sort(sorter(mode, rad));
  const noRating = !last.places.some(p => rating(p) != null);
  let h = `<h2>Nearby places (${live.length})</h2><p class="note">Verified by map coordinates within ${km(rad).join(' ')} of ${esc(last.label)}.</p>`;
  if (mode === 'rating' && noRating) h += '<p class="note">None of these live places have ratings yet, so the order falls back to unrated.</p>';
  if (hidden.rating) h += `<p class="note">${hidden.rating} place(s) hidden: the minimum-rating filter needs a rating and they have none.</p>`;
  if (hidden.price) h += `<p class="note">${hidden.price} place(s) hidden: the price filter needs a listed price and they have none.</p>`;
  h += live.length ? live.map(card).join('') : '<p>No live places match. Try a larger distance or fewer filters.</p>';
  $('#live').innerHTML = h;

  let c = `<h2>Saved listings for ${esc(last.city)}</h2>`;
  if (dsError) c += datasetErrorHtml();
  else {
    const matched = new Set(last.places.map(p => p.ds).filter(Boolean));
    const cn = norm(last.city), h2 = { rating: 0, price: 0, cuisine: 0 };
    let rows = dataset.filter(r => !matched.has(r) && (norm(r.location).includes(cn) || norm(r.area).includes(cn)) && passes(r, f, h2));
    rows.sort(mode === 'price' ? sorter('price') : sorter('rating'));
    const total = rows.length;
    c += `<p class="note">${total} listing(s) from the saved dataset. These are matched by city only. They are <b>not verified nearby</b> and have no distance. Ratings, prices and offers may be outdated.${mode === 'near' ? ' Nearest-first does not apply here.' : ''}</p>`;
    c += rows.slice(0, 30).map(r => card(r)).join('') + (total > 30 ? `<p class="note">Showing 30 of ${total}. Use the name, cuisine or other filters to narrow down.</p>` : '');
  }
  $('#city').innerHTML = c;
}

/* ---------- Search ---------- */
function showError(msg) {
  $('#status').className = 'err';
  $('#status').innerHTML = `${esc(msg)}<br><button type="button" id="retry">Try again</button>`;
  $('#retry').onclick = () => $('#form').requestSubmit();
}

$('#form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = { landmark: $('#landmark').value.trim(), road: $('#road').value.trim(), city: $('#city').value.trim(), state: $('#state').value.trim(), country: $('#country').value.trim() };
  if (!f.city || !f.country) return showError('Please enter at least a city and a country.');
  const rad = +$('#radius').value, btn = $('#go');
  btn.disabled = true; $('#status').className = ''; $('#status').textContent = 'Finding your location…';
  $('#live').innerHTML = ''; $('#city').innerHTML = '';
  try {
    const g = await geocode(f);
    if (g.none) { showError(`We couldn't find "${g.q}". Check the spelling, or remove the landmark or road and search by city. We never substitute a different location.`); return; }
    $('#status').textContent = 'Looking for food places nearby…';
    const els = await overpass(g.lat, g.lon, rad);
    const seen = new Set();
    const places = els.map(e => toPlace(e, g.lat, g.lon)).filter(p => p && !seen.has(p.name + Math.round(p.dist)) && seen.add(p.name + Math.round(p.dist)));
    places.forEach(p => p.ds = matchDataset(p, f.city));
    last = { places, rad, label: g.label, city: f.city };
    $('#status').textContent = places.length ? '' : 'No named food places were found in this area on OpenStreetMap. Try a larger distance.';
    render();
  } catch (e) {
    showError('Something went wrong: ' + e.message + ' Please check your connection and try again.');
  } finally { btn.disabled = false; }
});

['sort', 'cat', 'veg', 'offers'].forEach(id => $('#' + id).addEventListener('change', render));
['q', 'cuisine', 'minr', 'maxp'].forEach(id => $('#' + id).addEventListener('input', render));
loadDataset();
