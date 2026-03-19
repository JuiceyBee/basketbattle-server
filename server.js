const http = require("http");
const https = require("https");
const fs = require("fs");

// v2 — invite/access system + Upstash persistence
const PORT = 3000;
const ADMIN_KEY = process.env.BB_ADMIN_KEY || "";
console.log('[Startup] ADMIN_KEY set:', !!ADMIN_KEY, '| UPSTASH set:', !!process.env.UPSTASH_REDIS_REST_URL);
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
const COOKIE_FILE = "./auth-cookies.json";
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
    session.coles.buildId = "20260313.2-45e3750c9049ed9b17722f2e705a42cde61db1c8";
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
   UPSTASH REDIS — persistent storage that survives Render spin-downs.
   Uses the Upstash REST API (fetch-based, no npm package needed).
   Set these two env vars in your Render service:
     UPSTASH_REDIS_REST_URL   e.g. https://xxxxx.upstash.io
     UPSTASH_REDIS_REST_TOKEN your Upstash REST token
   ============================================================ */
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function upstashGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json();
    if (data.result === null || data.result === undefined) return null;
    // Parse once — if result is still a string (double-encoded legacy data), parse again
    let parsed;
    try { parsed = JSON.parse(data.result); } catch { return data.result; }
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch {}
    }
    return parsed;
  } catch(e) {
    console.warn("[Upstash] GET error for", key, ":", e.message);
    return null;
  }
}

async function upstashSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    // Store as single JSON string — not double encoded
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(JSON.stringify(value)),
    });
  } catch(e) {
    console.warn("[Upstash] SET error for", key, ":", e.message);
  }
}

async function upstashDel(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
  } catch(e) {
    console.warn("[Upstash] DEL error for", key, ":", e.message);
  }
}

/* ============================================================
   INVITE + ACCESS TOKEN SYSTEM
   Upstash keys:
     bb:invite:{CODE}  → "pending" (single-use, burned on redeem)
     bb:token:{TOKEN}  → "valid"   (permanent, issued on redeem)

   Admin creates codes via POST /admin/invite { adminKey, count }
   App redeems via POST /redeem-invite { code } → { ok, token }
   Every protected route checks x-bb-access header against bb:token:{TOKEN}
   ============================================================ */

function randomCode(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function isValidToken(token) {
  if (!token) {
    console.log('[Gate] No token provided');
    return false;
  }
  try {
    const val = await upstashGet(`bb:token:${token}`);
    console.log('[Gate] Token:', token.slice(0,8) + '…', '| Upstash result:', val);
    return val === 'valid' || val === '"valid"';
  } catch (e) {
    console.log('[Gate] isValidToken error:', e.message);
    return false;
  }
}

async function createInviteCodes(count) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = randomCode(8);
    await upstashSet(`bb:invite:${code}`, 'pending');
    codes.push(code);
  }
  return codes;
}

async function redeemInviteCode(code) {
  const val = await upstashGet(`bb:invite:${code}`);
  if (!val) return { ok: false, error: 'Invalid code' };
  if (val === 'used') return { ok: false, error: 'Code already used' };
  // Burn the invite code
  await upstashSet(`bb:invite:${code}`, 'used');
  // Issue a permanent token
  const token = randomCode(32);
  await upstashSet(`bb:token:${token}`, 'valid');
  // Store token against code so admin page can discover newly redeemed users
  await upstashSet(`bb:invite:${code}:token`, token);
  console.log('[Invite] Code', code, 'redeemed — token issued');
  return { ok: true, token };
}

/* ============================================================
   SSE + shared list + shared shop
   ============================================================ */
let householdLists = {};
let householdShops = {};
const sseClients = new Set();
const sseClientCodes = new Map();

// These stubs are called from old sync paths — now no-ops since we write to Upstash directly
function saveListsToDisk() {}
function saveShopsToDisk() {}

async function getList(code) {
  if (!code) return { coles: [], woolworths: [] };
  const key = code.toUpperCase();
  if (householdLists[key]) return householdLists[key];
  const stored = await upstashGet(`bb:list:${key}`);
  householdLists[key] = stored || { coles: [], woolworths: [] };
  return householdLists[key];
}
async function setList(code, data) {
  if (!code) return;
  const key = code.toUpperCase();
  householdLists[key] = data;
  await upstashSet(`bb:list:${key}`, data);
  broadcast('list-update', { code: key, list: data }, key);
}
async function getShop(code) {
  if (!code) return { coles: [], woolworths: [] };
  const key = code.toUpperCase();
  if (householdShops[key]) return householdShops[key];
  const stored = await upstashGet(`bb:shop:${key}`);
  householdShops[key] = stored || { coles: [], woolworths: [] };
  return householdShops[key];
}
async function setShop(code, data) {
  if (!code) return;
  const key = code.toUpperCase();
  householdShops[key] = data;
  await upstashSet(`bb:shop:${key}`, data);
  broadcast('shop-update', { code: key, shopList: data }, key);
}

/* ============================================================
   HOUSEHOLD BATTLES + HISTORY PERSISTENCE — Upstash Redis
   ============================================================ */
let allHouseholdBattles = {};
let householdHistory    = {};

// No-ops — startup sequence calls these but Upstash loads on demand
function loadBattlesFromDisk() { if (!UPSTASH_URL) console.warn("[Upstash] No UPSTASH_REDIS_REST_URL set — data will not persist across restarts!"); }
function loadListsFromDisk()   {}
function loadShopsFromDisk()   {}
function loadHistoryFromDisk() {}

async function getHistory(code) {
  if (!code) return [];
  const key = code.toUpperCase();
  if (householdHistory[key]) return householdHistory[key];
  const stored = await upstashGet(`bb:history:${key}`);
  householdHistory[key] = stored || [];
  return householdHistory[key];
}

async function addHistory(code, entry) {
  if (!code) return;
  const key = code.toUpperCase();
  const existing = await getHistory(key);
  existing.unshift(entry);
  if (existing.length > 50) existing.length = 50;
  householdHistory[key] = existing;
  await upstashSet(`bb:history:${key}`, existing);
  broadcast('history-update', { code: key, history: existing }, key);
}

async function getBattles(code) {
  if (!code) return [];
  const key = code.toUpperCase();
  if (allHouseholdBattles[key] !== undefined) return allHouseholdBattles[key];
  const stored = await upstashGet(`bb:battles:${key}`);
  allHouseholdBattles[key] = stored || [];
  return allHouseholdBattles[key];
}

async function setBattles(code, groups) {
  if (!code) return;
  const key = code.toUpperCase();
  allHouseholdBattles[key] = groups;
  await upstashSet(`bb:battles:${key}`, groups);
  broadcast('battles-update', { code: key, groups });
}

// ── Shared cart ───────────────────────────────────────────────────────────────
// Mirrors the app's cart shape: { createdAt, items: [...] }
// Stored per household so both users see the same cart state.
let householdCarts = {};

async function getCart(code) {
  if (!code) return null;
  const key = code.toUpperCase();
  if (householdCarts[key] !== undefined) return householdCarts[key];
  const stored = await upstashGet(`bb:cart:${key}`);
  householdCarts[key] = stored || null;
  return householdCarts[key];
}

async function setCart(code, cart) {
  if (!code) return;
  const key = code.toUpperCase();
  householdCarts[key] = cart;
  await upstashSet(`bb:cart:${key}`, cart);
}

// ── Feedback ──────────────────────────────────────────────────────────────────
// Stored as a single list under bb:feedback, newest first, capped at 200.

async function getFeedback() {
  const stored = await upstashGet('bb:feedback');
  return stored || [];
}

async function addFeedback(entry) {
  const existing = await getFeedback();
  existing.unshift(entry);
  if (existing.length > 200) existing.length = 200;
  await upstashSet('bb:feedback', existing);
  // Fire push notification to all registered admin subscriptions
  sendPushToAll(`New feedback from ${entry.householdCode || 'unknown'}`, entry.message).catch(() => {});
}

// ── Web Push (VAPID) -- no npm, pure Node.js crypto ───────────────────────────
// Subscriptions stored in Upstash under bb:push-subs as an array.
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || 'mailto:admin@basketbattle.app';

async function getPushSubs() {
  const stored = await upstashGet('bb:push-subs');
  return stored || [];
}
async function savePushSubs(subs) {
  await upstashSet('bb:push-subs', subs);
}
async function addPushSub(sub) {
  const subs = await getPushSubs();
  // Avoid duplicates by endpoint
  const filtered = subs.filter(s => s.endpoint !== sub.endpoint);
  filtered.push(sub);
  await savePushSubs(filtered);
}
async function removePushSub(endpoint) {
  const subs = await getPushSubs();
  await savePushSubs(subs.filter(s => s.endpoint !== endpoint));
}

// Build a VAPID JWT and send a Web Push notification
async function sendPush(subscription, title, body) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const endpoint = new URL(subscription.endpoint);
    const audience = endpoint.origin;

    // ── Build VAPID JWT ──────────────────────────────────────────────────────
    const header  = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: VAPID_SUBJECT,
    })).toString('base64url');

    const signingInput = `${header}.${payload}`;
    const privKeyDer   = Buffer.from(VAPID_PRIVATE_KEY, 'base64url');

    // Import the raw EC private key
    const { privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    // We need to build a proper PKCS8 DER from the raw key bytes
    // PKCS8 EC key header for prime256v1 (fixed prefix)
    const pkcs8Prefix = Buffer.from(
      '308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420',
      'hex'
    );
    const pkcs8Key = Buffer.concat([pkcs8Prefix, privKeyDer,
      Buffer.from('a144034200', 'hex'),
      Buffer.from(VAPID_PUBLIC_KEY, 'base64url'),
    ]);

    const ecKey = crypto.createPrivateKey({ key: pkcs8Key, format: 'der', type: 'pkcs8' });
    const sig   = crypto.sign('SHA256', Buffer.from(signingInput), { key: ecKey, dsaEncoding: 'ieee-p1363' });
    const jwt   = `${signingInput}.${sig.toString('base64url')}`;

    // ── Build notification payload ───────────────────────────────────────────
    const notifPayload = JSON.stringify({ title, body, icon: '/icon.png', badge: '/icon.png' });

    // ── Encrypt payload using Web Push encryption (RFC 8291) ────────────────
    const { p256dh, auth: authSecret } = subscription.keys;
    const recipientPublicKey = Buffer.from(p256dh, 'base64url');
    const authSecretBuf      = Buffer.from(authSecret, 'base64url');

    // Generate sender EC key pair
    const { privateKey: senderPriv, publicKey: senderPub } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const senderPubRaw = senderPub.export({ type: 'spki', format: 'der' }).slice(-65);

    // ECDH shared secret
    const recipKey = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
        recipientPublicKey,
      ]),
      format: 'der', type: 'spki',
    });
    const sharedSecret = crypto.diffieHellman({ privateKey: senderPriv, publicKey: recipKey });

    // HKDF-SHA256 helper
    function hkdf(salt, ikm, info, len) {
      const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
      const infoWithOne = Buffer.concat([Buffer.from(info), Buffer.from([1])]);
      return crypto.createHmac('sha256', prk).update(infoWithOne).digest().slice(0, len);
    }

    const salt         = crypto.randomBytes(16);
    const prk          = crypto.createHmac('sha256', authSecretBuf)
      .update(Buffer.concat([sharedSecret, Buffer.alloc(1, 0), Buffer.from('Content-Encoding: auth\0'), Buffer.alloc(1, 1)]))
      .digest();

    // Content encryption key and nonce
    const keyInfoBuf   = Buffer.concat([Buffer.from('Content-Encoding: aesgcm\0'), Buffer.alloc(1, 0), senderPubRaw, recipientPublicKey]);
    const nonceInfoBuf = Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.alloc(1, 0), senderPubRaw, recipientPublicKey]);
    const contentKey   = hkdf(salt, prk, keyInfoBuf, 16);
    const nonce        = hkdf(salt, prk, nonceInfoBuf, 12);

    // Encrypt
    const cipher = crypto.createCipheriv('aes-128-gcm', contentKey, nonce);
    const padded = Buffer.concat([Buffer.alloc(2, 0), Buffer.from(notifPayload)]);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

    // ── POST to push endpoint ────────────────────────────────────────────────
    const pushHeaders = {
      'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aesgcm',
      'Encryption': `salt=${salt.toString('base64url')}`,
      'Crypto-Key': `dh=${senderPubRaw.toString('base64url')};p256ecdsa=${VAPID_PUBLIC_KEY}`,
      'TTL': '86400',
      'Content-Length': String(encrypted.length),
    };

    await new Promise((resolve, reject) => {
      const req = https.request(subscription.endpoint, { method: 'POST', headers: pushHeaders, agent }, (res) => {
        res.resume();
        if (res.statusCode === 410 || res.statusCode === 404) {
          // Subscription expired — remove it
          removePushSub(subscription.endpoint).catch(() => {});
        }
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.write(encrypted);
      req.end();
    });
  } catch(e) {
    console.warn('[Push] sendPush error:', e.message);
  }
}

async function sendPushToAll(title, body) {
  const subs = await getPushSubs();
  if (!subs.length) return;
  await Promise.allSettled(subs.map(sub => sendPush(sub, title, body)));
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

  // ── Admin: generate invite codes ──────────────────────────────────────────
  if (path === "/admin/invite" && req.method === "POST") {
    const body = await parseBody(req);
    if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    const count = Math.min(Math.max(parseInt(body.count) || 1, 1), 50);
    const codes = await createInviteCodes(count);
    console.log('[Admin] Generated', codes.length, 'invite code(s)');
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, codes })); return;
  }

  // ── Admin: check if an invite code has been redeemed ─────────────────────
  if (path === "/admin/check-invite" && req.method === "POST") {
    const body = await parseBody(req);
    if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    const code = (body.code || '').trim().toUpperCase();
    const val  = await upstashGet(`bb:invite:${code}`);
    // If used, also return the token that was issued for it
    const token = val === 'used' ? await upstashGet(`bb:invite:${code}:token`) : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: val || 'unknown', token: token || null })); return;
  }

  // ── Admin: revoke a permanent token ──────────────────────────────────────
  if (path === "/admin/revoke" && req.method === "POST") {
    const body = await parseBody(req);
    if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    const token = (body.token || '').trim();
    if (token) {
      await upstashDel(`bb:token:${token}`);
      console.log('[Admin] Revoked token', token.slice(0, 8) + '…');
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true })); return;
  }

  // ── Admin: restore a revoked token ───────────────────────────────────────
  if (path === "/admin/restore" && req.method === "POST") {
    const body = await parseBody(req);
    if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    const token = (body.token || '').trim();
    if (token) {
      await upstashSet(`bb:token:${token}`, 'valid');
      console.log('[Admin] Restored token', token.slice(0, 8) + '…');
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true })); return;
  }

  // ── Admin: load users + pending from Upstash ─────────────────────────────
  if (path === "/admin/data" && req.method === "POST") {
    const body = await parseBody(req);
    if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    const stored = await upstashGet('bb:admin-data') || { users: [], pending: [] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, users: stored.users || [], pending: stored.pending || [] })); return;
  }

  // ── Admin: save users + pending to Upstash ────────────────────────────────
  if (path === "/admin/data/save" && req.method === "POST") {
    const body = await parseBody(req);
    if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    await upstashSet('bb:admin-data', { users: body.users || [], pending: body.pending || [] });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true })); return;
  }

  // ── Admin: get all feedback ───────────────────────────────────────────────
  if (path === "/admin/feedback" && req.method === "POST") {
    const body = await parseBody(req);
    if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    const feedback = await getFeedback();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, feedback })); return;
  }

  // ── Admin: delete a feedback entry ───────────────────────────────────────
  if (path === "/admin/feedback/delete" && req.method === "POST") {
    const body = await parseBody(req);
    if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    const existing = await getFeedback();
    const filtered = existing.filter(f => f.id !== body.id);
    await upstashSet('bb:feedback', filtered);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true })); return;
  }

  // ── Redeem invite code → permanent token ─────────────────────────────────
  if (path === "/redeem-invite" && req.method === "POST") {
    const body = await parseBody(req);
    const code = (body.code || '').trim().toUpperCase();
    if (!code) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: 'Invalid code' })); return;
    }
    const result = await redeemInviteCode(code);
    res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result)); return;
  }

  if (path === "/admin-panel" && req.method === "GET") {
    const urlKey = parsed.searchParams.get("key") || "";
    if (!ADMIN_KEY || urlKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end(`<html><body style="background:#0a0c10;color:#ef4444;font-family:monospace;padding:40px;text-align:center"><h2>403 Forbidden</h2></body></html>`);
      return;
    }
    const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="BB Admin">
<meta name="theme-color" content="#0a0c10">
<title>BasketBattle Admin</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&display=swap');
  :root {
    --bg:#0a0c10;--surface:#111318;--surface2:#181b22;--border:#1e2230;
    --gold:#f59e0b;--gold2:#fbbf24;--red:#ef4444;--green:#22c55e;
    --muted:#4b5563;--sub:#6b7280;--text:#f1f5f9;--text2:#94a3b8;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'DM Mono',monospace;min-height:100vh;padding-bottom:env(safe-area-inset-bottom)}
  #offline-banner{display:none;position:fixed;top:0;left:0;right:0;background:var(--red);color:#fff;text-align:center;padding:10px;font-size:13px;font-weight:500;z-index:9999;letter-spacing:.05em}
  body.offline #offline-banner{display:block}
  body.offline .app{pointer-events:none;opacity:.4;filter:grayscale(1)}
  .header{border-bottom:1px solid var(--border);padding:20px 24px;padding-top:calc(20px + env(safe-area-inset-top));display:flex;align-items:center;gap:14px;position:sticky;top:0;background:var(--bg);z-index:10}
  .header-logo{font-size:26px}
  .header-title{font-family:'Syne',sans-serif;font-size:20px;font-weight:800;color:var(--gold);letter-spacing:-.5px}
  .header-sub{font-size:11px;color:var(--muted);margin-top:2px}
  .online-dot{width:8px;height:8px;border-radius:50%;background:var(--green);margin-left:auto;box-shadow:0 0 8px var(--green);flex-shrink:0}
  .online-dot.offline{background:var(--red);box-shadow:0 0 8px var(--red)}
  .app{max-width:600px;margin:0 auto;padding:24px 16px 60px}
  .section{background:var(--surface);border:1px solid var(--border);border-radius:14px;margin-bottom:20px;overflow:hidden}
  .section-header{padding:14px 18px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
  .section-title{font-family:'Syne',sans-serif;font-size:13px;font-weight:700;color:var(--text);text-transform:uppercase;letter-spacing:1px}
  .section-body{padding:16px 18px}
  label{display:block;font-size:11px;color:var(--sub);margin-bottom:6px;letter-spacing:.05em;text-transform:uppercase}
  input[type="text"]{width:100%;background:var(--surface2);border:1.5px solid var(--border);border-radius:8px;padding:11px 14px;color:var(--text);font-family:'DM Mono',monospace;font-size:14px;outline:none;transition:border-color .15s}
  input:focus{border-color:var(--gold)}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:8px;border:none;font-family:'DM Mono',monospace;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .15s,transform .1s;white-space:nowrap}
  .btn:active{transform:scale(.97)}
  .btn:disabled{opacity:.4;cursor:not-allowed}
  .btn-gold{background:var(--gold);color:#1a1100}
  .btn-gold:hover:not(:disabled){background:var(--gold2)}
  .btn-ghost{background:transparent;border:1.5px solid var(--border);color:var(--text2)}
  .btn-ghost:hover:not(:disabled){border-color:var(--gold);color:var(--gold)}
  .btn-red{background:transparent;border:1.5px solid #3f1212;color:#f87171;font-size:12px;padding:6px 12px}
  .btn-red:hover:not(:disabled){background:#3f1212}
  .btn-sm{padding:6px 12px;font-size:12px}
  #toast{position:fixed;bottom:calc(28px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%) translateY(20px);background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:11px 20px;font-size:13px;color:var(--text);opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;white-space:nowrap;z-index:1000}
  #toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  #toast.success{border-color:var(--green);color:var(--green)}
  #toast.error{border-color:var(--red);color:var(--red)}
  .name-slots{display:flex;flex-direction:column;gap:8px}
  .name-slot{display:flex;align-items:center;gap:8px}
  .name-slot input{flex:1;margin:0}
  .slot-remove{background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:4px 6px;line-height:1;border-radius:6px;transition:color .15s;flex-shrink:0}
  .slot-remove:hover{color:var(--red)}
  .users-list{display:flex;flex-direction:column;gap:8px}
  .user-row{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:12px;animation:fadeIn .2s ease}
  @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  .user-avatar{width:34px;height:34px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
  .user-info{flex:1;min-width:0}
  .user-name{font-size:14px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .user-token{font-size:10px;color:var(--muted);margin-top:2px;letter-spacing:1px}
  .user-date{font-size:10px;color:var(--muted);margin-top:1px}
  .user-status{font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;letter-spacing:.5px;flex-shrink:0}
  .user-status.active{background:#14532d;color:#4ade80}
  .user-status.revoked{background:#3f1212;color:#f87171}
  .user-actions{display:flex;gap:6px;flex-shrink:0}
  .pending-list{display:flex;flex-direction:column;gap:6px}
  .pending-row{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px}
  .pending-code{font-size:14px;letter-spacing:2px;color:var(--gold)}
  .pending-date{font-size:10px;color:var(--muted)}
  .empty{text-align:center;padding:28px 16px;color:var(--muted);font-size:12px;line-height:1.8}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
  .name-edit{background:var(--surface);border:1.5px solid var(--gold);border-radius:6px;padding:4px 8px;color:var(--text);font-family:'DM Mono',monospace;font-size:13px;width:140px;outline:none}
  .install-banner{background:#1a1d27;border:1px solid var(--border);border-radius:10px;padding:12px 16px;font-size:12px;color:var(--text2);margin-bottom:20px;line-height:1.7;display:none}
  .install-banner.show{display:block}
</style>
</head>
<body>
<div id="offline-banner">⚠ No internet — changes disabled</div>
<div class="header">
  <div class="header-logo">🛒</div>
  <div><div class="header-title">BB Admin</div><div class="header-sub">Invite management</div></div>
  <div class="online-dot" id="online-dot"></div>
  <button id="push-btn" onclick="togglePush()" style="margin-left:10px;background:none;border:1.5px solid var(--border);border-radius:8px;padding:5px 10px;color:var(--muted);font-size:11px;cursor:pointer;font-family:'DM Mono',monospace">🔔 Off</button>
</div>
<div class="app">
  <div class="install-banner" id="install-banner">
    📱 <strong>Add to Home Screen</strong> to use as an app.<br>
    Safari: tap <strong>Share → Add to Home Screen</strong>
  </div>
  <div id="migrate-banner" style="display:none;background:#1c1206;border:1px solid #78350f;border-radius:10px;padding:14px 16px;font-size:12px;color:#fbbf24;margin-bottom:20px;line-height:1.8">
    📦 Found local data from a previous session.<br>
    <button onclick="migrateLocalData()" style="margin-top:8px;background:#f59e0b;border:none;border-radius:8px;padding:8px 16px;color:#1a1100;font-weight:700;font-size:13px;cursor:pointer;width:100%">
      Migrate to server →
    </button>
  </div>
  <div class="section">
    <div class="section-header"><span>🎟</span><span class="section-title">Generate Invite Codes</span></div>
    <div class="section-body">
      <div id="name-slots"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-ghost" onclick="addSlot()">+ Add person</button>
        <button class="btn btn-gold" onclick="generateCodes()" id="gen-btn">Generate</button>
      </div>
      <div id="gen-result"></div>
    </div>
  </div>
  <div class="section">
    <div class="section-header"><span>👥</span><span class="section-title">Active Users</span><span id="user-count" style="margin-left:auto;font-size:11px;color:var(--muted)"></span></div>
    <div class="section-body"><div id="users-list" class="users-list"><div class="empty">Loading…</div></div></div>
  </div>
  <div class="section">
    <div class="section-header"><span>⏳</span><span class="section-title">Pending Codes</span><span id="pending-count" style="margin-left:auto;font-size:11px;color:var(--muted)"></span></div>
    <div class="section-body"><div id="pending-list" class="pending-list"><div class="empty">No pending codes</div></div></div>
  </div>
  <div class="section">
    <div class="section-header">
      <span>💬</span><span class="section-title">Feedback</span>
      <span id="feedback-count" style="margin-left:auto;font-size:11px;color:var(--muted)"></span>
      <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="loadFeedback()">Refresh</button>
    </div>
    <div class="section-body"><div id="feedback-list"><div class="empty">Loading…</div></div></div>
  </div>
</div>
<div id="toast"></div>
<script>
const ADMIN_KEY  = ${JSON.stringify(ADMIN_KEY)};
const SERVER_URL = ${JSON.stringify('https://' + req.headers.host)};

let users   = [];
let pending = [];
let _dataLoaded = false;

async function loadAdminData() {
  try {
    const res = await fetch(SERVER_URL + '/admin/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminKey: ADMIN_KEY }),
    });
    if (!res.ok) return;
    const data = await res.json();
    users   = data.users   || [];
    pending = data.pending || [];
    _dataLoaded = true;
    renderUsers();
    renderPending();

    // Show migration banner if localStorage has data the server doesn't
    const lsUsers   = JSON.parse(localStorage.getItem('bb_admin_users')   || '[]');
    const lsPending = JSON.parse(localStorage.getItem('bb_admin_pending') || '[]');
    if ((lsUsers.length > 0 || lsPending.length > 0) && users.length === 0 && pending.length === 0) {
      document.getElementById('migrate-banner').style.display = 'block';
    }
  } catch(e) {
    console.warn('[Admin] loadAdminData error:', e.message);
  }
}

async function migrateLocalData() {
  const lsUsers   = JSON.parse(localStorage.getItem('bb_admin_users')   || '[]');
  const lsPending = JSON.parse(localStorage.getItem('bb_admin_pending') || '[]');
  if (!lsUsers.length && !lsPending.length) {
    toast('Nothing to migrate', ''); return;
  }
  try {
    users   = lsUsers;
    pending = lsPending;
    await save();
    localStorage.removeItem('bb_admin_users');
    localStorage.removeItem('bb_admin_pending');
    document.getElementById('migrate-banner').style.display = 'none';
    renderUsers();
    renderPending();
    toast('Migrated ' + lsUsers.length + ' user(s) to server', 'success');
  } catch(e) {
    toast('Migration failed: ' + e.message, 'error');
  }
}

async function save() {
  try {
    await fetch(SERVER_URL + '/admin/data/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminKey: ADMIN_KEY, users, pending }),
    });
  } catch(e) {
    console.warn('[Admin] save error:', e.message);
  }
}
function toast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'show ' + type;
  clearTimeout(el._t); el._t = setTimeout(() => { el.className=''; }, 2800);
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})
    + ' ' + d.toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit'});
}
function isOnline() { return navigator.onLine; }

function updateOnlineStatus() {
  const online = navigator.onLine;
  document.body.classList.toggle('offline', !online);
  document.getElementById('online-dot').classList.toggle('offline', !online);
}
window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// Show install banner if not already installed as PWA
if (!window.navigator.standalone && !window.matchMedia('(display-mode: standalone)').matches) {
  document.getElementById('install-banner').classList.add('show');
}

// ── Name slots ────────────────────────────────────────────────
let slots = [{id:1,name:''}]; let slotId = 1;
function renderSlots() {
  const el = document.getElementById('name-slots');
  el.innerHTML = '<div class="name-slots">' + slots.map(s => \`
    <div class="name-slot">
      <input type="text" placeholder="Person's name (e.g. Mum)"
        value="\${s.name}"
        oninput="updateSlot(\${s.id},this.value)"
        onkeydown="if(event.key==='Enter'){event.preventDefault();addSlot();}">
      \${slots.length > 1 ? \`<button class="slot-remove" onclick="removeSlot(\${s.id})">✕</button>\` : ''}
    </div>\`).join('') + '</div>';
  const inputs = el.querySelectorAll('input');
  const last = inputs[inputs.length-1];
  if (last && !last.value) last.focus();
}
function addSlot() { slotId++; slots.push({id:slotId,name:''}); renderSlots(); }
function removeSlot(id) { if(slots.length<=1)return; slots=slots.filter(s=>s.id!==id); renderSlots(); }
function updateSlot(id,val) { const s=slots.find(s=>s.id===id); if(s) s.name=val; }

// ── Generate ──────────────────────────────────────────────────
async function generateCodes() {
  if (!isOnline()) { toast('No internet connection','error'); return; }
  const names = slots.map(s => s.name.trim());
  const count = names.length;
  const btn = document.getElementById('gen-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating…';
  try {
    const res = await fetch(SERVER_URL+'/admin/invite', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({adminKey:ADMIN_KEY, count}),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Server error');
    const now = new Date().toISOString();
    data.codes.forEach((code,i) => pending.unshift({code, name:names[i]||'', createdAt:now}));
    save();
    document.getElementById('gen-result').innerHTML = '<div style="margin-top:14px;display:flex;flex-direction:column;gap:8px;">'
      + data.codes.map((c,i) => \`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;">
          <div style="flex:1"><div style="font-size:11px;color:var(--sub);margin-bottom:3px;">\${names[i]||'Unnamed'}</div>
          <div style="font-size:15px;letter-spacing:2px;color:var(--gold);">\${c}</div></div>
          <button class="btn btn-ghost btn-sm" onclick="copyText(this,'\${c}')">Copy</button>
        </div>\`).join('') + '</div>';
    slots=[{id:1,name:''}]; slotId=1; renderSlots();
    toast(data.codes.length + ' code' + (data.codes.length>1?'s':'') + ' generated','success');
    renderPending();
  } catch(e) { toast('Error: '+e.message,'error'); }
  finally { btn.disabled=false; btn.textContent='Generate'; }
}

function copyText(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent='✓ Copied'; setTimeout(()=>{btn.textContent='Copy';},1500);
  }).catch(() => {
    const el=document.createElement('textarea'); el.value=text;
    document.body.appendChild(el); el.select(); document.execCommand('copy');
    document.body.removeChild(el);
    btn.textContent='✓ Copied'; setTimeout(()=>{btn.textContent='Copy';},1500);
  });
}

// ── Revoke ────────────────────────────────────────────────────
async function revokeUser(token) {
  if (!isOnline()) { toast('No internet connection','error'); return; }
  if (!confirm('Revoke access? They will be locked out immediately.')) return;
  try {
    await fetch(SERVER_URL+'/admin/revoke', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({adminKey:ADMIN_KEY, token}),
    });
    const idx = users.findIndex(u=>u.token===token);
    if (idx>=0) { users[idx].active=false; users[idx].revokedAt=new Date().toISOString(); save(); }
    toast('Access revoked','success'); renderUsers();
  } catch(e) { toast('Error: '+e.message,'error'); }
}

async function restoreUser(token) {
  if (!isOnline()) { toast('No internet connection','error'); return; }
  try {
    await fetch(SERVER_URL+'/admin/restore', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({adminKey:ADMIN_KEY, token}),
    });
    const idx = users.findIndex(u=>u.token===token);
    if (idx>=0) { users[idx].active=true; delete users[idx].revokedAt; save(); }
    toast('Access restored','success'); renderUsers();
  } catch(e) { toast('Error: '+e.message,'error'); }
}

function deletePending(code) {
  pending=pending.filter(p=>p.code!==code); save(); renderPending();
  toast('Pending code removed','');
}

function startRename(token) {
  const row = document.querySelector('[data-token="'+token+'"]');
  if (!row) return;
  const nameEl = row.querySelector('.user-name');
  const current = nameEl.textContent;
  const input = document.createElement('input');
  input.className='name-edit'; input.value=current;
  nameEl.replaceWith(input); input.focus(); input.select();
  function commit() {
    const trimmed = input.value.trim() || current;
    const idx = users.findIndex(u=>u.token===token);
    if (idx>=0) { users[idx].name=trimmed; save(); }
    renderUsers();
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e=>{ if(e.key==='Enter'){e.preventDefault();commit();} });
}

// ── Render ────────────────────────────────────────────────────
function renderUsers() {
  const el = document.getElementById('users-list');
  const count = document.getElementById('user-count');
  if (!users.length) {
    el.innerHTML='<div class="empty">No users yet.<br>Codes appear here when redeemed.</div>';
    count.textContent=''; return;
  }
  const active = users.filter(u=>u.active!==false).length;
  count.textContent = active+' active · '+users.length+' total';
  el.innerHTML = users.map(u => \`
    <div class="user-row" data-token="\${u.token}">
      <div class="user-avatar">\${(u.name||'?')[0].toUpperCase()}</div>
      <div class="user-info">
        <div class="user-name">\${u.name||'Unnamed user'}</div>
        <div class="user-token">TOKEN: \${u.token.slice(0,8)}…</div>
        <div class="user-date">Joined \${fmtDate(u.redeemedAt)}</div>
      </div>
      <span class="user-status \${u.active!==false?'active':'revoked'}">\${u.active!==false?'ACTIVE':'REVOKED'}</span>
      <div class="user-actions">
        <button class="btn btn-ghost btn-sm" onclick="startRename('\${u.token}')" title="Rename">✏️</button>
        \${u.active!==false
          ? \`<button class="btn btn-red" onclick="revokeUser('\${u.token}')">Revoke</button>\`
          : \`<button class="btn btn-ghost btn-sm" onclick="restoreUser('\${u.token}')">Restore</button>\`}
      </div>
    </div>\`).join('');
}

function renderPending() {
  const el = document.getElementById('pending-list');
  const count = document.getElementById('pending-count');
  if (!pending.length) {
    el.innerHTML='<div class="empty">No pending codes</div>';
    count.textContent=''; return;
  }
  count.textContent = pending.length+' unused';
  el.innerHTML = pending.map(p => \`
    <div class="pending-row">
      <div style="flex:1;min-width:0">
        \${p.name ? \`<div style="font-size:11px;color:var(--sub);margin-bottom:2px;">\${p.name}</div>\` : ''}
        <div class="pending-code">\${p.code}</div>
        <div class="pending-date">\${fmtDate(p.createdAt)}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="copyText(this,'\${p.code}')">Copy</button>
      <button class="btn btn-red" onclick="deletePending('\${p.code}')">Delete</button>
    </div>\`).join('');
}

async function checkRedeemed() {
  if (!isOnline() || !pending.length) return;
  try {
    for (const p of [...pending]) {
      const res = await fetch(SERVER_URL+'/admin/check-invite', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({adminKey:ADMIN_KEY, code:p.code}),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.status==='used' && data.token) {
        const assignedName = p.name || '';
        pending = pending.filter(x=>x.code!==p.code);
        users.unshift({name:assignedName||'New user',token:data.token,redeemedAt:new Date().toISOString(),active:true,sourceCode:p.code});
        save();
        toast((assignedName||'Someone')+' just joined!','success');
      }
    }
    renderUsers(); renderPending();
  } catch {}
}

setInterval(checkRedeemed, 30000);

// ── Feedback ──────────────────────────────────────────────────
async function loadFeedback() {
  if (!isOnline()) return;
  const el    = document.getElementById('feedback-list');
  const count = document.getElementById('feedback-count');
  el.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const res = await fetch(SERVER_URL + '/admin/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminKey: ADMIN_KEY }),
    });
    if (!res.ok) throw new Error('Server error');
    const data = await res.json();
    const items = data.feedback || [];
    count.textContent = items.length ? items.length + ' item' + (items.length !== 1 ? 's' : '') : '';
    if (!items.length) {
      el.innerHTML = '<div class="empty">No feedback yet</div>';
      return;
    }
    el.innerHTML = items.map(f => \`
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px;animation:fadeIn .2s ease">
        <div style="font-size:13px;color:var(--text);line-height:1.6;margin-bottom:8px;">\${f.message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div>
            <span style="font-size:10px;color:var(--muted);">\${f.householdCode || '—'}</span>
            <span style="font-size:10px;color:var(--muted);margin-left:10px;">\${fmtDate(f.submittedAt)}</span>
          </div>
          <button class="btn btn-red" onclick="deleteFeedback(\${f.id})">Delete</button>
        </div>
      </div>\`).join('');
  } catch(e) {
    el.innerHTML = '<div class="empty">Could not load feedback</div>';
    count.textContent = '';
  }
}

async function deleteFeedback(id) {
  if (!isOnline()) { toast('No internet connection', 'error'); return; }
  try {
    await fetch(SERVER_URL + '/admin/feedback/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminKey: ADMIN_KEY, id }),
    });
    toast('Deleted', '');
    loadFeedback();
  } catch(e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ── Push notifications ────────────────────────────────────────────────
var _pushSub = null;

async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    document.getElementById('push-btn').style.display = 'none';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register(SERVER_URL + '/push-sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;

    // Check if already subscribed
    _pushSub = await reg.pushManager.getSubscription();
    updatePushBtn();
  } catch(e) {
    console.warn('[Push] init error:', e);
  }
}

function updatePushBtn() {
  const btn = document.getElementById('push-btn');
  if (!btn) return;
  if (_pushSub) {
    btn.textContent = '🔔 On';
    btn.style.borderColor = 'var(--green)';
    btn.style.color = 'var(--green)';
  } else {
    btn.textContent = '🔔 Off';
    btn.style.borderColor = 'var(--border)';
    btn.style.color = 'var(--muted)';
  }
}

async function togglePush() {
  if (!('serviceWorker' in navigator)) { toast('Push not supported in this browser', 'error'); return; }
  if (!isOnline()) { toast('No internet connection', 'error'); return; }

  try {
    const reg = await navigator.serviceWorker.ready;

    if (_pushSub) {
      // Unsubscribe
      await _pushSub.unsubscribe();
      await fetch(SERVER_URL + '/push/unsubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminKey: ADMIN_KEY, endpoint: _pushSub.endpoint }),
      });
      _pushSub = null;
      updatePushBtn();
      toast('Notifications off', '');
      return;
    }

    // Subscribe
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { toast('Permission denied', 'error'); return; }

    // Get VAPID public key from server
    const keyRes  = await fetch(SERVER_URL + '/push/vapid-key');
    const keyData = await keyRes.json();

    _pushSub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
    });

    await fetch(SERVER_URL + '/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminKey: ADMIN_KEY, subscription: _pushSub.toJSON() }),
    });

    updatePushBtn();
    toast('Notifications on!', 'success');
  } catch(e) {
    toast('Push error: ' + e.message, 'error');
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = window.atob(base64);
  const arr     = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

renderSlots(); loadAdminData(); checkRedeemed(); loadFeedback(); initPush();
</script>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(adminHtml);
    return;
  }

  // ── Push: service worker file ─────────────────────────────────────────────
  if (path === "/push-sw.js" && req.method === "GET") {
    const adminUrl = '/admin-panel?key=' + encodeURIComponent(ADMIN_KEY);
    const swCode = `
self.addEventListener('push', function(e) {
  var data = {};
  try { data = e.data.json(); } catch(err) {
    data = { title: 'BasketBattle', body: e.data ? e.data.text() : 'New notification' };
  }
  e.waitUntil(self.registration.showNotification(data.title || 'BasketBattle', {
    body: data.body || '',
    icon: '/icon.png',
    badge: '/icon.png',
    vibrate: [200, 100, 200],
    tag: 'bb-feedback',
    renotify: true,
  }));
});
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
    for (var i = 0; i < clientList.length; i++) {
      if (clientList[i].url.includes('/admin-panel') && 'focus' in clientList[i]) {
        return clientList[i].focus();
      }
    }
    if (clients.openWindow) return clients.openWindow('${adminUrl}');
  }));
});
`;
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-cache',
    });
    res.end(swCode); return;
  }

  // ── Push: get VAPID public key (needed by browser to subscribe) ──────────
  if (path === "/push/vapid-key" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ publicKey: VAPID_PUBLIC_KEY })); return;
  }

  // ── Push: register a subscription ────────────────────────────────────────
  if (path === "/push/subscribe" && req.method === "POST") {
    const body = await parseBody(req);
    if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    if (body.subscription) {
      await addPushSub(body.subscription);
      console.log('[Push] New subscription registered');
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true })); return;
  }

  // ── Push: unregister a subscription ──────────────────────────────────────
  if (path === "/push/unsubscribe" && req.method === "POST") {
    const body = await parseBody(req);
    if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    if (body.endpoint) await removePushSub(body.endpoint);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true })); return;
  }

  // ── Access gate — all routes below require a valid token ──────────────────
  // Skip check if no ADMIN_KEY is configured (dev/open mode)
  if (ADMIN_KEY) {
    const token = req.headers['x-bb-access'] || '';
    const valid = await isValidToken(token);
    if (!valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" })); return;
    }
  }

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
      res.end(JSON.stringify({ groups: await getBattles(code) }));
      return;
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      await setBattles(code, body.groups || []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  if (path === "/list") {
    const code = parsed.searchParams.get("code") || "";
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await getList(code)));
      return;
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      if (code) await setList(code, body);
      res.writeHead(200); res.end("ok");
      return;
    }
  }

  if (path === "/shop") {
    const code = parsed.searchParams.get("code") || "";
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await getShop(code)));
      return;
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      if (code) await setShop(code, body);
      res.writeHead(200); res.end("ok");
      return;
    }
  }

  if (path === "/history") {
    const code = parsed.searchParams.get("code") || "";
    if (!code) { res.writeHead(400); res.end("No code"); return; }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ history: await getHistory(code) }));
      return;
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      if (body.entry) await addHistory(code, body.entry);
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
  // ── Shared cart state (for household real-time sync) ──────────────────────
  if (path === "/cart") {
    const code = parsed.searchParams.get("code") || "";
    if (!code) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "No code" })); return; }
    if (req.method === "GET") {
      const cart = await getCart(code);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cart }));
      return;
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      await setCart(code, body.cart || null);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  if (path === "/feedback" && req.method === "POST") {
    const body = await parseBody(req);
    const message = (body.message || '').trim();
    if (!message) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "No message" })); return; }
    await addFeedback({
      id: Date.now(),
      message,
      householdCode: body.householdCode || 'unknown',
      submittedAt: body.submittedAt || new Date().toISOString(),
    });
    console.log('[Feedback] New from', body.householdCode || 'unknown');
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true })); return;
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
