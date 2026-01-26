// ==UserScript==
// @name         Amazon Vine Price Display
// @namespace    http://tampermonkey.net/
// @version      1.24.01
// @description  Displays product prices on Amazon Vine items with color-coded indicators and caching
// @author       Andrew Porzio
// @updateURL    https://raw.githubusercontent.com/aporzio1/Amazon-Vine-UserScript/main/amazon-vine-price-display.user.js
// @downloadURL  https://raw.githubusercontent.com/aporzio1/Amazon-Vine-UserScript/main/amazon-vine-price-display.user.js
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
    AUTO_ADVANCE_KEY: 'vine_auto_advance',
    SAVED_SEARCHES_KEY: 'vine_saved_searches',
    COLOR_FILTER_KEY: 'vine_color_filter',
    CACHE_DURATION: 7 * 24 * 60 * 60 * 1000, // 7 days
    MAX_CACHE_SIZE: 50000, // Optimized for high capacity
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
  let autoAdvance = false;
  let autoAdvanceLoaded = false;
  let colorFilter = { green: true, yellow: true, red: true };
  let colorFilterLoaded = false;

  // Cache optimization
  const pendingCacheUpdates = new Map();
  let cacheUpdateTimeout = null;
  let memoryCache = null; // In-memory cache to avoid repeated storage reads
  let cacheLoaded = false;
  let lastCleanupTime = 0;
  const CLEANUP_INTERVAL = 60 * 60 * 1000; // Clean up once per hour max

  // Selector optimization
  let cachedSelector = null;

  // Performance tracking
  let itemsProcessedThisSession = 0;

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
    colorFilter = getStorage(CONFIG.COLOR_FILTER_KEY, { green: true, yellow: true, red: true });
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
    if (memoryCache !== null) {
      // Return cached version immediately
      callback(memoryCache);
      return;
    }

    if (!cacheLoaded) {
      cacheLoaded = true;
      memoryCache = getStorage(CONFIG.CACHE_KEY, {});

      // Perform initial cleanup if needed
      const now = Date.now();
      if (now - lastCleanupTime > CLEANUP_INTERVAL) {
        memoryCache = cleanupExpiredCache(memoryCache);
        lastCleanupTime = now;
      }
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

    const limited = enforceCacheSizeLimit(toSave);
    memoryCache = limited; // Update in-memory cache
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

  function flushCacheUpdates() {
    if (pendingCacheUpdates.size === 0) return;

    getCache((cache) => {
      // Apply all pending updates to in-memory cache
      pendingCacheUpdates.forEach((value, key) => {
        cache[key] = value;
      });

      itemsProcessedThisSession += pendingCacheUpdates.size;
      pendingCacheUpdates.clear();

      // Save to storage (triggering cleanup and limit)
      setCache(cache);
    });
  }

  // Ensure cache is saved before navigating away
  window.addEventListener('beforeunload', () => {
    if (pendingCacheUpdates.size > 0) {
      flushCacheUpdates();
    }
  });

  function setCachedPrice(asin, price) {
    // Add to pending updates
    pendingCacheUpdates.set(asin, {
      price: price,
      timestamp: Date.now()
    });

    // Debounce the save operation (2 seconds)
    if (cacheUpdateTimeout) {
      clearTimeout(cacheUpdateTimeout);
    }
    cacheUpdateTimeout = setTimeout(flushCacheUpdates, 2000);
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
    badge.setAttribute('data-price-color', color);

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

  // Apply color filter to an item
  function applyColorFilter(item, color) {
    getColorFilter((filter) => {
      if (!filter[color]) {
        item.style.display = 'none';
        item.dataset.vineColorFiltered = 'true';
      } else {
        // Only show if not hidden by cache filter
        if (item.dataset.vineCachedHidden !== 'true') {
          item.style.display = '';
        }
        item.dataset.vineColorFiltered = 'false';
      }
    });
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
        applyColorFilter(item, color);
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
            applyColorFilter(item, color);
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
            applyColorFilter(item, color);
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
                applyColorFilter(item, color);
              }
            }
          });
        });

        // Check if all items are hidden and auto-advance if enabled
        checkAndAutoAdvance();
      });
    });
  }

  // Check if all items are hidden and auto-advance to next page
  function checkAndAutoAdvance() {
    getAutoAdvance((shouldAutoAdvance) => {
      if (!shouldAutoAdvance) {
        return;
      }

      getHideCached((shouldHide) => {
        if (!shouldHide) {
          return;
        }

        // Wait a bit to ensure all items have been processed
        setTimeout(() => {
          const selectors = [
            '.vvp-item-tile',
            '[data-recommendation-id]',
            '.a-section.a-spacing-base'
          ];

          let allItems = [];
          for (const selector of selectors) {
            const found = document.querySelectorAll(selector);
            if (found.length > 0) {
              allItems = Array.from(found);
              break;
            }
          }

          if (allItems.length === 0) {
            return;
          }

          // Check if all items are hidden
          const allHidden = allItems.every(item => {
            return item.dataset.vineCachedHidden === 'true' ||
              getComputedStyle(item).display === 'none';
          });

          if (allHidden) {
            // Find the next page button and click it
            const nextButton = document.querySelector('li.a-last a') ||
              document.querySelector('.a-pagination .a-last a') ||
              document.querySelector('a[aria-label="Next page"]') ||
              document.querySelector('.a-pagination li:last-child:not(.a-disabled) a');

            if (nextButton && !nextButton.parentElement.classList.contains('a-disabled')) {
              console.log('All items hidden, auto-advancing to next page...');
              nextButton.click();
            } else {
              console.log('All items hidden but no next page available');
            }
          }
        }, 1000); // Wait 1 second to ensure all items are processed
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

    // Try cached selector first for performance
    if (cachedSelector) {
      const found = document.querySelectorAll(cachedSelector);
      if (found.length > 0) {
        items = Array.from(found).filter(item => !item.dataset.vinePriceProcessed);
      } else {
        // Cached selector no longer works, reset it
        cachedSelector = null;
      }
    }

    // If no cached selector or it didn't work, try all selectors
    if (items.length === 0) {
      for (const selector of selectors) {
        const found = document.querySelectorAll(selector);
        if (found.length > 0) {
          items = Array.from(found).filter(item => !item.dataset.vinePriceProcessed);
          cachedSelector = selector; // Cache the working selector
          break;
        }
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

  // Color Filter UI
  function createColorFilterUI() {
    // Check if filter already exists
    if (document.getElementById('vine-color-filter-wrapper')) {
      return;
    }

    // Find the main content area where items are displayed
    const contentArea = document.querySelector('.vvp-items-grid') ||
      document.querySelector('.vvp-body') ||
      document.querySelector('#vvp-items-grid');

    if (!contentArea) {
      // Retry later if content area not found yet
      setTimeout(createColorFilterUI, 500);
      return;
    }

    // Create wrapper for right alignment
    const filterWrapper = document.createElement('div');
    filterWrapper.id = 'vine-color-filter-wrapper';
    filterWrapper.style.cssText = `
      display: flex;
      justify-content: flex-end;
      margin-bottom: 16px;
      position: sticky;
      top: 0;
      z-index: 1000;
    `;

    const filterContainer = document.createElement('div');
    filterContainer.id = 'vine-color-filter';
    filterContainer.style.cssText = `
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 12px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      display: inline-flex;
      align-items: center;
      gap: 20px;
      flex-wrap: wrap;
    `;

    const label = document.createElement('span');
    label.style.cssText = `
      font-weight: 600;
      font-size: 14px;
      color: white;
      margin-right: 8px;
    `;
    label.textContent = 'Filter by Price:';
    filterContainer.appendChild(label);

    const currentFilter = getStorage(CONFIG.COLOR_FILTER_KEY, { green: true, yellow: true, red: true });

    // Create checkboxes for each color
    const colors = [
      { name: 'green', label: '🟢 Green ($90+)', color: '#10b981' },
      { name: 'yellow', label: '🟡 Yellow ($50-89)', color: '#fbbf24' },
      { name: 'red', label: '🔴 Red (<$50)', color: '#ef4444' }
    ];

    colors.forEach(({ name, label: colorLabel, color }) => {
      const checkboxWrapper = document.createElement('label');
      checkboxWrapper.style.cssText = `
        display: flex;
        align-items: center;
        cursor: pointer;
        background: rgba(255, 255, 255, 0.2);
        padding: 8px 12px;
        border-radius: 6px;
        transition: background 0.2s ease;
        user-select: none;
      `;
      checkboxWrapper.onmouseover = () => {
        checkboxWrapper.style.background = 'rgba(255, 255, 255, 0.3)';
      };
      checkboxWrapper.onmouseout = () => {
        checkboxWrapper.style.background = 'rgba(255, 255, 255, 0.2)';
      };

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `vine-filter-${name}`;
      checkbox.checked = currentFilter[name];
      checkbox.style.cssText = `
        margin-right: 8px;
        width: 18px;
        height: 18px;
        cursor: pointer;
      `;

      const labelText = document.createElement('span');
      labelText.style.cssText = `
        font-size: 14px;
        font-weight: 500;
        color: white;
      `;
      labelText.textContent = colorLabel;

      checkbox.addEventListener('change', (e) => {
        const newFilter = getStorage(CONFIG.COLOR_FILTER_KEY, { green: true, yellow: true, red: true });
        newFilter[name] = e.target.checked;
        setStorage(CONFIG.COLOR_FILTER_KEY, newFilter);
        colorFilter = newFilter;
        colorFilterLoaded = true;

        // Apply filter to all items on the page
        applyColorFilterToAllItems();
      });

      checkboxWrapper.appendChild(checkbox);
      checkboxWrapper.appendChild(labelText);
      filterContainer.appendChild(checkboxWrapper);
    });

    // Add filter container to wrapper
    filterWrapper.appendChild(filterContainer);

    // Insert the wrapper at the top of the content area
    contentArea.insertBefore(filterWrapper, contentArea.firstChild);
  }

  // Apply color filter to all items on the page
  function applyColorFilterToAllItems() {
    getColorFilter((filter) => {
      const allItems = document.querySelectorAll('[data-vine-price-processed="true"]');
      allItems.forEach(item => {
        const badge = item.querySelector('.vine-price-badge');
        if (badge) {
          const color = badge.getAttribute('data-price-color');
          if (color) {
            if (!filter[color]) {
              item.style.display = 'none';
              item.dataset.vineColorFiltered = 'true';
            } else {
              // Only show if not hidden by cache filter
              if (item.dataset.vineCachedHidden !== 'true') {
                item.style.display = '';
              }
              item.dataset.vineColorFiltered = 'false';
            }
          }
        }
      });
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
      const autoAdvanceEnabled = getStorage(CONFIG.AUTO_ADVANCE_KEY, false);
      const savedSearches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);

      dialog.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <h2 style="margin: 0; font-size: 24px; color: #1f2937;">Vine Tools</h2>
          <a href="https://www.buymeacoffee.com/aporzio" target="_blank" style="
            display: flex !important;
            align-items: center !important;
            background-color: #40DCA5 !important;
            color: #ffffff !important;
            padding: 6px 12px !important;
            border-radius: 5px !important;
            text-decoration: none !important;
            font-family: 'Cookie', cursive, sans-serif !important;
            font-size: 18px !important;
            font-weight: 500 !important;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1) !important;
            opacity: 1 !important;
            visibility: visible !important;
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
              <path d="M18 8h1a4 4 0 0 1 0 8h-1"></path>
              <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path>
              <line x1="6" y1="1" x2="6" y2="4"></line>
              <line x1="10" y1="1" x2="10" y2="4"></line>
              <line x1="14" y1="1" x2="14" y2="4"></line>
            </svg>
            <span style="color: #ffffff !important; text-shadow: 0 1px 2px rgba(0,0,0,0.1) !important;">Buy me a coffee</span>
          </a>
        </div>
        
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
          <label style="display: flex; align-items: center; cursor: pointer;">
            <input type="checkbox" id="vine-auto-advance" ${autoAdvanceEnabled ? 'checked' : ''} 
              style="margin-right: 8px; width: 18px; height: 18px;">
            <span style="font-weight: 600; color: #374151;">Auto-advance when all items hidden</span>
          </label>
          <div style="font-size: 12px; color: #9ca3af; margin-top: 4px; margin-left: 26px;">
            Automatically go to the next page when all items on the current page are hidden
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
            <div style="display: flex; gap: 8px;">
              <input type="text" id="new-search-term" placeholder="Enter search term (e.g., 'laptop', 'headphones')" 
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
      const autoAdvanceCheckbox = dialog.querySelector('#vine-auto-advance');

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
        setStorage(CONFIG.AUTO_ADVANCE_KEY, autoAdvanceCheckbox.checked);

        cachedThresholds = newThresholds;
        hideCached = hideCachedCheckbox.checked;
        hideCachedLoaded = true;
        autoAdvance = autoAdvanceCheckbox.checked;
        autoAdvanceLoaded = true;

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

        // Check if we should auto-advance after settings change
        checkAndAutoAdvance();

        // Close the modal after a brief delay to show the success message
        setTimeout(() => {
          const modal = document.getElementById('vine-settings-modal');
          if (modal) {
            document.body.removeChild(modal);
            settingsModal = null;
          }
        }, 800);
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
        const term = newSearchTerm.value.trim();

        if (!term) {
          showStatus('Please enter a search term', true);
          return;
        }

        const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
        searches.push({ name: term, term: term });
        setStorage(CONFIG.SAVED_SEARCHES_KEY, searches);

        newSearchTerm.value = '';
        renderSearches();
        showStatus('Search added!');
      });

      // Allow Enter key to add search
      newSearchTerm.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          addSearchBtn.click();
        }
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
    @import url('https://fonts.googleapis.com/css?family=Cookie');
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
    getColorFilter(() => { });
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
    createColorFilterUI();
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
