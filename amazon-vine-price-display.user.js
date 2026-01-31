// ==UserScript==
// @name         Amazon Vine Price Display
// @namespace    http://tampermonkey.net/
// @version      1.33.00
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
    OPENAI_API_KEY: 'vine_openai_api_key',
    GITHUB_TOKEN_KEY: 'vine_github_token',
    GIST_ID_KEY: 'vine_gist_id',
    GIST_SEARCHES_ID_KEY: 'vine_gist_searches_id',
    LAST_SYNC_KEY: 'vine_last_sync',
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
  let colorFilter = { green: true, yellow: true, red: true, purple: true };
  let colorFilterLoaded = false;

  // Cache optimization
  const pendingCacheUpdates = new Map();
  let cacheUpdateTimeout = null;
  let autoAdvanceCheckTimeout = null;
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
    colorFilter = getStorage(CONFIG.COLOR_FILTER_KEY, { green: true, yellow: true, red: true, purple: true });
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
          if (!isNaN(price) && price >= 0) {
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
            // Caching is now handled by the caller based on filters
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

    if (price === 0) {
      return 'purple';
    } else if (price >= thresholds.GREEN_MIN) {
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
      getHideCached((shouldHideCached) => {
        const isCached = item.dataset.vineIsCached === 'true';

        if (isCached && shouldHideCached) {
          item.style.display = 'none';
          item.dataset.vineHidden = 'true';
        } else if (!filter[color]) {
          item.style.display = 'none';
          item.dataset.vineHidden = 'true';
        } else {
          item.style.display = '';
          item.dataset.vineHidden = 'false';
        }

        // Trigger auto-advance check whenever/if visibility changes
        checkAndAutoAdvance();
      });
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
      item.dataset.vineIsCached = 'true';
      getHideCached((shouldHide) => {
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

            // Only cache if the item is visible under current filters
            getColorFilter((filter) => {
              if (filter[color]) {
                setCachedPrice(asin, priceData.price);
              }
            });

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
            item.dataset.vineIsCached = 'true';
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

                // Only cache if the item is visible under current filters
                getColorFilter((filter) => {
                  if (filter[color]) {
                    setCachedPrice(asin, priceData.price);
                  }
                });

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

  // Check if all items are hidden and auto-advance to next page (Debounced)
  function checkAndAutoAdvance() {
    if (autoAdvanceCheckTimeout) {
      clearTimeout(autoAdvanceCheckTimeout);
    }

    autoAdvanceCheckTimeout = setTimeout(() => {
      getAutoAdvance((shouldAutoAdvance) => {
        if (!shouldAutoAdvance) {
          return;
        }

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

        // Check if all items are hidden (by any filter)
        const allHidden = allItems.every(item => {
          return getComputedStyle(item).display === 'none';
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
      });
    }, 1000); // Wait 1 second after last update
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

    // Attempt to find the search bar container to inject filters natively
    // We look for the container that holds the search input, usually in the browse toolbar
    const searchContainer = document.querySelector('.vvp-search-container') || document.querySelector('#vvp-search-box') || document.querySelector('.vvp-header-search-container');
    const searchForm = document.querySelector('#vvp-search-form') || document.querySelector('#search-vine-items-form');

    // Fallback: Find the main content area
    const contentArea = document.querySelector('.vvp-items-grid') ||
      document.querySelector('.vvp-body') ||
      document.querySelector('#vvp-items-grid');

    if (!contentArea && !searchContainer) {
      // Retry later if nothing found
      setTimeout(createColorFilterUI, 500);
      return;
    }

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
        border-bottom: 1px solid #e7e7e7;
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

    const currentFilter = getStorage(CONFIG.COLOR_FILTER_KEY, { green: true, yellow: true, red: true, purple: true });

    // Hide Cached Items Toggle
    const hideCachedWrapper = document.createElement('label');
    hideCachedWrapper.style.cssText = `
      display: flex;
      align-items: center;
      cursor: pointer;
      user-select: none;
      font-size: 13px;
      color: #333;
      font-family: "Amazon Ember", Arial, sans-serif;
    `;

    const hideCachedCheckbox = document.createElement('input');
    hideCachedCheckbox.type = 'checkbox';
    hideCachedCheckbox.id = 'vine-filter-hide-cached';
    hideCachedCheckbox.checked = getStorage(CONFIG.HIDE_CACHED_KEY, false);
    hideCachedCheckbox.style.cssText = `
      margin-right: 6px;
      cursor: pointer;
    `;

    const hideCachedLabel = document.createElement('span');
    hideCachedLabel.textContent = 'Hide Cached 📦';

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

    // Create checkboxes for each color
    const colors = [
      { name: 'purple', label: '🟣 Purple ($0)', color: '#8b5cf6' },
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
        color: #333;
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
      labelText.textContent = colorLabel;

      checkbox.addEventListener('change', (e) => {
        const newFilter = getStorage(CONFIG.COLOR_FILTER_KEY, { green: true, yellow: true, red: true, purple: true });
        newFilter[name] = e.target.checked;
        setStorage(CONFIG.COLOR_FILTER_KEY, newFilter);
        colorFilter = newFilter;
        colorFilterLoaded = true;
        applyColorFilterToAllItems();
      });

      checkboxWrapper.appendChild(checkbox);
      checkboxWrapper.appendChild(labelText);
      filterContainer.appendChild(checkboxWrapper);
    });

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
    getColorFilter((filter) => {
      getHideCached((shouldHideCached) => {
        const allItems = document.querySelectorAll('[data-vine-price-processed="true"]');
        allItems.forEach(item => {
          const badge = item.querySelector('.vine-price-badge');
          if (badge) {
            const color = badge.getAttribute('data-price-color');
            const isCached = item.dataset.vineIsCached === 'true' || !!item.querySelector('.vine-cache-indicator');

            if (color) {
              if (isCached && shouldHideCached) {
                item.style.display = 'none';
                item.dataset.vineHidden = 'true';
              } else if (!filter[color]) {
                item.style.display = 'none';
                item.dataset.vineHidden = 'true';
              } else {
                item.style.display = '';
                item.dataset.vineHidden = 'false';
              }
            }
          }
        });
        // Check for auto-advance after re-filtering
        checkAndAutoAdvance();
      });
    });
  }

  // AI Review Generator
  async function generateReview(productDescription, starRating, userComments) {
    const apiKey = getStorage(CONFIG.OPENAI_API_KEY, '');

    if (!apiKey) {
      throw new Error('OpenAI API key not configured. Please add your API key in Vine Tools > Price Settings.');
    }

    const sentiment = starRating >= 4 ? 'positive' : starRating >= 3 ? 'neutral' : 'negative';

    const systemPrompt = `You are writing an Amazon product review as a real customer who actually used this product. Your writing should sound completely natural and human - like you're telling a friend about your experience.

CRITICAL: Write like a real person, not an AI. Use:
- Casual, conversational language
- Personal pronouns (I, my, me)
- Contractions (it's, don't, I've)
- Varied sentence lengths
- Occasional minor imperfections that make it sound authentic
- Specific details and personal observations

Amazon Vine Voice Guidelines (follow these strictly):

Be unbiased: Whether positive, neutral, or negative, your review is about YOUR experience with the product and what YOU liked and didn't like about it. Your reviews are YOUR independent opinions and should not be influenced by anyone else.

Be honest: The honesty in an honest review will come through when you find a writing voice that comes natural to you. That's what customers can trust from Vine Voices - a solid honest review from another customer just like them who happens to spend their free time reviewing new products.

Be insightful yet specific: Reviews are about the product. Avoid vague, general, and repetitive comments. Share context that may help customers better assess the product and your experience with it, like:
- Your familiarity with this type of product
- How you used the product
- How long you used the product
- Specific situations where it worked well or didn't

Check your review for basic grammar and sentence structure (but don't make it sound overly polished or formal).

AVOID these AI tells:
- Starting with "As a..." or "As someone who..."
- Phrases like "overall," "in conclusion," "it's worth noting"
- Overly balanced structure (pro, con, pro, con)
- Perfect grammar with no personality
- Generic statements that could apply to any product

Format: Title on first line, then review body. 2 paragraphs or less. Do NOT mention the star rating number.`;

    const userPrompt = `Write a review for this product as if you personally tested it.

Product: ${productDescription}

${userComments ? `Personal notes from your testing: ${userComments}` : 'Write based on the product description and imagine realistic use cases.'}

This should be a ${sentiment} review. Write naturally - like you're texting a friend about this product. Include specific details that make it believable you actually used it.`;


    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 500
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'API request failed');
      }

      const data = await response.json();
      return data.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error generating review:', error);
      throw error;
    }
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
      // Retry after a delay
      console.log('[Vine Tools] Review generator: waiting for page elements...');
      setTimeout(createReviewGeneratorUI, 1000);
      return;
    }

    console.log('[Vine Tools] Review generator: inserting UI', {
      isReviewPage,
      element: reviewArea.tagName,
      insertPosition
    });

    const container = document.createElement('div');
    container.id = 'vine-review-generator';
    container.style.cssText = `
      margin: 20px 0;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      position: relative;
    `;

    container.innerHTML = `
      <button id="vine-close-generator" style="
        position: absolute;
        top: 12px;
        right: 12px;
        background: rgba(255, 255, 255, 0.2);
        color: white;
        border: none;
        border-radius: 50%;
        width: 32px;
        height: 32px;
        font-size: 20px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s ease;
      " title="Close">✕</button>
      <h3 style="margin: 0 0 16px 0; color: white; font-size: 18px; font-weight: 600;">
        🤖 AI Review Generator
      </h3>
      <div style="background: white; padding: 16px; border-radius: 8px;">
        <div style="margin-bottom: 12px;">
          <label style="display: block; margin-bottom: 4px; font-weight: 600; color: #374151;">
            Star Rating:
          </label>
          <select id="vine-review-stars" style="width: 100%; padding: 8px; border: 2px solid #e5e7eb; border-radius: 6px; font-size: 14px;">
            <option value="5">⭐⭐⭐⭐⭐ (5 stars)</option>
            <option value="4">⭐⭐⭐⭐ (4 stars)</option>
            <option value="3">⭐⭐⭐ (3 stars)</option>
            <option value="2">⭐⭐ (2 stars)</option>
            <option value="1">⭐ (1 star)</option>
          </select>
        </div>
        <div style="margin-bottom: 12px;">
          <label style="display: block; margin-bottom: 4px; font-weight: 600; color: #374151;">
            Your Comments (optional):
          </label>
          <textarea id="vine-review-comments" placeholder="Add any specific points you want to mention..." 
            style="width: 100%; min-height: 80px; padding: 8px; border: 2px solid #e5e7eb; border-radius: 6px; font-size: 14px; font-family: inherit; resize: vertical;"></textarea>
          <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">
            e.g., "Used it for 2 weeks", "Great battery life", "Too heavy for daily use"
          </div>
        </div>
        <button id="vine-generate-review-btn" style="
          width: 100%;
          padding: 12px;
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          margin-bottom: 12px;
        ">Generate Review</button>
        <div id="vine-review-output" style="display: none;">
          <div style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; font-weight: 600; color: #374151;">
              Review Title:
            </label>
            <div id="vine-review-title" style="
              padding: 12px;
              background: #f9fafb;
              border: 2px solid #e5e7eb;
              border-radius: 6px;
              font-size: 16px;
              font-weight: 600;
              line-height: 1.4;
              margin-bottom: 8px;
            "></div>
            <button id="vine-copy-title-btn" style="
              width: 100%;
              padding: 10px;
              background: #667eea;
              color: white;
              border: none;
              border-radius: 6px;
              font-size: 14px;
              font-weight: 600;
              cursor: pointer;
              margin-bottom: 12px;
            ">📋 Copy Title</button>
          </div>
          <div style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; font-weight: 600; color: #374151;">
              Review Body:
            </label>
            <div id="vine-review-body" style="
              padding: 12px;
              background: #f9fafb;
              border: 2px solid #e5e7eb;
              border-radius: 6px;
              white-space: pre-wrap;
              font-size: 14px;
              line-height: 1.6;
              margin-bottom: 8px;
            "></div>
            <button id="vine-copy-body-btn" style="
              width: 100%;
              padding: 10px;
              background: #667eea;
              color: white;
              border: none;
              border-radius: 6px;
              font-size: 14px;
              font-weight: 600;
              cursor: pointer;
            ">📋 Copy Review Body</button>
          </div>
        </div>
        <div id="vine-review-status" style="
          display: none;
          padding: 12px;
          border-radius: 6px;
          margin-top: 12px;
          font-size: 14px;
        "></div>
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

    // Close button handler
    closeBtn.addEventListener('click', () => {
      container.style.display = 'none';
    });

    // Hover effect for close button
    closeBtn.addEventListener('mouseover', () => {
      closeBtn.style.background = 'rgba(255, 255, 255, 0.3)';
    });
    closeBtn.addEventListener('mouseout', () => {
      closeBtn.style.background = 'rgba(255, 255, 255, 0.2)';
    });

    function showStatus(message, isError = false) {
      statusDiv.textContent = message;
      statusDiv.style.display = 'block';
      statusDiv.style.background = isError ? '#fee2e2' : '#d1fae5';
      statusDiv.style.color = isError ? '#991b1b' : '#065f46';
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 5000);
    }

    generateBtn.addEventListener('click', async () => {
      const stars = parseInt(starsSelect.value);
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
            const response = await fetch(productUrl);
            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Extract description from the fetched page
            const descElement = doc.querySelector('#feature-bullets') ||
              doc.querySelector('[data-feature-name="featurebullets"]') ||
              doc.querySelector('#productDescription') ||
              doc.querySelector('#productTitle');

            if (descElement) {
              description = descElement.textContent.trim().substring(0, 1000);
            } else {
              showStatus('Could not extract product description from product page', true);
              return;
            }
          } catch (fetchError) {
            showStatus('Failed to fetch product details: ' + fetchError.message, true);
            return;
          }
        } else {
          // On product detail page, get description directly
          const descriptionElement = document.querySelector('#feature-bullets') ||
            document.querySelector('[data-feature-name="featurebullets"]') ||
            document.querySelector('#productDescription');

          if (!descriptionElement) {
            showStatus('Could not find product description on this page', true);
            return;
          }

          description = descriptionElement.textContent.trim().substring(0, 1000);
        }

        const review = await generateReview(description, stars, comments);

        // Split the review into title and body
        const lines = review.split('\n');
        const title = lines[0].trim();
        const body = lines.slice(1).join('\n').trim();

        titleDiv.textContent = title;
        bodyDiv.textContent = body;
        outputDiv.style.display = 'block';
        showStatus('Review generated successfully!');
      } catch (error) {
        showStatus(error.message, true);
      } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Review';
      }
    });

    copyTitleBtn.addEventListener('click', () => {
      const text = titleDiv.textContent;
      navigator.clipboard.writeText(text).then(() => {
        const originalText = copyTitleBtn.textContent;
        copyTitleBtn.textContent = '✓ Copied!';
        setTimeout(() => {
          copyTitleBtn.textContent = originalText;
        }, 2000);
      }).catch(err => {
        showStatus('Failed to copy title', true);
      });
    });

    copyBodyBtn.addEventListener('click', () => {
      const text = bodyDiv.textContent;
      navigator.clipboard.writeText(text).then(() => {
        const originalText = copyBodyBtn.textContent;
        copyBodyBtn.textContent = '✓ Copied!';
        setTimeout(() => {
          copyBodyBtn.textContent = originalText;
        }, 2000);
      }).catch(err => {
        showStatus('Failed to copy body', true);
      });
    });
  }

  // Cloud Sync (GitHub Gist)
  async function syncWithGitHub(token, manualTrigger = false) {
    if (!token) {
      throw new Error('No GitHub Token provided');
    }

    const gistFileName = 'vine_price_cache.json';
    let gistId = getStorage(CONFIG.GIST_ID_KEY, null);

    // Helper to request GitHub API
    async function githubRequest(endpoint, method = 'GET', body = null) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: method,
          url: `https://api.github.com/${endpoint}`,
          headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          data: body ? JSON.stringify(body) : null,
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve(JSON.parse(response.responseText));
            } else {
              reject(new Error(`GitHub API Error: ${response.status} ${response.statusText}`));
            }
          },
          onerror: (error) => reject(error)
        });
      });
    }

    try {
      // 1. Find or Create Gist
      if (!gistId) {
        // Search for existing gist
        const gists = await githubRequest('gists');
        const existingGist = gists.find(g => g.files && g.files[gistFileName]);

        if (existingGist) {
          gistId = existingGist.id;
        } else {
          // Create new private gist
          const newGist = await githubRequest('gists', 'POST', {
            description: 'Amazon Vine Price Cache (Synced)',
            public: false,
            files: {
              [gistFileName]: {
                content: JSON.stringify({})
              }
            }
          });
          gistId = newGist.id;
        }
        setStorage(CONFIG.GIST_ID_KEY, gistId);
      }

      // 2. Fetch Remote Cache
      const gistData = await githubRequest(`gists/${gistId}`);
      let remoteCache = {};
      if (gistData.files && gistData.files[gistFileName]) {
        try {
          remoteCache = JSON.parse(gistData.files[gistFileName].content);
        } catch (e) {
          console.error('Error parsing remote cache:', e);
          remoteCache = {};
        }
      }

      // 3. Merge Caches (Union of keys, prefer newer timestamp)
      return new Promise((resolve) => {
        getCache((localCache) => {
          const mergedCache = { ...localCache };
          let hasChanges = false;
          const now = Date.now();

          // Merge remote into local
          for (const [asin, entry] of Object.entries(remoteCache)) {
            // Check expiry for remote items too
            if (now - (entry.timestamp || 0) > CONFIG.CACHE_DURATION) continue;

            if (!mergedCache[asin] || (entry.timestamp > mergedCache[asin].timestamp)) {
              mergedCache[asin] = entry;
              hasChanges = true;
            }
          }

          // Check if we need to push updates back to remote
          // (i.e. if local had newer items not in remote, or if we just merged new stuff)
          // For simplicity, we always push back the fully merged state to ensure consistency

          setCache(mergedCache, async () => {
            // 4. Update Remote Gist
            await githubRequest(`gists/${gistId}`, 'PATCH', {
              files: {
                [gistFileName]: {
                  content: JSON.stringify(mergedCache)
                }
              }
            });

            setStorage(CONFIG.LAST_SYNC_KEY, Date.now());
            resolve({ success: true, count: Object.keys(mergedCache).length });
          });
        });
      });

    } catch (error) {
      console.error('Sync failed:', error);
      throw error;
    }
  }

  // Sync Saved Searches with GitHub Gist
  async function syncSearchesWithGitHub(token, manualTrigger = false) {
    if (!token) {
      throw new Error('No GitHub Token provided');
    }

    const gistFileName = 'vine_saved_searches.json';
    let gistId = getStorage(CONFIG.GIST_SEARCHES_ID_KEY, null);

    // Helper to request GitHub API
    async function githubRequest(endpoint, method = 'GET', body = null) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: method,
          url: `https://api.github.com/${endpoint}`,
          headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          data: body ? JSON.stringify(body) : null,
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve(JSON.parse(response.responseText));
            } else {
              reject(new Error(`GitHub API Error: ${response.status} ${response.statusText}`));
            }
          },
          onerror: (error) => reject(error)
        });
      });
    }

    try {
      // 1. Find or Create Gist for Saved Searches
      if (!gistId) {
        // Search for existing gist
        const gists = await githubRequest('gists');
        const existingGist = gists.find(g => g.files && g.files[gistFileName]);

        if (existingGist) {
          gistId = existingGist.id;
        } else {
          // Create new private gist
          const newGist = await githubRequest('gists', 'POST', {
            description: 'Amazon Vine Saved Searches (Synced)',
            public: false,
            files: {
              [gistFileName]: {
                content: JSON.stringify([])
              }
            }
          });
          gistId = newGist.id;
        }
        setStorage(CONFIG.GIST_SEARCHES_ID_KEY, gistId);
      }

      // 2. Fetch Remote Searches
      const gistData = await githubRequest(`gists/${gistId}`);
      let remoteSearches = [];
      if (gistData.files && gistData.files[gistFileName]) {
        try {
          remoteSearches = JSON.parse(gistData.files[gistFileName].content);
        } catch (e) {
          console.error('Error parsing remote searches:', e);
          remoteSearches = [];
        }
      }

      // 3. Merge Searches - Prioritize local order, add new remote searches at end
      const localSearches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
      const localTerms = new Set(localSearches.map(s => s.term.toLowerCase()));

      // Start with local searches (preserving order)
      const mergedSearches = [...localSearches];

      // Add any remote searches that aren't in local
      remoteSearches.forEach(search => {
        const key = search.term.toLowerCase();
        if (!localTerms.has(key)) {
          mergedSearches.push(search);
        }
      });

      // Only update local storage if we added new searches from remote
      if (mergedSearches.length > localSearches.length) {
        setStorage(CONFIG.SAVED_SEARCHES_KEY, mergedSearches);
      }

      // 4. Update Remote Gist with merged list
      await githubRequest(`gists/${gistId}`, 'PATCH', {
        files: {
          [gistFileName]: {
            content: JSON.stringify(mergedSearches)
          }
        }
      });

      return { success: true, count: mergedSearches.length };

    } catch (error) {
      console.error('Searches sync failed:', error);
      throw error;
    }
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
        padding: 10px;
        overflow-y: auto;
      `;

      const dialog = document.createElement('div');
      dialog.className = 'vine-settings-dialog';
      dialog.style.cssText = `
        background: white;
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        max-width: 600px;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
        position: relative;
        margin: auto;
        padding: 24px;
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
      const githubToken = getStorage(CONFIG.GITHUB_TOKEN_KEY, '');
      const lastSyncTime = getStorage(CONFIG.LAST_SYNC_KEY, 0);

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
          <button id="tab-searches" class="vine-tab" style="
            flex: 1;
            padding: 12px;
            background: none;
            border: none;
            border-bottom: 3px solid transparent;
            font-size: 14px;
            font-weight: 600;
            color: #6b7280;
            cursor: pointer;
          ">Saved Searches</button>
          <button id="tab-sync" class="vine-tab" style="
            flex: 1;
            padding: 12px;
            background: none;
            border: none;
            border-bottom: 3px solid transparent;
            font-size: 14px;
            font-weight: 600;
            color: #6b7280;
            cursor: pointer;
          ">Cloud Sync</button>
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
            <input type="checkbox" id="vine-auto-advance" ${autoAdvanceEnabled ? 'checked' : ''} 
              style="margin-right: 8px; width: 18px; height: 18px;">
            <span style="font-weight: 600; color: #374151;">Auto-advance when all items hidden</span>
          </label>
          <div style="font-size: 12px; color: #9ca3af; margin-top: 4px; margin-left: 26px;">
            Automatically go to the next page when all items on the current page are hidden
          </div>
        </div>

        <div style="margin-bottom: 24px; padding-top: 24px; border-top: 2px solid #e5e7eb;">
          <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">AI Review Generator</label>
          <div style="margin-bottom: 12px;">
            <label style="display: block; margin-bottom: 4px; color: #6b7280;">OpenAI API Key (optional):</label>
            <input type="password" id="vine-openai-key" value="${getStorage(CONFIG.OPENAI_API_KEY, '')}" 
              placeholder="sk-..." 
              style="width: 100%; padding: 8px; border: 2px solid #e5e7eb; border-radius: 6px; font-size: 14px;">
            <div style="font-size: 12px; color: #9ca3af; margin-top: 4px;">
              Required for AI review generation. Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" style="color: #667eea;">platform.openai.com</a>
            </div>
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

        <div id="content-sync" class="vine-tab-content" style="display: none;">
          <div style="margin-bottom: 24px;">
            <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">Cloud Sync (GitHub Gist)</label>
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; padding: 12px; border-radius: 6px; font-size: 13px; margin-bottom: 16px;">
              Sync your price cache across multiple devices using a private GitHub Gist.
            </div>
            
            <div style="margin-bottom: 16px;">
              <label style="display: block; margin-bottom: 4px; color: #6b7280;">GitHub Personal Access Token:</label>
              <input type="password" id="vine-github-token" value="${githubToken}" 
                placeholder="ghp_..." 
                style="width: 100%; padding: 8px; border: 2px solid #e5e7eb; border-radius: 6px; font-size: 14px;">
              <div style="font-size: 11px; color: #9ca3af; margin-top: 4px;">
                Token requires <strong>gist</strong> permission. <a href="https://github.com/settings/tokens/new?scopes=gist&description=Vine%20Price%20Scaler" target="_blank" style="color: #667eea;">Generate Token</a>
              </div>
            </div>

            <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 16px;">
              <button id="vine-sync-btn" style="
                flex: 1;
                padding: 10px;
                background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
                color: white;
                border: none;
                border-radius: 6px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
              ">
                <span>🔄</span> Sync Now
              </button>
            </div>

            <div id="vine-sync-status" style="font-size: 12px; color: #6b7280; text-align: center;">
              ${lastSyncTime ? `Last synced: ${new Date(lastSyncTime).toLocaleString()}` : 'Never synced'}
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

      const autoAdvanceCheckbox = dialog.querySelector('#vine-auto-advance');
      const openaiKeyInput = dialog.querySelector('#vine-openai-key');
      const githubTokenInput = dialog.querySelector('#vine-github-token');

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
        setStorage(CONFIG.AUTO_ADVANCE_KEY, autoAdvanceCheckbox.checked);
        setStorage(CONFIG.OPENAI_API_KEY, openaiKeyInput.value.trim());
        setStorage(CONFIG.GITHUB_TOKEN_KEY, githubTokenInput.value.trim());

        cachedThresholds = newThresholds;
        autoAdvance = autoAdvanceCheckbox.checked;
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

              // Re-apply filter since color might have changed
              applyColorFilter(item, color);
            }
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
      const tabSync = dialog.querySelector('#tab-sync');

      const contentPrice = dialog.querySelector('#content-price');
      const contentSearches = dialog.querySelector('#content-searches');
      const contentSync = dialog.querySelector('#content-sync');

      function switchTab(tab) {
        const tabs = [tabPrice, tabSearches, tabSync];
        const contents = [contentPrice, contentSearches, contentSync];

        tabs.forEach(t => {
          t.style.borderBottomColor = 'transparent';
          t.style.color = '#6b7280';
        });
        contents.forEach(c => c.style.display = 'none');

        if (tab === 'price') {
          tabPrice.style.borderBottomColor = '#667eea';
          tabPrice.style.color = '#667eea';
          contentPrice.style.display = 'block';
        } else if (tab === 'searches') {
          tabSearches.style.borderBottomColor = '#667eea';
          tabSearches.style.color = '#667eea';
          contentSearches.style.display = 'block';
        } else {
          tabSync.style.borderBottomColor = '#667eea';
          tabSync.style.color = '#667eea';
          contentSync.style.display = 'block';
        }
      }

      tabPrice.addEventListener('click', () => switchTab('price'));
      tabSearches.addEventListener('click', () => switchTab('searches'));
      tabSync.addEventListener('click', () => switchTab('sync'));

      // Default to searches if opened, or price if that was last active (simplified for now)
      switchTab('searches');

      // Helper to sync searches in the background
      async function syncSearchesInBackground() {
        const token = getStorage(CONFIG.GITHUB_TOKEN_KEY, '');
        if (token) {
          try {
            await syncSearchesWithGitHub(token, false);
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
          // Sync both cache and searches
          const cacheResult = await syncWithGitHub(token, true);
          const searchesResult = await syncSearchesWithGitHub(token, true);

          showStatus(`Sync complete! (${cacheResult.count} cached items, ${searchesResult.count} searches)`);
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

      function renderSearches() {
        const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);

        if (searches.length === 0) {
          searchesList.innerHTML = '<div style="padding: 20px; text-align: center; color: #9ca3af; background: #f9fafb; border-radius: 6px;">No saved searches yet. Add one above!</div>';
          return;
        }

        searchesList.innerHTML = searches.map((search, index) => `
          <div style="display: flex; gap: 8px; align-items: center; padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
            <div style="display: flex; flex-direction: column; gap: 4px;">
              <button data-search-index="${index}" class="search-move-up-btn" style="
                padding: 4px 8px;
                background: #6b7280;
                color: white;
                border: none;
                border-radius: 4px;
                font-size: 10px;
                cursor: pointer;
                ${index === 0 ? 'opacity: 0.3; cursor: not-allowed;' : ''}
              " ${index === 0 ? 'disabled' : ''}>▲</button>
              <button data-search-index="${index}" class="search-move-down-btn" style="
                padding: 4px 8px;
                background: #6b7280;
                color: white;
                border: none;
                border-radius: 4px;
                font-size: 10px;
                cursor: pointer;
                ${index === searches.length - 1 ? 'opacity: 0.3; cursor: not-allowed;' : ''}
              " ${index === searches.length - 1 ? 'disabled' : ''}>▼</button>
            </div>
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
          btn.addEventListener('click', async (e) => {
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
                // Sync in background
                syncSearchesInBackground();
              }
            }
          });
        });

        searchesList.querySelectorAll('.search-delete-btn').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const index = parseInt(e.target.dataset.searchIndex);
            const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
            if (confirm(`Delete search "${searches[index].name}"?`)) {
              searches.splice(index, 1);
              setStorage(CONFIG.SAVED_SEARCHES_KEY, searches);
              renderSearches();
              showStatus('Search deleted!');
              // Sync in background
              syncSearchesInBackground();
            }
          });
        });

        // Move up/down buttons
        searchesList.querySelectorAll('.search-move-up-btn').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const index = parseInt(e.target.dataset.searchIndex);
            if (index > 0) {
              const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
              // Swap with previous item
              [searches[index - 1], searches[index]] = [searches[index], searches[index - 1]];
              setStorage(CONFIG.SAVED_SEARCHES_KEY, searches);
              renderSearches();
              showStatus('Search moved up!');
              // Sync in background
              syncSearchesInBackground();
            }
          });
        });

        searchesList.querySelectorAll('.search-move-down-btn').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const index = parseInt(e.target.dataset.searchIndex);
            const searches = getStorage(CONFIG.SAVED_SEARCHES_KEY, []);
            if (index < searches.length - 1) {
              // Swap with next item
              [searches[index], searches[index + 1]] = [searches[index + 1], searches[index]];
              setStorage(CONFIG.SAVED_SEARCHES_KEY, searches);
              renderSearches();
              showStatus('Search moved down!');
              // Sync in background
              syncSearchesInBackground();
            }
          });
        });
      }

      addSearchBtn.addEventListener('click', async () => {
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
        // Sync in background
        syncSearchesInBackground();
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

    .vine-price-purple {
      background: linear-gradient(135deg, #a855f7 0%, #7e22ce 100%);
      color: white;
      box-shadow: 0 0 10px rgba(168, 85, 247, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.2);
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
    
    /* Floating Action Button (FAB) for mobile */
    .vine-fab {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      font-size: 24px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    
    .vine-fab:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 16px rgba(102, 126, 234, 0.6);
    }
    
    .vine-fab:active {
      transform: scale(0.95);
    }
    
    /* Hide FAB on desktop if header link exists */
    @media screen and (min-width: 769px) {
      #vvp-price-settings-link ~ body .vine-fab {
        display: none;
      }
    }
  `);

  // Keyboard navigation
  function setupKeyboardNavigation() {
    document.addEventListener('keydown', (e) => {
      // Don't trigger if user is typing in an input field
      const activeElement = document.activeElement;
      const isTyping = activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.isContentEditable
      );

      if (isTyping) {
        return;
      }

      // Right Arrow = Next Page
      if (e.key === 'ArrowRight') {
        const nextButton = document.querySelector('li.a-last a') ||
          document.querySelector('.a-pagination .a-last a') ||
          document.querySelector('a[aria-label="Next page"]') ||
          document.querySelector('.a-pagination li:last-child:not(.a-disabled) a');

        if (nextButton && !nextButton.parentElement.classList.contains('a-disabled')) {
          e.preventDefault();
          nextButton.click();
        }
      }

      // Left Arrow = Previous Page
      if (e.key === 'ArrowLeft') {
        const prevButton = document.querySelector('li.a-first a') ||
          document.querySelector('.a-pagination .a-first a') ||
          document.querySelector('a[aria-label="Previous page"]') ||
          document.querySelector('.a-pagination li:first-child:not(.a-disabled) a');

        // Make sure we're not on the first page
        if (prevButton && !prevButton.parentElement.classList.contains('a-disabled')) {
          e.preventDefault();
          prevButton.click();
        }
      }
    });
  }

  // Initialize
  function init() {
    // Check if we're on a Vine page
    const isVinePage = window.location.href.includes('/vine/') ||
      window.location.hostname.includes('vine.amazon.com');

    // Only run Vine-specific features on Vine pages
    if (isVinePage) {
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

        // Auto-sync if token exists
        const githubToken = getStorage(CONFIG.GITHUB_TOKEN_KEY, '');
        if (githubToken) {
          // Add a small delay so we don't slow down initial page processing
          setTimeout(() => {
            console.log('Vine Price Display: Starting auto-sync...');

            // Sync cache
            syncWithGitHub(githubToken)
              .then(result => console.log(`Vine Price Display: Auto-sync complete (${result.count} cached items)`))
              .catch(err => console.error('Vine Price Display: Cache auto-sync failed', err));

            // Sync searches
            syncSearchesWithGitHub(githubToken)
              .then(result => console.log(`Vine Price Display: Searches auto-sync complete (${result.count} searches)`))
              .catch(err => console.error('Vine Price Display: Searches auto-sync failed', err));
          }, 2000);
        }
      }, 0);

      observePageChanges();
      createSettingsUI();
      if (window.location.href.startsWith('https://www.amazon.com/vine/vine-items')) {
        createColorFilterUI();
      }
    }

    // Always run review generator on product pages (works on all Amazon product pages)
    createReviewGeneratorUI();

    // Add keyboard navigation for pagination
    setupKeyboardNavigation();

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
