// ==UserScript==
// @name         Amazon Vine Price Display
// @namespace    http://tampermonkey.net/
// @version      1.16
// @description  Displays product prices on Amazon Vine items with color-coded indicators and caching
// @author       Andrew Porzio
// @match        https://www.amazon.com/vine/*
// @match        https://www.amazon.com/*/vine/*
// @match        https://vine.amazon.com/*
// @match        https://vine.amazon.com/**/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @inject-into  content
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Configuration constants
  const CONFIG = {
    CACHE_KEY: 'vine_price_cache',
    THRESHOLDS_KEY: 'vine_price_thresholds',
    HIDE_CACHED_KEY: 'vine_hide_cached',
    SAVED_SEARCHES_KEY: 'vine_saved_searches',
    CACHE_DURATION: 7 * 24 * 60 * 60 * 1000, // 7 days
    MAX_CACHE_SIZE: 1000,
    MAX_RETRIES: 3,
    RETRY_BASE_DELAY: 1000,
    MUTATION_DEBOUNCE: 50,
    DEFAULT_THRESHOLDS: {
      GREEN_MIN: 90,
      YELLOW_MIN: 50,
      RED_MAX: 49.99
    },
    AMAZON_DOMAINS: [
      'amazon.com', 'amazon.co.uk', 'amazon.ca', 'amazon.de',
      'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.co.jp',
      'amazon.com.au', 'amazon.in'
    ],
    PRICE_SELECTORS: [
      '.a-price .a-offscreen',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '.a-price-whole',
      '[data-a-color="price"] .a-offscreen',
      '.a-price-symbol + .a-price-whole',
      '.a-price .a-price-whole'
    ]
  };

  // Storage helpers with GM API fallback to localStorage
  const STORAGE_PREFIX = 'vine_price_display_';

  function getStorage(key, defaultValue) {
    try {
      // Try GM API first
      if (typeof GM_getValue !== 'undefined') {
        const value = GM_getValue(key);
        return value !== undefined ? value : defaultValue;
      }
    } catch (e) {
      // GM API failed, fall through to localStorage
    }

    // Fallback to localStorage
    try {
      const storageKey = STORAGE_PREFIX + key;
      const stored = localStorage.getItem(storageKey);
      if (stored === null) {
        return defaultValue;
      }
      return JSON.parse(stored);
    } catch (e) {
      console.error(`Error reading ${key}:`, e);
      return defaultValue;
    }
  }

  function setStorage(key, value) {
    try {
      // Try GM API first
      if (typeof GM_setValue !== 'undefined') {
        GM_setValue(key, value);
        return;
      }
    } catch (e) {
      // GM API failed, fall through to localStorage
    }

    // Fallback to localStorage
    try {
      const storageKey = STORAGE_PREFIX + key;
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (e) {
      console.error(`Error writing ${key}:`, e);
    }
  }

  // Cache management
  let cachedThresholds = null;
  let thresholdsLoaded = false;
  let hideCached = false;
  let hideCachedLoaded = false;

  function getHideCached(callback) {
    if (hideCachedLoaded) {
      callback(hideCached);
      return;
    }
    hideCachedLoaded = true;
    hideCached = getStorage(CONFIG.HIDE_CACHED_KEY, false);
    callback(hideCached);
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
      if (!thresholds.GREEN_MIN) thresholds.GREEN_MIN = CONFIG.DEFAULT_THRESHOLDS.GREEN_MIN;
      if (!thresholds.YELLOW_MIN) thresholds.YELLOW_MIN = CONFIG.DEFAULT_THRESHOLDS.YELLOW_MIN;
      if (!thresholds.RED_MAX) thresholds.RED_MAX = CONFIG.DEFAULT_THRESHOLDS.RED_MAX;

      cachedThresholds = thresholds;
      callback(cachedThresholds);
    } else {
      callback(CONFIG.DEFAULT_THRESHOLDS);
    }
  }

  function getCache(callback) {
    const cache = getStorage(CONFIG.CACHE_KEY, {});
    callback(cache);
  }

  function setCache(cache, callback) {
    const cleaned = cleanupExpiredCache(cache);
    const limited = enforceCacheSizeLimit(cleaned);
    setStorage(CONFIG.CACHE_KEY, limited);
    if (callback) callback();
  }

  function cleanupExpiredCache(cache) {
    const now = Date.now();
    const cleaned = {};
    for (const asin in cache) {
      const entry = cache[asin];
      if (entry && entry.timestamp && (now - entry.timestamp <= CONFIG.CACHE_DURATION)) {
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
      const timeA = a[1].timestamp || 0;
      const timeB = b[1].timestamp || 0;
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
        if (entry && entry.timestamp && entry.price !== undefined && entry.price !== null) {
          const age = now - entry.timestamp;
          if (age <= CONFIG.CACHE_DURATION) {
            results[asin] = entry;
          } else {
            results[asin] = null;
          }
        } else {
          results[asin] = null;
        }
      });
      callback(results);
    });
  }

  function setCachedPrice(asin, price) {
    getCache((cache) => {
      cache[asin] = {
        price: price,
        timestamp: Date.now()
      };
      setCache(cache);
    });
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

  function extractPriceFromHTML(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    for (const selector of CONFIG.PRICE_SELECTORS) {
      const element = doc.querySelector(selector);
      if (element) {
        const priceText = element.textContent.trim();
        const priceMatch = priceText.match(/\$?([\d,]+\.?\d*)/);
        if (priceMatch) {
          const price = parseFloat(priceMatch[1].replace(/,/g, ''));
          if (!isNaN(price) && price > 0) {
            return price;
          }
        }
      }
    }
    return null;
  }

  // Fetch price using GM_xmlhttpRequest
  function fetchPrice(url, asin, callback, retries = CONFIG.MAX_RETRIES) {
    if (!isValidAmazonURL(url)) {
      callback(null);
      return;
    }

    GM_xmlhttpRequest({
      method: 'GET',
      url: url,
      onload: function (response) {
        if (response.status === 200) {
          const price = extractPriceFromHTML(response.responseText);
          if (price !== null) {
            setCachedPrice(asin, price);
            callback({ price: price, isCached: false });
          } else {
            if (retries > 0) {
              const delay = CONFIG.RETRY_BASE_DELAY * Math.pow(2, CONFIG.MAX_RETRIES - retries);
              setTimeout(() => {
                fetchPrice(url, asin, callback, retries - 1);
              }, delay);
            } else {
              callback(null);
            }
          }
        } else {
          if (retries > 0) {
            const delay = CONFIG.RETRY_BASE_DELAY * Math.pow(2, CONFIG.MAX_RETRIES - retries);
            setTimeout(() => {
              fetchPrice(url, asin, callback, retries - 1);
            }, delay);
          } else {
            callback(null);
          }
        }
      },
      onerror: function (error) {
        if (retries > 0) {
          const delay = CONFIG.RETRY_BASE_DELAY * Math.pow(2, CONFIG.MAX_RETRIES - retries);
          setTimeout(() => {
            fetchPrice(url, asin, callback, retries - 1);
          }, delay);
        } else {
          callback(null);
        }
      }
    });
  }

  // UI helpers
  function getPriceColorSync(price) {
    let thresholds = cachedThresholds || CONFIG.DEFAULT_THRESHOLDS;

    // Migrate old format (HIGH/MEDIUM) to new format (GREEN_MIN/YELLOW_MIN)
    if (thresholds.HIGH !== undefined && thresholds.MEDIUM !== undefined) {
      thresholds = {
        GREEN_MIN: thresholds.HIGH,
        YELLOW_MIN: thresholds.MEDIUM,
        RED_MAX: thresholds.MEDIUM - 0.01
      };
      cachedThresholds = thresholds;
      setStorage(CONFIG.THRESHOLDS_KEY, thresholds);
    }

    if (price >= thresholds.GREEN_MIN) {
      return 'green';
    } else if (price >= thresholds.YELLOW_MIN) {
      return 'yellow';
    } else {
      return 'red';
    }
  }

  function createPriceBadge(price, isCached, color) {
    const badge = document.createElement('div');
    badge.className = `vine-price-badge vine-price-${color}`;
    badge.setAttribute('aria-label', `Product price: $${price.toFixed(2)}`);
    badge.setAttribute('role', 'status');

    const priceText = document.createElement('span');
    priceText.className = 'vine-price-text';
    priceText.textContent = `$${price.toFixed(2)}`;
    badge.appendChild(priceText);

    if (isCached) {
      const cacheIndicator = document.createElement('span');
      cacheIndicator.className = 'vine-cache-indicator';
      cacheIndicator.textContent = '📦';
      cacheIndicator.title = 'Cached price';
      badge.appendChild(cacheIndicator);
    }

    return badge;
  }

  // Processing
  const activeFetches = new Map();

  function processVineItem(item, cachedData = null) {
    if (item.dataset.vinePriceProcessed) {
      return;
    }
    item.dataset.vinePriceProcessed = 'true';

    const link = item.querySelector('a[href*="/dp/"]');
    if (!link) {
      return;
    }

    const url = link.href;
    const asin = extractASIN(url);
    if (!asin) {
      return;
    }

    if (getComputedStyle(item).position === 'static') {
      item.style.position = 'relative';
    }

    const cached = cachedData && cachedData.hasOwnProperty(asin) ? cachedData[asin] : null;

    if (cached) {
      getHideCached((shouldHide) => {
        if (shouldHide) {
          item.style.display = 'none';
          item.dataset.vineCachedHidden = 'true';
          return;
        }
        const color = getPriceColorSync(cached.price);
        const badge = createPriceBadge(cached.price, true, color);
        item.appendChild(badge);
      });
    } else {
      const fetchId = `${asin}-${Date.now()}`;
      activeFetches.set(asin, fetchId);

      fetchPrice(url, asin, (priceData) => {
        if (activeFetches.get(asin) === fetchId) {
          activeFetches.delete(asin);
          if (priceData) {
            const color = getPriceColorSync(priceData.price);
            const badge = createPriceBadge(priceData.price, false, color);
            item.appendChild(badge);
          }
        }
      });
    }
  }

  function processBatch(items, isInitialLoad = false) {
    if (items.length === 0) return;

    const itemData = items.map(item => {
      const link = item.querySelector('a[href*="/dp/"]');
      if (!link) return null;
      const asin = extractASIN(link.href);
      if (asin) {
        return { item, asin, url: link.href };
      }
      return null;
    }).filter(data => data && data.asin);

    if (itemData.length === 0) return;

    itemData.forEach(({ item }) => {
      if (getComputedStyle(item).position === 'static') {
        item.style.position = 'relative';
      }
      item.dataset.vinePriceProcessed = 'true';
    });

    const asins = itemData.map(data => data.asin);
    getMultipleCachedPrices(asins, (cachedResults) => {
      getHideCached((shouldHide) => {
        const uncachedItems = [];

        itemData.forEach(({ item, asin, url }) => {
          const cached = cachedResults[asin];
          if (cached && cached.price !== undefined && cached.price !== null) {
            if (shouldHide) {
              item.style.display = 'none';
              item.dataset.vineCachedHidden = 'true';
              return;
            }
            const color = getPriceColorSync(cached.price);
            const badge = createPriceBadge(cached.price, true, color);
            item.appendChild(badge);
          } else {
            uncachedItems.push({ item, asin, url });
          }
        });

        uncachedItems.forEach(({ item, asin, url }) => {
          const fetchId = `${asin}-${Date.now()}`;
          activeFetches.set(asin, fetchId);

          fetchPrice(url, asin, (priceData) => {
            if (activeFetches.get(asin) === fetchId) {
              activeFetches.delete(asin);
              if (priceData) {
                const color = getPriceColorSync(priceData.price);
                const badge = createPriceBadge(priceData.price, false, color);
                item.appendChild(badge);
              }
            }
          });
        });
      });
    });
  }

  function processVineItems(isInitialLoad = false) {
    const selectors = [
      '.vvp-item-tile',
      '[data-recommendation-id]',
      '.a-section.a-spacing-base'
    ];

    let items = [];
    for (const selector of selectors) {
      const found = document.querySelectorAll(selector);
      if (found.length > 0) {
        items = Array.from(found).filter(item => !item.dataset.vinePriceProcessed);
        break;
      }
    }

    if (items.length > 0) {
      processBatch(items, isInitialLoad);
    }
  }

  // Mutation observer
  let mutationObserver = null;
  let processingTimeout = null;

  function observePageChanges() {
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    if (processingTimeout) {
      clearTimeout(processingTimeout);
    }

    mutationObserver = new MutationObserver((mutations) => {
      if (processingTimeout) {
        clearTimeout(processingTimeout);
      }
      requestAnimationFrame(() => {
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

  // Settings UI
  function createSettingsUI() {
    function findHeaderContainer() {
      return document.querySelector('.vvp-header-links-container');
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
      return true;
    }

    let settingsModal = null;

    function openSettingsModal() {
      if (settingsModal) {
        document.body.removeChild(settingsModal);
        settingsModal = null;
        return;
      }

      settingsModal = document.createElement('div');
      settingsModal.id = 'vine-settings-modal';
      settingsModal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        z-index: 10001;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: white;
        border-radius: 12px;
        padding: 24px;
        max-width: 500px;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
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
      if (!thresholds.GREEN_MIN) thresholds.GREEN_MIN = CONFIG.DEFAULT_THRESHOLDS.GREEN_MIN;
      if (!thresholds.YELLOW_MIN) thresholds.YELLOW_MIN = CONFIG.DEFAULT_THRESHOLDS.YELLOW_MIN;
      if (!thresholds.RED_MAX) thresholds.RED_MAX = CONFIG.DEFAULT_THRESHOLDS.RED_MAX;

      const hideCached = getStorage(CONFIG.HIDE_CACHED_KEY, false);
      const savedSearches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);

      dialog.innerHTML = `
        <h2 style="margin: 0 0 20px 0; font-size: 24px; color: #1f2937;">Vine Tools</h2>
        
        <div style="display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 2px solid #e5e7eb;">
          <button id="tab-searches" class="vine-tab active" style="
            flex: 1;
            padding: 12px;
            background: none;
            border: none;
            border-bottom: 3px solid #667eea;
            font-size: 14px;
            font-weight: 600;
            color: #667eea;
            cursor: pointer;
          ">Saved Searches</button>
          <button id="tab-price" class="vine-tab" style="
            flex: 1;
            padding: 12px;
            background: none;
            border: none;
            border-bottom: 3px solid transparent;
            font-size: 14px;
            font-weight: 600;
            color: #6b7280;
            cursor: pointer;
          ">Price Settings</button>
        </div>

        <div id="content-price" class="vine-tab-content" style="display: none;">
          <div style="margin-bottom: 24px;">
          <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">Price Ranges</label>
          <div style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; color: #6b7280;">🟢 Green (minimum): $</label>
            <input type="number" id="vine-green-min" value="${thresholds.GREEN_MIN}" step="0.01"
              style="width: 100%; padding: 8px; border: 2px solid #e5e7eb; border-radius: 6px; font-size: 14px;">
            <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">Items $${thresholds.GREEN_MIN} and above</div>
          </div>
          <div style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; color: #6b7280;">🟡 Yellow (minimum): $</label>
            <input type="number" id="vine-yellow-min" value="${thresholds.YELLOW_MIN}" step="0.01"
              style="width: 100%; padding: 8px; border: 2px solid #e5e7eb; border-radius: 6px; font-size: 14px;">
            <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">Items $${thresholds.YELLOW_MIN} to $${(thresholds.GREEN_MIN - 0.01).toFixed(2)}</div>
          </div>
          <div style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; color: #6b7280;">🔴 Red (maximum): $</label>
            <input type="number" id="vine-red-max" value="${thresholds.RED_MAX}" step="0.01"
              style="width: 100%; padding: 8px; border: 2px solid #e5e7eb; border-radius: 6px; font-size: 14px;">
            <div style="font-size: 11px; color: #9ca3af; margin-top: 2px;">Items below $${(thresholds.YELLOW_MIN).toFixed(2)}</div>
          </div>
          <div style="font-size: 12px; color: #9ca3af; margin-top: 8px; padding: 8px; background: #f3f4f6; border-radius: 4px;">
            <div><strong>Current ranges:</strong></div>
            <div>🟢 Green: $${thresholds.GREEN_MIN}+</div>
            <div>🟡 Yellow: $${thresholds.YELLOW_MIN} - $${(thresholds.GREEN_MIN - 0.01).toFixed(2)}</div>
            <div>🔴 Red: Below $${thresholds.YELLOW_MIN}</div>
          </div>
        </div>

        <div style="margin-bottom: 24px;">
          <label style="display: flex; align-items: center; cursor: pointer;">
            <input type="checkbox" id="vine-hide-cached" ${hideCached ? 'checked' : ''} 
              style="margin-right: 8px; width: 18px; height: 18px;">
            <span style="font-weight: 600; color: #374151;">Hide cached items</span>
          </label>
          <div style="font-size: 12px; color: #9ca3af; margin-top: 4px; margin-left: 26px;">
            Hide items that have cached prices (already viewed)
          </div>
        </div>

        <div style="margin-bottom: 24px;">
          <button id="vine-save-btn" style="
            width: 100%;
            padding: 12px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            margin-bottom: 8px;
          ">Save Settings</button>
          <button id="vine-clear-cache-btn" style="
            width: 100%;
            padding: 12px;
            background: #ef4444;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
          ">Clear Cache</button>
        </div>
        </div>

        <div id="content-searches" class="vine-tab-content">
          <div style="margin-bottom: 20px;">
            <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">Add New Search</label>
            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
              <input type="text" id="new-search-name" placeholder="Search name (e.g., 'Electronics')"
                style="flex: 1; padding: 8px; border: 2px solid #e5e7eb; border-radius: 6px; font-size: 14px;">
            </div>
            <div style="display: flex; gap: 8px;">
              <input type="text" id="new-search-term" placeholder="Search term (e.g., 'laptop')"
                style="flex: 1; padding: 8px; border: 2px solid #e5e7eb; border-radius: 6px; font-size: 14px;">
              <button id="add-search-btn" style="
                padding: 8px 16px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 6px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                white-space: nowrap;
              ">Add Search</button>
            </div>
            <div style="font-size: 12px; color: #9ca3af; margin-top: 4px;">
              Saved searches will appear as quick links below
            </div>
          </div>

          <div style="margin-bottom: 16px;">
            <label style="display: block; margin-bottom: 12px; font-weight: 600; color: #374151;">Your Saved Searches</label>
            <div id="saved-searches-list" style="display: flex; flex-direction: column; gap: 8px;">
              ${savedSearches.length === 0 ? '<div style="padding: 20px; text-align: center; color: #9ca3af; background: #f9fafb; border-radius: 6px;">No saved searches yet. Add one above!</div>' : ''}
            </div>
          </div>
        </div>

        <div id="vine-status" style="
          padding: 12px;
          border-radius: 8px;
          margin-top: 12px;
          display: none;
          font-size: 14px;
        "></div>
      `;

      const saveBtn = dialog.querySelector('#vine-save-btn');
      const clearCacheBtn = dialog.querySelector('#vine-clear-cache-btn');
      const statusDiv = dialog.querySelector('#vine-status');
      const greenMinInput = dialog.querySelector('#vine-green-min');
      const yellowMinInput = dialog.querySelector('#vine-yellow-min');
      const redMaxInput = dialog.querySelector('#vine-red-max');
      const hideCachedCheckbox = dialog.querySelector('#vine-hide-cached');

      function showStatus(message, isError = false) {
        statusDiv.textContent = message;
        statusDiv.style.display = 'block';
        statusDiv.style.background = isError ? '#fee2e2' : '#d1fae5';
        statusDiv.style.color = isError ? '#991b1b' : '#065f46';
        setTimeout(() => {
          statusDiv.style.display = 'none';
        }, 3000);
      }

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
        setStorage(CONFIG.HIDE_CACHED_KEY, hideCachedCheckbox.checked);

        cachedThresholds = newThresholds;
        hideCached = hideCachedCheckbox.checked;
        hideCachedLoaded = true;

        // Update page
        const allItems = document.querySelectorAll('[data-vine-price-processed="true"]');
        allItems.forEach(item => {
          const badge = item.querySelector('.vine-price-badge');
          if (badge) {
            const priceText = badge.querySelector('.vine-price-text').textContent;
            const price = parseFloat(priceText.replace('$', ''));
            if (!isNaN(price)) {
              const color = getPriceColorSync(price);
              badge.className = `vine-price-badge vine-price-${color}`;
            }
          }

          const cacheIndicator = item.querySelector('.vine-cache-indicator');
          if (cacheIndicator && hideCached) {
            item.style.display = 'none';
            item.dataset.vineCachedHidden = 'true';
          } else if (item.dataset.vineCachedHidden === 'true' && !hideCached) {
            item.style.display = '';
            item.dataset.vineCachedHidden = 'false';
          }
        });

        showStatus('Settings saved!');
      });

      // Tab switching
      const tabPrice = dialog.querySelector('#tab-price');
      const tabSearches = dialog.querySelector('#tab-searches');
      const contentPrice = dialog.querySelector('#content-price');
      const contentSearches = dialog.querySelector('#content-searches');

      function switchTab(tab) {
        const tabs = [tabPrice, tabSearches];
        const contents = [contentPrice, contentSearches];

        tabs.forEach(t => {
          t.style.borderBottomColor = 'transparent';
          t.style.color = '#6b7280';
        });
        contents.forEach(c => c.style.display = 'none');

        if (tab === 'price') {
          tabPrice.style.borderBottomColor = '#667eea';
          tabPrice.style.color = '#667eea';
          contentPrice.style.display = 'block';
        } else {
          tabSearches.style.borderBottomColor = '#667eea';
          tabSearches.style.color = '#667eea';
          contentSearches.style.display = 'block';
        }
      }

      tabPrice.addEventListener('click', () => switchTab('price'));
      tabSearches.addEventListener('click', () => switchTab('searches'));

      // Saved searches functionality
      const addSearchBtn = dialog.querySelector('#add-search-btn');
      const newSearchName = dialog.querySelector('#new-search-name');
      const newSearchTerm = dialog.querySelector('#new-search-term');
      const searchesList = dialog.querySelector('#saved-searches-list');

      function renderSearches() {
        const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);

        if (searches.length === 0) {
          searchesList.innerHTML = '<div style="padding: 20px; text-align: center; color: #9ca3af; background: #f9fafb; border-radius: 6px;">No saved searches yet. Add one above!</div>';
          return;
        }

        searchesList.innerHTML = searches.map((search, index) => `
          <div style="display: flex; gap: 8px; align-items: center; padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
            <button data-search-index="${index}" class="search-go-btn" style="
              flex: 1;
              padding: 8px 12px;
              background: linear-gradient(135deg, #10b981 0%, #059669 100%);
              color: white;
              border: none;
              border-radius: 6px;
              font-size: 14px;
              font-weight: 600;
              cursor: pointer;
              text-align: left;
            ">${search.name}</button>
            <button data-search-index="${index}" class="search-edit-btn" style="
              padding: 8px 12px;
              background: #f59e0b;
              color: white;
              border: none;
              border-radius: 6px;
              font-size: 12px;
              cursor: pointer;
            ">✏️</button>
            <button data-search-index="${index}" class="search-delete-btn" style="
              padding: 8px 12px;
              background: #ef4444;
              color: white;
              border: none;
              border-radius: 6px;
              font-size: 12px;
              cursor: pointer;
            ">🗑️</button>
          </div>
        `).join('');

        // Add event listeners
        searchesList.querySelectorAll('.search-go-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.searchIndex);
            const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
            const search = searches[index];
            if (search) {
              window.location.href = `https://www.amazon.com/vine/vine-items?search=${encodeURIComponent(search.term)}`;
            }
          });
        });

        searchesList.querySelectorAll('.search-edit-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.searchIndex);
            const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
            const search = searches[index];
            if (search) {
              const newName = prompt('Enter new name for this search:', search.name);
              if (newName && newName.trim()) {
                searches[index].name = newName.trim();
                setStorage(CONFIG.SAVED_SEARCHES_KEY, searches);
                renderSearches();
                showStatus('Search renamed!');
              }
            }
          });
        });

        searchesList.querySelectorAll('.search-delete-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.searchIndex);
            const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
            if (confirm(`Delete search "${searches[index].name}"?`)) {
              searches.splice(index, 1);
              setStorage(CONFIG.SAVED_SEARCHES_KEY, searches);
              renderSearches();
              showStatus('Search deleted!');
            }
          });
        });
      }

      addSearchBtn.addEventListener('click', () => {
        const name = newSearchName.value.trim();
        const term = newSearchTerm.value.trim();

        if (!name || !term) {
          showStatus('Please enter both a name and search term', true);
          return;
        }

        const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
        searches.push({ name, term });
        setStorage(CONFIG.SAVED_SEARCHES_KEY, searches);

        newSearchName.value = '';
        newSearchTerm.value = '';
        renderSearches();
        showStatus('Search added!');
      });

      // Allow Enter key to add search
      [newSearchName, newSearchTerm].forEach(input => {
        input.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
            addSearchBtn.click();
          }
        });
      });

      renderSearches();

      clearCacheBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear all cached prices?')) {
          setStorage(CONFIG.CACHE_KEY, {});
          showStatus('Cache cleared!');
        }
      });

      settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) {
          document.body.removeChild(settingsModal);
          settingsModal = null;
        }
      });

      settingsModal.appendChild(dialog);
      document.body.appendChild(settingsModal);
    }

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
        addSettingsLink();
        headerObserver.disconnect();
      }, 1000);
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
    .vine-price-badge {
      position: absolute;
      top: 8px;
      right: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      z-index: 1000;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
      animation: slideIn 0.3s ease-out;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .vine-price-badge:hover {
      transform: scale(1.05);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    }

    .vine-price-green {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
    }

    .vine-price-yellow {
      background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
      color: #1f2937;
    }

    .vine-price-red {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      color: white;
    }

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
  `);

  // Initialize
  function init() {
    getThresholds(() => { });
    getHideCached(() => { });
    processVineItems(true);

    setTimeout(() => {
      getCache((cache) => {
        const cleaned = cleanupExpiredCache(cache);
        if (Object.keys(cleaned).length !== Object.keys(cache).length) {
          setCache(cleaned);
        }
      });
    }, 0);

    observePageChanges();
    createSettingsUI();
    console.log('Amazon Vine Price Display userscript loaded');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('beforeunload', () => {
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    if (processingTimeout) {
      clearTimeout(processingTimeout);
    }
  });
})();
