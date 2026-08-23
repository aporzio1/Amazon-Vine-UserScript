const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', 'amazon-vine-price-display.user.js');
const LATE_ASIN = 'B000LATE01';
const INITIAL_ASIN = 'B000SEED01';

function within(promise, milliseconds, events) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${events.join(', ')}`)), milliseconds))
  ]);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function loadUserscriptHarness() {
  const storage = new Map([
    ['vine_sync_session', {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }]
  ]);
  let remoteCache = {};
  let firstGet;
  const firstGetStarted = new Promise(resolve => { firstGet = resolve; });
  let firstReplace;
  const firstReplaceStarted = new Promise(resolve => { firstReplace = resolve; });
  let secondReplace;
  const secondReplaceFinished = new Promise(resolve => { secondReplace = resolve; });
  let getCount = 0;
  let replaceCount = 0;
  const events = [];

  const context = {
    URL,
    URLSearchParams,
    TextEncoder,
    Uint8Array,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    clearInterval,
    clearTimeout,
    console,
    crypto: globalThis.crypto,
    document: {
      readyState: 'loading',
      addEventListener() { },
      removeEventListener() { }
    },
    GM_deleteValue: key => storage.delete(key),
    GM_getValue: key => clone(storage.get(key)),
    GM_addStyle() { },
    GM_info: { script: { version: 'test' } },
    GM_setValue: (key, value) => storage.set(key, clone(value)),
    GM_xmlhttpRequest: request => {
      if (request.url.includes('/rest/v1/vine_sync_documents?')) {
        events.push(`get-${getCount}`);
        if (getCount++ > 0) {
          request.onload({
            status: 200,
            responseText: JSON.stringify([{ payload: remoteCache, revision: 1 }])
          });
          return;
        }
        firstGet();
        context.releaseFirstGet = () => request.onload({
          status: 200,
          responseText: JSON.stringify([{ payload: remoteCache, revision: 1 }])
        });
        return;
      }
      if (request.url.includes('/rest/v1/rpc/replace_vine_sync_document')) {
        events.push(`replace-${replaceCount}`);
        remoteCache = JSON.parse(request.data).p_payload;
        if (replaceCount++ === 0) {
          context.releaseFirstReplace = () => request.onload({
            status: 200,
            responseText: JSON.stringify([{ applied: true, revision: 2 }])
          });
          firstReplace();
          return;
        }
        request.onload({
          status: 200,
          responseText: JSON.stringify([{ applied: true, revision: 2 }])
        });
        secondReplace();
        return;
      }
      throw new Error(`Unexpected request: ${request.url}`);
    },
    setInterval,
    setTimeout,
    navigator: { userAgent: 'Node.js' },
    window: {
      addEventListener() { },
      location: { href: 'https://www.amazon.com/vine/vine-items', hostname: 'www.amazon.com' }
    }
  };
  context.globalThis = context;

  const source = fs.readFileSync(SCRIPT_PATH, 'utf8').replace(
    /\n\}\)\(\);\s*$/,
    '\n;globalThis.__vineTestHooks = { getCacheAsync, setCache, setCachedPrice, flushCacheUpdates, syncCacheWithSupabase, hasSavedSearchAlertMonitor: typeof startSavedSearchMonitor === \'function\' };\n})();'
  );
  vm.runInNewContext(source, context, { filename: SCRIPT_PATH });
  return {
    context,
    firstGetStarted,
    firstReplaceStarted,
    secondReplaceFinished,
    events,
    get remoteCache() { return remoteCache; }
  };
}

test('sync preserves and uploads an ASIN written while its first remote write is pending', async () => {
  const harness = loadUserscriptHarness();
  harness.context.__vineTestHooks.setCache({
    [INITIAL_ASIN]: { price: 25, isSeen: true, timestamp: Date.now() }
  });
  const sync = harness.context.__vineTestHooks.syncCacheWithSupabase();
  sync.catch(error => harness.events.push(`error-${error.message}`));
  await within(harness.firstGetStarted, 100, harness.events);
  harness.context.releaseFirstGet();
  await within(harness.firstReplaceStarted, 100, harness.events);

  harness.context.__vineTestHooks.setCachedPrice(LATE_ASIN, 42, true);
  harness.context.__vineTestHooks.flushCacheUpdates();
  harness.context.releaseFirstReplace();
  await within(sync, 100, harness.events);
  await within(harness.secondReplaceFinished, 100, harness.events);

  const localCache = await harness.context.__vineTestHooks.getCacheAsync();
  assert.equal(localCache[LATE_ASIN].isSeen, true);
  assert.equal(harness.remoteCache[LATE_ASIN].isSeen, true);
});

test('does not run saved-search alert monitoring', () => {
  const harness = loadUserscriptHarness();
  assert.equal(harness.context.__vineTestHooks.hasSavedSearchAlertMonitor, false);
});
