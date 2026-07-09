// ==UserScript==
// @name         Amazon Vine Price Display
// @namespace    http://tampermonkey.net/
// @version      1.46.9
// @description  Displays product prices on Amazon Vine items with color-coded indicators and caching
// @author       Andrew Porzio
// @updateURL    https://raw.githubusercontent.com/aporzio1/Amazon-Vine-UserScript/main/amazon-vine-price-display.user.js
// @downloadURL  https://raw.githubusercontent.com/aporzio1/Amazon-Vine-UserScript/main/amazon-vine-price-display.user.js
// @match        https://www.amazon.com/vine/*
// @match        https://www.amazon.com/*/vine/*
// @match        https://vine.amazon.com/*
// @match        https://vine.amazon.com/**/*
// @match        https://www.amazon.com/*/dp/*
// @match        https://www.amazon.com/dp/*
// @match        https://www.amazon.com/review/create-review*
// @match        https://www.amazon.com/*/review/create-review*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @inject-into  content
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';



  // ===== TEMP BISECTION FLAGS (Build C) — remove after testing. =====
  // Isolating the item-request 403. Badges ON, but the badge NODE injection
  // into Amazon's tiles (appendChild + external links) is skipped; dataset
  // writes and the color-filter/hide logic still run.
  const TEST = { disableActive: true, disableDisplay: false, noBadgeNode: true, noColorFilter: true };
  // ===================================================================

  // Configuration constants
  const CONFIG = {
    CACHE_KEY: 'vine_price_cache',
    THRESHOLDS_KEY: 'vine_price_thresholds',
    HIDE_CACHED_KEY: 'vine_hide_cached',
    AUTO_ADVANCE_KEY: 'vine_auto_advance',
    SAVED_SEARCHES_KEY: 'vine_saved_searches',
    SAVED_SEARCHES_TIMESTAMP_KEY: 'vine_saved_searches_timestamp',
    KEYWORD_LISTS_KEY: 'vine_keyword_lists',
    KEYWORD_LISTS_TIMESTAMP_KEY: 'vine_keyword_lists_timestamp',
    EXTERNAL_LINKS_KEY: 'vine_external_links',
    SORT_ORDER_KEY: 'vine_sort_order',
    INFINITE_SCROLL_KEY: 'vine_infinite_scroll',
    COLOR_FILTER_KEY: 'vine_color_filter',
    OPENAI_API_KEY: 'vine_openai_api_key',
    DEEPSEEK_API_KEY: 'vine_deepseek_api_key',
    DEEPSEEK_MODEL: 'vine_deepseek_model',
    CLAUDE_API_KEY: 'vine_claude_api_key',
    CLAUDE_MODEL: 'vine_claude_model',
    AI_PROVIDER: 'vine_ai_provider',
    GITHUB_TOKEN_KEY: 'vine_github_token',
    GIST_ID_KEY: 'vine_gist_id',
    GIST_SEARCHES_ID_KEY: 'vine_gist_searches_id',
    GIST_KEYWORDS_ID_KEY: 'vine_gist_keywords_id',
    LAST_SYNC_KEY: 'vine_last_sync',
    LAST_ACTIVE_TAB_KEY: 'vine_last_active_tab',
    CACHE_DURATION: 7 * 24 * 60 * 60 * 1000, // 7 days
    NEGATIVE_CACHE_DURATION: 12 * 60 * 60 * 1000, // 12 hours — "no price" results
    SYNC_MIN_INTERVAL: 30 * 60 * 1000, // 30 min — min gap between auto-syncs
    CACHE_FLUSH_DEBOUNCE: 5000, // coalesce cache writes for 5s of idle...
    CACHE_FLUSH_MAX_WAIT: 15000, // ...but never delay a pending write past 15s
    MAX_CACHE_SIZE: 50000,
    MAX_RETRIES: 3,
    RETRY_BASE_DELAY: 1000,
    MUTATION_DEBOUNCE: 50,
    DEFAULT_THRESHOLDS: {
      GREEN_MIN: 90,
      YELLOW_MIN: 50,
      RED_MAX: 49.99
    },
    DEFAULT_COLOR_FILTER: { green: true, yellow: true, red: true },
    AMAZON_DOMAINS: [
      'amazon.com', 'amazon.co.uk', 'amazon.ca', 'amazon.de',
      'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.co.jp',
      'amazon.com.au', 'amazon.in'
    ],
    // Buybox containers searched first — prices found elsewhere in the document
    // are often carousels ("Frequently bought together") or strikethrough list prices.
    PRICE_SCOPE_SELECTORS: [
      '#corePriceDisplay_desktop_feature_div',
      '#corePrice_feature_div',
      '#apex_desktop',
      '#buybox'
    ],
    PRICE_SELECTORS: [
      '.a-price:not(.a-text-price) .a-offscreen',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '[data-a-color="price"] .a-offscreen'
    ],
    VINE_ITEM_SELECTORS: [
      '.vvp-item-tile',
      '[data-recommendation-id]',
      '.a-section.a-spacing-base'
    ],
    PRODUCT_DESC_SELECTORS: [
      '#feature-bullets',
      '[data-feature-name="featurebullets"]',
      '#productDescription',
      '#productTitle'
    ],
    NEXT_PAGE_SELECTORS: [
      'li.a-last a',
      '.a-pagination .a-last a',
      'a[aria-label="Next page"]',
      '.a-pagination li:last-child:not(.a-disabled) a'
    ],
    PREV_PAGE_SELECTORS: [
      'li.a-first a',
      '.a-pagination .a-first a',
      'a[aria-label="Previous page"]',
      '.a-pagination li:first-child:not(.a-disabled) a'
    ],
    PROVIDERS: {
      openai: {
        label: 'OpenAI',
        url: 'https://api.openai.com/v1/chat/completions',
        defaultModel: 'gpt-3.5-turbo'
      },
      deepseek: {
        label: 'DeepSeek',
        url: 'https://api.deepseek.com/chat/completions',
        defaultModel: 'deepseek-v4-flash'
      },
      claude: {
        label: 'Claude (Anthropic)',
        url: 'https://api.anthropic.com/v1/messages',
        defaultModel: 'claude-opus-4-8'
      }
    }
  };

  // Global references for modal control (used by keyboard shortcuts and close buttons)
  let openSettingsModal = null;
  let settingsModal = null;
  let settingsModalPrevFocus = null;

  function closeSettingsModal() {
    if (!settingsModal) return;
    settingsModal.remove();
    settingsModal = null;
    document.body.style.removeProperty('overflow');
    if (settingsModalPrevFocus && typeof settingsModalPrevFocus.focus === 'function') {
      try { settingsModalPrevFocus.focus(); } catch (e) { /* focus target may have unmounted */ }
    }
    settingsModalPrevFocus = null;
  }

  // Storage helpers with GM API fallback to localStorage
  const STORAGE_PREFIX = 'vine_price_display_';

  function getStorage(key, defaultValue) {
    try {
      if (typeof GM_getValue !== 'undefined') {
        const value = GM_getValue(key);
        return value !== undefined ? value : defaultValue;
      }
    } catch (e) {
      console.warn(`GM_getValue failed for "${key}", falling back to localStorage:`, e);
    }

    try {
      const stored = localStorage.getItem(STORAGE_PREFIX + key);
      return stored === null ? defaultValue : JSON.parse(stored);
    } catch (e) {
      console.error(`Error reading ${key}:`, e);
      return defaultValue;
    }
  }

  function setStorage(key, value) {
    try {
      if (typeof GM_setValue !== 'undefined') {
        GM_setValue(key, value);
        return;
      }
    } catch (e) {
      console.warn(`GM_setValue failed for "${key}", falling back to localStorage:`, e);
    }

    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (e) {
      console.error(`Error writing ${key}:`, e);
    }
  }

  // ---- Network helpers (shared across OpenAI, GitHub Gist, and product-page fetches) ----
  function gmFetch({ method = 'GET', url, headers, data }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        ...(data != null ? { data } : {}),
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            resolve(response);
          } else {
            const err = new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
            err.status = response.status;
            err.statusText = response.statusText || '';
            err.responseText = response.responseText || '';
            err.responseHeaders = response.responseHeaders || '';
            reject(err);
          }
        },
        onerror: () => reject(new Error(`Network error: ${url}`))
      });
    });
  }

  // Parse a `Retry-After` header value (seconds or HTTP-date) into a millisecond delay.
  function parseRetryAfterMs(headersStr) {
    if (!headersStr) return null;
    const match = headersStr.match(/^retry-after:\s*(.+)$/im);
    if (!match) return null;
    const value = match[1].trim();
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return null;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function githubRequest(token, endpoint, method = 'GET', body = null) {
    return gmFetch({
      method,
      url: `https://api.github.com/${endpoint}`,
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      data: body ? JSON.stringify(body) : null
    }).then(r => JSON.parse(r.responseText))
      .catch(err => { throw new Error(`GitHub API ${method} ${endpoint}: ${err.message}`); });
  }

  // Temporary status banner wired to a specific DOM element. Returns a showStatus(message, isError) fn.
  function makeShowStatus(statusEl, timeoutMs = 3000) {
    let hideTimer = null;
    return (message, isError = false) => {
      statusEl.textContent = message;
      statusEl.style.display = 'block';
      statusEl.style.background = isError ? '#FEF0EF' : '#E8F5E9';
      statusEl.style.color = isError ? '#B12704' : '#1B5E20';
      statusEl.style.border = isError ? '1px solid #F5C2C0' : '1px solid #C8E6C9';
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { statusEl.style.display = 'none'; }, timeoutMs);
    };
  }

  // Two-step destructive button: first click arms (confirm label + .armed),
  // second click within timeoutMs fires onConfirm; otherwise it disarms.
  function wireConfirmButton(btn, confirmText, onConfirm, timeoutMs = 3000) {
    const restoreText = btn.textContent;
    let armed = false;
    let disarmTimer = null;
    const disarm = () => {
      armed = false;
      btn.textContent = restoreText;
      btn.classList.remove('armed');
      if (disarmTimer) { clearTimeout(disarmTimer); disarmTimer = null; }
    };
    btn.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        btn.textContent = confirmText;
        btn.classList.add('armed');
        if (disarmTimer) clearTimeout(disarmTimer);
        disarmTimer = setTimeout(disarm, timeoutMs);
        return;
      }
      disarm();
      onConfirm();
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function findFirstMatch(root, selectors) {
    for (const s of selectors) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  // Cache management
  let cachedThresholds = null;
  let thresholdsLoaded = false;
  let hideCached = false;
  let hideCachedLoaded = false;
  let autoAdvance = false;
  let autoAdvanceLoaded = false;
  let colorFilter = { ...CONFIG.DEFAULT_COLOR_FILTER };
  let colorFilterLoaded = false;

  // Cache optimization
  const pendingCacheUpdates = new Map();
  let cacheUpdateTimeout = null;
  let firstPendingAt = 0; // when the oldest un-flushed update was queued
  let autoAdvanceCheckTimeout = null;
  let memoryCache = null; // In-memory cache to avoid repeated storage reads
  let cacheLoaded = false;
  let lastCleanupTime = 0;
  const CLEANUP_INTERVAL = 60 * 60 * 1000; // Clean up once per hour max

  // Selector optimization
  let cachedSelector = null;

  function getHideCached(callback) {
    if (hideCachedLoaded) {
      callback(hideCached);
      return;
    }
    hideCachedLoaded = true;
    hideCached = getStorage(CONFIG.HIDE_CACHED_KEY, false);
    callback(hideCached);
  }

  function getAutoAdvance(callback) {
    if (autoAdvanceLoaded) {
      callback(autoAdvance);
      return;
    }
    autoAdvanceLoaded = true;
    autoAdvance = getStorage(CONFIG.AUTO_ADVANCE_KEY, false);
    callback(autoAdvance);
  }

  function getColorFilter(callback) {
    if (colorFilterLoaded) {
      callback(colorFilter);
      return;
    }
    colorFilterLoaded = true;
    colorFilter = { ...CONFIG.DEFAULT_COLOR_FILTER, ...getStorage(CONFIG.COLOR_FILTER_KEY, {}) };

    // Clean up legacy preRelease key if it exists
    if (typeof colorFilter.preRelease !== 'undefined') {
      delete colorFilter.preRelease;
      setStorage(CONFIG.COLOR_FILTER_KEY, colorFilter);
    }

    callback(colorFilter);
  }

  function getThresholds(callback) {
    if (cachedThresholds !== null) {
      callback(cachedThresholds);
      return;
    }
    if (!thresholdsLoaded) {
      thresholdsLoaded = true;
      let thresholds = getStorage(CONFIG.THRESHOLDS_KEY, CONFIG.DEFAULT_THRESHOLDS);

      // Migrate old format (HIGH/MEDIUM) to new format (GREEN_MIN/YELLOW_MIN/RED_MAX)
      if (thresholds.HIGH !== undefined && thresholds.MEDIUM !== undefined) {
        thresholds = {
          GREEN_MIN: thresholds.HIGH,
          YELLOW_MIN: thresholds.MEDIUM,
          RED_MAX: thresholds.MEDIUM - 0.01
        };
        setStorage(CONFIG.THRESHOLDS_KEY, thresholds);
      }

      // Ensure all required fields exist
      if (thresholds.GREEN_MIN == null) thresholds.GREEN_MIN = CONFIG.DEFAULT_THRESHOLDS.GREEN_MIN;
      if (thresholds.YELLOW_MIN == null) thresholds.YELLOW_MIN = CONFIG.DEFAULT_THRESHOLDS.YELLOW_MIN;
      if (thresholds.RED_MAX == null) thresholds.RED_MAX = CONFIG.DEFAULT_THRESHOLDS.RED_MAX;

      cachedThresholds = thresholds;
      callback(cachedThresholds);
    } else {
      callback(CONFIG.DEFAULT_THRESHOLDS);
    }
  }

  function getCache(callback) {
    if (memoryCache !== null) {
      callback(memoryCache);
      return;
    }

    if (!cacheLoaded) {
      cacheLoaded = true;
      const storedCache = getStorage(CONFIG.CACHE_KEY, {});
      memoryCache = (storedCache && typeof storedCache === 'object' && !Array.isArray(storedCache))
        ? storedCache
        : {};

      // Defer O(n) cleanup off the first-load path so the first processBatch() isn't blocked.
      const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 500));
      idle(() => {
        const cleaned = cleanupExpiredCache(memoryCache);
        if (Object.keys(cleaned).length !== Object.keys(memoryCache).length) {
          memoryCache = cleaned;
          setStorage(CONFIG.CACHE_KEY, cleaned);
        }
        lastCleanupTime = Date.now();
      });
    }

    callback(memoryCache);
  }

  function setCache(cache, callback) {
    const now = Date.now();
    let toSave = cache;

    // Only clean up if enough time has passed (throttle expensive operation)
    if (now - lastCleanupTime > CLEANUP_INTERVAL) {
      toSave = cleanupExpiredCache(cache);
      lastCleanupTime = now;
    }

    // Skip the Object.entries()/sort machinery unless we're actually over the
    // cap — the common case is far under it.
    const limited = Object.keys(toSave).length > CONFIG.MAX_CACHE_SIZE
      ? enforceCacheSizeLimit(toSave)
      : toSave;
    memoryCache = limited; // Update in-memory cache
    setStorage(CONFIG.CACHE_KEY, limited);
    if (callback) callback();
  }

  // Failed lookups ("no price") are cached briefly so unavailable items don't
  // re-fetch on every page load; real prices keep the full duration.
  function cacheTTL(entry) {
    return entry && entry.noPrice ? CONFIG.NEGATIVE_CACHE_DURATION : CONFIG.CACHE_DURATION;
  }

  function cleanupExpiredCache(cache) {
    const now = Date.now();
    const cleaned = {};
    for (const asin in cache) {
      const entry = cache[asin];
      if (entry && entry.timestamp && (now - entry.timestamp <= cacheTTL(entry))) {
        cleaned[asin] = entry;
      }
    }
    return cleaned;
  }

  function enforceCacheSizeLimit(cache) {
    const entries = Object.entries(cache);
    if (entries.length <= CONFIG.MAX_CACHE_SIZE) {
      return cache;
    }
    entries.sort((a, b) => {
      const entryA = a[1];
      const entryB = b[1];
      const timeA = entryA && typeof entryA === 'object' && typeof entryA.timestamp === 'number'
        ? entryA.timestamp
        : 0;
      const timeB = entryB && typeof entryB === 'object' && typeof entryB.timestamp === 'number'
        ? entryB.timestamp
        : 0;
      return timeA - timeB;
    });
    const toKeep = entries.slice(-CONFIG.MAX_CACHE_SIZE);
    return Object.fromEntries(toKeep);
  }

  function getMultipleCachedPrices(asins, callback) {
    getCache((cache) => {
      const now = Date.now();
      const results = {};
      asins.forEach(asin => {
        const entry = cache[asin];
        const hasValue = entry && entry.timestamp &&
          (entry.noPrice === true || (entry.price !== undefined && entry.price !== null));
        if (hasValue && (now - entry.timestamp) <= cacheTTL(entry)) {
          results[asin] = entry;
        } else {
          results[asin] = null;
        }
      });
      callback(results);
    });
  }

  function flushCacheUpdates() {
    if (cacheUpdateTimeout) { clearTimeout(cacheUpdateTimeout); cacheUpdateTimeout = null; }
    firstPendingAt = 0;
    if (pendingCacheUpdates.size === 0) return;

    // Re-read the latest blob from storage and fold pending updates into THAT,
    // so a concurrent tab's newly cached prices aren't clobbered. Fall back to
    // the in-memory copy only if storage is missing/unreadable — never wipe the
    // cache on a transient read failure.
    const stored = getStorage(CONFIG.CACHE_KEY, null);
    const base = (stored && typeof stored === 'object' && !Array.isArray(stored))
      ? stored
      : (memoryCache && typeof memoryCache === 'object' && !Array.isArray(memoryCache) ? memoryCache : {});
    pendingCacheUpdates.forEach((value, key) => { base[key] = value; });
    pendingCacheUpdates.clear();
    setCache(base);
  }

  function setCachedPrice(asin, price, isSeen = true, extra = null) {
    const entry = {
      price: price,
      isSeen: isSeen,
      timestamp: Date.now()
    };
    if (extra) {
      if (extra.priceMax != null && extra.priceMax > price) entry.priceMax = extra.priceMax;
      if (extra.isParent) entry.isParent = true;
      if (extra.isEtv) entry.isEtv = true;
      if (extra.noPrice) entry.noPrice = true;
      if (extra.approx) entry.approx = true;
    }
    // Add to pending updates
    pendingCacheUpdates.set(asin, entry);

    // Debounce the save, but force a flush once the oldest pending update has
    // waited CACHE_FLUSH_MAX_WAIT so a steady price stream can't defer it forever.
    const now = Date.now();
    if (!firstPendingAt) firstPendingAt = now;
    if (cacheUpdateTimeout) {
      clearTimeout(cacheUpdateTimeout);
      cacheUpdateTimeout = null;
    }
    if (now - firstPendingAt >= CONFIG.CACHE_FLUSH_MAX_WAIT) {
      flushCacheUpdates();
    } else {
      cacheUpdateTimeout = setTimeout(flushCacheUpdates, CONFIG.CACHE_FLUSH_DEBOUNCE);
    }
  }

  // Price extraction
  function extractASIN(url) {
    const match = url.match(/\/dp\/([A-Z0-9]{10})/i) || url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
    return match ? match[1].toUpperCase() : null;
  }

  function isValidAmazonURL(url) {
    try {
      const urlObj = new URL(url);
      return CONFIG.AMAZON_DOMAINS.some(domain => urlObj.hostname.includes(domain));
    } catch (e) {
      return false;
    }
  }

  function parsePriceText(text) {
    const match = (text || '').match(/\$?([\d,]+(?:\.\d{1,2})?)/);
    if (!match) return null;
    const price = parseFloat(match[1].replace(/,/g, ''));
    return (!isNaN(price) && price >= 0) ? price : null;
  }

  function extractPriceFromDoc(doc) {
    const scopes = [];
    for (const sel of CONFIG.PRICE_SCOPE_SELECTORS) {
      const el = doc.querySelector(sel);
      if (el) scopes.push(el);
    }
    if (scopes.length === 0) scopes.push(doc);
    for (const scope of scopes) {
      for (const selector of CONFIG.PRICE_SELECTORS) {
        const element = scope.querySelector(selector);
        if (element) {
          const price = parsePriceText(element.textContent.trim());
          if (price !== null) return price;
        }
      }
    }
    return null;
  }

  // Which ASIN the fetched page actually shows. Amazon serves a default child
  // variant when asked for a parent ASIN, so this can differ from the requested one.
  function extractPageAsin(html, doc) {
    const m = html.match(/"currentAsin"\s*:\s*"([A-Z0-9]{10})"/i);
    if (m) return m[1].toUpperCase();
    const input = doc.querySelector('input[name="ASIN"]');
    if (input && /^[A-Z0-9]{10}$/i.test(input.value)) return input.value.toUpperCase();
    return null;
  }

  function extractPriceFromHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return { price: extractPriceFromDoc(doc), pageAsin: extractPageAsin(html, doc) };
  }

  // ---- Amazon throttle circuit breaker ----
  // When Amazon signals throttling (429/503 or a robot-check interstitial),
  // pause every Amazon-bound queue for a cooldown instead of retrying into it.
  const THROTTLE_BASE_COOLDOWN_MS = 60000;
  const THROTTLE_MAX_COOLDOWN_MS = 900000;
  const THROTTLE_REQUEUE_LIMIT = 2;
  let throttledUntil = 0;
  let throttleStrikes = 0;

  function isThrottled() {
    return Date.now() < throttledUntil;
  }

  function noteFetchSuccess() {
    throttleStrikes = 0;
  }

  function tripThrottle(retryAfterMs, source) {
    const cooldown = retryAfterMs
      ? Math.min(retryAfterMs, THROTTLE_MAX_COOLDOWN_MS)
      : Math.min(THROTTLE_BASE_COOLDOWN_MS * Math.pow(2, throttleStrikes), THROTTLE_MAX_COOLDOWN_MS);
    throttledUntil = Math.max(throttledUntil, Date.now() + cooldown);
    throttleStrikes++;
    console.warn(`[Vine] Amazon throttling detected (${source}) — pausing fetches for ${Math.round(cooldown / 1000)}s`);
    showThrottleIndicator(throttledUntil);
    setTimeout(() => {
      if (isThrottled()) return; // a later trip extended the cooldown; its timer resumes
      removeThrottleIndicator();
      pumpDpQueue();
      pumpVineApiQueue();
    }, cooldown + 50);
  }

  function showThrottleIndicator(until) {
    let el = document.getElementById('vine-throttle-indicator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vine-throttle-indicator';
      el.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#b12704;color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = `Vine price fetches paused — Amazon throttling (resumes in ~${Math.max(1, Math.round((until - Date.now()) / 1000))}s)`;
  }

  function removeThrottleIndicator() {
    const el = document.getElementById('vine-throttle-indicator');
    if (el) el.remove();
  }

  // Robot-check/captcha interstitials are small pages (real product pages run
  // to ~1MB), often served with HTTP 200 — sniff before parsing for a price.
  function looksLikeRobotCheck(html) {
    if (!html || html.length > 100000) return false;
    return html.includes('/errors/validateCaptcha') ||
      html.includes('api-services-support@amazon.com') ||
      html.includes('Type the characters you see in this image') ||
      /<title>[^<]*(Robot Check|Bot Check|CAPTCHA)/i.test(html);
  }

  // ---- /dp/ product-page fetch queue ----
  // Product pages used to be fetched one-per-tile in parallel (30+ at once on
  // a fresh grid), which is what trips Amazon's rate limiting. Cap concurrency
  // and space completions out with jitter.
  const dpQueue = [];
  let dpActive = 0;
  const DP_MAX_CONCURRENT = 3;
  const DP_DELAY_MIN_MS = 100;
  const DP_DELAY_MAX_MS = 300;

  function pumpDpQueue() {
    if (isThrottled()) return; // tripThrottle re-pumps after the cooldown
    while (dpActive < DP_MAX_CONCURRENT && dpQueue.length > 0) {
      const task = dpQueue.shift();
      dpActive++;
      task(() => {
        dpActive--;
        setTimeout(pumpDpQueue, DP_DELAY_MIN_MS + Math.random() * (DP_DELAY_MAX_MS - DP_DELAY_MIN_MS));
      });
    }
  }

  function fetchPrice(url, asin, callback, retries = CONFIG.MAX_RETRIES, requeues = 0) {
    if (!isValidAmazonURL(url)) {
      callback(null);
      return;
    }
    dpQueue.push((done) => fetchPriceNow(url, asin, callback, retries, requeues, done));
    pumpDpQueue();
  }

  function fetchPriceNow(url, asin, callback, retries, requeues, done) {
    // Transient failure: free the slot, back off, rejoin the queue tail.
    const retry = () => {
      done();
      if (retries > 0) {
        const delay = CONFIG.RETRY_BASE_DELAY * Math.pow(2, CONFIG.MAX_RETRIES - retries);
        setTimeout(() => fetchPrice(url, asin, callback, retries - 1, requeues), delay);
      } else {
        callback(null);
      }
    };

    // Amazon is throttling: re-enqueue (bounded) so the item retries after the
    // cooldown without counting as a failed fetch.
    const requeue = () => {
      done();
      if (requeues >= THROTTLE_REQUEUE_LIMIT) {
        callback(null);
      } else {
        fetchPrice(url, asin, callback, retries, requeues + 1);
      }
    };

    GM_xmlhttpRequest({
      method: 'GET',
      url,
      onload: (response) => {
        if (response.status === 404 || response.status === 410) {
          done();
          return callback(null); // gone for good — retrying can't help
        }
        if (response.status === 429 || response.status === 503) {
          tripThrottle(parseRetryAfterMs(response.responseHeaders), `HTTP ${response.status}`);
          return requeue();
        }
        if (response.status !== 200) return retry();
        if (looksLikeRobotCheck(response.responseText)) {
          tripThrottle(null, 'robot check');
          return requeue();
        }
        noteFetchSuccess();
        done();
        const { price, pageAsin } = extractPriceFromHTML(response.responseText);
        // Page loaded fine but carries no price (pre-release / unavailable):
        // retrying would just re-download the same page.
        if (price === null) return callback(null);
        // Amazon substituted a different variant (typically a parent's default
        // child) — its price is not this ASIN's price.
        if (pageAsin && asin && pageAsin !== asin.toUpperCase()) {
          return callback({ price, isCached: false, unreliable: true });
        }
        callback({ price, isCached: false });
      },
      onerror: retry
    });
  }

  // ---- Vine recommendations API (parent-ASIN listings) ----
  // A parent tile's link goes to /dp/{parentAsin}, where Amazon renders the
  // default child's buybox — which is how a $16.99 accessory merged into a
  // $299 listing shows as $299. The recommendations API (the same endpoint the
  // "See details" modal uses) reports which child variations Vine actually
  // offers, and — when present — their ETV (taxValue).

  const vineApiQueue = [];
  let vineApiActive = 0;
  const VINE_API_MAX_CONCURRENT = 2;

  function pumpVineApiQueue() {
    if (isThrottled()) return; // tripThrottle re-pumps after the cooldown
    while (vineApiActive < VINE_API_MAX_CONCURRENT && vineApiQueue.length > 0) {
      const task = vineApiQueue.shift();
      vineApiActive++;
      task(() => {
        vineApiActive--;
        pumpVineApiQueue();
      });
    }
  }

  function fetchVineRecommendation(recId, callback) {
    vineApiQueue.push((done) => {
      const url = `${location.origin}/vine/api/recommendations/${encodeURIComponent(recId)}`;
      gmFetch({ url, headers: { 'Accept': 'application/json' } })
        .then(res => {
          done();
          let json = null;
          try { json = JSON.parse(res.responseText); } catch (e) { /* HTML error page */ }
          callback(json && json.result ? json.result : null);
        })
        .catch(err => {
          const retryAfter = parseRetryAfterMs(err.responseHeaders);
          if (err.status === 429 || err.status === 503) {
            tripThrottle(retryAfter, `vine API HTTP ${err.status}`);
          }
          // On 429, hold the slot until Retry-After elapses so we don't hammer the API.
          setTimeout(done, err.status === 429 ? (retryAfter || 5000) : 0);
          callback(null);
        });
    });
    pumpVineApiQueue();
  }

  function numOrNull(v) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n) && n >= 0) ? n : null;
  }

  // Resolve the price (or range) of the variations Vine actually offers on a
  // parent listing. Calls back with:
  //   { price, priceMax, isEtv } — from the API (plus child pages if it lacks taxValue)
  //   { price, approx: true }   — fell back to the parent page's default-child price
  //   null                      — nothing resolvable
  function fetchParentPrices(recId, parentUrl, callback) {
    const origin = (() => {
      try { return new URL(parentUrl, location.href).origin; } catch (e) { return location.origin; }
    })();

    const fallbackToParentPage = () => {
      fetchPrice(parentUrl, null, (data) => {
        callback(data ? { price: data.price, approx: true } : null);
      });
    };

    fetchVineRecommendation(recId, (result) => {
      if (!result) return fallbackToParentPage();
      const variations = Array.isArray(result.variations) ? result.variations : [];

      // Best case: ETV per variation — exact, and no page fetches needed.
      const taxValues = [];
      for (const v of variations) {
        const tv = v && numOrNull(v.taxValue);
        if (tv !== null) taxValues.push(tv);
      }
      const itemEtv = numOrNull(result.taxValue);
      if (taxValues.length === 0 && itemEtv !== null) taxValues.push(itemEtv);
      if (taxValues.length > 0) {
        callback({ price: Math.min(...taxValues), priceMax: Math.max(...taxValues), isEtv: true });
        return;
      }

      // No ETV in the response: probe the offered children's pages (capped).
      const childAsins = variations
        .map(v => v && v.asin)
        .filter(a => /^[A-Z0-9]{10}$/i.test(a || ''))
        .slice(0, 4);
      if (childAsins.length === 0) return fallbackToParentPage();

      const prices = [];
      let pending = childAsins.length;
      childAsins.forEach(childAsin => {
        fetchPrice(`${origin}/dp/${childAsin}`, childAsin, (data) => {
          if (data && !data.unreliable) prices.push(data.price);
          if (--pending === 0) {
            if (prices.length > 0) {
              callback({ price: Math.min(...prices), priceMax: Math.max(...prices), isEtv: false });
            } else {
              fallbackToParentPage();
            }
          }
        }, 0); // child probes: no retries
      });
    });
  }

  // UI helpers — called per-item on hot paths. getThresholds() handles format migration once at load.
  function getPriceColorSync(price) {
    const t = cachedThresholds || CONFIG.DEFAULT_THRESHOLDS;
    if (price >= t.GREEN_MIN) return 'green';
    if (price >= t.YELLOW_MIN) return 'yellow';
    return 'red';
  }

  // priceData: { price, priceMax?, isEtv?, approx? } — priceMax renders a range
  // (multi-variant listing), approx marks a wrong-variant fallback price.
  function formatPriceLabel(priceData) {
    const base = `$${priceData.price.toFixed(2)}`;
    if (priceData.priceMax != null && priceData.priceMax > priceData.price) {
      return `${base}–$${priceData.priceMax.toFixed(2)}`;
    }
    return priceData.approx ? `~${base}` : base;
  }

  function createPriceBadge(priceData, isCached, isSeen, color) {
    const label = formatPriceLabel(priceData);
    const isRange = priceData.priceMax != null && priceData.priceMax > priceData.price;

    const badge = document.createElement('div');
    badge.className = `vine-price-badge vine-price-${color}`;
    badge.setAttribute('aria-label', isRange
      ? `Product price range: ${label}`
      : `Product price: ${label}`);
    badge.setAttribute('role', 'status');
    badge.setAttribute('data-price-color', color);

    const priceText = document.createElement('span');
    priceText.className = 'vine-price-text';
    priceText.textContent = label;
    if (priceData.isEtv) {
      priceText.title = 'ETV (estimated tax value) reported by Vine';
    } else if (priceData.approx) {
      priceText.title = 'Approximate — Amazon showed a different variant of this listing';
    }
    badge.appendChild(priceText);

    if (isRange) {
      const variantIndicator = document.createElement('span');
      variantIndicator.className = 'vine-variant-indicator';
      variantIndicator.textContent = '🔀';
      variantIndicator.title = 'Multiple variants offered — price range shown';
      badge.appendChild(variantIndicator);
    }

    if (isCached) {
      const cacheIndicator = document.createElement('span');
      cacheIndicator.className = 'vine-cache-indicator';
      cacheIndicator.textContent = '📦';
      cacheIndicator.title = 'Cached price';
      badge.appendChild(cacheIndicator);
    }

    if (isSeen) {
      const seenIndicator = document.createElement('span');
      seenIndicator.className = 'vine-seen-indicator';
      seenIndicator.textContent = '👁️';
      seenIndicator.title = 'Previously seen';
      seenIndicator.style.marginLeft = '4px';
      badge.appendChild(seenIndicator);
    }

    return badge;
  }

  // Pre-release detection drives the "auto mark as seen" path when price fetch fails.
  // Memoized on item.dataset.vinePreRelease because the full text-normalization scan is expensive.
  function isPreReleaseItem(item) {
    if (item.dataset.vinePreRelease === 'true') return true;
    if (item.dataset.vinePreRelease === 'false') return false;

    const result = computePreReleaseItem(item);
    item.dataset.vinePreRelease = result ? 'true' : 'false';
    return result;
  }

  function computePreReleaseItem(item) {
    const htmlContent = item.innerHTML || '';
    if (htmlContent.includes('data-is-pre-release="true"') || htmlContent.includes('vvp-badge-prerelease')) {
      return true;
    }
    if (item.querySelector('input[data-is-pre-release="true"]')) return true;
    if (item.classList.contains('vvp-badge-prerelease') || item.querySelector('.vvp-badge-prerelease')) {
      return true;
    }

    // Normalized text match handles "Pre-Release", "Pre - Release", "Pre Release", etc.
    const normalizedText = (item.textContent || '').toLowerCase().replace(/[\W_]+/g, '');
    if (/prerelease|availableforpreorder|preorder|presale|willbereleasedon/.test(normalizedText)) {
      return true;
    }

    for (const img of item.querySelectorAll('img')) {
      const alt = (img.alt || '').toLowerCase().replace(/[\W_]+/g, '');
      const title = (img.title || '').toLowerCase().replace(/[\W_]+/g, '');
      if (alt.includes('prerelease') || title.includes('prerelease')) return true;
    }

    for (const badge of item.querySelectorAll('.a-badge-text')) {
      const label = (badge.textContent || '').toLowerCase().replace(/[\W_]+/g, '');
      if (label.includes('prerelease')) return true;
    }

    return false;
  }

  // ---- Tile title + keyword lists + external price-check links ----

  function getTileTitle(item) {
    if (item.dataset.vineTitle) return item.dataset.vineTitle;
    // .a-truncate-full holds the un-ellipsized title (visually hidden)
    const fullTitle = item.querySelector('.vvp-item-product-title-container .a-truncate-full');
    let title = fullTitle ? fullTitle.textContent.trim() : '';
    if (!title) {
      const link = item.querySelector('a[href*="/dp/"]');
      title = link ? link.textContent.trim() : '';
    }
    if (!title) {
      const img = item.querySelector('img[alt]');
      title = img ? img.alt.trim() : '';
    }
    item.dataset.vineTitle = title;
    return title;
  }

  // Keyword lists: 'block' hides tiles, 'highlight' outlines them. Loaded once,
  // matched synchronously (applyColorFilter is already two callbacks deep), and
  // memoized per tile against a revision counter so edits invalidate cleanly.
  let cachedKeywordLists = null;
  let keywordListsRevision = 0;

  function getKeywordListsSync() {
    if (cachedKeywordLists === null) {
      const stored = getStorage(CONFIG.KEYWORD_LISTS_KEY, {});
      cachedKeywordLists = {
        highlight: Array.isArray(stored && stored.highlight) ? stored.highlight : [],
        block: Array.isArray(stored && stored.block) ? stored.block : []
      };
    }
    return cachedKeywordLists;
  }

  function setKeywordLists(lists) {
    cachedKeywordLists = lists;
    keywordListsRevision++;
    setStorage(CONFIG.KEYWORD_LISTS_KEY, lists);
    setStorage(CONFIG.KEYWORD_LISTS_TIMESTAMP_KEY, Date.now());
  }

  function getKeywordStateSync(item) {
    if (item.dataset.vineKwRev === String(keywordListsRevision) && item.dataset.vineKwState) {
      return item.dataset.vineKwState;
    }
    const lists = getKeywordListsSync();
    let state = 'none';
    if (lists.block.length || lists.highlight.length) {
      const title = getTileTitle(item).toLowerCase();
      if (lists.block.some(kw => kw && title.includes(kw.toLowerCase()))) {
        state = 'block'; // block wins over highlight
      } else if (lists.highlight.some(kw => kw && title.includes(kw.toLowerCase()))) {
        state = 'highlight';
      }
    }
    item.dataset.vineKwState = state;
    item.dataset.vineKwRev = String(keywordListsRevision);
    return state;
  }

  // Keepa's URL scheme uses a numeric marketplace id, not the domain.
  const KEEPA_DOMAIN_IDS = {
    'amazon.com': 1, 'amazon.co.uk': 2, 'amazon.de': 3, 'amazon.fr': 4,
    'amazon.co.jp': 5, 'amazon.ca': 6, 'amazon.it': 8, 'amazon.es': 9,
    'amazon.in': 10, 'amazon.com.au': 11
  };

  function keepaDomainId() {
    const host = location.hostname;
    for (const [domain, id] of Object.entries(KEEPA_DOMAIN_IDS)) {
      if (host.endsWith(domain)) return id;
    }
    return 1;
  }

  let externalLinksEnabled = true;
  let externalLinksLoaded = false;

  function getExternalLinksEnabled() {
    if (!externalLinksLoaded) {
      externalLinksLoaded = true;
      externalLinksEnabled = getStorage(CONFIG.EXTERNAL_LINKS_KEY, true);
    }
    return externalLinksEnabled;
  }

  function attachExternalLinks(badge, asin, title) {
    if (!getExternalLinksEnabled()) return;
    const row = document.createElement('span');
    row.className = 'vine-ext-links';
    const links = [
      { label: 'K', tip: 'Price history on Keepa', url: `https://keepa.com/#!product/${keepaDomainId()}-${asin}` },
      { label: 'C', tip: 'Price history on CamelCamelCamel', url: `https://camelcamelcamel.com/product/${asin}` },
      { label: 'G', tip: 'Search Google for this product', url: `https://www.google.com/search?q=${encodeURIComponent(title || asin)}` }
    ];
    links.forEach(({ label, tip, url }) => {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label;
      a.title = tip;
      a.className = 'vine-ext-link';
      // keep tile click handlers out of it, but let the link itself navigate
      a.addEventListener('click', (e) => e.stopPropagation());
      row.appendChild(a);
    });
    badge.appendChild(row);
  }

  // Apply color filter to an item.
  // NOTE: we intentionally don't flip item.dataset.vineSeen to 'true' when a not-seen item is shown,
  // otherwise toggling "Hide Seen" back on would make it vanish mid-session. The cache is bumped
  // to seen=true once, for the next session — guarded by vineSeenPersisted so we don't re-write
  // the cache every time the filter re-applies.
  function applyColorFilter(item, color) {
    if (TEST.noColorFilter) return; // TEMP bisection D — skip all hide/style/class changes
    getColorFilter((filter) => {
      getHideCached((shouldHideCached) => {
        const isSeen = item.dataset.vineSeen === 'true';
        const colorAllowed = filter[color];
        const kwState = getKeywordStateSync(item);
        item.classList.toggle('vine-keyword-highlight', kwState === 'highlight');
        const shouldShow = colorAllowed && !(isSeen && shouldHideCached) && kwState !== 'block';

        if (shouldShow) {
          item.style.display = '';
          item.dataset.vineHidden = 'false';

          // Approx (wrong-variant) tiles are excluded here — this write doesn't
          // tag the entry as approx, and doing so would let a stale/possibly-wrong
          // price get served directly on a future load. Their isSeen is instead
          // persisted (with the approx tag) at fetch time in processBatch.
          if (!isSeen && item.dataset.vineSeenPersisted !== 'true' && item.dataset.vineApprox !== 'true') {
            const asin = item.dataset.vineAsin;
            const price = parseFloat(item.dataset.vinePrice);
            if (asin && !isNaN(price)) {
              // carry the variant metadata through, or this rewrite would strip
              // isParent and force a refetch of parent items on every load
              const priceMax = parseFloat(item.dataset.vinePriceMax);
              setCachedPrice(asin, price, true, {
                priceMax: isNaN(priceMax) ? null : priceMax,
                isParent: item.dataset.vineIsParent === 'true',
                isEtv: item.dataset.vineIsEtv === 'true'
              });
              item.dataset.vineSeenPersisted = 'true';
            }
          }
        } else {
          item.style.display = 'none';
          item.dataset.vineHidden = 'true';
        }

        checkAndAutoAdvance();
      });
    });
  }

  // Processing
  const activeFetches = new Map();

  function processBatch(items, isInitialLoad = false) {
    if (items.length === 0) return;

    const itemData = items.map(item => {
      // The "See details" button input is authoritative: it carries the offer's
      // ASIN, whether it's a variation parent, and the recommendation id the
      // Vine API needs. The dp-link is the fallback for layout changes.
      const detailsInput = item.querySelector('.vvp-details-btn input, input[data-recommendation-id]');
      const link = item.querySelector('a[href*="/dp/"]');
      const inputAsin = detailsInput && detailsInput.dataset.asin;
      const asin = (inputAsin && /^[A-Z0-9]{10}$/i.test(inputAsin))
        ? inputAsin.toUpperCase()
        : (link ? extractASIN(link.href) : null);
      if (!asin) return null;
      let origin = location.origin;
      if (link) {
        try { origin = new URL(link.href, location.href).origin; } catch (e) { /* keep location.origin */ }
      }
      // Store ASIN on item immediately for consistency
      item.dataset.vineAsin = asin;
      if (detailsInput && detailsInput.dataset.isParentAsin === 'true') {
        item.dataset.vineIsParent = 'true';
      }
      return {
        item,
        asin,
        url: link ? link.href : `${origin}/dp/${asin}`,
        isParent: !!(detailsInput && detailsInput.dataset.isParentAsin === 'true'),
        recId: detailsInput ? (detailsInput.dataset.recommendationId || null) : null
      };
    }).filter(data => data && data.asin);

    if (itemData.length === 0) return;

    // Batch style checks - only check first item and apply to all if needed
    const needsPositioning = itemData.length > 0 && getComputedStyle(itemData[0].item).position === 'static';

    itemData.forEach(({ item }) => {
      if (needsPositioning) {
        item.style.position = 'relative';
      }
      item.dataset.vinePriceProcessed = 'true';
    });

    const asins = itemData.map(data => data.asin);
    getMultipleCachedPrices(asins, (cachedResults) => {
      getHideCached((shouldHide) => {
        const uncachedItems = [];

        itemData.forEach(({ item, asin, url, isParent, recId }) => {
          const cached = cachedResults[asin];
          // Entries cached before parent detection existed hold the parent
          // page's default-child price (the wrong product) — refetch them.
          const staleParentEntry = isParent && cached && !cached.isParent;
          // Approx (wrong-variant) entries are never served directly — the
          // price could be for the wrong product — but we still remember
          // whether the user already saw this tile so it doesn't come back
          // every reload just because we have to refetch its price.
          const staleApproxEntry = !!(cached && cached.approx === true);
          if (cached && !staleParentEntry && !staleApproxEntry && cached.price !== undefined && cached.price !== null) {
            item.dataset.vineIsCached = 'true';
            item.dataset.vinePrice = cached.price;
            if (cached.priceMax != null) item.dataset.vinePriceMax = cached.priceMax;
            if (cached.isEtv) item.dataset.vineIsEtv = 'true';
            // Default to true for legacy cache entries without isSeen property
            const isSeen = cached.isSeen !== undefined ? cached.isSeen : true;
            item.dataset.vineSeen = String(isSeen);

            const color = getPriceColorSync(cached.price);
            const badge = createPriceBadge(
              { price: cached.price, priceMax: cached.priceMax, isEtv: cached.isEtv },
              true, isSeen, color
            );
            if (!TEST.noBadgeNode) {
              attachExternalLinks(badge, asin, getTileTitle(item));
              item.appendChild(badge);
            }
            applyColorFilter(item, color);
          } else if (cached && !staleParentEntry && !staleApproxEntry && cached.noPrice) {
            // Recently confirmed to have no price — skip the fetch and mirror
            // the live-failure behavior (pre-release tiles get hidden).
            item.dataset.vineNoPrice = 'true';
            if (isPreReleaseItem(item)) applyColorFilter(item, 'gray');
          } else {
            const priorIsSeen = staleApproxEntry ? !!cached.isSeen : false;
            uncachedItems.push({ item, asin, url, isParent, recId, priorIsSeen });
          }
        });

        uncachedItems.forEach(({ item, asin, url, isParent, recId, priorIsSeen }) => {
          const fetchId = `${asin}-${Date.now()}`;
          activeFetches.set(asin, fetchId);

          const handleResult = (priceData) => {
            if (activeFetches.get(asin) !== fetchId) return;
            activeFetches.delete(asin);
            if (priceData) {
              const color = getPriceColorSync(priceData.price);

              // Store price (lowest of a range) — filters/sort key off this
              item.dataset.vinePrice = priceData.price;
              if (priceData.priceMax != null) item.dataset.vinePriceMax = priceData.priceMax;
              if (priceData.isEtv) item.dataset.vineIsEtv = 'true';
              if (priceData.approx) item.dataset.vineApprox = 'true';

              // Calculate visibility (isSeen) based on filters
              getColorFilter((filter) => {
                const isVisible = filter[color];

                // Always persist isSeen so "Hide Seen" keeps working across
                // reloads. Approx (wrong-variant) prices are tagged so the
                // read path above never trusts the cached price itself —
                // only the isSeen flag is reused; the price is refetched
                // fresh every time.
                setCachedPrice(asin, priceData.price, isVisible, {
                  priceMax: priceData.priceMax,
                  isParent,
                  isEtv: priceData.isEtv,
                  approx: priceData.approx || undefined
                });

                // Carry forward whether this tile was already marked seen in
                // a prior session (relevant for approx tiles, which always
                // land here since their price can't be served from cache).
                item.dataset.vineSeen = priorIsSeen ? 'true' : 'false';
              });

              const badge = createPriceBadge(priceData, false, false, color);
              if (!TEST.noBadgeNode) {
                attachExternalLinks(badge, asin, getTileTitle(item));
                item.appendChild(badge);
              }
              applyColorFilter(item, color);
              scheduleSortRefresh();
            } else {
              // Genuine no-price result (not a throttle abort): remember it so
              // this item doesn't re-fetch on every page load.
              if (!isThrottled()) {
                setCachedPrice(asin, null, false, { noPrice: true, isParent });
                item.dataset.vineNoPrice = 'true';
              }
              // If price fetch failed but it IS a pre-release item
              if (isPreReleaseItem(item)) applyColorFilter(item, 'gray');
            }
          };

          if (isParent && recId) {
            fetchParentPrices(recId, url, handleResult);
          } else {
            fetchPrice(url, asin, (data) => {
              if (data && data.unreliable) {
                handleResult({ price: data.price, approx: true });
              } else {
                handleResult(data);
              }
            });
          }
        });

        // Check if all items are hidden and auto-advance if enabled
        checkAndAutoAdvance();

        // Cached items got their badges synchronously above
        scheduleSortRefresh();
      });
    });
  }

  // Check if all items are hidden and auto-advance to next page (Debounced)
  function checkAndAutoAdvance() {
    if (autoAdvanceCheckTimeout) {
      clearTimeout(autoAdvanceCheckTimeout);
    }

    autoAdvanceCheckTimeout = setTimeout(() => {
      // Synchronous read: don't do any DOM work if auto-advance is disabled.
      if (!autoAdvanceLoaded) {
        getAutoAdvance(() => checkAndAutoAdvance());
        return;
      }
      if (!autoAdvance) return;
      // Infinite scroll subsumes auto-advance: with everything hidden the
      // sentinel stays in view and the next page loads inline anyway.
      if (getInfiniteScroll()) return;

      const allItems = findVineItems();
      if (allItems.length === 0) return;

      const allHidden = allItems.every(item => item.dataset.vineHidden === 'true');
      if (!allHidden) return;

      const nextButton = findPageLink(CONFIG.NEXT_PAGE_SELECTORS);
      if (nextButton && !nextButton.parentElement.classList.contains('a-disabled')) {
        console.log('All items hidden, auto-advancing to next page...');
        nextButton.click();
      } else {
        console.log('All items hidden but no next page available');
      }
    }, 1000);
  }

  // Scope every tile lookup to the items grid. Amazon clones a tile (with its
  // `data-recommendation-id`) into the request/order popover it appends to
  // <body>; a document-wide query would match that clone and inject our badge
  // into Amazon's order DOM, breaking the submit selector. The grid never
  // contains the popover, so scoping to it excludes the clone regardless of
  // the popover's class. Falls back to document-wide on Vine layouts that
  // have no grid (which also never render the request popover).
  function vineItemsRoot() {
    return document.querySelector('.vvp-items-grid, #vvp-items-grid') || document;
  }

  function findVineItems() {
    const root = vineItemsRoot();
    for (const selector of CONFIG.VINE_ITEM_SELECTORS) {
      const found = root.querySelectorAll(selector);
      if (found.length > 0) return Array.from(found);
    }
    return [];
  }

  function findPageLink(selectors) {
    return findFirstMatch(document, selectors);
  }

  // ---- Sort tiles by price ----
  let sortOrder = null; // 'none' | 'asc' | 'desc'
  let isReordering = false;
  let sortRefreshTimeout = null;

  function getSortOrder() {
    if (sortOrder === null) sortOrder = getStorage(CONFIG.SORT_ORDER_KEY, 'none');
    return sortOrder;
  }

  function sortVineTiles() {
    const order = getSortOrder();
    if (order !== 'asc' && order !== 'desc') return;
    const items = findVineItems();
    if (items.length < 2) return;
    const parent = items[0].parentElement;
    if (!parent) return;

    const sorted = [...items].sort((a, b) => {
      const pa = parseFloat(a.dataset.vinePrice);
      const pb = parseFloat(b.dataset.vinePrice);
      const va = isNaN(pa) ? Infinity : pa; // unpriced tiles sink to the end
      const vb = isNaN(pb) ? Infinity : pb;
      if (va === vb) return 0;
      if (va === Infinity) return 1;
      if (vb === Infinity) return -1;
      return order === 'asc' ? va - vb : vb - va;
    });

    // appendChild moves nodes (badges/listeners survive); flag the reorder so
    // the MutationObserver doesn't burn a debounce cycle on our own mutations.
    isReordering = true;
    sorted.forEach(item => parent.appendChild(item));
    setTimeout(() => { isReordering = false; }, 0);
  }

  // Debounced re-sort: prices arrive async, so the page settles into order
  // shortly after fetches complete instead of thrashing per item.
  function scheduleSortRefresh() {
    if (getSortOrder() === 'none') return;
    if (sortRefreshTimeout) clearTimeout(sortRefreshTimeout);
    sortRefreshTimeout = setTimeout(sortVineTiles, 500);
  }

  // ---- Infinite scroll ----
  let infiniteScroll = false;
  let infiniteScrollLoaded = false;
  let infiniteScrollObserver = null;
  let infiniteSentinel = null;
  let nextPageHref = null;
  let isLoadingNextPage = false;
  let lastInfiniteLoadAt = 0;
  let loadsSinceScroll = 0;
  const INFINITE_LOAD_COOLDOWN = 1000;
  const INFINITE_MAX_CHAIN = 5; // pages loaded without a user scroll (filters can hide everything)
  const onInfiniteUserScroll = () => { loadsSinceScroll = 0; };

  function getInfiniteScroll() {
    if (!infiniteScrollLoaded) {
      infiniteScrollLoaded = true;
      infiniteScroll = getStorage(CONFIG.INFINITE_SCROLL_KEY, false);
    }
    return infiniteScroll;
  }

  function setupInfiniteScroll() {
    if (!getInfiniteScroll() || infiniteScrollObserver) return;
    const items = findVineItems();
    const grid = items.length
      ? items[0].parentElement
      : document.querySelector('.vvp-items-grid, #vvp-items-grid');
    if (!grid) return;

    const nextLink = findPageLink(CONFIG.NEXT_PAGE_SELECTORS);
    nextPageHref = (nextLink && !nextLink.parentElement.classList.contains('a-disabled'))
      ? nextLink.href
      : null;
    if (!nextPageHref) return;

    // A previous teardown may have left an end-message sentinel in the DOM.
    const staleSentinel = document.getElementById('vine-infinite-sentinel');
    if (staleSentinel) staleSentinel.remove();

    infiniteSentinel = document.createElement('div');
    infiniteSentinel.id = 'vine-infinite-sentinel';
    grid.parentElement.insertBefore(infiniteSentinel, grid.nextSibling);

    window.addEventListener('scroll', onInfiniteUserScroll, { passive: true });

    infiniteScrollObserver = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) loadNextPageInline(grid);
    }, { rootMargin: '800px' });
    infiniteScrollObserver.observe(infiniteSentinel);
  }

  function teardownInfiniteScroll(endMessage) {
    window.removeEventListener('scroll', onInfiniteUserScroll);
    if (infiniteScrollObserver) {
      infiniteScrollObserver.disconnect();
      infiniteScrollObserver = null;
    }
    if (infiniteSentinel) {
      if (endMessage) {
        infiniteSentinel.textContent = endMessage;
        infiniteSentinel.className = 'vine-infinite-end';
      } else {
        infiniteSentinel.remove();
        infiniteSentinel = null;
      }
    }
  }

  async function loadNextPageInline(grid) {
    if (isLoadingNextPage || !nextPageHref || isThrottled()) return;
    const now = Date.now();
    if (now - lastInfiniteLoadAt < INFINITE_LOAD_COOLDOWN) return;
    if (loadsSinceScroll >= INFINITE_MAX_CHAIN) return; // wait for a real scroll
    isLoadingNextPage = true;
    lastInfiniteLoadAt = now;
    loadsSinceScroll++;
    const fetchedUrl = nextPageHref;

    try {
      const res = await gmFetch({ url: fetchedUrl });
      const doc = new DOMParser().parseFromString(res.responseText, 'text/html');

      let newTiles = [];
      for (const selector of CONFIG.VINE_ITEM_SELECTORS) {
        const found = doc.querySelectorAll(selector);
        if (found.length > 0) { newTiles = Array.from(found); break; }
      }

      // Vine reshuffles items between pages — skip tiles already on the page.
      const presentAsins = new Set(
        Array.from(document.querySelectorAll('[data-vine-asin]')).map(el => el.dataset.vineAsin)
      );
      const appended = [];
      newTiles.forEach(tile => {
        const input = tile.querySelector('.vvp-details-btn input, input[data-recommendation-id]');
        const link = tile.querySelector('a[href*="/dp/"]');
        const inputAsin = input && input.dataset.asin;
        const asin = (inputAsin && /^[A-Z0-9]{10}$/i.test(inputAsin))
          ? inputAsin.toUpperCase()
          : (link ? extractASIN(link.href) : null);
        if (asin && presentAsins.has(asin)) return;
        if (asin) presentAsins.add(asin);
        appended.push(document.adoptNode(tile));
      });
      // The MutationObserver routes these through processBatch (they lack
      // vinePriceProcessed). Scripts parsed by DOMParser are inert.
      // One fragment append = one layout + one observer batch.
      const fragment = document.createDocumentFragment();
      appended.forEach(tile => fragment.appendChild(tile));
      grid.appendChild(fragment);

      // Advance pagination state from the FETCHED document — the live DOM
      // still points at the page we just consumed.
      const fetchedNext = findFirstMatch(doc, CONFIG.NEXT_PAGE_SELECTORS);
      const hasNext = fetchedNext && fetchedNext.parentElement
        && !fetchedNext.parentElement.classList.contains('a-disabled')
        && fetchedNext.getAttribute('href');
      const livePagination = document.querySelector('.a-pagination');
      const fetchedPagination = doc.querySelector('.a-pagination');
      if (livePagination && fetchedPagination) {
        // keeps ArrowLeft/ArrowRight keyboard nav coherent
        livePagination.replaceWith(document.adoptNode(fetchedPagination));
      }
      try { history.replaceState(null, '', fetchedUrl); } catch (e) { /* ignore */ }
      nextPageHref = hasNext ? new URL(fetchedNext.getAttribute('href'), fetchedUrl).href : null;
      if (!nextPageHref) teardownInfiniteScroll('— End of results —');

      scheduleSortRefresh();
    } catch (err) {
      if (err && err.status === 503) {
        const retryAfterMs = parseRetryAfterMs(err.responseHeaders) || 30000;
        console.warn(`[Vine] Infinite scroll got 503 — retrying in ${Math.round(retryAfterMs / 1000)}s`);
        // No page was consumed — don't let the failed attempt count against
        // the no-scroll chain cap, or a 503 near the cap can never retry.
        loadsSinceScroll = Math.max(0, loadsSinceScroll - 1);
        setTimeout(() => {
          // User may have disabled infinite scroll during the wait.
          if (infiniteScrollObserver) loadNextPageInline(grid);
        }, retryAfterMs);
      } else {
        console.error('[Vine] Infinite scroll load failed:', err);
      }
    } finally {
      isLoadingNextPage = false;
    }
  }

  function processVineItems(isInitialLoad = false) {
    let items = [];
    // Grid-scoped so the request/order popover clone is never processed — see vineItemsRoot().
    const root = vineItemsRoot();

    if (cachedSelector) {
      const found = root.querySelectorAll(cachedSelector);
      if (found.length > 0) {
        items = Array.from(found).filter(item => !item.dataset.vinePriceProcessed);
      } else {
        cachedSelector = null;
      }
    }

    if (items.length === 0) {
      for (const selector of CONFIG.VINE_ITEM_SELECTORS) {
        const found = root.querySelectorAll(selector);
        if (found.length > 0) {
          items = Array.from(found).filter(item => !item.dataset.vinePriceProcessed);
          cachedSelector = selector;
          break;
        }
      }
    }

    if (items.length > 0) processBatch(items, isInitialLoad);
  }

  // Mutation observer
  let mutationObserver = null;
  let processingTimeout = null;
  let processingRaf = null;

  function observePageChanges() {
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    if (processingRaf) {
      cancelAnimationFrame(processingRaf);
      processingRaf = null;
    }
    if (processingTimeout) {
      clearTimeout(processingTimeout);
    }

    mutationObserver = new MutationObserver((mutations) => {
      // Our own sort reorders fire childList mutations — skip them
      if (isReordering) return;

      // Filter mutations to only process relevant changes
      const hasRelevantChanges = mutations.some(mutation => {
        // Only process if nodes were added
        if (mutation.addedNodes.length === 0) return false;

        // Check if any added nodes or their children contain Vine items
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) { // Element node
            if (node.classList && (
              node.classList.contains('vvp-item-tile') ||
              node.hasAttribute('data-recommendation-id') ||
              node.querySelector('.vvp-item-tile') ||
              node.querySelector('[data-recommendation-id]')
            )) {
              return true;
            }
          }
        }
        return false;
      });

      if (!hasRelevantChanges) return;

      // Cancel BOTH pending stages: a stale rAF from an earlier batch would
      // otherwise queue a second timeout and double-run processVineItems.
      if (processingRaf) cancelAnimationFrame(processingRaf);
      if (processingTimeout) clearTimeout(processingTimeout);
      processingRaf = requestAnimationFrame(() => {
        processingRaf = null;
        processingTimeout = setTimeout(() => {
          processVineItems(false);
        }, CONFIG.MUTATION_DEBOUNCE);
      });
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  let colorFilterRetries = 0;
  let reviewGenRetries = 0;
  const MAX_UI_INJECT_RETRIES = 10;

  function createColorFilterUI() {
    if (document.getElementById('vine-color-filter-wrapper')) return;

    const searchContainer = document.querySelector('.vvp-search-container') || document.querySelector('#vvp-search-box') || document.querySelector('.vvp-header-search-container');
    const searchForm = document.querySelector('#vvp-search-form') || document.querySelector('#search-vine-items-form');
    const contentArea = document.querySelector('.vvp-items-grid') ||
      document.querySelector('.vvp-body') ||
      document.querySelector('#vvp-items-grid');

    if (!contentArea && !searchContainer) {
      if (++colorFilterRetries <= MAX_UI_INJECT_RETRIES) {
        setTimeout(createColorFilterUI, 500);
      }
      return;
    }
    colorFilterRetries = 0;

    // Wrapper for the filters
    const filterWrapper = document.createElement('div');
    filterWrapper.id = 'vine-color-filter-wrapper';

    // Check if we can inject nicely into the toolbar
    const isToolbarInjection = !!(searchForm && searchForm.parentNode);

    if (isToolbarInjection) {
      filterWrapper.style.cssText = `
        display: inline-flex;
        align-items: center;
        margin-right: 20px;
        vertical-align: middle;
      `;
    } else {
      // Fallback style (subtle bar above content)
      filterWrapper.style.cssText = `
        display: flex;
        justify-content: flex-end;
        padding: 10px 0;
        margin-bottom: 10px;
        border-bottom: 1px solid var(--vine-border);
      `;
    }

    const filterContainer = document.createElement('div');
    filterContainer.id = 'vine-color-filter';
    filterContainer.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 15px;
      flex-wrap: wrap;
    `;

    // Prime memoized state — these read from storage exactly once.
    let currentFilter;
    getColorFilter((f) => { currentFilter = f; });
    getHideCached(() => {});

    // Hide Cached Items Toggle
    const hideCachedWrapper = document.createElement('label');
    hideCachedWrapper.style.cssText = `
      display: flex;
      align-items: center;
      cursor: pointer;
      user-select: none;
      font-size: 13px;
      color: var(--vine-fg);
      font-family: "Amazon Ember", Arial, sans-serif;
    `;

    const hideCachedCheckbox = document.createElement('input');
    hideCachedCheckbox.type = 'checkbox';
    hideCachedCheckbox.id = 'vine-filter-hide-cached';
    hideCachedCheckbox.checked = hideCached;
    hideCachedCheckbox.style.cssText = `
      margin-right: 6px;
      cursor: pointer;
    `;

    const hideCachedLabel = document.createElement('span');
    hideCachedLabel.textContent = 'Hide Seen 📦';

    hideCachedCheckbox.addEventListener('change', (e) => {
      hideCached = e.target.checked;
      hideCachedLoaded = true;
      setStorage(CONFIG.HIDE_CACHED_KEY, e.target.checked);
      applyColorFilterToAllItems();
    });

    hideCachedWrapper.appendChild(hideCachedCheckbox);
    hideCachedWrapper.appendChild(hideCachedLabel);

    // Add separator if sticking to toolbar
    if (isToolbarInjection) {
      hideCachedWrapper.style.marginRight = '12px';
      hideCachedWrapper.style.paddingRight = '12px';
      hideCachedWrapper.style.borderRight = '1px solid #ccc';
    }

    filterContainer.appendChild(hideCachedWrapper);

    const colors = [
      { name: 'green', label: '🟢 Green ($90+)', color: '#10b981' },
      { name: 'yellow', label: '🟡 Yellow', color: '#fbbf24' },
      { name: 'red', label: '🔴 Red', color: '#ef4444' }
    ];

    colors.forEach(({ name, label: colorLabel, color }) => {
      const checkboxWrapper = document.createElement('label');
      checkboxWrapper.style.cssText = `
        display: flex;
        align-items: center;
        cursor: pointer;
        user-select: none;
        font-size: 13px;
        color: var(--vine-fg);
        font-family: "Amazon Ember", Arial, sans-serif;
      `;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `vine-filter-${name}`;
      checkbox.checked = currentFilter[name];
      checkbox.style.cssText = `
        margin-right: 4px;
        cursor: pointer;
      `;

      const labelText = document.createElement('span');
      labelText.style.color = color;
      labelText.style.fontWeight = 'bold';
      labelText.textContent = colorLabel;

      checkbox.addEventListener('change', (e) => {
        colorFilter[name] = e.target.checked;
        setStorage(CONFIG.COLOR_FILTER_KEY, colorFilter);
        applyColorFilterToAllItems();
      });

      checkboxWrapper.appendChild(checkbox);
      checkboxWrapper.appendChild(labelText);
      filterContainer.appendChild(checkboxWrapper);
    });

    // Sort-by-price toggle: Off → low-to-high → high-to-low
    const sortBtn = document.createElement('button');
    sortBtn.type = 'button';
    sortBtn.id = 'vine-sort-btn';
    const sortLabels = { none: 'Sort: Off', asc: 'Sort: $ ↑', desc: 'Sort: $ ↓' };
    sortBtn.textContent = sortLabels[getSortOrder()] || sortLabels.none;
    sortBtn.title = 'Sort items on this page by price';
    sortBtn.addEventListener('click', () => {
      const next = { none: 'asc', asc: 'desc', desc: 'none' }[getSortOrder()] || 'none';
      sortOrder = next;
      setStorage(CONFIG.SORT_ORDER_KEY, next);
      sortBtn.textContent = sortLabels[next];
      // 'none' leaves the current order; a reload restores Vine's natural order
      if (next !== 'none') sortVineTiles();
    });
    filterContainer.appendChild(sortBtn);

    filterWrapper.appendChild(filterContainer);

    // Injection logic
    if (isToolbarInjection) {
      // Insert before the search form in the toolbar
      searchForm.parentNode.insertBefore(filterWrapper, searchForm);
    } else {
      // Fallback: Insert at top of content area
      contentArea.insertBefore(filterWrapper, contentArea.firstChild);
    }
  }

  // Apply color filter to all items on the page
  function applyColorFilterToAllItems() {
    // Re-use the single item logic which handles checks, 'seen' status updates, and auto-advance
    const allItems = document.querySelectorAll('[data-vine-price-processed="true"]');
    allItems.forEach(item => {
      const badge = item.querySelector('.vine-price-badge');
      if (badge) {
        const color = badge.getAttribute('data-price-color');
        if (color) {
          applyColorFilter(item, color);
        }
      } else if (isPreReleaseItem(item)) {
        // Handle pre-release items that didn't get a price badge (failed fetch)
        // We pass 'gray' as a dummy color, but applyColorFilter prioritizes isPreRelease check anyway
        applyColorFilter(item, 'gray');
      }
    });
  }

  // ---- Review-form auto-fill (title + body) ----
  // Amazon's review form comes in two flavors: (1) legacy React <input>/<textarea> pair, or
  // (2) a contenteditable rich-text editor (body is a div[contenteditable], not a textarea).
  // We try both. Title is virtually always a plain <input>. Body is the moving target.

  const REVIEW_TITLE_SELECTORS = [
    'input#ryp__review-title__input',
    'input[name="reviewTitle"]',
    'input[id*="review-title"]',
    'input[aria-label*="review" i][aria-label*="title" i]',
    'input[placeholder*="title" i]'
  ];

  const REVIEW_BODY_TEXTAREA_SELECTORS = [
    'textarea#ryp__review-text__textarea',
    'textarea.ryp__review-text__textarea',
    'textarea#reviewText',
    'textarea[id*="review-text"]',
    'textarea[id*="reviewText"]',
    'textarea[id*="review-body"]',
    'textarea[id*="reviewBody"]',
    'textarea[name="reviewText"]',
    'textarea[name="review"]',
    'textarea[aria-label*="review" i]',
    'textarea[placeholder*="review" i]',
    'textarea[placeholder*="like or dislike" i]',
    '[data-hook="review-body"]',
    '[data-testid*="review-text" i]',
    '[data-testid*="review-body" i]'
  ];

  const REVIEW_BODY_CONTENTEDITABLE_SELECTORS = [
    'div[contenteditable="true"][aria-label*="review" i]',
    'div[contenteditable="true"][data-hook*="review"]',
    '[contenteditable="true"].ProseMirror',
    '[contenteditable="true"][data-lexical-editor="true"]',
    'div[role="textbox"][contenteditable="true"]'
  ];

  // React-mounted container for the entire review form (Scarface app).
  const REVIEW_APP_SCOPE_SELECTORS = [
    '#react-app.ryp__desktop',
    '#react-app',
    'form[name="ryp__review-form"]',
    'form[action*="review"]',
    '[data-hook*="review-form"]',
    '[class*="ryp__"]'
  ];

  // Must be excluded from any fallback — these are other textareas Amazon injects on the
  // same page (Rufus AI chat, search, etc.) that would otherwise match first.
  const NON_REVIEW_FIELD_IDS = new Set(['vine-review-comments', 'rufus-text-area']);
  const NON_REVIEW_ID_PATTERNS = [/rufus/i, /search/i];

  function isNonReviewField(el) {
    if (!el || !el.id) return false;
    if (NON_REVIEW_FIELD_IDS.has(el.id)) return true;
    return NON_REVIEW_ID_PATTERNS.some(p => p.test(el.id));
  }

  function findReviewFormScope() {
    return findFirstMatch(document, REVIEW_APP_SCOPE_SELECTORS);
  }

  function findReviewTitleField() {
    return findFirstMatch(document, REVIEW_TITLE_SELECTORS);
  }

  function describeEl(el) {
    if (!el) return 'null';
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string'
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
    const aria = el.getAttribute && el.getAttribute('aria-label');
    const ariaStr = aria ? ` aria-label="${aria.slice(0, 40)}"` : '';
    const editable = el.isContentEditable ? '[contenteditable]' : '';
    return `${el.tagName}${id}${cls}${ariaStr}${editable}`;
  }

  function dumpReviewFormCandidates() {
    const scope = findReviewFormScope();
    console.log('[Vine Tools] Review form scope:', scope ? describeEl(scope) : 'NO SCOPE FOUND');
    const searchRoot = scope || document;
    const textareas = Array.from(searchRoot.querySelectorAll('textarea'))
      .filter(el => el.id !== 'vine-review-comments' && el.offsetParent !== null);
    const editables = Array.from(searchRoot.querySelectorAll('[contenteditable="true"]'))
      .filter(el => el.offsetParent !== null);
    console.log('[Vine Tools] Visible textareas in scope:', textareas.map(describeEl));
    console.log('[Vine Tools] Visible contenteditables in scope:', editables.map(describeEl));
  }

  function findReviewBodyField() {
    const scope = findReviewFormScope();

    // 1. Scoped search within the React app (most reliable — can't match Rufus).
    if (scope) {
      for (const s of REVIEW_BODY_TEXTAREA_SELECTORS) {
        const el = scope.querySelector(s);
        if (el && !isNonReviewField(el)) return el;
      }
      for (const s of REVIEW_BODY_CONTENTEDITABLE_SELECTORS) {
        const el = scope.querySelector(s);
        if (el) return el;
      }
      // Any contenteditable inside the scope, visible.
      for (const el of scope.querySelectorAll('[contenteditable="true"]')) {
        if (el.offsetParent !== null) return el;
      }
      // Any non-excluded, visible textarea inside the scope.
      for (const ta of scope.querySelectorAll('textarea')) {
        if (isNonReviewField(ta)) continue;
        if (ta.offsetParent === null) continue;
        return ta;
      }
    }

    // 2. Unscoped selector fallback (older layouts without the React app container).
    for (const s of REVIEW_BODY_TEXTAREA_SELECTORS) {
      const el = document.querySelector(s);
      if (el && !isNonReviewField(el)) return el;
    }
    for (const s of REVIEW_BODY_CONTENTEDITABLE_SELECTORS) {
      const el = document.querySelector(s);
      if (el) return el;
    }

    return null;
  }

  function fillReviewField(el, value) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();

    if (tag === 'input' || tag === 'textarea') {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (el.isContentEditable) {
      el.focus();
      // Select everything currently in the editor, then let execCommand do the insert —
      // this works across Draft/Lexical/ProseMirror-style editors because they all
      // listen for beforeinput/input events produced by execCommand.
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, value);
      } catch (e) {
        inserted = false;
      }

      if (!inserted) {
        // Fallback: direct DOM write + bubbling input event. Most rich editors will
        // re-render from their internal state, but this at least gets the text visible.
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
      } else {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }

    console.warn('[Vine Tools] Unknown review field type:', el);
    return false;
  }

  function autoFillReviewForm(title, body) {
    const titleEl = findReviewTitleField();
    const bodyEl = findReviewBodyField();
    console.log('[Vine Tools] Review fields found:', {
      title: titleEl ? describeEl(titleEl) : 'NONE',
      body: bodyEl ? describeEl(bodyEl) : 'NONE'
    });
    if (!bodyEl) dumpReviewFormCandidates();
    return {
      title: !!(titleEl && fillReviewField(titleEl, title)),
      body: !!(bodyEl && fillReviewField(bodyEl, body))
    };
  }

  // Pull a human-readable error message + structured code out of an OpenAI error response.
  function parseOpenAIError(err) {
    const status = err && err.status;
    let code = null;
    let message = '';
    if (err && err.responseText) {
      try {
        const body = JSON.parse(err.responseText);
        if (body && body.error) {
          code = body.error.code || body.error.type || null;
          message = body.error.message || '';
        }
      } catch (_) { /* non-JSON body — leave message empty */ }
    }
    return { status, code, message };
  }

  // AI Review Generator
  // Per-provider storage keys — keeps generateReview free of nested provider ternaries.
  const PROVIDER_STORAGE = {
    openai: { apiKey: CONFIG.OPENAI_API_KEY, model: null },
    deepseek: { apiKey: CONFIG.DEEPSEEK_API_KEY, model: CONFIG.DEEPSEEK_MODEL },
    claude: { apiKey: CONFIG.CLAUDE_API_KEY, model: CONFIG.CLAUDE_MODEL }
  };

  async function generateReview(productDescription, starRating, userComments, onRetry) {
    const providerKey = getStorage(CONFIG.AI_PROVIDER, 'openai');
    const provider = CONFIG.PROVIDERS[providerKey] || CONFIG.PROVIDERS.openai;
    const storageKeys = PROVIDER_STORAGE[providerKey] || PROVIDER_STORAGE.openai;
    const isClaude = provider === CONFIG.PROVIDERS.claude;
    const apiKey = getStorage(storageKeys.apiKey, '');

    if (!apiKey) {
      throw new Error(`${provider.label} API key not configured. Please add your key in Vine Tools > Price Settings.`);
    }

    const model = storageKeys.model
      ? (getStorage(storageKeys.model, '') || provider.defaultModel)
      : provider.defaultModel;

    const sentiment = starRating >= 4 ? 'positive' : starRating >= 3 ? 'neutral' : 'negative';

    const systemPrompt = `You are writing an Amazon product review as a real customer who actually used this product. Your writing should sound completely natural and human - like you're telling a friend about your experience.

CRITICAL: Write like a real person, not an AI. Use:
- Casual, conversational language
- Personal pronouns (I, my, me)
- Contractions (it's, don't, I've)
- Varied sentence lengths
- Occasional minor imperfections that make it sound authentic
- Observations grounded in the product's actual features and typical use

Amazon Vine Voice Guidelines (follow these strictly):

Be unbiased: Whether positive, neutral, or negative, your review is about YOUR experience with the product and what YOU liked and didn't like about it. Your reviews are YOUR independent opinions and should not be influenced by anyone else.

Be honest: The honesty in an honest review will come through when you find a writing voice that comes natural to you. That's what customers can trust from Vine Voices - a solid honest review from another customer just like them who happens to spend their free time reviewing new products.

Be insightful yet specific: Reviews are about the product. Avoid vague, general, and repetitive comments. Share context that may help customers better assess the product and your experience with it, like:
- Your familiarity with this type of product
- How you used the product
- How long you used the product
- Specific situations where it worked well or didn't

Check your review for basic grammar and sentence structure (but don't make it sound overly polished or formal).

AVOID these AI tells and unnatural formats:
- Starting with greetings (e.g., "Hey there", "Hi", "Hello")
- Starting with "As a..." or "As someone who..."
- Phrases like "overall," "in conclusion," "it's worth noting"
- Overly balanced structure (pro, con, pro, con)
- Perfect grammar with no personality
- Generic statements that could apply to any product
- Fabricated personal scenarios (invented trips, events, or life context not provided by the user — stick to the product itself)

Output format:
You MUST return a JSON object with exactly two string fields:
- "title": a single short phrase, under 10 words, max 60 characters. NEVER a multi-sentence title. Do NOT include "Title:" or surrounding quotes. "Less is more."
- "body": the review body, 5-8 sentences. Jump straight into it with no greetings. Do NOT mention the star rating number.
Return ONLY the JSON object — no prose before or after.`;

    const userPrompt = `Write a review for this product based on its features and typical use.

Product: ${productDescription}

${userComments ? `Notes from testing: ${userComments}` : 'Base the review on the product description and realistic use cases for this type of product.'}

This should be a ${sentiment} review. Write naturally - like you're telling a friend about this product, but do not use any greetings or pleasantries. Do not invent personal stories, trips, or events — keep it grounded in what the product actually does.

Respond with a JSON object: {"title": "...", "body": "..."}`;

    // Anthropic's Messages API differs from the OpenAI-compatible providers:
    // auth via x-api-key + anthropic-version, system prompt is a top-level
    // field, no response_format (the prompt's JSON contract + parse fallbacks
    // cover that), and recent Claude models reject sampling params.
    const requestOpts = isClaude
      ? {
        method: 'POST',
        url: provider.url,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        data: JSON.stringify({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPrompt }
          ]
        })
      }
      : {
        method: 'POST',
        url: provider.url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        data: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 700,
          response_format: { type: 'json_object' }
        })
      };

    // Retry transient 429 (rate_limit_exceeded) and 5xx with exponential backoff, honoring
    // Retry-After header when present. Don't retry insufficient_quota — that's a billing issue.
    const MAX_ATTEMPTS = 4;
    const BASE_DELAY_MS = 1000;
    let attempt = 0;
    while (true) {
      try {
        const response = await gmFetch(requestOpts);
        const data = JSON.parse(response.responseText);
        if (isClaude) {
          if (data.stop_reason === 'refusal') {
            throw new Error('Claude declined to generate this review. Try adjusting your comments.');
          }
          const textBlock = (data.content || []).find(b => b.type === 'text');
          if (!textBlock || !textBlock.text) {
            throw new Error('Claude returned no text content.');
          }
          return textBlock.text.trim();
        }
        const choice = data.choices && data.choices[0];
        if (!choice || !choice.message || typeof choice.message.content !== 'string') {
          throw new Error(`${provider.label} returned no review content. Try again.`);
        }
        return choice.message.content.trim();
      } catch (error) {
        const info = parseOpenAIError(error);
        const isRateLimit = info.status === 429 && info.code !== 'insufficient_quota';
        const isServerErr = info.status >= 500 && info.status < 600;
        const canRetry = (isRateLimit || isServerErr) && attempt < MAX_ATTEMPTS - 1;

        if (!canRetry) {
          console.error('Error generating review:', error, info);
          if (info.status === 401) {
            throw new Error(`${provider.label} rejected the API key (401). Check it in Vine Tools > Price Settings.`);
          }
          if (info.status === 429 && info.code === 'insufficient_quota') {
            throw new Error(`${provider.label} quota exceeded — check your plan and billing. (${info.message || 'insufficient_quota'})`);
          }
          if (info.status === 429) {
            throw new Error(`${provider.label} rate limit hit and retries exhausted. ${info.message || 'Please wait a minute and try again.'}`);
          }
          if (info.status >= 500) {
            throw new Error(`${provider.label} server error (${info.status}) after ${attempt + 1} attempts. Try again shortly.`);
          }
          if (info.status && info.message) {
            throw new Error(`${provider.label} ${info.status}: ${info.message}`);
          }
          throw error;
        }

        const retryAfterMs = parseRetryAfterMs(error.responseHeaders);
        const backoff = BASE_DELAY_MS * Math.pow(2, attempt);
        const delayMs = retryAfterMs != null ? retryAfterMs : backoff;
        const reason = isRateLimit ? 'Rate limited' : ('Server error ' + info.status);
        console.warn('[Vine Tools] ' + reason + ' — retrying in ' + Math.round(delayMs / 1000) + 's (attempt ' + (attempt + 2) + '/' + MAX_ATTEMPTS + ')');
        if (typeof onRetry === 'function') {
          onRetry({ attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, delayMs, reason });
        }
        await sleep(delayMs);
        attempt++;
      }
    }
  }

  // Parse the AI response into {title, body}. Prefers JSON (our contract), then falls back
  // to newline-split, then to first-sentence-split — in case the model ignores JSON mode.
  function parseGeneratedReview(raw) {
    const text = (raw || '').trim();

    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj.title === 'string' && typeof obj.body === 'string') {
        return { title: obj.title.trim(), body: obj.body.trim() };
      }
    } catch (e) { /* fall through */ }

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      return { title: lines[0], body: lines.slice(1).join('\n').trim() };
    }

    // Single-line response: split on the first sentence boundary if it keeps the title under
    // the 60-char / 10-word budget. Otherwise bail — caller shows the whole thing as body.
    const match = text.match(/^([^.!?]{1,60}[.!?])\s+(.+)$/s);
    if (match && match[1].split(/\s+/).length <= 10) {
      return { title: match[1].trim(), body: match[2].trim() };
    }

    return { title: '', body: text };
  }

  function createReviewGeneratorUI() {
    // Show on product detail pages OR review creation pages
    const isProductPage = window.location.href.includes('/dp/');
    const isReviewPage = window.location.href.includes('/review/create-review');

    if (!isProductPage && !isReviewPage) {
      return;
    }

    // Check if already exists
    if (document.getElementById('vine-review-generator')) {
      return;
    }

    // Find the appropriate area to insert the generator
    let reviewArea;
    let insertPosition = 'before'; // 'before' or 'prepend'

    if (isReviewPage) {
      // On review creation page, try multiple selectors
      reviewArea = document.querySelector('form[name="ryp__review-form"]') ||
        document.querySelector('#ryp-review-form') ||
        document.querySelector('[data-hook="review-form"]') ||
        document.querySelector('.cr-widget-ReviewForm') ||
        document.querySelector('#product-review-form') ||
        document.querySelector('form[action*="review"]') ||
        document.querySelector('.a-section.review-form') ||
        document.querySelector('#cm-cr-review-form') ||
        document.querySelector('textarea[name="review"]')?.closest('form') ||
        document.querySelector('body'); // Fallback to body

      // If we found a form or specific element, prepend to it
      if (reviewArea && reviewArea.tagName !== 'BODY') {
        insertPosition = 'before';
      } else {
        // If using body, prepend to it
        insertPosition = 'prepend';
      }
    } else {
      // On product detail page, look for review section
      reviewArea = document.querySelector('#cr-write-review-link') ||
        document.querySelector('[data-hook="write-review-button"]') ||
        document.querySelector('#reviewsMedley') ||
        document.querySelector('body'); // Fallback
      insertPosition = 'before';
    }

    if (!reviewArea) {
      if (++reviewGenRetries <= MAX_UI_INJECT_RETRIES) {
        console.log('[Vine Tools] Review generator: waiting for page elements...');
        setTimeout(createReviewGeneratorUI, 1000);
      }
      return;
    }
    reviewGenRetries = 0;

    console.log('[Vine Tools] Review generator: inserting UI', {
      isReviewPage,
      element: reviewArea.tagName,
      insertPosition
    });

    const container = document.createElement('div');
    container.id = 'vine-review-generator';
    container.className = 'vine-review-panel';

    container.innerHTML = `
      <div class="vine-review-header">
        <h3 class="vine-review-title">🤖 AI Review Generator</h3>
        <button type="button" id="vine-close-generator" class="vine-review-close" aria-label="Close AI review generator">✕</button>
      </div>
      <div class="vine-review-body-wrap">
        <label class="vine-review-label" for="vine-review-stars">Star Rating</label>
        <select id="vine-review-stars" class="vine-review-input">
          <option value="5">⭐⭐⭐⭐⭐ (5 stars)</option>
          <option value="4">⭐⭐⭐⭐ (4 stars)</option>
          <option value="3">⭐⭐⭐ (3 stars)</option>
          <option value="2">⭐⭐ (2 stars)</option>
          <option value="1">⭐ (1 star)</option>
        </select>

        <label class="vine-review-label" for="vine-review-comments">Your Comments <span class="vine-review-hint">(optional)</span></label>
        <textarea id="vine-review-comments" class="vine-review-input vine-review-textarea" placeholder="e.g. Used it for 2 weeks, great battery, too heavy for daily use"></textarea>

        <button type="button" id="vine-generate-review-btn" class="vine-btn-primary vine-review-generate">Generate Review</button>

        <div id="vine-review-output" class="vine-review-output" style="display: none;" role="region" aria-label="Generated review">
          <label class="vine-review-label">Review Title</label>
          <div id="vine-review-title" class="vine-review-result"></div>
          <button type="button" id="vine-copy-title-btn" class="vine-btn-secondary vine-review-copy" aria-label="Copy review title to clipboard">📋 Copy Title</button>

          <label class="vine-review-label">Review Body</label>
          <div id="vine-review-body" class="vine-review-result vine-review-result-body"></div>
          <button type="button" id="vine-copy-body-btn" class="vine-btn-secondary vine-review-copy" aria-label="Copy review body to clipboard">📋 Copy Review Body</button>
        </div>

        <div id="vine-review-status" class="vine-status-banner" role="status" aria-live="polite"></div>
      </div>
    `;

    // Insert the container based on position
    if (insertPosition === 'prepend' && reviewArea.tagName === 'BODY') {
      // Prepend to body
      reviewArea.insertBefore(container, reviewArea.firstChild);
    } else if (reviewArea.parentNode) {
      // Insert before the target element
      reviewArea.parentNode.insertBefore(container, reviewArea);
    } else {
      // Fallback: append to body
      document.body.appendChild(container);
    }

    // Event listeners
    const closeBtn = document.getElementById('vine-close-generator');
    const generateBtn = document.getElementById('vine-generate-review-btn');
    const copyTitleBtn = document.getElementById('vine-copy-title-btn');
    const copyBodyBtn = document.getElementById('vine-copy-body-btn');
    const starsSelect = document.getElementById('vine-review-stars');
    const commentsTextarea = document.getElementById('vine-review-comments');
    const outputDiv = document.getElementById('vine-review-output');
    const titleDiv = document.getElementById('vine-review-title');
    const bodyDiv = document.getElementById('vine-review-body');
    const statusDiv = document.getElementById('vine-review-status');

    // Closing used to orphan the panel (display:none + the getElementById
    // early-return above blocked recreation). A reopen button restores it.
    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.id = 'vine-reopen-generator';
    reopenBtn.className = 'vine-btn-secondary vine-review-reopen';
    reopenBtn.textContent = '🤖 AI Review Generator';
    reopenBtn.setAttribute('aria-label', 'Reopen AI review generator');
    reopenBtn.style.display = 'none';
    container.parentNode.insertBefore(reopenBtn, container);
    reopenBtn.addEventListener('click', () => {
      container.style.display = '';
      reopenBtn.style.display = 'none';
    });
    closeBtn.addEventListener('click', () => {
      container.style.display = 'none';
      reopenBtn.style.display = '';
    });
    const showStatus = makeShowStatus(statusDiv, 5000);

    generateBtn.addEventListener('click', async () => {
      const stars = parseInt(starsSelect.value, 10);
      const comments = commentsTextarea.value.trim();

      generateBtn.disabled = true;
      generateBtn.textContent = 'Generating...';
      outputDiv.style.display = 'none';

      try {
        let description = '';

        if (window.location.href.includes('/review/create-review')) {
          // On review page, extract ASIN from URL and fetch product page
          const urlParams = new URLSearchParams(window.location.search);
          const asin = urlParams.get('asin');

          if (!asin) {
            showStatus('Could not find product ASIN in URL', true);
            return;
          }

          showStatus('Fetching product details...');

          // Fetch the product page
          const productUrl = `https://www.amazon.com/dp/${asin}`;

          try {
            const response = await gmFetch({ method: 'GET', url: productUrl });
            const doc = new DOMParser().parseFromString(response.responseText, 'text/html');
            const descElement = findFirstMatch(doc, CONFIG.PRODUCT_DESC_SELECTORS);
            if (!descElement) {
              showStatus('Could not extract product description from product page', true);
              return;
            }
            description = descElement.textContent.trim().substring(0, 1000);
          } catch (fetchError) {
            showStatus('Failed to fetch product details: ' + fetchError.message, true);
            return;
          }
        } else {
          // Live product-detail page — omit #productTitle so we prefer body copy when available.
          const descriptionElement = findFirstMatch(document, CONFIG.PRODUCT_DESC_SELECTORS.slice(0, 3));
          if (!descriptionElement) {
            showStatus('Could not find product description on this page', true);
            return;
          }
          description = descriptionElement.textContent.trim().substring(0, 1000);
        }

        const review = await generateReview(description, stars, comments, ({ attempt, maxAttempts, delayMs, reason }) => {
          showStatus(`${reason} — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts})…`);
        });
        const { title, body } = parseGeneratedReview(review);

        titleDiv.textContent = title;
        bodyDiv.textContent = body;
        outputDiv.style.display = 'block';

        if (window.location.href.includes('/review/create-review')) {
          try {
            const filled = autoFillReviewForm(title, body);
            console.log('[Vine Tools] Auto-fill result:', filled);
            if (filled.title && filled.body) {
              showStatus('Review inserted into the form');
            } else if (filled.title && !filled.body) {
              showStatus('Title filled — body field not found, please paste manually', true);
            } else if (!filled.title && filled.body) {
              showStatus('Body filled — title field not found, please paste manually', true);
            } else {
              showStatus('Review generated — could not find form fields, please paste manually', true);
            }
          } catch (e) {
            console.error('Vine Tools auto-fill error:', e);
            showStatus('Review generated — auto-fill threw, please paste manually', true);
          }
        } else {
          showStatus('Review generated successfully!');
        }
      } catch (error) {
        showStatus(error.message, true);
      } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Review';
      }
    });

    const wireCopy = (btn, sourceEl, label) => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(sourceEl.textContent).then(() => {
          const original = btn.textContent;
          btn.textContent = '✓ Copied!';
          btn.classList.add('vine-copied');
          setTimeout(() => {
            btn.textContent = original;
            btn.classList.remove('vine-copied');
          }, 1500);
        }).catch(err => {
          console.error(`Failed to copy ${label}:`, err);
          showStatus(`Failed to copy ${label}`, true);
        });
      });
    };
    wireCopy(copyTitleBtn, titleDiv, 'title');
    wireCopy(copyBodyBtn, bodyDiv, 'body');
  }

  // Cloud Sync (GitHub Gist)

  // Locate the gist holding fileName, or create it. The gist list is
  // paginated (30/page by default) — without walking pages, users with many
  // gists silently got a duplicate sync gist created on every new device.
  async function findOrCreateGist(gh, fileName, description, initialContent) {
    for (let page = 1; page <= 10; page++) {
      const gists = await gh(`gists?per_page=100&page=${page}`);
      if (!Array.isArray(gists) || gists.length === 0) break;
      const existing = gists.find(g => g.files && g.files[fileName]);
      if (existing) return existing.id;
      if (gists.length < 100) break; // last page
    }
    const newGist = await gh('gists', 'POST', {
      description,
      public: false,
      files: { [fileName]: { content: initialContent } }
    });
    return newGist.id;
  }

  async function syncWithGitHub(token) {
    if (!token) throw new Error('No GitHub Token provided');

    // Ensure any debounced writes land in memoryCache before we merge with remote.
    flushCacheUpdates();

    const gistFileName = 'vine_price_cache.json';
    let gistId = getStorage(CONFIG.GIST_ID_KEY, null);
    const gh = (endpoint, method, body) => githubRequest(token, endpoint, method, body);

    try {
      if (!gistId) {
        gistId = await findOrCreateGist(gh, gistFileName, 'Amazon Vine Price Cache (Synced)', JSON.stringify({}));
        setStorage(CONFIG.GIST_ID_KEY, gistId);
      }

      const gistData = await gh(`gists/${gistId}`);
      let remoteCache = {};
      const file = gistData.files && gistData.files[gistFileName];

      if (file) {
        if (file.truncated) {
          console.log('[Vine Sync] Remote file truncated, fetching raw content...');
          const raw = await gmFetch({ method: 'GET', url: file.raw_url });
          remoteCache = JSON.parse(raw.responseText);
        } else {
          remoteCache = file.content ? JSON.parse(file.content) : {};
        }
      }

      return new Promise((resolve) => {
        getCache((localCache) => {
          const now = Date.now();
          const safeLocalCache = (localCache && typeof localCache === 'object' && !Array.isArray(localCache))
            ? localCache
            : {};
          const mergedCache = (remoteCache && typeof remoteCache === 'object' && !Array.isArray(remoteCache))
            ? { ...remoteCache }
            : {};
          let remoteNeedsUpdate = false;

          for (const [asin, localEntry] of Object.entries(safeLocalCache)) {
            if (!localEntry || typeof localEntry !== 'object') continue;
            const localTimestamp = typeof localEntry.timestamp === 'number' ? localEntry.timestamp : 0;
            if (now - localTimestamp > cacheTTL(localEntry)) continue;
            const remoteEntry = mergedCache[asin];
            const remoteTimestamp = remoteEntry && typeof remoteEntry === 'object' && typeof remoteEntry.timestamp === 'number'
              ? remoteEntry.timestamp
              : 0;
            if (!remoteEntry || localTimestamp > remoteTimestamp) {
              mergedCache[asin] = localEntry;
              remoteNeedsUpdate = true;
            }
          }

          const finalizeSync = async () => {
            if (remoteNeedsUpdate) {
              const mergedJson = JSON.stringify(mergedCache);
              // Final byte-level guard: skip PATCH if merge equals what's already on Gist.
              if (file && !file.truncated && file.content === mergedJson) {
                console.log('[Vine Sync] Merge matches remote — skipping PATCH.');
              } else {
                console.log('[Vine Sync] Pushing updates to GitHub...');
                await gh(`gists/${gistId}`, 'PATCH', {
                  files: { [gistFileName]: { content: mergedJson } }
                });
              }
            } else {
              console.log('[Vine Sync] Remote is up to date.');
            }

            setCache(mergedCache, () => {
              setStorage(CONFIG.LAST_SYNC_KEY, Date.now());
              resolve({ success: true, count: Object.keys(mergedCache).length });
            });
          };

          finalizeSync().catch(err => {
            console.error('Sync finalize failed:', err);
            setCache(mergedCache);
            resolve({ success: false, error: err });
          });
        });
      });

    } catch (error) {
      console.error('Sync failed:', error);
      throw error;
    }
  }

  // Sync Saved Searches with GitHub Gist
  async function syncSearchesWithGitHub(token) {
    if (!token) throw new Error('No GitHub Token provided');

    const gistFileName = 'vine_saved_searches.json';
    let gistId = getStorage(CONFIG.GIST_SEARCHES_ID_KEY, null);
    const gh = (endpoint, method, body) => githubRequest(token, endpoint, method, body);

    try {
      if (!gistId) {
        gistId = await findOrCreateGist(
          gh, gistFileName, 'Amazon Vine Saved Searches (Synced)',
          JSON.stringify({ timestamp: Date.now(), searches: [] })
        );
        setStorage(CONFIG.GIST_SEARCHES_ID_KEY, gistId);
      }

      // Drop malformed/legacy entries (missing string `term`) so merge
      // comparisons below can't throw on `.term.toLowerCase()`.
      const normalizeSearches = (arr) => (Array.isArray(arr) ? arr : [])
        .filter(s => s && typeof s === 'object' && typeof s.term === 'string');

      const gistData = await gh(`gists/${gistId}`);
      let remoteData = { timestamp: 0, searches: [] };
      if (gistData.files && gistData.files[gistFileName]) {
        try {
          const parsedContent = JSON.parse(gistData.files[gistFileName].content);
          // Handle old format (array) vs new format (object with timestamp)
          if (Array.isArray(parsedContent)) {
            remoteData = { timestamp: 0, searches: parsedContent };
          } else if (parsedContent && typeof parsedContent === 'object') {
            remoteData = {
              timestamp: typeof parsedContent.timestamp === 'number' ? parsedContent.timestamp : 0,
              searches: parsedContent.searches
            };
          }
        } catch (e) {
          console.error('Error parsing remote searches:', e);
          remoteData = { timestamp: 0, searches: [] };
        }
      }
      remoteData.searches = normalizeSearches(remoteData.searches);

      // 3. Get local searches and timestamp
      const localSearches = normalizeSearches(getStorage(CONFIG.SAVED_SEARCHES_KEY, []));
      const localTimestamp = getStorage(CONFIG.SAVED_SEARCHES_TIMESTAMP_KEY, 0);

      // 4. Determine which version is newer and merge
      let finalSearches = [];
      let shouldUpdateLocal = false;
      let shouldUpdateRemote = false;

      if (localTimestamp > remoteData.timestamp) {
        // Local is newer - use local and push to remote
        console.log('[Vine Searches Sync] Local is newer, pushing to remote');
        finalSearches = [...localSearches];
        shouldUpdateRemote = true;
      } else if (remoteData.timestamp > localTimestamp) {
        // Remote is newer - use remote and pull to local
        console.log('[Vine Searches Sync] Remote is newer, pulling to local');
        finalSearches = [...remoteData.searches];
        shouldUpdateLocal = true;
      } else {
        // Same timestamp - merge by adding new items from each side
        console.log('[Vine Searches Sync] Same timestamp, smart merging');
        const localTerms = new Set(localSearches.map(s => s.term.toLowerCase()));
        const remoteTerms = new Set(remoteData.searches.map(s => s.term.toLowerCase()));

        // Start with local searches (preserving order)
        finalSearches = [...localSearches];

        // Add any remote searches that aren't in local
        remoteData.searches.forEach(search => {
          const key = search.term.toLowerCase();
          if (!localTerms.has(key)) {
            finalSearches.push(search);
            shouldUpdateLocal = true;
          }
        });

        // Check if local has items not in remote
        localSearches.forEach(search => {
          const key = search.term.toLowerCase();
          if (!remoteTerms.has(key)) {
            shouldUpdateRemote = true;
          }
        });
      }

      // 5. Persist — both sides must end on the SAME timestamp, or the next
      // sync sees a fake "newer" side and re-pulls/pushes forever.
      const mergedTimestamp = Math.max(localTimestamp, remoteData.timestamp) || Date.now();

      if (shouldUpdateLocal) {
        setStorage(CONFIG.SAVED_SEARCHES_KEY, finalSearches);
        setStorage(CONFIG.SAVED_SEARCHES_TIMESTAMP_KEY, mergedTimestamp);
      }

      if (shouldUpdateRemote) {
        const updateData = {
          timestamp: mergedTimestamp,
          searches: finalSearches
        };
        await gh(`gists/${gistId}`, 'PATCH', {
          files: { [gistFileName]: { content: JSON.stringify(updateData) } }
        });
        setStorage(CONFIG.SAVED_SEARCHES_TIMESTAMP_KEY, mergedTimestamp);
      }

      return { success: true, count: finalSearches.length };

    } catch (error) {
      console.error('Searches sync failed:', error);
      throw error;
    }
  }

  // Sync Keyword Lists with GitHub Gist (last-write-wins by timestamp;
  // equal timestamps union-merge both sides).
  async function syncKeywordsWithGitHub(token) {
    if (!token) throw new Error('No GitHub Token provided');

    const gistFileName = 'vine_keyword_lists.json';
    let gistId = getStorage(CONFIG.GIST_KEYWORDS_ID_KEY, null);
    const gh = (endpoint, method, body) => githubRequest(token, endpoint, method, body);

    try {
      if (!gistId) {
        gistId = await findOrCreateGist(
          gh, gistFileName, 'Amazon Vine Keyword Lists (Synced)',
          JSON.stringify({ timestamp: 0, highlight: [], block: [] })
        );
        setStorage(CONFIG.GIST_KEYWORDS_ID_KEY, gistId);
      }

      const gistData = await gh(`gists/${gistId}`);
      let remoteData = { timestamp: 0, highlight: [], block: [] };
      if (gistData.files && gistData.files[gistFileName]) {
        try {
          const parsed = JSON.parse(gistData.files[gistFileName].content);
          remoteData = {
            timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
            highlight: Array.isArray(parsed.highlight) ? parsed.highlight : [],
            block: Array.isArray(parsed.block) ? parsed.block : []
          };
        } catch (e) {
          console.error('Error parsing remote keyword lists:', e);
        }
      }

      const localLists = getKeywordListsSync();
      const localTimestamp = getStorage(CONFIG.KEYWORD_LISTS_TIMESTAMP_KEY, 0);

      const applyLocal = (lists, timestamp) => {
        cachedKeywordLists = lists;
        keywordListsRevision++;
        setStorage(CONFIG.KEYWORD_LISTS_KEY, lists);
        setStorage(CONFIG.KEYWORD_LISTS_TIMESTAMP_KEY, timestamp);
        applyColorFilterToAllItems();
      };

      let finalLists;
      if (localTimestamp > remoteData.timestamp) {
        finalLists = localLists;
        await gh(`gists/${gistId}`, 'PATCH', {
          files: { [gistFileName]: { content: JSON.stringify({ timestamp: localTimestamp, ...localLists }) } }
        });
      } else if (remoteData.timestamp > localTimestamp) {
        finalLists = { highlight: remoteData.highlight, block: remoteData.block };
        applyLocal(finalLists, remoteData.timestamp);
      } else {
        const union = (a, b) => Array.from(new Set([...a, ...b]));
        finalLists = {
          highlight: union(localLists.highlight, remoteData.highlight),
          block: union(localLists.block, remoteData.block)
        };
        const changedLocal = finalLists.highlight.length !== localLists.highlight.length
          || finalLists.block.length !== localLists.block.length;
        const changedRemote = finalLists.highlight.length !== remoteData.highlight.length
          || finalLists.block.length !== remoteData.block.length;
        // Both sides must land on the same timestamp after a merge, or the
        // next sync misreads one side as newer and re-syncs forever.
        const mergedTimestamp = Math.max(localTimestamp, remoteData.timestamp) || Date.now();
        if (changedLocal) applyLocal(finalLists, mergedTimestamp);
        if (changedRemote) {
          await gh(`gists/${gistId}`, 'PATCH', {
            files: { [gistFileName]: { content: JSON.stringify({ timestamp: mergedTimestamp, ...finalLists }) } }
          });
          setStorage(CONFIG.KEYWORD_LISTS_TIMESTAMP_KEY, mergedTimestamp);
        }
      }

      return { success: true, count: finalLists.highlight.length + finalLists.block.length };

    } catch (error) {
      console.error('Keywords sync failed:', error);
      throw error;
    }
  }


  // Stats dashboard — recomputed on every tab open in one pass over the cache
  // (which can hold tens of thousands of entries: counters only, no sorting).
  function renderStatsTab(container) {
    if (!container) return;
    flushCacheUpdates(); // include debounced writes
    getCache((cache) => {
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const startOfToday = new Date().setHours(0, 0, 0, 0);

      let total = 0;
      const ageBuckets = { '< 1 day': 0, '1–3 days': 0, '3–7 days': 0 };
      let seenToday = 0;
      let seenThisWeek = 0;
      const priceBuckets = [
        { label: '$0–10', min: 0, max: 10, count: 0 },
        { label: '$10–25', min: 10, max: 25, count: 0 },
        { label: '$25–50', min: 25, max: 50, count: 0 },
        { label: '$50–100', min: 50, max: 100, count: 0 },
        { label: '$100–200', min: 100, max: 200, count: 0 },
        { label: '$200+', min: 200, max: Infinity, count: 0 }
      ];

      for (const asin in cache) {
        const entry = cache[asin];
        if (!entry || typeof entry.timestamp !== 'number') continue;
        const age = now - entry.timestamp;
        if (age > cacheTTL(entry)) continue;
        total++;
        if (age < DAY) ageBuckets['< 1 day']++;
        else if (age < 3 * DAY) ageBuckets['1–3 days']++;
        else ageBuckets['3–7 days']++;
        if (entry.isSeen !== false) {
          if (entry.timestamp >= startOfToday) seenToday++;
          if (age <= 7 * DAY) seenThisWeek++;
        }
        const price = typeof entry.price === 'number' ? entry.price : parseFloat(entry.price);
        if (!isNaN(price)) {
          const bucket = priceBuckets.find(b => price >= b.min && price < b.max);
          if (bucket) bucket.count++;
        }
      }

      const pageItems = document.querySelectorAll('[data-vine-price-processed="true"]');
      let pageHidden = 0;
      pageItems.forEach(item => { if (item.dataset.vineHidden === 'true') pageHidden++; });

      container.replaceChildren();

      const addHeading = (text) => {
        const h = document.createElement('div');
        h.style.cssText = 'font-weight: 600; color: var(--vine-fg); margin: 16px 0 8px;';
        h.textContent = text;
        container.appendChild(h);
      };
      const addLine = (label, value) => {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: var(--vine-fg-muted);';
        const l = document.createElement('span');
        l.textContent = label;
        const v = document.createElement('span');
        v.style.cssText = 'font-weight: 600; color: var(--vine-fg);';
        v.textContent = value;
        row.appendChild(l);
        row.appendChild(v);
        container.appendChild(row);
      };

      addHeading('📦 Price Cache');
      addLine('Cached items', String(total));
      Object.entries(ageBuckets).forEach(([label, count]) => addLine(`Age ${label}`, String(count)));
      addLine('Seen today', String(seenToday));
      addLine('Seen this week', String(seenThisWeek));

      addHeading('💰 Price Distribution');
      const maxCount = Math.max(1, ...priceBuckets.map(b => b.count));
      priceBuckets.forEach(({ label, min, count }) => {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 12px;';
        const l = document.createElement('span');
        l.style.cssText = 'width: 70px; color: var(--vine-fg-muted); flex-shrink: 0;';
        l.textContent = label;
        const barWrap = document.createElement('div');
        barWrap.style.cssText = 'flex: 1; background: var(--vine-surface); border-radius: 3px; height: 14px;';
        const bar = document.createElement('div');
        const color = getPriceColorSync(min + 0.01);
        const barColor = color === 'green' ? '#046044' : color === 'yellow' ? '#FFD814' : '#B12704';
        bar.style.cssText = `width: ${Math.round(count / maxCount * 100)}%; background: ${barColor}; height: 100%; border-radius: 3px; min-width: ${count > 0 ? 2 : 0}px;`;
        barWrap.appendChild(bar);
        const c = document.createElement('span');
        c.style.cssText = 'width: 50px; text-align: right; color: var(--vine-fg); font-weight: 600;';
        c.textContent = String(count);
        row.appendChild(l);
        row.appendChild(barWrap);
        row.appendChild(c);
        container.appendChild(row);
      });

      addHeading('📄 Current Page');
      if (pageItems.length === 0) {
        addLine('Items', 'n/a (not on an items page)');
      } else {
        addLine('Items processed', String(pageItems.length));
        addLine('Visible', String(pageItems.length - pageHidden));
        addLine('Hidden by filters', String(pageHidden));
      }
    });
  }

  // Settings UI
  function createSettingsUI() {
    function findHeaderContainer() {
      // Try multiple selectors for desktop and mobile
      const selectors = [
        '.vvp-header-links-container',  // Desktop
        '#vvp-header-links',             // Mobile variant
        '.vvp-header',                   // Mobile header
        'nav[role="navigation"]',       // Generic mobile nav
        '#nav-main',                     // Amazon mobile nav
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
          return element;
        }
      }

      return null;
    }

    function addSettingsLink() {
      const headerContainer = findHeaderContainer();
      if (!headerContainer) {
        return false;
      }

      // Check if already added
      if (document.getElementById('vvp-price-settings-link')) {
        return true;
      }

      const settingsLi = document.createElement('li');
      settingsLi.id = 'vvp-price-settings-link';
      settingsLi.className = 'vvp-header-link';

      const settingsLink = document.createElement('a');
      settingsLink.href = 'javascript:void(0)';
      settingsLink.role = 'button';
      settingsLink.className = 'a-popover-trigger a-declarative';
      settingsLink.textContent = 'Vine Tools';
      settingsLink.style.cursor = 'pointer';

      settingsLink.addEventListener('click', (e) => {
        e.preventDefault();
        openSettingsModal();
      });

      settingsLi.appendChild(settingsLink);
      headerContainer.appendChild(settingsLi);
      document.body.classList.add('vine-has-header-link');
      return true;
    }

    // Floating Action Button (FAB) fallback for mobile
    function createFloatingButton() {
      // Check if already exists
      if (document.getElementById('vine-fab-button')) {
        return;
      }

      const fab = document.createElement('button');
      fab.id = 'vine-fab-button';
      fab.className = 'vine-fab';
      fab.setAttribute('aria-label', 'Open Vine Tools');
      fab.innerHTML = '⚙️';
      fab.title = 'Vine Tools';

      fab.addEventListener('click', (e) => {
        e.preventDefault();
        openSettingsModal();
      });

      document.body.appendChild(fab);
    }

    openSettingsModal = function () {
      if (settingsModal) {
        closeSettingsModal();
        return;
      }

      settingsModalPrevFocus = document.activeElement;
      document.body.style.overflow = 'hidden';

      settingsModal = document.createElement('div');
      settingsModal.id = 'vine-settings-modal';
      settingsModal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 10001;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 10px;
        overflow-y: auto;
      `;

      const dialog = document.createElement('div');
      dialog.className = 'vine-settings-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'vine-modal-title');
      dialog.style.cssText = `
        background: #fff;
        border: 1px solid #D5D9D9;
        border-radius: 8px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
        max-width: 600px;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
        position: relative;
        margin: auto;
        padding: 20px;
      `;

      let thresholds = getStorage(CONFIG.THRESHOLDS_KEY, CONFIG.DEFAULT_THRESHOLDS);

      // Migrate old format to new format
      if (thresholds.HIGH !== undefined && thresholds.MEDIUM !== undefined) {
        thresholds = {
          GREEN_MIN: thresholds.HIGH,
          YELLOW_MIN: thresholds.MEDIUM,
          RED_MAX: thresholds.MEDIUM - 0.01
        };
        setStorage(CONFIG.THRESHOLDS_KEY, thresholds);
      }

      // Ensure all required fields exist
      if (thresholds.GREEN_MIN == null) thresholds.GREEN_MIN = CONFIG.DEFAULT_THRESHOLDS.GREEN_MIN;
      if (thresholds.YELLOW_MIN == null) thresholds.YELLOW_MIN = CONFIG.DEFAULT_THRESHOLDS.YELLOW_MIN;
      if (thresholds.RED_MAX == null) thresholds.RED_MAX = CONFIG.DEFAULT_THRESHOLDS.RED_MAX;

      // Keep the badge-coloring hot path in step with what the modal shows —
      // otherwise migrated/backfilled values only take effect after a Save.
      cachedThresholds = thresholds;

      const autoAdvanceEnabled = getStorage(CONFIG.AUTO_ADVANCE_KEY, false);
      const savedSearches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
      const githubToken = getStorage(CONFIG.GITHUB_TOKEN_KEY, '');
      const lastSyncTime = getStorage(CONFIG.LAST_SYNC_KEY, 0);
      const aiProvider = getStorage(CONFIG.AI_PROVIDER, 'openai');
      const externalLinks = getStorage(CONFIG.EXTERNAL_LINKS_KEY, true);
      const infiniteScrollEnabled = getStorage(CONFIG.INFINITE_SCROLL_KEY, false);

      dialog.innerHTML = `
        <div class="vine-modal-header">
          <h2 id="vine-modal-title" class="vine-modal-title">Vine Tools <span class="vine-modal-version">v${GM_info.script.version}</span></h2>
          <button type="button" id="vine-modal-close" class="vine-modal-close-btn" aria-label="Close settings">✕</button>
        </div>

        <div class="vine-tabs" role="tablist">
          <button type="button" id="tab-searches" class="vine-tab" role="tab">Saved Searches</button>
          <button type="button" id="tab-keywords" class="vine-tab" role="tab">Keywords</button>
          <button type="button" id="tab-stats" class="vine-tab" role="tab">Stats</button>
          <button type="button" id="tab-sync" class="vine-tab" role="tab">Cloud Sync</button>
          <button type="button" id="tab-price" class="vine-tab" role="tab">Price Settings</button>
          <button type="button" id="tab-shortcuts" class="vine-tab" role="tab">Shortcuts</button>
        </div>

        <div id="content-price" class="vine-tab-content" style="display: none;">
          <div style="margin-bottom: 24px;">
          <label style="display: block; margin-bottom: 8px; font-weight: 600; color: var(--vine-fg);">Price Ranges</label>
          <div style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">🟢 Green (minimum): $</label>
            <input type="number" id="vine-green-min" value="${thresholds.GREEN_MIN}" step="0.01"
              style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
            <div style="font-size: 11px; color: var(--vine-fg-muted); margin-top: 2px;">Items $${thresholds.GREEN_MIN} and above</div>
          </div>
          <div style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">🟡 Yellow (minimum): $</label>
            <input type="number" id="vine-yellow-min" value="${thresholds.YELLOW_MIN}" step="0.01"
              style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
            <div style="font-size: 11px; color: var(--vine-fg-muted); margin-top: 2px;">Items $${thresholds.YELLOW_MIN} to $${(thresholds.GREEN_MIN - 0.01).toFixed(2)}</div>
          </div>
          <div style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">🔴 Red (maximum): $</label>
            <input type="number" id="vine-red-max" value="${thresholds.RED_MAX}" step="0.01"
              style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
            <div style="font-size: 11px; color: var(--vine-fg-muted); margin-top: 2px;">Items below $${(thresholds.YELLOW_MIN).toFixed(2)}</div>
          </div>
          <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 8px; padding: 8px; background: var(--vine-surface); border-radius: 4px;">
            <div><strong>Current ranges:</strong></div>
            <div>🟢 Green: $${thresholds.GREEN_MIN}+</div>
            <div>🟡 Yellow: $${thresholds.YELLOW_MIN} - $${(thresholds.GREEN_MIN - 0.01).toFixed(2)}</div>
            <div>🔴 Red: Below $${thresholds.YELLOW_MIN}</div>
          </div>
        </div>



        <div style="margin-bottom: 24px;">
          <label style="display: flex; align-items: center; cursor: pointer;">
            <input type="checkbox" id="vine-auto-advance" ${autoAdvanceEnabled ? 'checked' : ''} 
              style="margin-right: 8px; width: 18px; height: 18px;">
            <span style="font-weight: 600; color: var(--vine-fg);">Auto-advance when all items hidden</span>
          </label>
          <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 4px; margin-left: 26px;">
            Automatically go to the next page when all items on the current page are hidden
          </div>
        </div>

        <div style="margin-bottom: 24px;">
          <label style="display: flex; align-items: center; cursor: pointer;">
            <input type="checkbox" id="vine-infinite-scroll" ${infiniteScrollEnabled ? 'checked' : ''}
              style="margin-right: 8px; width: 18px; height: 18px;">
            <span style="font-weight: 600; color: var(--vine-fg);">Infinite scroll</span>
          </label>
          <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 4px; margin-left: 26px;">
            Load the next page inline when you near the bottom (replaces auto-advance)
          </div>
        </div>

        <div style="margin-bottom: 24px;">
          <label style="display: flex; align-items: center; cursor: pointer;">
            <input type="checkbox" id="vine-external-links" ${externalLinks ? 'checked' : ''}
              style="margin-right: 8px; width: 18px; height: 18px;">
            <span style="font-weight: 600; color: var(--vine-fg);">Show price-check links on badges</span>
          </label>
          <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 4px; margin-left: 26px;">
            K = Keepa, C = CamelCamelCamel, G = Google search (applies to newly loaded items)
          </div>
        </div>

        <div style="margin-bottom: 24px; padding-top: 24px; border-top: 1px solid var(--vine-border);">
          <label style="display: block; margin-bottom: 8px; font-weight: 600; color: var(--vine-fg);">AI Review Generator</label>
          <div style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">AI Provider:</label>
            <select id="vine-ai-provider" style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px; background: var(--vine-bg); color: var(--vine-fg);">
              <option value="openai" ${aiProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
              <option value="deepseek" ${aiProvider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
              <option value="claude" ${aiProvider === 'claude' ? 'selected' : ''}>Claude (Anthropic)</option>
            </select>
          </div>
          <div id="vine-openai-section" style="margin-bottom: 12px; ${aiProvider !== 'openai' ? 'display: none;' : ''}">
            <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">OpenAI API Key:</label>
            <input type="password" id="vine-openai-key"
              placeholder="sk-..."
              style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
            <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 4px;">
              Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" style="color: var(--vine-link);">platform.openai.com</a>
            </div>
          </div>
          <div id="vine-claude-section" style="margin-bottom: 12px; ${aiProvider !== 'claude' ? 'display: none;' : ''}">
            <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">Anthropic API Key:</label>
            <input type="password" id="vine-claude-key"
              placeholder="sk-ant-..."
              style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px; margin-bottom: 8px;">
            <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">Claude Model:</label>
            <input type="text" id="vine-claude-model"
              placeholder="claude-opus-4-8"
              style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
            <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 4px;">
              Get your key at <a href="https://platform.claude.com/" target="_blank" style="color: var(--vine-link);">platform.claude.com</a>
            </div>
          </div>
          <div id="vine-deepseek-section" style="margin-bottom: 12px; ${aiProvider !== 'deepseek' ? 'display: none;' : ''}">
            <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">DeepSeek API Key:</label>
            <input type="password" id="vine-deepseek-key"
              placeholder="sk-..."
              style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px; margin-bottom: 8px;">
            <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">DeepSeek Model:</label>
            <input type="text" id="vine-deepseek-model"
              placeholder="deepseek-v4-flash"
              style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
            <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 4px;">
              Get your key at <a href="https://platform.deepseek.com/api-keys" target="_blank" style="color: var(--vine-link);">platform.deepseek.com</a>
            </div>
          </div>
        </div>

        <div style="margin-bottom: 24px;">
          <button type="button" id="vine-save-btn" class="vine-btn-primary" style="width: 100%;">Save Settings</button>
          <div style="display: flex; justify-content: flex-end; margin-top: 12px;">
            <button type="button" id="vine-clear-cache-btn" class="vine-btn-link-danger">Clear cached prices</button>
          </div>
        </div>
        </div>

        <div id="content-searches" class="vine-tab-content">
          <div style="margin-bottom: 20px;">
            <label style="display: block; margin-bottom: 8px; font-weight: 600; color: var(--vine-fg);">Add New Search</label>
            <div style="display: flex; gap: 8px;">
              <input type="text" id="new-search-term" placeholder="Enter search term (e.g. 'laptop', 'headphones')"
                style="flex: 1; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
              <button type="button" id="add-search-btn" class="vine-btn-primary" style="white-space: nowrap;">Add Search</button>
            </div>
            <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 4px;">
              Saved searches will appear as quick links below
            </div>
          </div>

          <div style="margin-bottom: 16px;">
            <label style="display: block; margin-bottom: 12px; font-weight: 600; color: var(--vine-fg);">Your Saved Searches</label>
            <div id="saved-searches-list" style="display: flex; flex-direction: column; gap: 8px;">
              ${savedSearches.length === 0 ? '<div style="padding: 20px; text-align: center; color: var(--vine-fg-muted); background: var(--vine-surface); border-radius: 6px;">No saved searches yet. Add one above!</div>' : ''}
            </div>
          </div>
        </div>

        <div id="content-keywords" class="vine-tab-content" style="display: none;">
          <div style="margin-bottom: 24px;">
            <label style="display: block; margin-bottom: 4px; font-weight: 600; color: var(--vine-fg);">✨ Highlight Keywords</label>
            <div style="font-size: 12px; color: var(--vine-fg-muted); margin-bottom: 8px;">Items whose title contains one of these get an orange glow.</div>
            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
              <input type="text" id="vine-kw-highlight-input" placeholder="e.g. 'ssd', 'torque wrench'"
                style="flex: 1; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
              <button type="button" id="vine-kw-highlight-add" class="vine-btn-primary" style="white-space: nowrap;">Add</button>
            </div>
            <div id="vine-kw-highlight-list" class="vine-kw-chips"></div>
          </div>
          <div style="margin-bottom: 16px;">
            <label style="display: block; margin-bottom: 4px; font-weight: 600; color: var(--vine-fg);">🚫 Block Keywords</label>
            <div style="font-size: 12px; color: var(--vine-fg-muted); margin-bottom: 8px;">Items whose title contains one of these are hidden from the grid.</div>
            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
              <input type="text" id="vine-kw-block-input" placeholder="e.g. 'ring sizer', 'phone case'"
                style="flex: 1; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
              <button type="button" id="vine-kw-block-add" class="vine-btn-primary" style="white-space: nowrap;">Add</button>
            </div>
            <div id="vine-kw-block-list" class="vine-kw-chips"></div>
          </div>
        </div>

        <div id="content-stats" class="vine-tab-content" style="display: none;">
          <div id="vine-stats-body"></div>
        </div>

        <div id="content-sync" class="vine-tab-content" style="display: none;">
          <div style="margin-bottom: 24px;">
            <label style="display: block; margin-bottom: 8px; font-weight: 600; color: var(--vine-fg);">Cloud Sync (GitHub Gist)</label>
            <div style="background: var(--vine-surface); border: 1px solid var(--vine-border); color: var(--vine-fg); padding: 12px; border-radius: 6px; font-size: 13px; margin-bottom: 16px;">
              Sync your price cache across multiple devices using a private GitHub Gist.
            </div>
            
            <div style="margin-bottom: 16px;">
              <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">GitHub Personal Access Token:</label>
              <input type="password" id="vine-github-token"
                placeholder="ghp_..."
                style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
              <div style="font-size: 11px; color: var(--vine-fg-muted); margin-top: 4px;">
                Token requires <strong>gist</strong> permission. <a href="https://github.com/settings/tokens/new?scopes=gist&description=Vine%20Price%20Scaler" target="_blank" style="color: var(--vine-link);">Generate Token</a>
              </div>
            </div>

            <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 16px;">
              <button type="button" id="vine-sync-btn" class="vine-btn-primary" style="flex: 1;">🔄 Sync Now</button>
            </div>

            <div id="vine-sync-status" role="status" aria-live="polite" style="font-size: 12px; color: var(--vine-fg-muted); text-align: center;">
              ${lastSyncTime ? `Last synced: ${new Date(lastSyncTime).toLocaleString()}` : 'Never synced'}
            </div>
          </div>
        </div>

        <div id="content-shortcuts" class="vine-tab-content" style="display: none;">
          <div style="margin-bottom: 16px;">
            <label style="display: block; margin-bottom: 12px; font-weight: 600; color: var(--vine-fg); font-size: 16px;">⌨️ Keyboard Shortcuts</label>
            <div style="background: var(--vine-surface); border: 1px solid var(--vine-border); color: var(--vine-fg); padding: 12px; border-radius: 6px; font-size: 13px; margin-bottom: 16px;">
              Use these keyboard shortcuts to navigate faster and boost your productivity!
            </div>
            <table style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr style="background: var(--vine-surface);">
                  <th style="padding: 12px; text-align: left; border-bottom: 1px solid var(--vine-border); font-weight: 600; color: var(--vine-fg);">Shortcut</th>
                  <th style="padding: 12px; text-align: left; border-bottom: 1px solid var(--vine-border); font-weight: 600; color: var(--vine-fg);">Action</th>
                </tr>
              </thead>
              <tbody>
                <tr style="border-bottom: 1px solid var(--vine-border);">
                  <td style="padding: 12px;">
                    <code style="background: var(--vine-surface); padding: 6px 10px; border-radius: 4px; font-family: monospace; font-size: 13px;">V V (double-tap)</code>
                  </td>
                  <td style="padding: 12px; color: var(--vine-fg-muted);">Open/Close Vine Tools</td>
                </tr>
                <tr style="border-bottom: 1px solid var(--vine-border);">
                  <td style="padding: 12px;">
                    <code style="background: var(--vine-surface); padding: 6px 10px; border-radius: 4px; font-family: monospace; font-size: 13px;">Escape</code>
                  </td>
                  <td style="padding: 12px; color: var(--vine-fg-muted);">Close any open modal</td>
                </tr>
                <tr style="border-bottom: 1px solid var(--vine-border);">
                  <td style="padding: 12px;">
                    <code style="background: var(--vine-surface); padding: 6px 10px; border-radius: 4px; font-family: monospace; font-size: 13px;">1</code>
                  </td>
                  <td style="padding: 12px; color: var(--vine-fg-muted);">Toggle Hide Cached</td>
                </tr>
                <tr style="border-bottom: 1px solid var(--vine-border);">
                  <td style="padding: 12px;">
                    <code style="background: var(--vine-surface); padding: 6px 10px; border-radius: 4px; font-family: monospace; font-size: 13px;">4</code>
                  </td>
                  <td style="padding: 12px; color: var(--vine-fg-muted);">Toggle Green filter</td>
                </tr>
                <tr style="border-bottom: 1px solid var(--vine-border);">
                  <td style="padding: 12px;">
                    <code style="background: var(--vine-surface); padding: 6px 10px; border-radius: 4px; font-family: monospace; font-size: 13px;">5</code>
                  </td>
                  <td style="padding: 12px; color: var(--vine-fg-muted);">Toggle Yellow filter</td>
                </tr>
                <tr style="border-bottom: 1px solid var(--vine-border);">
                  <td style="padding: 12px;">
                    <code style="background: var(--vine-surface); padding: 6px 10px; border-radius: 4px; font-family: monospace; font-size: 13px;">6</code>
                  </td>
                  <td style="padding: 12px; color: var(--vine-fg-muted);">Toggle Red filter</td>
                </tr>
                <tr style="border-bottom: 1px solid var(--vine-border);">
                  <td style="padding: 12px;">
                    <code style="background: var(--vine-surface); padding: 6px 10px; border-radius: 4px; font-family: monospace; font-size: 13px;">←</code>
                  </td>
                  <td style="padding: 12px; color: var(--vine-fg-muted);">Go to previous page</td>
                </tr>
                <tr>
                  <td style="padding: 12px;">
                    <code style="background: var(--vine-surface); padding: 6px 10px; border-radius: 4px; font-family: monospace; font-size: 13px;">→</code>
                  </td>
                  <td style="padding: 12px; color: var(--vine-fg-muted);">Go to next page</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div id="vine-status" class="vine-status-banner" role="status" aria-live="polite"></div>
      `;



      const saveBtn = dialog.querySelector('#vine-save-btn');
      const clearCacheBtn = dialog.querySelector('#vine-clear-cache-btn');
      const closeBtn = dialog.querySelector('#vine-modal-close');
      const statusDiv = dialog.querySelector('#vine-status');
      const greenMinInput = dialog.querySelector('#vine-green-min');
      const yellowMinInput = dialog.querySelector('#vine-yellow-min');
      const redMaxInput = dialog.querySelector('#vine-red-max');

      const autoAdvanceCheckbox = dialog.querySelector('#vine-auto-advance');
      const infiniteScrollCheckbox = dialog.querySelector('#vine-infinite-scroll');
      const externalLinksCheckbox = dialog.querySelector('#vine-external-links');
      const openaiKeyInput = dialog.querySelector('#vine-openai-key');

      // Auto-advance and infinite scroll are mutually exclusive
      infiniteScrollCheckbox.addEventListener('change', () => {
        if (infiniteScrollCheckbox.checked) autoAdvanceCheckbox.checked = false;
      });
      autoAdvanceCheckbox.addEventListener('change', () => {
        if (autoAdvanceCheckbox.checked) infiniteScrollCheckbox.checked = false;
      });
      const githubTokenInput = dialog.querySelector('#vine-github-token');
      const aiProviderSelect = dialog.querySelector('#vine-ai-provider');
      const deepseekKeyInput = dialog.querySelector('#vine-deepseek-key');
      const deepseekModelInput = dialog.querySelector('#vine-deepseek-model');
      const claudeKeyInput = dialog.querySelector('#vine-claude-key');
      const claudeModelInput = dialog.querySelector('#vine-claude-model');
      const openaiSection = dialog.querySelector('#vine-openai-section');
      const deepseekSection = dialog.querySelector('#vine-deepseek-section');
      const claudeSection = dialog.querySelector('#vine-claude-section');

      // Secrets are set as DOM properties, never interpolated into innerHTML —
      // a synced value containing a quote must not be able to break out of an attribute.
      openaiKeyInput.value = getStorage(CONFIG.OPENAI_API_KEY, '');
      claudeKeyInput.value = getStorage(CONFIG.CLAUDE_API_KEY, '');
      claudeModelInput.value = getStorage(CONFIG.CLAUDE_MODEL, '') || CONFIG.PROVIDERS.claude.defaultModel;
      deepseekKeyInput.value = getStorage(CONFIG.DEEPSEEK_API_KEY, '');
      deepseekModelInput.value = getStorage(CONFIG.DEEPSEEK_MODEL, '') || CONFIG.PROVIDERS.deepseek.defaultModel;
      githubTokenInput.value = githubToken;

      const showStatus = makeShowStatus(statusDiv, 3000);
      closeBtn.addEventListener('click', closeSettingsModal);

      aiProviderSelect.addEventListener('change', () => {
        openaiSection.style.display = aiProviderSelect.value === 'openai' ? '' : 'none';
        deepseekSection.style.display = aiProviderSelect.value === 'deepseek' ? '' : 'none';
        claudeSection.style.display = aiProviderSelect.value === 'claude' ? '' : 'none';
      });

      saveBtn.addEventListener('click', () => {
        const greenMin = parseFloat(greenMinInput.value);
        const yellowMin = parseFloat(yellowMinInput.value);
        const redMax = parseFloat(redMaxInput.value);

        if (isNaN(greenMin) || isNaN(yellowMin) || isNaN(redMax) || greenMin < 0 || yellowMin < 0 || redMax < 0) {
          showStatus('Please enter valid positive numbers', true);
          return;
        }

        if (yellowMin >= greenMin) {
          showStatus('Yellow minimum must be less than green minimum', true);
          return;
        }

        if (redMax >= yellowMin) {
          showStatus('Red maximum should be less than yellow minimum', true);
          return;
        }

        const newThresholds = {
          GREEN_MIN: greenMin,
          YELLOW_MIN: yellowMin,
          RED_MAX: redMax
        };

        setStorage(CONFIG.THRESHOLDS_KEY, newThresholds);
        setStorage(CONFIG.AUTO_ADVANCE_KEY, autoAdvanceCheckbox.checked);
        setStorage(CONFIG.EXTERNAL_LINKS_KEY, externalLinksCheckbox.checked);
        externalLinksEnabled = externalLinksCheckbox.checked;
        externalLinksLoaded = true;

        const wasInfinite = getInfiniteScroll();
        infiniteScroll = infiniteScrollCheckbox.checked;
        infiniteScrollLoaded = true;
        setStorage(CONFIG.INFINITE_SCROLL_KEY, infiniteScroll);
        if (infiniteScroll && !wasInfinite) setupInfiniteScroll();
        if (!infiniteScroll && wasInfinite) teardownInfiniteScroll();
        setStorage(CONFIG.OPENAI_API_KEY, openaiKeyInput.value.trim());
        setStorage(CONFIG.GITHUB_TOKEN_KEY, githubTokenInput.value.trim());
        setStorage(CONFIG.AI_PROVIDER, aiProviderSelect.value);
        setStorage(CONFIG.DEEPSEEK_API_KEY, deepseekKeyInput.value.trim());
        setStorage(CONFIG.DEEPSEEK_MODEL, deepseekModelInput.value.trim());
        setStorage(CONFIG.CLAUDE_API_KEY, claudeKeyInput.value.trim());
        setStorage(CONFIG.CLAUDE_MODEL, claudeModelInput.value.trim());

        cachedThresholds = newThresholds;
        autoAdvance = autoAdvanceCheckbox.checked;
        autoAdvanceLoaded = true;

        // Update page
        const allItems = document.querySelectorAll('[data-vine-price-processed="true"]');
        allItems.forEach(item => {
          const badge = item.querySelector('.vine-price-badge');
          if (badge) {
            // dataset holds the lowest price of a range — badge text may be "$a–$b"
            const price = parseFloat(item.dataset.vinePrice);
            if (!isNaN(price)) {
              const color = getPriceColorSync(price);
              badge.className = `vine-price-badge vine-price-${color}`;
              badge.setAttribute('data-price-color', color);

              // Re-apply filter since color might have changed
              applyColorFilter(item, color);
            }
          }
        });

        showStatus('Settings saved!');

        // Check if we should auto-advance after settings change
        checkAndAutoAdvance();

        setTimeout(() => { if (settingsModal) closeSettingsModal(); }, 800);
      });

      // Tab switching
      const tabPrice = dialog.querySelector('#tab-price');
      const tabSearches = dialog.querySelector('#tab-searches');
      const tabKeywords = dialog.querySelector('#tab-keywords');
      const tabStats = dialog.querySelector('#tab-stats');
      const tabSync = dialog.querySelector('#tab-sync');
      const tabShortcuts = dialog.querySelector('#tab-shortcuts');

      const contentPrice = dialog.querySelector('#content-price');
      const contentSearches = dialog.querySelector('#content-searches');
      const contentKeywords = dialog.querySelector('#content-keywords');
      const contentStats = dialog.querySelector('#content-stats');
      const contentSync = dialog.querySelector('#content-sync');
      const contentShortcuts = dialog.querySelector('#content-shortcuts');

      const tabMap = {
        price: [tabPrice, contentPrice],
        searches: [tabSearches, contentSearches],
        keywords: [tabKeywords, contentKeywords],
        stats: [tabStats, contentStats],
        sync: [tabSync, contentSync],
        shortcuts: [tabShortcuts, contentShortcuts]
      };

      function switchTab(tab) {
        Object.values(tabMap).forEach(([t, c]) => {
          t.classList.remove('vine-tab-active');
          t.setAttribute('aria-selected', 'false');
          c.style.display = 'none';
        });
        const [activeTab, activeContent] = tabMap[tab] || tabMap.searches;
        activeTab.classList.add('vine-tab-active');
        activeTab.setAttribute('aria-selected', 'true');
        activeContent.style.display = 'block';
        if (tab === 'stats') renderStatsTab(dialog.querySelector('#vine-stats-body'));
      }

      tabPrice.addEventListener('click', () => { switchTab('price'); setStorage(CONFIG.LAST_ACTIVE_TAB_KEY, 'price'); });
      tabSearches.addEventListener('click', () => { switchTab('searches'); setStorage(CONFIG.LAST_ACTIVE_TAB_KEY, 'searches'); });
      tabKeywords.addEventListener('click', () => { switchTab('keywords'); setStorage(CONFIG.LAST_ACTIVE_TAB_KEY, 'keywords'); });
      tabStats.addEventListener('click', () => { switchTab('stats'); setStorage(CONFIG.LAST_ACTIVE_TAB_KEY, 'stats'); });
      tabSync.addEventListener('click', () => { switchTab('sync'); setStorage(CONFIG.LAST_ACTIVE_TAB_KEY, 'sync'); });
      tabShortcuts.addEventListener('click', () => { switchTab('shortcuts'); setStorage(CONFIG.LAST_ACTIVE_TAB_KEY, 'shortcuts'); });

      switchTab(getStorage(CONFIG.LAST_ACTIVE_TAB_KEY, 'searches'));

      // Keyword list management
      function syncKeywordsInBackground() {
        const token = getStorage(CONFIG.GITHUB_TOKEN_KEY, '');
        if (!token) return;
        syncKeywordsWithGitHub(token).catch(err => console.error('Background keywords sync failed:', err));
      }

      function renderKeywordChips() {
        ['highlight', 'block'].forEach(listName => {
          const container = dialog.querySelector(`#vine-kw-${listName}-list`);
          if (!container) return;
          container.replaceChildren();
          const lists = getKeywordListsSync();
          if (lists[listName].length === 0) {
            const empty = document.createElement('span');
            empty.className = 'vine-kw-empty';
            empty.textContent = 'No keywords yet.';
            container.appendChild(empty);
            return;
          }
          lists[listName].forEach(kw => {
            const chip = document.createElement('span');
            chip.className = 'vine-kw-chip';
            const text = document.createElement('span');
            text.textContent = kw;
            chip.appendChild(text);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'vine-kw-chip-remove';
            remove.textContent = '✕';
            remove.setAttribute('aria-label', `Remove keyword "${kw}"`);
            remove.addEventListener('click', () => {
              const current = getKeywordListsSync();
              setKeywordLists({
                ...current,
                [listName]: current[listName].filter(k => k !== kw)
              });
              renderKeywordChips();
              applyColorFilterToAllItems();
              syncKeywordsInBackground();
            });
            chip.appendChild(remove);
            container.appendChild(chip);
          });
        });
      }

      function wireKeywordAdd(listName) {
        const input = dialog.querySelector(`#vine-kw-${listName}-input`);
        const addBtn = dialog.querySelector(`#vine-kw-${listName}-add`);
        const add = () => {
          const kw = input.value.trim().toLowerCase();
          if (!kw) return;
          const current = getKeywordListsSync();
          if (current[listName].includes(kw)) {
            // Duplicate: skip the full re-filter + gist sync a real add triggers.
            input.value = '';
            showStatus(`"${kw}" is already in the list`, true);
            return;
          }
          setKeywordLists({ ...current, [listName]: [...current[listName], kw] });
          input.value = '';
          renderKeywordChips();
          applyColorFilterToAllItems();
          syncKeywordsInBackground();
        };
        addBtn.addEventListener('click', add);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      }

      wireKeywordAdd('highlight');
      wireKeywordAdd('block');
      renderKeywordChips();

      // Helper to sync searches in the background
      async function syncSearchesInBackground() {
        const token = getStorage(CONFIG.GITHUB_TOKEN_KEY, '');
        if (token) {
          try {
            await syncSearchesWithGitHub(token);
          } catch (error) {
            console.error('Background search sync failed:', error);
            // Silent fail - don't disrupt user experience
          }
        }
      }

      // Sync Button Logic
      const syncBtn = dialog.querySelector('#vine-sync-btn');
      const syncStatus = dialog.querySelector('#vine-sync-status');

      syncBtn.addEventListener('click', async () => {
        const token = githubTokenInput.value.trim();
        if (!token) {
          showStatus('Please save a GitHub Token first', true);
          return;
        }

        syncBtn.disabled = true;
        syncBtn.innerHTML = '<span>⏳</span> Syncing...';

        // Save token first just in case
        setStorage(CONFIG.GITHUB_TOKEN_KEY, token);

        try {
          // Sync cache, searches, and keyword lists
          const [cacheResult, searchesResult, keywordsResult] = await Promise.all([
            syncWithGitHub(token),
            syncSearchesWithGitHub(token),
            syncKeywordsWithGitHub(token)
          ]);

          showStatus(`Sync complete! (${cacheResult.count} cached items, ${searchesResult.count} searches, ${keywordsResult.count} keywords)`);
          renderKeywordChips();
          syncStatus.textContent = `Last synced: ${new Date().toLocaleString()}`;

          // Refresh the searches list in case new ones were synced
          renderSearches();
        } catch (error) {
          console.error('Sync error details:', error);
          const errorMsg = error.message || String(error);
          showStatus('Sync failed: ' + errorMsg, true);
        } finally {
          syncBtn.disabled = false;
          syncBtn.innerHTML = '<span>🔄</span> Sync Now';
        }
      });

      // Saved searches functionality
      const addSearchBtn = dialog.querySelector('#add-search-btn');
      const newSearchTerm = dialog.querySelector('#new-search-term');
      const searchesList = dialog.querySelector('#saved-searches-list');

      function persistSearches(searches, statusMsg) {
        setStorage(CONFIG.SAVED_SEARCHES_KEY, searches);
        setStorage(CONFIG.SAVED_SEARCHES_TIMESTAMP_KEY, Date.now());
        renderSearches();
        if (statusMsg) showStatus(statusMsg);
        syncSearchesInBackground();
      }

      // Focus to restore after a re-render (e.g. after drag-drop so the dragged row stays focused).
      let focusAfterRender = null;

      function renderSearches() {
        const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
        searchesList.replaceChildren();

        if (searches.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'vine-search-empty';
          empty.textContent = "No saved searches. Type a term above (e.g. 'usb-c hub') and press Enter to save a one-click shortcut.";
          searchesList.appendChild(empty);
          return;
        }

        searches.forEach((search, index) => {
          searchesList.appendChild(renderSearchRow(search, index, searches.length));
        });

        if (focusAfterRender !== null) {
          const target = searchesList.querySelector(`.vine-search-row[data-index="${focusAfterRender}"] .vine-search-go`);
          if (target) target.focus();
          focusAfterRender = null;
        }
      }

      function renderSearchRow(search, index, total) {
        const row = document.createElement('div');
        row.className = 'vine-search-row';
        row.dataset.index = String(index);
        row.draggable = true;

        const grip = document.createElement('span');
        grip.className = 'vine-search-grip';
        grip.textContent = '⋮⋮';
        grip.setAttribute('aria-hidden', 'true');
        row.appendChild(grip);

        const goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.className = 'vine-search-go';
        goBtn.textContent = search.name;
        goBtn.setAttribute('aria-label', `Run search: ${search.name}`);
        goBtn.addEventListener('click', () => {
          window.location.href = `https://www.amazon.com/vine/vine-items?search=${encodeURIComponent(search.term)}`;
        });
        row.appendChild(goBtn);

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'vine-search-edit';
        editBtn.textContent = '✏️';
        editBtn.setAttribute('aria-label', `Rename "${search.name}"`);
        editBtn.addEventListener('click', () => beginRename(row, index));
        row.appendChild(editBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'vine-search-delete';
        deleteBtn.textContent = '🗑️';
        deleteBtn.setAttribute('aria-label', `Delete "${search.name}"`);
        wireConfirmButton(deleteBtn, '⚠️ Confirm?', () => {
          const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
          searches.splice(index, 1);
          persistSearches(searches, 'Search deleted');
        });
        row.appendChild(deleteBtn);

        wireDragAndDrop(row, index);
        return row;
      }

      function beginRename(row, index) {
        const goBtn = row.querySelector('.vine-search-go');
        if (!goBtn) return;
        const currentName = goBtn.textContent;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'vine-search-rename';
        input.value = currentName;
        input.setAttribute('aria-label', 'Rename search');

        const commit = () => {
          const newName = input.value.trim();
          if (newName && newName !== currentName) {
            const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
            if (searches[index]) {
              searches[index].name = newName;
              persistSearches(searches, 'Search renamed');
              return;
            }
          }
          renderSearches();
        };

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); renderSearches(); }
        });
        input.addEventListener('blur', commit);

        goBtn.replaceWith(input);
        input.focus();
        input.select();
      }

      function wireDragAndDrop(row, index) {
        row.addEventListener('dragstart', (e) => {
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(index));
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          searchesList.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          row.classList.add('drop-target');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('drop-target');
          const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          const to = index;
          if (Number.isNaN(from) || from === to) return;
          const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
          const [moved] = searches.splice(from, 1);
          searches.splice(to, 0, moved);
          focusAfterRender = to;
          persistSearches(searches, 'Search reordered');
        });
      }

      addSearchBtn.addEventListener('click', () => {
        const term = newSearchTerm.value.trim();
        if (!term) {
          showStatus('Please enter a search term', true);
          return;
        }
        const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
        searches.push({ name: term, term });
        newSearchTerm.value = '';
        persistSearches(searches, 'Search added');
      });

      // Allow Enter key to add search
      newSearchTerm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addSearchBtn.click();
        }
      });

      renderSearches();

      wireConfirmButton(clearCacheBtn, '⚠️ Confirm: clear all cached prices?', () => {
        setStorage(CONFIG.CACHE_KEY, {});
        memoryCache = {};
        pendingCacheUpdates.clear();
        if (cacheUpdateTimeout) { clearTimeout(cacheUpdateTimeout); cacheUpdateTimeout = null; }
        firstPendingAt = 0;
        showStatus('Cache cleared');
      });

      settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettingsModal();
      });

      // Focus trap inside the dialog (Tab / Shift-Tab cycles first↔last).
      dialog.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        // Skip controls inside hidden tab panels (offsetParent is null for
        // display:none) or the trap wraps focus onto invisible elements.
        const focusables = Array.from(dialog.querySelectorAll(
          'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])'
        )).filter(el => el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });

      settingsModal.appendChild(dialog);
      document.body.appendChild(settingsModal);
    };

    // Try to add the link immediately
    if (!addSettingsLink()) {
      // If header not found, retry with a mutation observer
      const headerObserver = new MutationObserver(() => {
        if (addSettingsLink()) {
          headerObserver.disconnect();
        }
      });
      headerObserver.observe(document.body, {
        childList: true,
        subtree: true
      });

      // Also try after a short delay
      setTimeout(() => {
        if (!addSettingsLink()) {
          // If still no header found, create a floating button (mobile fallback)
          createFloatingButton();
        }
        headerObserver.disconnect();
      }, 2000);
    }
  }

  // Add CSS with fallback for GM_addStyle
  function addStyle(css) {
    if (typeof GM_addStyle !== 'undefined') {
      GM_addStyle(css);
    } else {
      const style = document.createElement('style');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  addStyle(`
    :root {
      --vine-bg: #ffffff;
      --vine-fg: #0F1111;
      --vine-fg-muted: #565959;
      --vine-border: #D5D9D9;
      --vine-border-strong: #8D9091;
      --vine-surface: #F7F8F8;
      --vine-primary: #FFD814;
      --vine-primary-hover: #F7CA00;
      --vine-primary-border: #FCD200;
      --vine-secondary: #F0F2F2;
      --vine-secondary-hover: #E3E6E6;
      --vine-link: #007185;
      --vine-link-hover: #C7511F;
      --vine-danger: #B12704;
      --vine-danger-bg: #FEF0EF;
      --vine-success-fg: #1B5E20;
      --vine-success-bg: #E8F5E9;
      --vine-z-badge: 10;
      --vine-z-fab: 9000;
      --vine-z-modal: 10000;
    }

    /* Intentionally light-only: this UI is injected into Amazon, which is also light-only.
       Tokens above don't flip with prefers-color-scheme — that caused button text to go
       illegible on macOS dark-mode (v1.41.0 regression). */

    .vine-price-badge {
      position: absolute;
      top: 6px;
      right: 6px;
      padding: 4px 8px;
      border-radius: 4px;
      font-weight: 700;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 4px;
      box-shadow: 0 1px 2px rgba(15, 17, 17, 0.15);
      z-index: var(--vine-z-badge);
    }

    .vine-price-badge:hover {
      box-shadow: 0 2px 6px rgba(15, 17, 17, 0.2);
    }

    .vine-price-green  { background: #046044; color: #fff; }
    .vine-price-yellow { background: #FFD814; color: #0F1111; }
    .vine-price-red    { background: #B12704; color: #fff; }

    .vine-price-text {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      letter-spacing: 0.5px;
    }

    .vine-cache-indicator {
      font-size: 12px;
      opacity: 0.9;
      cursor: help;
      animation: pulse 2s ease-in-out infinite;
    }

    .vine-variant-indicator {
      font-size: 11px;
      cursor: help;
    }

    /* External price-check links inside the badge */
    .vine-ext-links {
      display: inline-flex;
      gap: 5px;
      margin-left: 4px;
      padding-left: 5px;
      border-left: 1px solid rgba(255, 255, 255, 0.35);
    }
    .vine-price-yellow .vine-ext-links { border-left-color: rgba(15, 17, 17, 0.25); }
    .vine-ext-link {
      color: inherit !important;
      font-size: 11px;
      font-weight: 700;
      text-decoration: none;
      opacity: 0.85;
    }
    .vine-ext-link:hover {
      opacity: 1;
      text-decoration: underline;
    }

    /* Keyword highlight — outline, not border (border shifts grid layout) */
    .vine-keyword-highlight {
      outline: 3px solid #C7511F !important;
      outline-offset: -3px;
      box-shadow: 0 0 8px rgba(199, 81, 31, 0.5);
    }

    /* Keyword chips in the settings modal */
    .vine-kw-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .vine-kw-empty {
      font-size: 12px;
      color: var(--vine-fg-muted);
      padding: 4px 0;
    }
    .vine-kw-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--vine-surface);
      border: 1px solid var(--vine-border);
      border-radius: 14px;
      padding: 4px 6px 4px 12px;
      font-size: 13px;
      color: var(--vine-fg);
    }
    .vine-kw-chip-remove {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--vine-fg-muted);
      font-size: 12px;
      padding: 2px 5px;
      border-radius: 50%;
    }
    .vine-kw-chip-remove:hover {
      background: var(--vine-secondary-hover);
      color: var(--vine-danger);
    }

    /* Sort-by-price toggle in the filter bar */
    #vine-sort-btn {
      background: var(--vine-secondary);
      color: var(--vine-fg);
      border: 1px solid var(--vine-border);
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: "Amazon Ember", Arial, sans-serif;
      white-space: nowrap;
    }
    #vine-sort-btn:hover { background: var(--vine-secondary-hover); }

    /* Infinite scroll sentinel / end marker */
    #vine-infinite-sentinel {
      min-height: 1px;
    }
    .vine-infinite-end {
      text-align: center;
      color: var(--vine-fg-muted);
      font-size: 13px;
      padding: 16px 0;
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 0.9;
      }
      50% {
        opacity: 0.6;
      }
    }

    [data-vine-price-processed="true"] {
      position: relative !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .vine-price-badge,
      .vine-cache-indicator {
        animation: none;
      }
      .vine-price-badge:hover {
        transform: none;
      }
    }
    
    /* Mobile responsiveness */
    @media screen and (max-width: 768px) {
      .vine-price-badge {
        font-size: 12px;
        padding: 6px 8px;
        top: 4px;
        right: 4px;
      }
      
      #vine-color-filter-wrapper {
        flex-wrap: wrap;
        gap: 8px;
        padding: 8px;
      }
      
      #vine-color-filter-wrapper label {
        font-size: 12px;
        padding: 6px 10px;
      }
      
      .vine-settings-dialog {
        max-width: 95vw !important;
        max-height: 95vh !important;
        margin: 10px !important;
        border-radius: 8px !important;
      }
      
      #vine-settings-modal {
        padding: 5px !important;
      }
    }
    
    /* Floating Action Button (FAB) — shown only when there's no header link. */
    .vine-fab {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--vine-primary);
      color: var(--vine-fg);
      border: 1px solid var(--vine-primary-border);
      font-size: 24px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(15, 17, 17, 0.2);
      z-index: var(--vine-z-fab);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .vine-fab:hover { background: var(--vine-primary-hover); }
    .vine-fab:active { transform: scale(0.97); }
    body.vine-has-header-link .vine-fab { display: none; }

    /* Shared button styles inside the settings modal and review generator. */
    .vine-btn-primary {
      background: var(--vine-primary);
      color: #0F1111; /* hardcoded: always dark text on Amazon yellow — WCAG AA */
      border: 1px solid var(--vine-primary-border);
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      min-height: 36px;
    }
    .vine-btn-primary:hover:not([disabled]) { background: var(--vine-primary-hover); }
    .vine-btn-primary[disabled] { opacity: 0.5; cursor: not-allowed; }

    .vine-btn-secondary {
      background: var(--vine-secondary);
      color: var(--vine-fg);
      border: 1px solid var(--vine-border);
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 14px;
      cursor: pointer;
      min-height: 36px;
    }
    .vine-btn-secondary:hover:not([disabled]) { background: var(--vine-secondary-hover); }
    .vine-btn-secondary[disabled] { opacity: 0.5; cursor: not-allowed; }

    /* Saved-search rows (DOM-rendered). */
    .vine-search-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      background: var(--vine-surface);
      border: 1px solid var(--vine-border);
      border-radius: 6px;
    }
    .vine-search-row.dragging { opacity: 0.4; }
    .vine-search-row.drop-target { border-color: var(--vine-link); background: #E6F3F5; }
    .vine-search-grip {
      cursor: grab;
      color: var(--vine-fg-muted);
      padding: 0 4px;
      font-size: 14px;
      letter-spacing: -2px;
      user-select: none;
    }
    .vine-search-row.dragging .vine-search-grip { cursor: grabbing; }
    .vine-search-go {
      flex: 1;
      text-align: left;
      padding: 8px 12px;
      background: var(--vine-secondary);
      color: var(--vine-fg);
      border: 1px solid var(--vine-border);
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      min-height: 36px;
    }
    .vine-search-go:hover { background: var(--vine-secondary-hover); }
    .vine-search-edit, .vine-search-delete {
      padding: 6px 10px;
      background: var(--vine-bg);
      color: var(--vine-fg);
      border: 1px solid var(--vine-border);
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      min-height: 36px;
      min-width: 40px;
    }
    .vine-search-edit:hover, .vine-search-delete:hover { background: var(--vine-secondary); }
    .vine-search-delete.armed {
      background: var(--vine-danger-bg);
      border-color: var(--vine-danger);
      color: var(--vine-danger);
      font-weight: 600;
    }
    .vine-search-rename {
      flex: 1;
      padding: 8px 10px;
      border: 2px solid var(--vine-link);
      border-radius: 6px;
      font-size: 14px;
      background: var(--vine-bg);
      color: var(--vine-fg);
      outline: none;
    }
    .vine-search-empty {
      padding: 20px;
      text-align: center;
      color: var(--vine-fg-muted);
      background: var(--vine-surface);
      border: 1px dashed var(--vine-border);
      border-radius: 6px;
      font-size: 13px;
    }

    /* Settings modal chrome. */
    .vine-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vine-border);
    }
    .vine-modal-title {
      margin: 0;
      font-size: clamp(18px, 4vw, 22px);
      font-weight: 600;
      color: var(--vine-fg);
    }
    .vine-modal-version {
      margin-left: 6px;
      font-size: 12px;
      font-weight: 400;
      color: var(--vine-fg-muted);
    }
    .vine-modal-close-btn {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 1px solid var(--vine-border);
      background: var(--vine-bg);
      color: var(--vine-fg);
      font-size: 14px;
      cursor: pointer;
    }
    .vine-modal-close-btn:hover { background: var(--vine-secondary); }

    .vine-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--vine-border);
    }
    .vine-tab {
      flex: 1;
      padding: 10px 8px;
      background: none;
      border: none;
      border-bottom: 3px solid transparent;
      font-size: 13px;
      font-weight: 600;
      color: var(--vine-fg-muted);
      cursor: pointer;
      min-height: 44px;
    }
    .vine-tab:hover { color: var(--vine-fg); }
    .vine-tab.vine-tab-active {
      color: var(--vine-fg);
      border-bottom-color: var(--vine-primary);
    }

    /* Destructive-but-recoverable actions: de-emphasized link-style, not a full-width
       twin of the primary. Upgrades visually (bg + border) when "armed" via two-step click. */
    .vine-btn-link-danger {
      background: transparent;
      color: var(--vine-danger);
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .vine-btn-link-danger:hover { background: var(--vine-danger-bg); text-decoration: none; }
    .vine-btn-link-danger.armed {
      background: var(--vine-danger-bg);
      border-color: var(--vine-danger);
      font-weight: 600;
      text-decoration: none;
    }

    /* AI Review Generator panel — matches Amazon's card aesthetic. */
    .vine-review-panel {
      margin: 20px 0;
      padding: 16px;
      background: var(--vine-bg);
      border: 1px solid var(--vine-border);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgba(15, 17, 17, 0.06);
    }
    .vine-review-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .vine-review-title {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--vine-fg);
    }
    .vine-review-close {
      width: 32px;
      height: 32px;
      min-width: 32px;
      border-radius: 50%;
      border: 1px solid var(--vine-border);
      background: var(--vine-bg);
      color: var(--vine-fg);
      font-size: 16px;
      cursor: pointer;
    }
    .vine-review-close:hover { background: var(--vine-secondary); }
    .vine-review-reopen { margin: 10px 0; }
    .vine-review-label {
      display: block;
      margin: 10px 0 4px;
      font-size: 13px;
      font-weight: 600;
      color: var(--vine-fg);
    }
    .vine-review-hint {
      font-weight: 400;
      color: var(--vine-fg-muted);
    }
    .vine-review-input {
      width: 100%;
      padding: 8px;
      border: 1px solid var(--vine-border);
      border-radius: 6px;
      font-size: 14px;
      background: var(--vine-bg);
      color: var(--vine-fg);
      font-family: inherit;
      box-sizing: border-box;
    }
    .vine-review-input:focus {
      border-color: var(--vine-link);
      outline: 2px solid rgba(0, 113, 133, 0.2);
      outline-offset: -1px;
    }
    .vine-review-textarea {
      min-height: 80px;
      resize: vertical;
    }
    .vine-review-generate {
      width: 100%;
      margin-top: 12px;
    }
    .vine-review-output { margin-top: 12px; }
    .vine-review-result {
      padding: 10px 12px;
      background: var(--vine-surface);
      border: 1px solid var(--vine-border);
      border-radius: 6px;
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 6px;
    }
    .vine-review-result-body { white-space: pre-wrap; }
    .vine-review-copy { width: 100%; margin-bottom: 10px; }
    .vine-review-copy.vine-copied {
      background: var(--vine-success-bg);
      border-color: var(--vine-success-fg);
      color: var(--vine-success-fg);
    }
    .vine-status-banner {
      display: none;
      padding: 10px 12px;
      border-radius: 6px;
      margin-top: 10px;
      font-size: 13px;
    }

    /* Improve filter bar tap targets on mobile. */
    @media screen and (max-width: 768px) {
      #vine-color-filter label {
        min-height: 44px;
        padding: 0 6px;
      }
      #vine-color-filter input[type="checkbox"] {
        width: 18px;
        height: 18px;
      }
    }
  `);

  const FILTER_HOTKEYS = {
    '1': 'vine-filter-hide-cached',
    '4': 'vine-filter-green',
    '5': 'vine-filter-yellow',
    '6': 'vine-filter-red'
  };

  function setupKeyboardNavigation() {
    console.log('[Vine] Setting up keyboard navigation...');

    let lastVPress = 0;

    const keyHandler = (e) => {
      const activeElement = document.activeElement;
      const isTyping = activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.isContentEditable
      );

      // Escape always closes modals/panels — even while typing inside them.
      if (e.key === 'Escape') {
        if (settingsModal) {
          e.preventDefault();
          closeSettingsModal();
          return;
        }
        const reviewPanel = document.getElementById('vine-review-generator');
        if (reviewPanel && reviewPanel.style.display !== 'none') {
          e.preventDefault();
          reviewPanel.style.display = 'none';
          const reopenBtn = document.getElementById('vine-reopen-generator');
          if (reopenBtn) reopenBtn.style.display = '';
          return;
        }
      }

      // Settings modal open: stop here so filter hotkeys and pagination keys
      // can't act on the page behind the dialog (focus can sit on a modal
      // button, which isTyping doesn't catch).
      if (settingsModal) return;

      // Double-tap V: Open Vine Tools (only when NOT typing)
      if (!isTyping && e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        const now = Date.now();
        if (now - lastVPress < 500) {
          e.preventDefault();
          e.stopPropagation();
          openSettingsModal();
          lastVPress = 0;
          return false;
        }
        lastVPress = now;
      } else if (e.key !== 'Escape') {
        // Any key that isn't another 'v' resets the double-tap window.
        lastVPress = 0;
      }

      if (isTyping) return;

      const filterId = FILTER_HOTKEYS[e.key];
      if (filterId) {
        const checkbox = document.getElementById(filterId);
        if (checkbox) {
          e.preventDefault();
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change'));
        }
        return;
      }

      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const selectors = e.key === 'ArrowRight' ? CONFIG.NEXT_PAGE_SELECTORS : CONFIG.PREV_PAGE_SELECTORS;
        const btn = findPageLink(selectors);
        if (btn && !btn.parentElement.classList.contains('a-disabled')) {
          e.preventDefault();
          btn.click();
        }
      }
    };

    // Use window instead of document and capture phase for better Safari support
    window.addEventListener('keydown', keyHandler, true);
    console.log('[Vine] Keyboard navigation ready');
  }

  // Initialize
  function init() {
    // ===== TEMP BISECTION TEST (Build B2) — remove after testing. =====
    // Active half still OFF (clean B retest passed: no 403). Now re-enabling
    // processVineItems (full badges + dataset writes + hide/style) to see if
    // touching Amazon's tiles at all triggers the 403, tested with a clean
    // session this time.
    const TEST_DISABLE_ACTIVE = true;
    const TEST_DISABLE_DISPLAY = false;
    console.log('[Vine] BISECTION Build B2: active half disabled, price badges (full) re-enabled');
    // =================================================================
    // Check if we're on a Vine page
    const isVinePage = window.location.href.includes('/vine/') ||
      window.location.hostname.includes('vine.amazon.com');

    // Only run Vine-specific features on Vine pages
    if (isVinePage) {
      getThresholds(() => { });
      getHideCached(() => { });
      getColorFilter(() => { });
      if (!TEST_DISABLE_DISPLAY) processVineItems(true);

      // Auto-sync if a GitHub token is configured. Cache-expiry cleanup is deferred in getCache.
      // Throttled to at most once per SYNC_MIN_INTERVAL across page loads/tabs
      // so navigating Vine doesn't re-transfer the whole cache blob every time.
      const githubToken = getStorage(CONFIG.GITHUB_TOKEN_KEY, '');
      const syncFreshEnough = () =>
        (Date.now() - (getStorage(CONFIG.LAST_SYNC_KEY, 0) || 0)) < CONFIG.SYNC_MIN_INTERVAL;
      if (!TEST_DISABLE_ACTIVE && githubToken && !syncFreshEnough()) {
        // Jitter so multiple open tabs don't all sync at once.
        setTimeout(() => {
          if (syncFreshEnough()) {
            console.log('Vine Price Display: Auto-sync skipped (recently synced)');
            return;
          }
          console.log('Vine Price Display: Starting auto-sync...');
          syncWithGitHub(githubToken)
            .then(result => console.log(`Vine Price Display: Auto-sync complete (${result.count} cached items)`))
            .catch(err => console.error('Vine Price Display: Cache auto-sync failed', err));
          syncSearchesWithGitHub(githubToken)
            .then(result => console.log(`Vine Price Display: Searches auto-sync complete (${result.count} searches)`))
            .catch(err => console.error('Vine Price Display: Searches auto-sync failed', err));
          syncKeywordsWithGitHub(githubToken)
            .then(result => console.log(`Vine Price Display: Keywords auto-sync complete (${result.count} keywords)`))
            .catch(err => console.error('Vine Price Display: Keywords auto-sync failed', err));
        }, 2000 + Math.random() * 3000);
      }

      if (!TEST_DISABLE_ACTIVE) observePageChanges();
      createSettingsUI();
      if (window.location.href.startsWith('https://www.amazon.com/vine/vine-items')) {
        createColorFilterUI();
        if (!TEST_DISABLE_ACTIVE) setupInfiniteScroll();
      }
    }

    // Always run review generator on product pages (works on all Amazon product pages)
    createReviewGeneratorUI();

    // Add keyboard navigation for pagination
    if (!TEST_DISABLE_ACTIVE) setupKeyboardNavigation();

    console.log('Amazon Vine Price Display userscript loaded');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('beforeunload', () => {
    if (pendingCacheUpdates.size > 0) flushCacheUpdates();
    if (mutationObserver) mutationObserver.disconnect();
    if (processingTimeout) clearTimeout(processingTimeout);
  });
})();
