'use strict';
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SPECIALS_CACHE_TTL = 10 * 60 * 1000; // 10 min
const WOW_TERMS = [
  'bread','milk','snacks','fruit','vegetables','meat','dairy','cheese',
  'yoghurt','chips','biscuits','chocolate','coffee','tea','juice','cereal',
  'pasta','rice','sauce','frozen','chicken','beef','seafood','eggs',
  'butter','oil','cleaning','personal care','pantry','deli',
];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Persistence ───────────────────────────────────────────────────────────────
function dbPath(name) { return path.join(DATA_DIR, `${name}.json`); }
function loadDb(name, def = {}) {
  try { return JSON.parse(fs.readFileSync(dbPath(name), 'utf8')); }
  catch { return def; }
}
function saveDb(name, data) {
  fs.writeFileSync(dbPath(name), JSON.stringify(data, null, 2));
}

// households: { [id]: { pinHash, salt, createdAt, memberCount } }
// lists:      { [householdId]: { coles: [], woolworths: [] } }
// battles:    { [householdId]: [...] }
// history:    { [householdId]: [...] }
let households = loadDb('households', {});
let lists      = loadDb('lists', {});
let battles    = loadDb('battles', {});
let history    = loadDb('history', {});

function save() {
  saveDb('households', households);
  saveDb('lists', lists);
  saveDb('battles', battles);
  saveDb('history', history);
}

// ── Household helpers ─────────────────────────────────────────────────────────
function hashPin(pin, salt) {
  return crypto.pbkdf2Sync(pin, salt, 100000, 32, 'sha256').toString('hex');
}
function newHousehold(pin) {
  const id   = crypto.randomBytes(8).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  households[id] = { pinHash: hashPin(pin, salt), salt, createdAt: Date.now(), memberCount: 1 };
  lists[id]    = { coles: [], woolworths: [] };
  battles[id]  = [];
  history[id]  = [];
  save();
  return id;
}
function verifyPin(id, pin) {
  const h = households[id];
  if (!h) return false;
  return hashPin(pin, h.salt) === h.pinHash;
}

// Join tokens: { [token]: { householdId, expiresAt } }
const joinTokens = {};

// ── SSE broadcast ─────────────────────────────────────────────────────────────
const sseClients = {}; // { [householdId]: Set<res> }
function broadcast(householdId, event, data) {
  const clients = sseClients[householdId];
  if (!clients || !clients.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-AU,en;q=0.9',
};

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...BASE_HEADERS, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Specials cache ────────────────────────────────────────────────────────────
let specialsCache = { data: null, ts: 0, page: 0 };

async function fetchColesSpecials(page) {
  const data = await fetchJson(
    `https://www.coles.com.au/api/bff/products/v1/special?page=${page}&pageSize=48&sortBy=PriceDesc`,
    { headers: { ...BASE_HEADERS, 'Accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' } }
  );
  return (data?.results?.[0]?.products || []).map(p => ({
    id: String(p.id), store: 'coles',
    name: p.name, brand: p.brand,
    price: p.pricing?.now,
    wasPrice: p.pricing?.was,
    unitPrice: p.pricing?.comparable,
    image: p.imageUris?.[0]?.uri ? `https://productimages.coles.com.au/productimages${p.imageUris[0].uri}` : null,
    isOnSpecial: true,
  }));
}

async function fetchWowSpecials(page) {
  const termCount = 3;
  const offset = ((page - 1) * termCount) % WOW_TERMS.length;
  const terms = WOW_TERMS.slice(offset, offset + termCount);
  if (offset + termCount > WOW_TERMS.length) terms.push(...WOW_TERMS.slice(0, (offset + termCount) - WOW_TERMS.length));

  const results = await Promise.allSettled(terms.map(term =>
    fetchJson(`https://www.woolworths.com.au/apis/ui/Search/products?searchTerm=${encodeURIComponent(term)}&pageNumber=1&pageSize=36&filter=SaleOnly%3Dtrue`, {
      headers: { ...BASE_HEADERS, 'Accept': 'application/json' }
    })
  ));

  const seen = new Set();
  const items = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const p of r.value?.Products || []) {
      const prod = p.Product || p;
      if (!prod?.Stockcode || seen.has(prod.Stockcode)) continue;
      seen.add(prod.Stockcode);
      items.push({
        id: String(prod.Stockcode), store: 'woolworths',
        name: prod.Name, brand: prod.Brand,
        price: prod.Price,
        wasPrice: prod.WasPrice,
        unitPrice: prod.CupString || null,
        image: prod.MediumImageFile || prod.SmallImageFile || null,
        isOnSpecial: true,
      });
    }
  }
  // Shuffle
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// ── Search ────────────────────────────────────────────────────────────────────
async function searchColes(q, page = 1) {
  const data = await fetchJson(
    `https://www.coles.com.au/api/bff/products/v1/search?q=${encodeURIComponent(q)}&page=${page}&pageSize=24`,
    { headers: { ...BASE_HEADERS, 'Accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' } }
  );
  return (data?.results?.[0]?.products || []).map(p => ({
    id: String(p.id), store: 'coles',
    name: p.name, brand: p.brand,
    price: p.pricing?.now,
    wasPrice: p.pricing?.was,
    unitPrice: p.pricing?.comparable,
    image: p.imageUris?.[0]?.uri ? `https://productimages.coles.com.au/productimages${p.imageUris[0].uri}` : null,
    isOnSpecial: !!(p.pricing?.was),
  }));
}

async function searchWoolworths(q, page = 1) {
  const data = await fetchJson(
    `https://www.woolworths.com.au/apis/ui/Search/products?searchTerm=${encodeURIComponent(q)}&pageNumber=${page}&pageSize=24`,
    { headers: { ...BASE_HEADERS, 'Accept': 'application/json' } }
  );
  return (data?.Products || []).map(p => {
    const prod = p.Product || p;
    return {
      id: String(prod.Stockcode), store: 'woolworths',
      name: prod.Name, brand: prod.Brand,
      price: prod.Price,
      wasPrice: prod.WasPrice,
      unitPrice: prod.CupString || null,
      image: prod.MediumImageFile || prod.SmallImageFile || null,
      isOnSpecial: !!(prod.WasPrice),
    };
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function cors(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Household-ID, X-Household-PIN',
  });
  res.end();
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireHousehold(req, res) {
  const id  = req.headers['x-household-id'];
  const pin = req.headers['x-household-pin'];
  if (!id || !pin || !verifyPin(id, pin)) {
    json(res, 401, { error: 'Invalid household credentials' });
    return null;
  }
  return id;
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') { cors(res); return; }

  const parsed = new URL(req.url, `http://localhost`);
  const path_  = parsed.pathname;

  try {
    // ── Health ──────────────────────────────────────────────────────────────
    if (path_ === '/ping') {
      json(res, 200, { ok: true, ts: Date.now() }); return;
    }

    // ── Household: create ───────────────────────────────────────────────────
    if (path_ === '/household/create' && req.method === 'POST') {
      const { pin } = await parseBody(req);
      if (!pin || pin.length < 4) { json(res, 400, { error: 'PIN must be at least 4 characters' }); return; }
      const id = newHousehold(pin);
      json(res, 200, { householdId: id });
      return;
    }

    // ── Household: verify (login) ───────────────────────────────────────────
    if (path_ === '/household/verify' && req.method === 'POST') {
      const { householdId, pin } = await parseBody(req);
      if (!verifyPin(householdId, pin)) { json(res, 401, { error: 'Invalid household ID or PIN' }); return; }
      json(res, 200, { ok: true });
      return;
    }

    // ── Household: generate invite link ────────────────────────────────────
    if (path_ === '/household/invite' && req.method === 'POST') {
      const hid = requireHousehold(req, res); if (!hid) return;
      const token = crypto.randomBytes(16).toString('hex');
      joinTokens[token] = { householdId: hid, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
      // Clean expired tokens
      for (const [t, v] of Object.entries(joinTokens)) {
        if (v.expiresAt < Date.now()) delete joinTokens[t];
      }
      json(res, 200, { token, expiresAt: joinTokens[token].expiresAt });
      return;
    }

    // ── Household: join via token + PIN ────────────────────────────────────
    if (path_ === '/household/join' && req.method === 'POST') {
      const { token, pin } = await parseBody(req);
      const jt = joinTokens[token];
      if (!jt || jt.expiresAt < Date.now()) { json(res, 400, { error: 'Invite link expired or invalid' }); return; }
      if (!verifyPin(jt.householdId, pin)) { json(res, 401, { error: 'Incorrect PIN' }); return; }
      delete joinTokens[token]; // one-time use
      households[jt.householdId].memberCount = (households[jt.householdId].memberCount || 1) + 1;
      save();
      json(res, 200, { householdId: jt.householdId });
      return;
    }

    // ── SSE ─────────────────────────────────────────────────────────────────
    if (path_ === '/events') {
      const hid = req.headers['x-household-id'];
      const pin = req.headers['x-household-pin'];
      if (!hid || !pin || !verifyPin(hid, pin)) { json(res, 401, { error: 'Unauthorized' }); return; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('event: connected\ndata: {}\n\n');
      if (!sseClients[hid]) sseClients[hid] = new Set();
      sseClients[hid].add(res);
      const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => {
        clearInterval(keepAlive);
        sseClients[hid]?.delete(res);
      });
      return;
    }

    // ── List ────────────────────────────────────────────────────────────────
    if (path_ === '/list') {
      const hid = requireHousehold(req, res); if (!hid) return;
      if (req.method === 'GET') {
        json(res, 200, lists[hid] || { coles: [], woolworths: [] });
      } else if (req.method === 'POST') {
        const body = await parseBody(req);
        lists[hid] = body;
        save();
        broadcast(hid, 'list-update', lists[hid]);
        json(res, 200, { ok: true });
      }
      return;
    }

    // ── Battles ─────────────────────────────────────────────────────────────
    if (path_ === '/battles') {
      const hid = requireHousehold(req, res); if (!hid) return;
      if (req.method === 'GET') {
        json(res, 200, battles[hid] || []);
      } else if (req.method === 'POST') {
        const body = await parseBody(req);
        battles[hid] = body;
        save();
        broadcast(hid, 'battles-update', battles[hid]);
        json(res, 200, { ok: true });
      }
      return;
    }

    // ── History ─────────────────────────────────────────────────────────────
    if (path_ === '/history') {
      const hid = requireHousehold(req, res); if (!hid) return;
      if (req.method === 'GET') {
        json(res, 200, history[hid] || []);
      } else if (req.method === 'POST') {
        const body = await parseBody(req);
        history[hid] = body;
        save();
        broadcast(hid, 'history-update', history[hid]);
        json(res, 200, { ok: true });
      }
      return;
    }

    // ── Specials ─────────────────────────────────────────────────────────────
    if (path_ === '/specials') {
      const page = parseInt(parsed.searchParams.get('page') || '1', 10);
      const [coles, wow] = await Promise.allSettled([
        fetchColesSpecials(page),
        fetchWowSpecials(page),
      ]);
      json(res, 200, {
        coles: coles.status === 'fulfilled' ? coles.value : [],
        woolworths: wow.status === 'fulfilled' ? wow.value : [],
        page,
        done: page >= 30,
      });
      return;
    }

    // ── Search ───────────────────────────────────────────────────────────────
    if (path_ === '/search') {
      const q    = parsed.searchParams.get('q') || '';
      const page = parseInt(parsed.searchParams.get('page') || '1', 10);
      const store = parsed.searchParams.get('store') || 'both';
      if (!q) { json(res, 400, { error: 'Missing q' }); return; }

      const fetchers = [];
      if (store === 'both' || store === 'coles')      fetchers.push(searchColes(q, page).catch(() => []));
      if (store === 'both' || store === 'woolworths') fetchers.push(searchWoolworths(q, page).catch(() => []));

      const [a, b] = await Promise.all(fetchers);
      if (store === 'both') {
        json(res, 200, { coles: a, woolworths: b });
      } else {
        json(res, 200, { [store]: a || b });
      }
      return;
    }

    json(res, 404, { error: 'Not found' });

  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`BasketBattle server on :${PORT}`));
