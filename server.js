const http = require("http");
const https = require("https");
const fs = require("fs");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 3000;
const agent = new https.Agent({ rejectUnauthorized: false });

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-AU,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

/* ============================================================
   COOKIE PERSISTENCE
   ============================================================ */
const DATA_DIR = process.env.DATA_DIR || ".";
const COOKIE_FILE = DATA_DIR + "/auth-cookies.json";
// Auth is stored per household code. The global `auth` object holds the currently-active household's tokens.
// When a client connects with a code, their household's auth is loaded into `auth`.
let householdAuth = {}; // { code: { coles: {...}, woolworths: {...} } }
let activeHouseholdCode = "";

function getHouseholdAuth(code) {
  if (!code) return null;
  return householdAuth[code] || { coles: { cookies: "", loggedIn: false, email: "" }, woolworths: { cookies: "", loggedIn: false, email: "" } };
}

function saveCookiesToDisk() {
  try {
    // Save current auth under active household code
    if (activeHouseholdCode) {
      householdAuth[activeHouseholdCode] = {
        coles:      { cookies: auth.coles.cookies,      loggedIn: auth.coles.loggedIn,      email: auth.coles.email,
                      subscriptionKey: colesCartConfig.subscriptionKey },
        woolworths: { cookies: auth.woolworths.cookies, loggedIn: auth.woolworths.loggedIn, email: auth.woolworths.email },
      };
    }
    fs.writeFileSync(COOKIE_FILE, JSON.stringify({ householdAuth, legacy: {
      coles:      { cookies: auth.coles.cookies,      loggedIn: auth.coles.loggedIn,      email: auth.coles.email,
                    subscriptionKey: colesCartConfig.subscriptionKey },
      woolworths: { cookies: auth.woolworths.cookies, loggedIn: auth.woolworths.loggedIn, email: auth.woolworths.email },
    }}, null, 2));
    console.log("[Auth] Cookies saved to disk (household:", activeHouseholdCode || "global", ")");
  } catch(e) {
    console.warn("[Auth] Could not save cookies:", e.message);
  }
}

function loadCookiesFromDisk() {
  try {
    if (!fs.existsSync(COOKIE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
    // Support new household format and legacy flat format
    if (data.householdAuth) {
      householdAuth = data.householdAuth;
      console.log("[Auth] Loaded household auth for", Object.keys(householdAuth).length, "household(s)");
    }
    // Load legacy/global auth as fallback
    const src = data.legacy || data;
    if (src.coles) {
      auth.coles.cookies   = src.coles.cookies   || "";
      auth.coles.loggedIn  = src.coles.loggedIn  || false;
      auth.coles.email     = src.coles.email      || "";
      if (auth.coles.cookies) session.coles.cookies = auth.coles.cookies;
      if (src.coles.subscriptionKey) {
        colesCartConfig.subscriptionKey = src.coles.subscriptionKey;
        console.log("[Auth] Restored Coles subscription key from disk.");
      }
    }
    if (src.woolworths) {
      auth.woolworths.cookies   = src.woolworths.cookies   || "";
      auth.woolworths.loggedIn  = src.woolworths.loggedIn  || false;
      auth.woolworths.email     = src.woolworths.email      || "";
      if (auth.woolworths.cookies) session.woolworths.cookies = auth.woolworths.cookies;
    }
    console.log("[Auth] Coles:", auth.coles.loggedIn ? "logged in" : "not logged in", "| Woolworths:", auth.woolworths.loggedIn ? "logged in" : "not logged in");
  } catch(e) {
    console.warn("[Auth] Could not load cookies:", e.message);
  }
}

function applyHouseholdAuth(code) {
  if (!code) return;
  let ha = getHouseholdAuth(code);
  // If this household has no saved cookies but global legacy cookies exist, migrate them in
  if (!ha.coles.cookies && !ha.woolworths.cookies && (auth.coles.cookies || auth.woolworths.cookies)) {
    console.log("[Auth] Migrating legacy global cookies into household", code);
    ha = {
      coles: { cookies: auth.coles.cookies, loggedIn: auth.coles.loggedIn, email: auth.coles.email, subscriptionKey: colesCartConfig.subscriptionKey },
      woolworths: { cookies: auth.woolworths.cookies, loggedIn: auth.woolworths.loggedIn, email: auth.woolworths.email },
    };
    householdAuth[code] = ha;
    saveCookiesToDisk();
  }
  auth.coles.cookies   = ha.coles.cookies   || "";
  auth.coles.loggedIn  = ha.coles.loggedIn  || false;
  auth.coles.email     = ha.coles.email      || "";
  auth.woolworths.cookies   = ha.woolworths.cookies   || "";
  auth.woolworths.loggedIn  = ha.woolworths.loggedIn  || false;
  auth.woolworths.email     = ha.woolworths.email      || "";
  if (ha.coles.subscriptionKey) colesCartConfig.subscriptionKey = ha.coles.subscriptionKey;
  session.coles.cookies = auth.coles.cookies;
  session.woolworths.cookies = auth.woolworths.cookies;
  activeHouseholdCode = code;
  console.log("[Auth] Applied household auth for", code, "— Coles:", auth.coles.loggedIn ? "in" : "out", "| Woolies:", auth.woolworths.loggedIn ? "in" : "out");
  // Restart token refresh timers for the new household's tokens
  if (auth.woolworths.loggedIn) startWoolworthsTokenRefresh();
  if (auth.coles.loggedIn) startColesTokenRefresh();
}

/* ============================================================
   SESSION CACHE
   ============================================================ */
const session = {
  coles:      { cookies: "", buildId: "", subscriptionKey: "", fetched: 0 },
  woolworths: { cookies: "", buildId: "", fetched: 0 },
};

async function refreshColes() {
  if (Date.now() - session.coles.fetched < 8 * 60 * 1000) return;
  const pagesToTry = [
    "https://www.coles.com.au/search/products?q=milk",
    "https://www.coles.com.au/browse/dairy-eggs-fridge",
    "https://www.coles.com.au/",
  ];
  for (const pageUrl of pagesToTry) {
    try {
      const res = await fetch(pageUrl, {
        headers: { ...BASE_HEADERS, "Accept": "text/html,*/*", "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
        agent, redirect: "follow",
      });
      const html = await res.text();
      const sc = res.headers.get("set-cookie") || "";
      let buildId = "";
      const m1 = html.match(/"buildId"\s*:\s*"([^"]+)"/);
      if (m1) buildId = m1[1];
      if (!buildId) {
        const m2 = html.match(/\/_next\/static\/([a-zA-Z0-9._-]+)\/_buildManifest/);
        if (m2) buildId = m2[1];
      }
      if (buildId) {
        session.coles.buildId = buildId;
        if (sc) session.coles.cookies = sc.split(",").map(c => c.split(";")[0].trim()).join("; ");
        break;
      }
    } catch(e) {}
  }
  if (!session.coles.buildId) {
    session.coles.buildId = "20260225.2-125b188e5403326089f284f2886ed93482440af0";
  }
  session.coles.fetched = Date.now();
  console.log("[Coles] buildId:", session.coles.buildId);
  if (!colesCartConfig.subscriptionKey) {
    await refreshColesSubscriptionKey();
  }
}

const colesCartConfig = {
  subscriptionKey: "",
  trolleyPath: "/api/bff/trolley",
};

async function refreshColesSubscriptionKey() {
  try {
    const homeRes = await fetch("https://www.coles.com.au/", {
      headers: { ...BASE_HEADERS, "Accept": "text/html,*/*", "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
      agent, redirect: "follow",
    });
    const html = await homeRes.text();
    const chunkMatches = [...html.matchAll(/\/_next\/static\/chunks\/([^"'\s]+\.js)/g)];
    const candidates = [...new Set(chunkMatches.map(m => "https://www.coles.com.au/_next/static/chunks/" + m[1]))];
    console.log("[Coles] Scanning", candidates.length, "JS chunks for subscription key...");
    for (const url of candidates) {
      try {
        const jsRes = await fetch(url, { headers: { ...BASE_HEADERS, "Referer": "https://www.coles.com.au/" }, agent });
        if (!jsRes.ok) continue;
        const js = await jsRes.text();
        const keyMatch =
          js.match(/["']Ocp-Apim-Subscription-Key["']\s*[:,]\s*["']([a-f0-9]{32})["']/i) ||
          js.match(/subscriptionKey\s*[:,]\s*["']([a-f0-9]{32})["']/i) ||
          js.match(/subscription[_-]?key["'\s:,]+["']([a-f0-9]{32})["']/i) ||
          js.match(/apim[_-]?key["'\s:,]+["']([a-f0-9]{32})["']/i) ||
          js.match(/subscription[^"']{0,40}["']([a-f0-9]{32})["']/i);
        if (keyMatch) {
          colesCartConfig.subscriptionKey = keyMatch[1];
          console.log("[Coles] ✅ Found subscription key in:", url.split('/').pop());
          return;
        }
        const pathMatch = js.match(/["'](\/api\/bff\/trolley[^"']*store[^"']*)["']/i);
        if (pathMatch) {
          colesCartConfig.trolleyPath = pathMatch[1];
          console.log("[Coles] Found trolley path:", colesCartConfig.trolleyPath);
        }
      } catch(e) {}
    }
    console.warn("[Coles] Could not find subscription key in JS bundles — will try without it");
  } catch(e) {
    console.warn("[Coles] Error scraping subscription key:", e.message);
  }
}

async function refreshWoolworths() {
  if (Date.now() - session.woolworths.fetched < 8 * 60 * 1000) return;
  const res = await fetch("https://www.woolworths.com.au/", {
    headers: { ...BASE_HEADERS, "Accept": "text/html,*/*", "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    agent, redirect: "follow",
  });
  const html = await res.text();
  const sc = res.headers.get("set-cookie") || "";
  if (sc) session.woolworths.cookies = sc.split(",").map(c => c.split(";")[0].trim()).join("; ");
  const m = html.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (m) session.woolworths.buildId = m[1];
  session.woolworths.fetched = Date.now();
  console.log("[Woolworths] buildId:", session.woolworths.buildId);
}

function notifyReloginNeeded(store, householdCode) {
  console.log(`[Auth] Session expired for ${store} — notifying household ${householdCode || 'all'}`);
  auth[store].loggedIn = false;
  saveCookiesToDisk();
  broadcast({ type: 'auth-update', store, loggedIn: false, error: 'session_expired' }, householdCode);
}

/* ============================================================
   TOKEN REFRESH — WOOLWORTHS
   wow-auth-token is a JWT, expires ~30min. Refresh via API.
   ============================================================ */
function parseJwtExp(token) {
  try {
    const payload = Buffer.from(token.split('.')[1], 'base64').toString('utf8');
    return JSON.parse(payload).exp * 1000; // ms
  } catch(e) { return 0; }
}

function getCookieVal(cookieStr, name) {
  const m = cookieStr.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

function setCookieVal(cookieStr, name, value) {
  // Replace existing or append
  if (new RegExp('(?:^|;\\s*)' + name + '=').test(cookieStr)) {
    return cookieStr.replace(new RegExp('((?:^|;\\s*)' + name + '=)[^;]+'), '$1' + value);
  }
  return cookieStr + '; ' + name + '=' + value;
}

let woolworthsRefreshTimer = null;

async function refreshWoolworthsToken() {
  if (!auth.woolworths.loggedIn || !auth.woolworths.cookies) return;
  const token = getCookieVal(auth.woolworths.cookies, 'wow-auth-token');
  if (!token) return;

  const exp = parseJwtExp(token);
  const msUntilExpiry = exp - Date.now();
  console.log(`[Woolworths] Token expires in ${Math.round(msUntilExpiry/60000)}min`);

  // Only refresh if expiring within 10 minutes
  if (msUntilExpiry > 10 * 60 * 1000) {
    scheduleWoolworthsRefresh(msUntilExpiry);
    return;
  }

  console.log('[Woolworths] Refreshing auth token...');
  try {
    const res = await fetch('https://www.woolworths.com.au/apis/ui/v2/uielements/token/refresh', {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://www.woolworths.com.au',
        'Referer': 'https://www.woolworths.com.au/',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'Cookie': auth.woolworths.cookies,
      },
      body: JSON.stringify({}),
      agent,
    });

    // New token may come back as Set-Cookie or in JSON body
    const setCookie = res.headers.get('set-cookie') || '';
    const newTokenMatch = setCookie.match(/wow-auth-token=([^;]+)/i);
    if (newTokenMatch) {
      auth.woolworths.cookies = setCookieVal(auth.woolworths.cookies, 'wow-auth-token', newTokenMatch[1]);
      session.woolworths.cookies = auth.woolworths.cookies;
      saveCookiesToDisk();
      const newExp = parseJwtExp(newTokenMatch[1]);
      console.log('[Woolworths] ✅ Token refreshed via Set-Cookie, new expiry:', new Date(newExp).toISOString());
      scheduleWoolworthsRefresh(newExp - Date.now());
      return;
    }

    // Try JSON body
    if (res.ok) {
      try {
        const data = await res.json();
        const newToken = data.token || data.accessToken || data.wow_auth_token;
        if (newToken) {
          auth.woolworths.cookies = setCookieVal(auth.woolworths.cookies, 'wow-auth-token', newToken);
          session.woolworths.cookies = auth.woolworths.cookies;
          saveCookiesToDisk();
          const newExp = parseJwtExp(newToken);
          console.log('[Woolworths] ✅ Token refreshed via JSON, new expiry:', new Date(newExp).toISOString());
          scheduleWoolworthsRefresh(newExp - Date.now());
          return;
        }
      } catch(e) {}
    }

    console.warn('[Woolworths] Token refresh returned', res.status, '— will need re-login');
    if (res.status === 401 || res.status === 403) notifyReloginNeeded('woolworths', activeHouseholdCode);
  } catch(e) {
    console.warn('[Woolworths] Token refresh error:', e.message);
    // Retry in 5 minutes
    scheduleWoolworthsRefresh(5 * 60 * 1000);
  }
}

function scheduleWoolworthsRefresh(msUntilExpiry) {
  if (woolworthsRefreshTimer) clearTimeout(woolworthsRefreshTimer);
  // Refresh 8 minutes before expiry, minimum 30 seconds
  const delay = Math.max(30000, msUntilExpiry - 8 * 60 * 1000);
  console.log(`[Woolworths] Scheduling token refresh in ${Math.round(delay/60000)}min`);
  woolworthsRefreshTimer = setTimeout(refreshWoolworthsToken, delay);
}

function startWoolworthsTokenRefresh() {
  if (!auth.woolworths.loggedIn || !auth.woolworths.cookies) return;
  const token = getCookieVal(auth.woolworths.cookies, 'wow-auth-token');
  if (!token) return;
  const exp = parseJwtExp(token);
  if (!exp) return;
  const msUntilExpiry = exp - Date.now();
  if (msUntilExpiry <= 0) {
    console.log('[Woolworths] Stored token already expired — need re-login');
    notifyReloginNeeded('woolworths', activeHouseholdCode);
    return;
  }
  scheduleWoolworthsRefresh(msUntilExpiry);
}

/* ============================================================
   TOKEN REFRESH — COLES
   Uses OAuth refreshToken to get a new accessToken
   ============================================================ */
let colesRefreshTimer = null;

async function refreshColesToken() {
  if (!auth.coles.loggedIn || !auth.coles.cookies) return;
  const refreshToken = getCookieVal(auth.coles.cookies, 'refreshToken');
  if (!refreshToken) { console.warn('[Coles] No refreshToken in cookies'); return; }

  console.log('[Coles] Refreshing access token...');
  try {
    // Coles uses Okta/Auth0 under colesgroupprofile.com.au
    const res = await fetch('https://auth.colesgroupprofile.com.au/oauth2/default/v1/token', {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Origin': 'https://www.coles.com.au',
        'Referer': 'https://www.coles.com.au/',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: 'coles-web',
      }).toString(),
      agent,
    });

    if (res.ok) {
      const data = await res.json();
      if (data.access_token) {
        auth.coles.cookies = setCookieVal(auth.coles.cookies, 'accessToken', data.access_token);
        if (data.refresh_token) {
          auth.coles.cookies = setCookieVal(auth.coles.cookies, 'refreshToken', data.refresh_token);
        }
        session.coles.cookies = auth.coles.cookies;
        saveCookiesToDisk();
        const expiresIn = (data.expires_in || 3600) * 1000;
        console.log('[Coles] ✅ Access token refreshed, expires in', Math.round(expiresIn/60000), 'min');
        scheduleColesRefresh(expiresIn);
        return;
      }
    }

    console.warn('[Coles] Token refresh returned', res.status);
    if (res.status === 400 || res.status === 401) {
      // Refresh token itself expired — need full re-login
      notifyReloginNeeded('coles', activeHouseholdCode);
    } else {
      scheduleColesRefresh(5 * 60 * 1000);
    }
  } catch(e) {
    console.warn('[Coles] Token refresh error:', e.message);
    scheduleColesRefresh(5 * 60 * 1000);
  }
}

function scheduleColesRefresh(expiresInMs) {
  if (colesRefreshTimer) clearTimeout(colesRefreshTimer);
  // Refresh 10 minutes before expiry
  const delay = Math.max(30000, expiresInMs - 10 * 60 * 1000);
  console.log(`[Coles] Scheduling token refresh in ${Math.round(delay/60000)}min`);
  colesRefreshTimer = setTimeout(refreshColesToken, delay);
}

function startColesTokenRefresh() {
  if (!auth.coles.loggedIn || !auth.coles.cookies) return;
  const accessToken = getCookieVal(auth.coles.cookies, 'accessToken');
  if (!accessToken) return;
  // Try to read expiry from JWT, fall back to 50 minutes
  const exp = parseJwtExp(accessToken);
  const msUntilExpiry = exp ? exp - Date.now() : 50 * 60 * 1000;
  if (exp && msUntilExpiry <= 0) {
    console.log('[Coles] Access token expired — attempting immediate refresh');
    refreshColesToken();
    return;
  }
  scheduleColesRefresh(msUntilExpiry);
}


/* ============================================================
   SEARCH — COLES
   ============================================================ */
async function searchColes(query, page) {
  if (!page) page = 1;
  await refreshColes();
  const { buildId, cookies } = session.coles;
  if (!buildId) throw new Error("Could not get Coles buildId");
  const url = `https://www.coles.com.au/_next/data/${buildId}/en/search/products.json?q=${encodeURIComponent(query)}&page=${page}`;
  const res = await fetch(url, {
    headers: { ...BASE_HEADERS, "Accept": "application/json", "Referer": `https://www.coles.com.au/search/products?q=${encodeURIComponent(query)}`, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", ...(cookies ? { "Cookie": cookies } : {}) },
    agent,
  });
  if (!res.ok) {
    if (res.status === 404) { session.coles.buildId = ""; session.coles.fetched = 0; }
    throw new Error("Coles HTTP " + res.status);
  }
  const data = await res.json();
  const assetsUrl = data?.pageProps?.assetsUrl || "";
  const results = data?.pageProps?.searchResults?.results || [];
  return results.filter(p => p._type === "PRODUCT" && p.pricing && p.pricing.now > 0).map(p => {
    const comparable = p.pricing?.comparable;
    // Parse comparable into a normalised unitPrice string e.g. "$1.20 / 100g"
    // Coles comparable can be an object {value, unit} or a plain string
    let unitPrice = null;
    if (comparable) {
      if (typeof comparable === 'object' && comparable !== null) {
        // Object form: { value: 1.2, unit: "100g" } or similar
        const val = comparable.value ?? comparable.price ?? comparable.amount;
        const u   = comparable.unit ?? comparable.per ?? comparable.measure;
        if (val != null && u != null) unitPrice = '$' + parseFloat(val).toFixed(2) + ' / ' + u;
        else unitPrice = JSON.stringify(comparable);
      } else {
        unitPrice = String(comparable).trim();
      }
    }
    return {
      name: p.name, brand: p.brand || null, price: p.pricing?.now,
      wasPrice: p.pricing?.was || null, isOnSpecial: !!p.pricing?.promotionType,
      unitPrice: unitPrice || null,
      unit: p.size || null, imgUrl: p.imageUris?.[0]?.uri ? assetsUrl + p.imageUris[0].uri : null, id: p.id,
      unavailable: false,
    };
  });
}

/* ============================================================
   SEARCH — WOOLWORTHS
   ============================================================ */
async function searchWoolworths(query, page) {
  if (!page) page = 1;
  await refreshWoolworths();
  const { cookies } = session.woolworths;
  const res = await fetch("https://www.woolworths.com.au/apis/ui/Search/products", {
    method: "POST",
    headers: { ...BASE_HEADERS, "Accept": "application/json", "Content-Type": "application/json", "Origin": "https://www.woolworths.com.au", "Referer": `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(query)}`, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", ...(cookies ? { "Cookie": cookies } : {}) },
    body: JSON.stringify({ Filters: [], IsSpecial: false, Location: `/shop/search/products?searchTerm=${encodeURIComponent(query)}`, PageNumber: page, PageSize: 24, SearchTerm: query, SortType: "TraderRelevance", TimeZoneOffset: -660, enableGp: true }),
    agent,
  });
  if (!res.ok) throw new Error("Woolworths HTTP " + res.status);
  const data = await res.json();
  const products = data?.Products || [];
  return products.flatMap(p => {
    const items = p.Products || [p];
    return items.map(item => ({
      name: item.Name || item.DisplayName, brand: item.Brand || null,
      price: item.Price || 0,
      wasPrice: item.WasPrice || null, isOnSpecial: item.IsOnSpecial || false,
      unitPrice: item.CupString || null, unit: item.PackageSize || null,
      imgUrl: item.SmallImageFile ? item.SmallImageFile.replace('/small/', '/large/') : null,
      stockcode: item.Stockcode,
      unavailable: !item.Price || item.Price <= 0 || item.IsAvailable === false,
    }));
  });
}

/* ============================================================
   SPECIALS — COLES
   ============================================================ */
async function getColesSpecials(page) {
  if (!page) page = 1;
  await refreshColes();
  const { buildId, cookies } = session.coles;
  if (!buildId) throw new Error("Could not get Coles buildId");
  const url = `https://www.coles.com.au/_next/data/${buildId}/en/on-special.json?page=${page}`;
  const res = await fetch(url, {
    headers: { ...BASE_HEADERS, "Accept": "application/json", "Referer": "https://www.coles.com.au/on-special", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", ...(cookies ? { "Cookie": cookies } : {}) },
    agent,
  });
  if (!res.ok) {
    if (res.status === 404) { session.coles.buildId = ""; session.coles.fetched = 0; }
    throw new Error("Coles specials HTTP " + res.status);
  }
  const data = await res.json();
  const assetsUrl = data?.pageProps?.assetsUrl || "";
  const results = data?.pageProps?.searchResults?.results || [];
  return results.filter(p => p._type === "PRODUCT" && p.pricing && p.pricing.now > 0).map(p => {
    const comparable = p.pricing?.comparable;
    let unitPrice = null;
    if (comparable) {
      if (typeof comparable === 'object' && comparable !== null) {
        const val = comparable.value ?? comparable.price ?? comparable.amount;
        const u   = comparable.unit ?? comparable.per ?? comparable.measure;
        if (val != null && u != null) unitPrice = '$' + parseFloat(val).toFixed(2) + ' / ' + u;
        else unitPrice = JSON.stringify(comparable);
      } else {
        unitPrice = String(comparable).trim();
      }
    }
    return {
      name: p.name, brand: p.brand || null, price: p.pricing?.now,
      wasPrice: p.pricing?.was || null, isOnSpecial: true,
      unitPrice: unitPrice || null,
      unit: p.size || null, imgUrl: p.imageUris?.[0]?.uri ? assetsUrl + p.imageUris[0].uri : null, id: p.id,
      unavailable: false,
    };
  });
}

/* ============================================================
   SPECIALS — WOOLWORTHS
   ============================================================ */
async function getWoolworthsSpecials(page) {
  if (!page) page = 1;
  const terms = [
    'bread', 'milk', 'snacks', 'pantry', 'fruit', 'vegetables', 'meat', 'dairy',
    'cheese', 'yoghurt', 'chips', 'biscuits', 'chocolate', 'coffee', 'tea',
    'juice', 'cereal', 'pasta', 'rice', 'sauce', 'frozen', 'chicken', 'beef',
    'seafood', 'deli', 'eggs', 'butter', 'oil', 'cleaning', 'personal care',
  ];
  // Pick 3 terms per page, offset by page so each load gives new variety
  const offset = ((page - 1) * 3) % terms.length;
  const batch = [
    terms[offset % terms.length],
    terms[(offset + 1) % terms.length],
    terms[(offset + 2) % terms.length],
  ];
  // Fetch all 3 in parallel
  const results = await Promise.all(batch.map(term =>
    searchWoolworths(term, 1)
      .then(r => r.filter(i => i.isOnSpecial || i.wasPrice).map(i => ({ ...i, isOnSpecial: true })))
      .catch(() => [])
  ));
  // Merge and deduplicate by stockcode, then shuffle
  const seen = new Set();
  const merged = results.flat().filter(item => {
    const key = item.stockcode || item.name;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  // Fisher-Yates shuffle for a natural mixed look
  for (let i = merged.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [merged[i], merged[j]] = [merged[j], merged[i]];
  }
  console.log(`[Woolworths Specials] page=${page} terms="${batch.join(',')}" specials=${merged.length}`);
  return merged;
}

/* ============================================================
   AUTH STATE
   ============================================================ */
const auth = {
  coles:      { cookies: "", loggedIn: false, email: "" },
  woolworths: { cookies: "", loggedIn: false, email: "" },
};

const cartState = {
  coles:      { running: false, done: 0, total: 0, errors: [], log: [] },
  woolworths: { running: false, done: 0, total: 0, errors: [], log: [] },
};

const loginSessions = { coles: null, woolworths: null };
const remoteSessions = {}; // token → { store, code, created, used }

/* ============================================================
   COOKIE VALIDITY CHECK
   ============================================================ */
async function validateSavedCookies(store) {
  if (!auth[store].cookies || !auth[store].loggedIn) return false;
  try {
    if (store === "coles") {
      // Try a few known Coles auth-gated endpoints
      const endpoints = [
        "https://www.coles.com.au/api/bff/customer/profile",
        "https://www.coles.com.au/api/bff/loyalty/member",
        "https://www.coles.com.au/api/bff/cart",
      ];
      for (const url of endpoints) {
        const res = await fetch(url, {
          headers: { ...BASE_HEADERS, "Accept": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "Cookie": auth.coles.cookies },
          agent,
        });
        console.log("[Coles] Cookie check", url.split('/').pop(), "→ status:", res.status);
        if (res.status === 200 || res.status === 204) {
          console.log("[Coles] Cookies valid ✓");
          return true;
        }
        if (res.status === 401 || res.status === 403) {
          console.log("[Coles] Cookies expired — need to re-login");
          auth.coles.loggedIn = false; saveCookiesToDisk(); return false;
        }
        // 404 means endpoint moved, try next
      }
      // All endpoints returned non-auth errors — assume expired
      console.log("[Coles] Could not verify cookies — marking as logged out");
      auth.coles.loggedIn = false; saveCookiesToDisk(); return false;
    } else {
      const res = await fetch("https://www.woolworths.com.au/apis/ui/v2/personalisation/content?pageId=home", {
        headers: { ...BASE_HEADERS, "Accept": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "Cookie": auth.woolworths.cookies },
        agent,
      });
      if (res.status === 401 || res.status === 403) {
        console.log("[Woolworths] Saved cookies are expired — need to re-login");
        auth.woolworths.loggedIn = false; saveCookiesToDisk(); return false;
      }
      console.log("[Woolworths] Saved cookies appear valid (status:", res.status + ")");
      return true;
    }
  } catch(e) {
    console.warn("[" + store + "] Cookie validation error:", e.message);
    return true;
  }
}

/* ============================================================
   PUPPETEER LOGIN
   ============================================================ */
async function puppeteerLogin(store) {
  if (loginSessions[store]) {
    try { await loginSessions[store].browser.close(); } catch(e) {}
    loginSessions[store] = null;
  }

  let puppeteer;
  try {
    const puppeteerExtra = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    puppeteer = puppeteerExtra;
    console.log("[" + store + "] Using puppeteer-extra with stealth");
  } catch(e) {
    try {
      puppeteer = require('puppeteer');
      console.log("[" + store + "] Using standard puppeteer (stealth not installed)");
    } catch(e2) {
      return { success: false, error: 'Puppeteer not installed. Run install-puppeteer.bat' };
    }
  }

  const loginUrl = store === 'coles' ? 'https://www.coles.com.au/' : 'https://www.woolworths.com.au/';
  console.log("[" + store + "] Opening browser:", loginUrl);

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  const fs2 = require('fs');
  let executablePath = undefined;
  for (const p of chromePaths) {
    try { if (fs2.existsSync(p)) { executablePath = p; break; } } catch(e) {}
  }
  console.log("[" + store + "] Chrome path:", executablePath || "using bundled Chromium");

  const browser = await puppeteer.launch({
    headless: false, defaultViewport: null, executablePath,
    args: ['--start-maximized', '--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars', '--disable-web-security', '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(function() {
    Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
    window.chrome = { runtime: {} };
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  if (store === 'coles') {
    try {
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = request.url();
        const headers = request.headers();
        if (!colesCartConfig.subscriptionKey) {
          const key = headers['ocp-apim-subscription-key'] || headers['Ocp-Apim-Subscription-Key'];
          if (key) {
            colesCartConfig.subscriptionKey = key;
            console.log('[Coles] ✅ Captured subscription key from browser:', key.slice(0, 8) + '...');
          }
        }
        if (url.includes('/api/bff/trolley') && request.method() === 'POST') {
          const body = request.postData();
          console.log('[Coles] 🛒 Browser cart request:', url.replace('https://www.coles.com.au',''), '| body:', (body || '').slice(0, 300));
          const path = url.replace('https://www.coles.com.au', '');
          colesCartConfig.trolleyPath = path.split('?')[0];
        }
        request.continue();
      });
    } catch(e) {
      console.log('[coles] Request interception unavailable:', e.message);
    }
  }

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (store === 'coles') {
    try {
      await page.waitForSelector('a[href*="sign-in"], a[href*="login"], button[aria-label*="Sign in"], [data-testid*="sign-in"], a[href*="auth"]', { timeout: 5000 });
      await page.click('a[href*="sign-in"], a[href*="login"], button[aria-label*="Sign in"], [data-testid*="sign-in"], a[href*="auth"]');
    } catch(e) { console.log("[coles] Could not auto-click sign-in:", e.message); }
  }

  if (store === 'woolworths') {
    try {
      await page.waitForSelector('[data-testid="login-link"], a[href*="securelogin"], a[href*="login"], button[aria-label*="Sign in"], button[aria-label*="Log in"]', { timeout: 5000 });
      await page.click('[data-testid="login-link"], a[href*="securelogin"], a[href*="login"], button[aria-label*="Sign in"], button[aria-label*="Log in"]');
    } catch(e) { console.log("[woolworths] Could not auto-click sign-in:", e.message); }
  }

  loginSessions[store] = { browser, page, status: 'waiting' };
  const timeout = Date.now() + 10 * 60 * 1000;

  return new Promise(async (resolve) => {
    const checkInterval = setInterval(async () => {
      try {
        const url = page.url();
        const cookies = await page.cookies('https://www.' + (store === 'coles' ? 'coles' : 'woolworths') + '.com.au');
        const cookieNames = cookies.map(c => c.name).join(', ');
        const wowToken = cookies.find(c => c.name === 'wow-auth-token' || c.name === 'WOWAuthToken');
        if (store === 'woolworths') {
          console.log("[woolworths] url:", url.slice(0, 80), "| wow-auth-token:", wowToken ? wowToken.value.slice(0,20)+'...' : 'NOT SET', "| all cookies:", cookieNames);
        } else {
          console.log("[" + store + "] url:", url.slice(0, 80), "| cookies:", cookieNames);
        }
        const hasColesAuth = cookies.some(c => c.name === 'accessToken') && cookies.some(c => c.name === 'refreshToken');
        const colesAuthPages = ['/sign-in', '/auth/login', '/auth/callback', 'auth.colesgroupprofile'];
        const onColesHome = url.includes('coles.com.au') && !colesAuthPages.some(p => url.includes(p));
        const onWwwWoolworths = url.startsWith('https://www.woolworths.com.au');
        const wowAuthCookie = cookies.find(c => c.name === 'wow-auth-token');
        const hasWowAuth = !!wowAuthCookie && wowAuthCookie.value.length > 20;
        const isLoggedIn = store === 'coles' ? onColesHome && hasColesAuth : onWwwWoolworths && hasWowAuth;
        if (isLoggedIn) {
          clearInterval(checkInterval);
          let allCookies = [...cookies];
          const extraDomains = store === 'coles'
            ? ['https://www.coles.com.au', 'https://auth.colesgroupprofile.com.au']
            : ['https://www.woolworths.com.au'];
          for (const domain of extraDomains) {
            try {
              const dc = await page.cookies(domain);
              for (const c of dc) {
                if (!allCookies.find(x => x.name === c.name)) allCookies.push(c);
              }
            } catch(e) {}
          }
          const cookieStr = allCookies.map(c => c.name + "=" + c.value).join("; ");
          auth[store].cookies = cookieStr;
          auth[store].loggedIn = true;
          session[store].cookies = cookieStr;
          console.log("[" + store + "] ✅ Login detected! URL:", url, "| Cookies:", allCookies.length);
          saveCookiesToDisk();
          // Start token refresh timers
          if (store === 'woolworths') startWoolworthsTokenRefresh();
          if (store === 'coles') startColesTokenRefresh();
          broadcast('auth-update', { store, loggedIn: true });
          setTimeout(async () => {
            try { await browser.close(); } catch(e) {}
            loginSessions[store] = null;
          }, 2000);
          resolve({ success: true });
        } else if (Date.now() > timeout) {
          clearInterval(checkInterval);
          try { await browser.close(); } catch(e) {}
          loginSessions[store] = null;
          resolve({ success: false, error: 'Login timed out after 10 minutes' });
        }
      } catch(e) {
        clearInterval(checkInterval);
        loginSessions[store] = null;
        resolve({ success: false, error: 'Browser closed: ' + e.message });
      }
    }, 2000);
  });
}

async function woolworthsLogin(email, password) { return puppeteerLogin('woolworths'); }
async function colesLogin(email, password) { return puppeteerLogin('coles'); }

/* ============================================================
   CART — ADD TO WOOLWORTHS
   
   Endpoint: POST /apis/ui/Basket/update
   Body: { items: [{ stockcode, quantity, addoncontents }] }
   
   We try two body formats in case one fails, and log everything.
   ============================================================ */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function addToWoolworthsCart(items) {
  const s = cartState.woolworths;
  s.running = true; s.done = 0; s.total = items.length; s.errors = []; s.log = [];
  broadcastCartUpdate('woolworths');

  // Log what we're working with upfront
  console.log("\n[Woolworths Cart] ═══════════════════════════════");
  console.log("[Woolworths Cart] Starting cart add for", items.length, "items");
  console.log("[Woolworths Cart] Auth loggedIn:", auth.woolworths.loggedIn);
  console.log("[Woolworths Cart] Cookie length:", auth.woolworths.cookies.length);
  console.log("[Woolworths Cart] Cookie preview:", auth.woolworths.cookies.slice(0, 200));

  // Extract key cookies for debugging
  const cookiePairs = auth.woolworths.cookies.split(';').map(c => c.trim());
  const cookieMap = {};
  for (const pair of cookiePairs) {
    const [k, ...rest] = pair.split('=');
    if (k) cookieMap[k.trim()] = rest.join('=');
  }
  const importantCookies = ['wow-auth-token', 'WOWAuthToken', 'BVBRANDID', 'BVBRANDSID', 'SES', '_session_id'];
  for (const name of importantCookies) {
    if (cookieMap[name]) {
      console.log("[Woolworths Cart] Cookie '" + name + "':", cookieMap[name].slice(0, 40) + (cookieMap[name].length > 40 ? '...' : ''));
    } else {
      console.log("[Woolworths Cart] Cookie '" + name + "': NOT PRESENT");
    }
  }
  console.log("[Woolworths Cart] All cookie names:", Object.keys(cookieMap).join(', '));
  console.log("[Woolworths Cart] ───────────────────────────────────\n");

  const cartHeaders = {
    ...BASE_HEADERS,
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://www.woolworths.com.au",
    "Referer": "https://www.woolworths.com.au/shop/cart",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "X-Requested-With": "OnlineShopping.WebApp",
    "Cookie": auth.woolworths.cookies,
  };

  for (const item of items) {
    console.log("\n[Woolworths Cart] ── Item:", item.name);
    console.log("[Woolworths Cart]    stockcode:", item.stockcode, "| type:", typeof item.stockcode);
    console.log("[Woolworths Cart]    quantity:", item.quantity || 1);

    if (!item.stockcode) {
      const msg = item.name + " — no stockcode (was this item from Woolworths search?)";
      console.log("[Woolworths Cart]    ❌ SKIP:", msg);
      s.errors.push(msg);
      s.done++;
      broadcastCartUpdate('woolworths');
      continue;
    }

    // Three endpoints + body formats to try, in order of most likely
    const attempts = [
      {
        label: "Trolley/AddItem (current)",
        url: "https://www.woolworths.com.au/apis/ui/Trolley/AddItem",
        body: JSON.stringify({
          stockcode: Number(item.stockcode),
          quantity: item.quantity || 1,
          addoncontents: [],
        }),
      },
      {
        label: "Trolley/UpdateItem",
        url: "https://www.woolworths.com.au/apis/ui/Trolley/UpdateItem",
        body: JSON.stringify({
          stockcode: Number(item.stockcode),
          quantity: item.quantity || 1,
          addoncontents: [],
        }),
      },
      {
        label: "Basket/update (legacy flat)",
        url: "https://www.woolworths.com.au/apis/ui/Basket/update",
        body: JSON.stringify({
          Quantity: item.quantity || 1,
          StockCode: Number(item.stockcode),
          IsInCart: false,
          IsBundle: false,
        }),
      },
    ];

    let added = false;

    for (const attempt of attempts) {
      try {
        console.log("[Woolworths Cart]    Trying:", attempt.label);
        console.log("[Woolworths Cart]    URL:", attempt.url);
        console.log("[Woolworths Cart]    Body:", attempt.body);

        const res = await fetch(attempt.url, {
          method: "POST",
          headers: cartHeaders,
          body: attempt.body,
          agent,
        });

        const responseText = await res.text();
        console.log("[Woolworths Cart]    Status:", res.status);
        console.log("[Woolworths Cart]    Response headers:", JSON.stringify(Object.fromEntries(res.headers.entries())).slice(0, 300));
        console.log("[Woolworths Cart]    Response body:", responseText.slice(0, 500));

        if (res.ok) {
          console.log("[Woolworths Cart]    ✅ SUCCESS with:", attempt.label);
          s.log.push("✓ " + item.name);
          added = true;
          break;
        }

        if (res.status === 401 || res.status === 403) {
          console.log("[Woolworths Cart]    🔒 Session expired — notifying client to re-login");
          notifyReloginNeeded('woolworths', body.code);
          s.errors.push(item.name + " — session expired, please re-login to Woolworths");
          added = true; // don't retry other formats, it's an auth problem
          break;
        }

        console.log("[Woolworths Cart]    ❌ Failed with:", attempt.label, "— trying next format...");
      } catch(e) {
        console.log("[Woolworths Cart]    ❌ Fetch error:", e.message);
      }
    }

    if (!added) {
      s.errors.push(item.name + " — both request formats failed");
      console.log("[Woolworths Cart]    ❌ All attempts failed for:", item.name);
    }

    s.done++;
    broadcastCartUpdate('woolworths');
    await sleep(1500 + Math.random() * 1500);
  }

  s.running = false;
  broadcastCartUpdate('woolworths');
  console.log("\n[Woolworths Cart] ═══════════════════════════════");
  console.log("[Woolworths Cart] Done.", s.done, "processed,", s.errors.length, "errors");
  if (s.errors.length) console.log("[Woolworths Cart] Errors:", s.errors);
  console.log("[Woolworths Cart] ═══════════════════════════════\n");
}

/* ============================================================
   CART — ADD TO COLES
   ============================================================ */
async function addToColesCart(items) {
  const s = cartState.coles;
  s.running = true; s.done = 0; s.total = items.length; s.errors = []; s.log = [];
  broadcastCartUpdate('coles');

  await refreshColes();

  const tokenMatch = auth.coles.cookies.match(/accessToken=([^;]+)/);
  const accessToken = tokenMatch ? tokenMatch[1] : null;
  console.log("[Coles Cart] accessToken found:", !!accessToken);

  const subKey = colesCartConfig.subscriptionKey;
  console.log("[Coles Cart] subscriptionKey:", subKey ? subKey.slice(0, 8) + "…" : "NOT FOUND");

  if (!subKey) { await refreshColesSubscriptionKey(); }

  const storeMatch = auth.coles.cookies.match(/fulfillmentStoreId=([^;]+)/);
  const storeId = storeMatch ? storeMatch[1] : '7674';
  console.log("[Coles Cart] storeId:", storeId);

  const cartHeaders = {
    ...BASE_HEADERS,
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://www.coles.com.au",
    "Referer": "https://www.coles.com.au/cart",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "Cookie": auth.coles.cookies,
    ...(accessToken ? { "Authorization": "Bearer " + accessToken } : {}),
    ...(colesCartConfig.subscriptionKey ? { "Ocp-Apim-Subscription-Key": colesCartConfig.subscriptionKey } : {}),
  };

  let workingEndpoint = null;
  const endpointsToTry = [
    `https://www.coles.com.au/api/bff/trolley/store/${storeId}`,
    `https://www.coles.com.au/api/bff/trolley`,
    `https://www.coles.com.au/api/2.0/trolley/update`,
  ];

  for (const item of items) {
    if (!item.id) {
      s.errors.push(item.name + " — no product ID");
      s.done++; broadcastCartUpdate('coles'); continue;
    }

    let added = false;
    const endpoints = workingEndpoint ? [workingEndpoint] : endpointsToTry;

    for (const endpoint of endpoints) {
      try {
        let body;
        if (endpoint.includes('2.0/trolley')) {
          body = JSON.stringify({ productId: Number(item.id), quantity: item.quantity || 1, storeId });
        } else {
          body = JSON.stringify({
            ageGateVerified: false, swapBehaviour: false,
            items: [{ productId: Number(item.id), quantity: item.quantity || 1 }],
          });
        }

        const res = await fetch(endpoint, { method: "POST", headers: cartHeaders, body, agent });
        const responseText = await res.text();
        let data = {};
        try { data = JSON.parse(responseText); } catch(e) {}
        console.log("[Coles Cart]", item.name, "| endpoint:", endpoint.replace('https://www.coles.com.au', ''), "| status:", res.status, "| response:", responseText.slice(0, 500));

        if (res.ok) {
          s.log.push("✓ " + item.name); workingEndpoint = endpoint; added = true; break;
        }
        if (res.status === 401 && responseText.includes("subscription key") && !added) {
          console.log("[Coles Cart] Subscription key rejected — forcing re-scrape...");
          colesCartConfig.subscriptionKey = "";
          await refreshColesSubscriptionKey();
          if (colesCartConfig.subscriptionKey) cartHeaders["Ocp-Apim-Subscription-Key"] = colesCartConfig.subscriptionKey;
          else delete cartHeaders["Ocp-Apim-Subscription-Key"];
          const retry = await fetch(endpoint, { method: "POST", headers: cartHeaders, body, agent });
          const retryText = await retry.text();
          console.log("[Coles Cart] Retry status:", retry.status, retryText.slice(0, 120));
          if (retry.ok) { s.log.push("✓ " + item.name); workingEndpoint = endpoint; added = true; break; }
        }
        if (res.status === 401 || res.status === 403) {
          s.errors.push(item.name + " — auth failed (HTTP " + res.status + ") — try re-logging in");
          added = true; break;
        }
      } catch(e) {
        console.log("[Coles Cart] Fetch error:", endpoint, e.message);
      }
    }

    if (!added) {
      s.errors.push(item.name + " — all endpoints failed");
      console.log("[Coles Cart] ❌ Failed to add:", item.name);
    }

    s.done++; broadcastCartUpdate('coles');
    await sleep(1500 + Math.random() * 2000);
  }

  s.running = false;
  broadcastCartUpdate('coles');
  console.log("[Coles Cart] Done.", s.done, "items,", s.errors.length, "errors");
}

/* ============================================================
   SSE + shared list + shared shop
   ============================================================ */
let householdLists = {};   // { code: { coles:[], woolworths:[] } }
let householdShops = {};   // { code: { coles:[], woolworths:[] } }
const sseClients = new Set();
const sseClientCodes = new Map(); // client res -> householdCode

function getList(code) {
  if (!code) return { coles: [], woolworths: [] };
  return householdLists[code] || { coles: [], woolworths: [] };
}
function setList(code, data) {
  if (!code) return;
  householdLists[code] = data;
  saveListsToDisk();
  broadcast('list-update', { code, list: data }, code);
}
function getShop(code) {
  if (!code) return { coles: [], woolworths: [] };
  return householdShops[code] || { coles: [], woolworths: [] };
}
function setShop(code, data) {
  if (!code) return;
  householdShops[code] = data;
  saveShopsToDisk();
  broadcast('shop-update', { code, shopList: data }, code);
}

/* ============================================================
   HOUSEHOLD BATTLES PERSISTENCE
   ============================================================ */
const BATTLES_FILE = DATA_DIR + "/battles.json";
const LISTS_FILE   = DATA_DIR + "/lists.json";
const SHOPS_FILE   = DATA_DIR + "/shops.json";
const HISTORY_FILE = DATA_DIR + "/history.json";
let allHouseholdBattles = {};
let householdHistory = {}; // { code: [ { id, date, coles: {total, items}, woolworths: {total, items} } ] }

function loadBattlesFromDisk() {
  try {
    if (fs.existsSync(BATTLES_FILE)) {
      allHouseholdBattles = JSON.parse(fs.readFileSync(BATTLES_FILE, "utf8"));
      console.log("[Battles] Loaded", Object.keys(allHouseholdBattles).length, "household(s) from disk.");
    }
  } catch(e) { console.warn("[Battles] Could not load battles:", e.message); }
}

function saveBattlesToDisk() {
  try { fs.writeFileSync(BATTLES_FILE, JSON.stringify(allHouseholdBattles, null, 2)); }
  catch(e) { console.warn("[Battles] Could not save battles:", e.message); }
}

function loadListsFromDisk() {
  try {
    if (fs.existsSync(LISTS_FILE)) {
      householdLists = JSON.parse(fs.readFileSync(LISTS_FILE, "utf8"));
      console.log("[Lists] Loaded", Object.keys(householdLists).length, "household(s) from disk.");
    }
  } catch(e) { console.warn("[Lists] Could not load lists:", e.message); }
}

function saveListsToDisk() {
  try { fs.writeFileSync(LISTS_FILE, JSON.stringify(householdLists, null, 2)); }
  catch(e) { console.warn("[Lists] Could not save lists:", e.message); }
}

function loadShopsFromDisk() {
  try {
    if (fs.existsSync(SHOPS_FILE)) {
      householdShops = JSON.parse(fs.readFileSync(SHOPS_FILE, "utf8"));
      console.log("[Shops] Loaded", Object.keys(householdShops).length, "household(s) from disk.");
    }
  } catch(e) { console.warn("[Shops] Could not load shops:", e.message); }
}

function saveShopsToDisk() {
  try { fs.writeFileSync(SHOPS_FILE, JSON.stringify(householdShops, null, 2)); }
  catch(e) { console.warn("[Shops] Could not save shops:", e.message); }
}

function loadHistoryFromDisk() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      householdHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      console.log("[History] Loaded", Object.keys(householdHistory).length, "household(s) from disk.");
    }
  } catch(e) { console.warn("[History] Could not load history:", e.message); }
}

function saveHistoryToDisk() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(householdHistory, null, 2)); }
  catch(e) { console.warn("[History] Could not save history:", e.message); }
}

function getHistory(code) {
  if (!code) return [];
  return householdHistory[code.toUpperCase()] || [];
}

function addHistory(code, entry) {
  if (!code) return;
  const key = code.toUpperCase();
  if (!householdHistory[key]) householdHistory[key] = [];
  householdHistory[key].unshift(entry); // newest first
  // Keep max 50 entries per household
  if (householdHistory[key].length > 50) householdHistory[key] = householdHistory[key].slice(0, 50);
  saveHistoryToDisk();
  broadcast('history-update', { code: key, history: householdHistory[key] }, key);
}

function getBattles(code) {
  if (!code) return [];
  return allHouseholdBattles[code.toUpperCase()] || [];
}

function setBattles(code, groups) {
  if (!code) return;
  allHouseholdBattles[code.toUpperCase()] = groups;
  saveBattlesToDisk();
  // broadcast to all clients with this household code
  broadcast('battles-update', { code: code.toUpperCase(), groups });
}

function broadcast(event, data, targetCode) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      if (targetCode) {
        const clientCode = sseClientCodes.get(client);
        if (clientCode !== targetCode) continue;
      }
      client.write(msg);
    } catch(e) { sseClients.delete(client); sseClientCodes.delete(client); }
  }
}
function broadcastCartUpdate(store) { broadcast('cart-update', { store, state: cartState[store] }); }

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });
}

/* ============================================================
   HTTP SERVER
   ============================================================ */
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

  if (path === "/ping") { res.writeHead(200); res.end("ok"); return; }

  if (path === "/specials") {
    const page = parseInt(parsed.searchParams.get("page") || "1", 10);
    let colesError = null, woolworthsError = null, coles = [], woolworths = [];
    await Promise.all([
      getColesSpecials(page).then(r => { coles = r; }).catch(e => { colesError = e.message; console.error("[Specials] Coles:", e.message); }),
      getWoolworthsSpecials(page).then(r => { woolworths = r; }).catch(e => { woolworthsError = e.message; console.error("[Specials] Woolworths:", e.message); }),
    ]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ coles, woolworths, colesError, woolworthsError }));
    return;
  }

  if (path === "/search") {
    const q     = parsed.searchParams.get("q") || "";
    const page  = parseInt(parsed.searchParams.get("page") || "1", 10);
    const store = parsed.searchParams.get("store") || "both";
    let colesError = null, woolworthsError = null, coles = [], woolworths = [];
    const tasks = [];
    if (store === "both" || store === "coles")
      tasks.push(searchColes(q, page).then(r => { coles = r; }).catch(e => { colesError = e.message; }));
    if (store === "both" || store === "woolworths")
      tasks.push(searchWoolworths(q, page).then(r => { woolworths = r; }).catch(e => { woolworthsError = e.message; }));
    await Promise.all(tasks);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ coles, woolworths, colesError, woolworthsError }));
    return;
  }

  if (path === "/battles") {
    const code = parsed.searchParams.get("code") || "";
    if (!code) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "No household code" })); return; }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ groups: getBattles(code) }));
      return;
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      setBattles(code, body.groups || []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  if (path === "/list") {
    const code = parsed.searchParams.get("code") || "";
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getList(code)));
      return;
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      if (code) setList(code, body);
      res.writeHead(200); res.end("ok");
      return;
    }
  }

  if (path === "/shop") {
    const code = parsed.searchParams.get("code") || "";
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getShop(code)));
      return;
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      if (code) setShop(code, body);
      res.writeHead(200); res.end("ok");
      return;
    }
  }

  if (path === "/history") {
    const code = parsed.searchParams.get("code") || "";
    if (!code) { res.writeHead(400); res.end("No code"); return; }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ history: getHistory(code) }));
      return;
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      if (body.entry) addHistory(code, body.entry);
      res.writeHead(200); res.end("ok");
      return;
    }
  }

  if (path === "/auth/status") {
    const code = parsed.searchParams.get("code") || "";
    if (code) applyHouseholdAuth(code);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      coles:      { loggedIn: auth.coles.loggedIn,      email: auth.coles.email },
      woolworths: { loggedIn: auth.woolworths.loggedIn, email: auth.woolworths.email },
    }));
    return;
  }

  if (path === "/auth/login" && req.method === "POST") {
    const { store, code } = await parseBody(req);
    if (code) applyHouseholdAuth(code);
    if (!store || !auth[store]) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Unknown store" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ browserOpening: true }));
    puppeteerLogin(store).then(result => {
      if (!result.success) broadcast('auth-update', { store, loggedIn: false, error: result.error });
    }).catch(e => {
      broadcast('auth-update', { store, loggedIn: false, error: e.message });
    });
    return;
  }

  if (path === "/auth/set-cookies" && req.method === "POST") {
    const { store, cookies, code } = await parseBody(req);
    if (!store || !auth[store] || !cookies) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Need store and cookies" })); return; }
    if (code) { activeHouseholdCode = code; }
    auth[store].cookies = cookies;
    auth[store].loggedIn = true;
    session[store].cookies = cookies;
    saveCookiesToDisk();
    broadcast('auth-update', { store, loggedIn: true });
    console.log("[Auth] Manually set cookies for", store, "(household:", activeHouseholdCode || "global", ")");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, store, cookieCount: cookies.split(";").length }));
    return;
  }

  if (path === "/auth/logout" && req.method === "POST") {
    const { store, code } = await parseBody(req);
    if (code) applyHouseholdAuth(code);
    if (auth[store]) { auth[store].cookies = ""; auth[store].loggedIn = false; saveCookiesToDisk(); }
    broadcast('auth-update', { store, loggedIn: false });
    res.writeHead(200); res.end("ok");
    return;
  }

  if (path === "/auth/validate" && req.method === "POST") {
    const { store, code } = await parseBody(req);
    if (code) applyHouseholdAuth(code);
    if (!store || !auth[store]) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Unknown store" })); return; }
    const valid = await validateSavedCookies(store);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ store, valid, loggedIn: auth[store].loggedIn }));
    broadcast('auth-update', { store, loggedIn: auth[store].loggedIn });
    return;
  }

  /* ── REMOTE LOGIN: generate a one-time token and return the login URL ── */
  if (path === "/auth/remote-start" && req.method === "POST") {
    const { store, code } = await parseBody(req);
    if (!store || !['coles','woolworths'].includes(store)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown store" })); return;
    }
    if (code) applyHouseholdAuth(code);
    const token = require('crypto').randomBytes(16).toString('hex');
    remoteSessions[token] = { store, code: code || activeHouseholdCode, created: Date.now(), used: false };
    setTimeout(() => { delete remoteSessions[token]; }, 15 * 60 * 1000);
    const loginUrl = `http://${req.headers.host}/auth/remote-login?token=${token}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ token, loginUrl }));
    return;
  }

  /* ── REMOTE LOGIN PAGE: instructions + cookie paste UI ── */
  if (path === "/auth/remote-login" && req.method === "GET") {
    const token = parsed.searchParams.get("token");
    const rs = remoteSessions[token];
    if (!rs || rs.used) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:sans-serif;padding:32px;text-align:center;background:#111;color:white"><h2>❌ Link expired</h2><p>Generate a new one from the app.</p></body></html>`);
      return;
    }
    const store = rs.store;
    const storeName = store === 'woolworths' ? 'Woolworths' : 'Coles';
    const storeColor = store === 'woolworths' ? '#00843d' : '#e01a22';
    const storeUrl = store === 'woolworths' ? 'https://www.woolworths.com.au' : 'https://www.coles.com.au';
    const storeLoginUrl = store === 'woolworths' ? 'https://www.woolworths.com.au/shop/securelogin' : 'https://www.coles.com.au/sign-in';
    // The cookie name we need
    const cookieName = store === 'woolworths' ? 'wow-auth-token' : 'accessToken';
    // JS snippet user runs in devtools on the store's site after logging in
    const snippet = store === 'woolworths'
      ? `fetch('http://${req.headers.host}/auth/cookie-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${token}',store:'woolworths',cookies:document.cookie})})`
      : `fetch('http://${req.headers.host}/auth/cookie-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${token}',store:'coles',cookies:document.cookie})})`;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Sign in to ${storeName}</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111;color:white;min-height:100vh;padding:20px}
        .wrap{max-width:480px;margin:0 auto;padding-top:24px}
        h1{font-size:1.3rem;margin-bottom:4px}
        .sub{color:#aaa;font-size:.875rem;margin-bottom:24px}
        .step{background:#1e1e1e;border-radius:12px;padding:16px;margin-bottom:12px;display:flex;gap:12px;align-items:flex-start}
        .num{background:${storeColor};color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.9rem;flex-shrink:0;margin-top:1px}
        .step-title{font-weight:600;font-size:.95rem;margin-bottom:4px}
        .step-sub{color:#aaa;font-size:.8rem;line-height:1.4}
        .btn{display:block;background:${storeColor};color:white;text-decoration:none;padding:13px 16px;border-radius:10px;font-size:1rem;font-weight:700;text-align:center;margin-top:8px}
        .code-wrap{position:relative;margin-top:8px}
        .code{background:#0d0d0d;border:1px solid #333;border-radius:8px;padding:10px 40px 10px 10px;font-family:monospace;font-size:.72rem;word-break:break-all;color:#7ec8e3;line-height:1.5;cursor:pointer}
        .copy-btn{position:absolute;top:6px;right:6px;background:#333;border:none;color:white;border-radius:6px;padding:4px 8px;font-size:.75rem;cursor:pointer}
        .copy-btn:active{background:#555}
        .paste-area{width:100%;background:#0d0d0d;border:1px solid #333;border-radius:8px;padding:10px;color:#aaa;font-family:monospace;font-size:.8rem;resize:vertical;min-height:60px;margin-top:8px}
        .submit-btn{width:100%;background:${storeColor};color:white;border:none;padding:12px;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;margin-top:8px}
        .submit-btn:disabled{opacity:.5;cursor:not-allowed}
        .result{display:none;text-align:center;padding:24px}
        .hint{color:#555;font-size:.75rem;margin-top:6px}
      </style>
    </head><body><div class="wrap">
      <h1>${store === 'woolworths' ? '🟢' : '🔴'} Sign in to ${storeName}</h1>
      <p class="sub">Follow these steps to link your ${storeName} account.</p>

      <div class="step">
        <div class="num">1</div>
        <div>
          <div class="step-title">Sign in to ${storeName}</div>
          <div class="step-sub">Open the link below and sign in with your ${storeName} account. Keep this tab open.</div>
          <a class="btn" href="${storeLoginUrl}" target="_blank">Open ${storeName} sign-in ↗</a>
        </div>
      </div>

      <div class="step">
        <div class="num">2</div>
        <div>
          <div class="step-title">Open DevTools Console</div>
          <div class="step-sub">On the ${storeName} tab after signing in:<br>
            <strong>Desktop:</strong> Press F12 → Console tab<br>
            <strong>iPhone/iPad:</strong> Enable Web Inspector in Settings → Safari → Advanced, then connect to Mac and use Safari's Develop menu<br>
            <strong>Android:</strong> Open Chrome on desktop → chrome://inspect</div>
        </div>
      </div>

      <div class="step">
        <div class="num">3</div>
        <div>
          <div class="step-title">Run this snippet in the console</div>
          <div class="step-sub">Copy and paste into the console on <strong>${storeUrl}</strong></div>
          <div class="code-wrap">
            <div class="code" id="snippet">${snippet.replace(/</g,'&lt;')}</div>
            <button class="copy-btn" onclick="copySnippet()">Copy</button>
          </div>
          <p class="hint">Tap the code box or the Copy button to copy it.</p>
        </div>
      </div>

      <div class="step">
        <div class="num">4</div>
        <div>
          <div class="step-title">Or paste cookies manually</div>
          <div class="step-sub">If the snippet doesn't work, run <code style="background:#1a1a1a;padding:2px 5px;border-radius:4px">document.cookie</code> in the console on ${storeUrl}, copy the result, and paste it here:</div>
          <textarea class="paste-area" id="cookiePaste" placeholder="Paste cookie string here..."></textarea>
          <button class="submit-btn" id="submitBtn" onclick="submitCookies()">Submit Cookies</button>
        </div>
      </div>

      <div class="result" id="result"></div>
    </div>
    <script>
      function copySnippet() {
        navigator.clipboard.writeText(${JSON.stringify(snippet)}).then(() => {
          document.querySelector('.copy-btn').textContent = '✓ Copied';
          setTimeout(() => document.querySelector('.copy-btn').textContent = 'Copy', 2000);
        }).catch(() => {
          // fallback
          const el = document.getElementById('snippet');
          const range = document.createRange();
          range.selectNode(el);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        });
      }
      document.getElementById('snippet').onclick = copySnippet;

      async function submitCookies() {
        const cookies = document.getElementById('cookiePaste').value.trim();
        if (!cookies) return;
        document.getElementById('submitBtn').disabled = true;
        document.getElementById('submitBtn').textContent = 'Submitting…';
        try {
          const r = await fetch('/auth/cookie-submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: ${JSON.stringify(token)}, store: ${JSON.stringify(store)}, cookies })
          });
          const d = await r.json();
          if (d.ok) {
            document.querySelector('.wrap').innerHTML = '<div style="text-align:center;padding:40px"><div style="font-size:3rem">✅</div><h2 style="margin:12px 0 8px">Signed in!</h2><p style="color:#aaa">You can close this tab.</p></div>';
          } else {
            document.getElementById('submitBtn').disabled = false;
            document.getElementById('submitBtn').textContent = 'Submit Cookies';
            alert('Could not find auth token in cookies. Make sure you are signed in to ${storeName} and copied from the right tab.\\n\\nLooking for: ${cookieName}');
          }
        } catch(e) {
          document.getElementById('submitBtn').disabled = false;
          document.getElementById('submitBtn').textContent = 'Submit Cookies';
          alert('Error: ' + e.message);
        }
      }

      // Auto-poll in case snippet ran successfully
      var poll = setInterval(async function() {
        try {
          var r = await fetch('/auth/proxy-check?token=${token}');
          var d = await r.json();
          if (d.done) {
            clearInterval(poll);
            document.querySelector('.wrap').innerHTML = '<div style="text-align:center;padding:40px"><div style="font-size:3rem">✅</div><h2 style="margin:12px 0 8px">Signed in to ${storeName}!</h2><p style="color:#aaa">You can close this tab.</p></div>';
          }
        } catch(e) {}
      }, 2000);
      setTimeout(() => clearInterval(poll), 15 * 60 * 1000);
    </script>
    </body></html>`);
    return;
  }

  /* ── COOKIE SUBMIT: receive pasted/snippet cookies and save them ── */
  if (path === "/auth/cookie-submit" && req.method === "POST") {
    const { token, store, cookies } = await parseBody(req);
    const rs = remoteSessions[token];
    if (!rs || rs.used) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: !!(rs?.used) })); return;
    }
    // Check we got the required token
    const hasWow = store === 'woolworths' && /wow-auth-token=\S{20,}/.test(cookies);
    const hasColes = store === 'coles' && /accessToken=\S{20,}/.test(cookies);
    if (!hasWow && !hasColes) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: 'missing_token' })); return;
    }
    rs.used = true;
    if (rs.code) applyHouseholdAuth(rs.code);
    auth[store].cookies = cookies;
    auth[store].loggedIn = true;
    session[store].cookies = cookies;
    saveCookiesToDisk();
    if (store === 'woolworths') startWoolworthsTokenRefresh();
    if (store === 'coles') startColesTokenRefresh();
    broadcast('auth-update', { store, loggedIn: true });
    console.log('[Auth] Cookie-submit captured auth for', store);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  /* ── PROXY CHECK ── */
  if (path === "/auth/proxy-check") {
    const token = parsed.searchParams.get("token");
    const rs = remoteSessions[token];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ done: !!(rs && rs.used) }));
    return;
  }
  if (path === "/cart/add" && req.method === "POST") {
    const body = await parseBody(req);
    const store = body.store;
    const items = body.items || []; // always use what was sent — never fall back to sharedList
    if (!auth[store] || !auth[store].loggedIn) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not logged in" })); return; }
    if (cartState[store].running) { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Already running" })); return; }
    if (!items.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "List is empty" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: true, total: items.length }));
    if (store === "woolworths") addToWoolworthsCart(items);
    else if (store === "coles") addToColesCart(items);
    return;
  }

  if (path === "/cart/status") {
    const store = parsed.searchParams.get("store");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(store ? cartState[store] : cartState));
    return;
  }

  if (path === "/events") {
    const code = parsed.searchParams.get("code") || "";
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    res.write("event: connected\ndata: {}\n\n");
    sseClients.add(res);
    if (code) sseClientCodes.set(res, code);
    req.on("close", () => { sseClients.delete(res); sseClientCodes.delete(res); });
    return;
  }

  if (path === "/shutdown" && req.method === "POST") {
    res.writeHead(200); res.end("ok");
    require("child_process").exec("shutdown /s /t 5");
    return;
  }

  if (path === "/imgproxy") {
    const imgUrl = parsed.searchParams.get("url");
    if (!imgUrl) { res.writeHead(400); res.end(); return; }
    try {
      const ir = await fetch(imgUrl, { agent });
      if (!ir.ok) { res.writeHead(502); res.end(); return; }
      const buf = Buffer.from(await ir.arrayBuffer());
      res.writeHead(200, { "Content-Type": ir.headers.get("content-type") || "image/jpeg", "Cache-Control": "public, max-age=86400" });
      res.end(buf);
    } catch(e) { res.writeHead(502); res.end(); }
    return;
  }

  if (path === "/") {
    try { res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync("index.html")); }
    catch(e) { res.writeHead(404); res.end("index.html not found"); }
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, async () => {
  console.log("Basket Battle running on port", PORT);
  loadCookiesFromDisk();
  loadBattlesFromDisk();
  loadListsFromDisk();
  loadShopsFromDisk();
  loadHistoryFromDisk();
  setTimeout(async () => {
    for (const store of ['coles', 'woolworths']) {
      if (auth[store].loggedIn && auth[store].cookies) {
        await validateSavedCookies(store);
        broadcast('auth-update', { store, loggedIn: auth[store].loggedIn });
        if (auth[store].loggedIn) {
          if (store === 'woolworths') startWoolworthsTokenRefresh();
          if (store === 'coles') startColesTokenRefresh();
        }
      }
    }
  }, 2000);
});
