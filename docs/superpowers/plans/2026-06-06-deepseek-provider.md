# DeepSeek Provider Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DeepSeek as a selectable AI provider for the AI Review Generator alongside the existing OpenAI integration.

**Architecture:** A `PROVIDERS` map in `CONFIG` holds each provider's endpoint URL and default model. `generateReview` reads the active provider from storage and uses the map to resolve URL, key, and model at call time. The Settings UI gains a dropdown to select the provider and shows/hides provider-specific fields accordingly.

**Tech Stack:** Vanilla JS userscript (no build step). One file: `amazon-vine-price-display.user.js`. No test suite — manual verification steps are provided instead.

---

### Task 1: Add new CONFIG keys and PROVIDERS map

**Files:**
- Modify: `amazon-vine-price-display.user.js:39` (after `OPENAI_API_KEY`) and `:92` (before the closing `}` of CONFIG)

- [ ] **Step 1: Add three new storage keys to CONFIG**

  In `amazon-vine-price-display.user.js`, find this line (line 39):
  ```js
      OPENAI_API_KEY: 'vine_openai_api_key',
  ```
  Replace it with:
  ```js
      OPENAI_API_KEY: 'vine_openai_api_key',
      DEEPSEEK_API_KEY: 'vine_deepseek_api_key',
      DEEPSEEK_MODEL: 'vine_deepseek_model',
      AI_PROVIDER: 'vine_ai_provider',
  ```

- [ ] **Step 2: Add PROVIDERS map to CONFIG**

  Find this section near line 87–92 (end of CONFIG):
  ```js
      PREV_PAGE_SELECTORS: [
        'li.a-first a',
        '.a-pagination .a-first a',
        'a[aria-label="Previous page"]',
        '.a-pagination li:first-child:not(.a-disabled) a'
      ]
    };
  ```
  Replace it with:
  ```js
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
        }
      }
    };
  ```

- [ ] **Step 3: Verify the file still loads**

  Load the userscript in Tampermonkey (or reload the tab). Open the browser console and confirm no syntax errors appear. The Vine Tools modal should still open normally.

- [ ] **Step 4: Commit**

  ```bash
  git add amazon-vine-price-display.user.js
  git commit -m "Add PROVIDERS map and new AI config keys to CONFIG"
  ```

---

### Task 2: Update `generateReview` to use provider config

**Files:**
- Modify: `amazon-vine-price-display.user.js:1189–1271` (`generateReview` function)

- [ ] **Step 1: Replace the hardcoded provider values**

  Find the top of `generateReview` (around line 1189):
  ```js
  async function generateReview(productDescription, starRating, userComments) {
    const apiKey = getStorage(CONFIG.OPENAI_API_KEY, '');

    if (!apiKey) {
      throw new Error('OpenAI API key not configured. Please add your API key in Vine Tools > Price Settings.');
    }
  ```
  Replace those 6 lines with:
  ```js
  async function generateReview(productDescription, starRating, userComments) {
    const providerKey = getStorage(CONFIG.AI_PROVIDER, 'openai');
    const provider = CONFIG.PROVIDERS[providerKey] || CONFIG.PROVIDERS.openai;
    const apiKey = providerKey === 'deepseek'
      ? getStorage(CONFIG.DEEPSEEK_API_KEY, '')
      : getStorage(CONFIG.OPENAI_API_KEY, '');

    if (!apiKey) {
      throw new Error(`${provider.label} API key not configured. Please add your key in Vine Tools > Price Settings.`);
    }

    const model = providerKey === 'deepseek'
      ? (getStorage(CONFIG.DEEPSEEK_MODEL, '') || provider.defaultModel)
      : provider.defaultModel;
  ```

- [ ] **Step 2: Update the gmFetch call to use resolved variables**

  Find (around line 1247):
  ```js
      const response = await gmFetch({
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        data: JSON.stringify({
          model: 'gpt-3.5-turbo',
  ```
  Replace those 9 lines with:
  ```js
      const response = await gmFetch({
        method: 'POST',
        url: provider.url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        data: JSON.stringify({
          model,
  ```

- [ ] **Step 3: Manual verification — OpenAI path still works**

  - In Settings > Price Settings, confirm the provider is "OpenAI" (default).
  - On an Amazon product page (`/dp/...`), open the AI Review Generator panel.
  - Generate a review. It should succeed exactly as before.
  - If the OpenAI key is missing, the error should read: *"OpenAI API key not configured. Please add your key in Vine Tools > Price Settings."*

- [ ] **Step 4: Commit**

  ```bash
  git add amazon-vine-price-display.user.js
  git commit -m "Update generateReview to resolve provider, URL, and model from CONFIG.PROVIDERS"
  ```

---

### Task 3: Update Settings UI HTML

**Files:**
- Modify: `amazon-vine-price-display.user.js:1948–1958` (AI Review Generator block in Price Settings tab HTML)

- [ ] **Step 1: Replace the single OpenAI key field with provider dropdown + conditional sections**

  Find the entire AI Review Generator block (around line 1948):
  ```js
          <div style="margin-bottom: 24px; padding-top: 24px; border-top: 1px solid var(--vine-border);">
            <label style="display: block; margin-bottom: 8px; font-weight: 600; color: var(--vine-fg);">AI Review Generator</label>
            <div style="margin-bottom: 12px;">
              <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">OpenAI API Key (optional):</label>
              <input type="password" id="vine-openai-key" value="${getStorage(CONFIG.OPENAI_API_KEY, '')}" 
                placeholder="sk-..." 
                style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
              <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 4px;">
                Required for AI review generation. Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" style="color: var(--vine-link);">platform.openai.com</a>
              </div>
            </div>
          </div>
  ```
  Replace it with:
  ```js
          <div style="margin-bottom: 24px; padding-top: 24px; border-top: 1px solid var(--vine-border);">
            <label style="display: block; margin-bottom: 8px; font-weight: 600; color: var(--vine-fg);">AI Review Generator</label>
            <div style="margin-bottom: 12px;">
              <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">AI Provider:</label>
              <select id="vine-ai-provider" style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px; background: var(--vine-bg); color: var(--vine-fg);">
                <option value="openai" ${getStorage(CONFIG.AI_PROVIDER, 'openai') === 'openai' ? 'selected' : ''}>OpenAI</option>
                <option value="deepseek" ${getStorage(CONFIG.AI_PROVIDER, 'openai') === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
              </select>
            </div>
            <div id="vine-openai-section" style="margin-bottom: 12px; ${getStorage(CONFIG.AI_PROVIDER, 'openai') === 'deepseek' ? 'display: none;' : ''}">
              <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">OpenAI API Key:</label>
              <input type="password" id="vine-openai-key" value="${getStorage(CONFIG.OPENAI_API_KEY, '')}"
                placeholder="sk-..."
                style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
              <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 4px;">
                Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" style="color: var(--vine-link);">platform.openai.com</a>
              </div>
            </div>
            <div id="vine-deepseek-section" style="margin-bottom: 12px; ${getStorage(CONFIG.AI_PROVIDER, 'openai') === 'openai' ? 'display: none;' : ''}">
              <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">DeepSeek API Key:</label>
              <input type="password" id="vine-deepseek-key" value="${getStorage(CONFIG.DEEPSEEK_API_KEY, '')}"
                placeholder="sk-..."
                style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px; margin-bottom: 8px;">
              <label style="display: block; margin-bottom: 4px; color: var(--vine-fg-muted);">DeepSeek Model:</label>
              <input type="text" id="vine-deepseek-model" value="${getStorage(CONFIG.DEEPSEEK_MODEL, '') || 'deepseek-v4-flash'}"
                placeholder="deepseek-v4-flash"
                style="width: 100%; padding: 8px; border: 1px solid var(--vine-border); border-radius: 6px; font-size: 14px;">
              <div style="font-size: 12px; color: var(--vine-fg-muted); margin-top: 4px;">
                Get your key at <a href="https://platform.deepseek.com/api-keys" target="_blank" style="color: var(--vine-link);">platform.deepseek.com</a>
              </div>
            </div>
          </div>
  ```

- [ ] **Step 2: Manual verification — UI renders correctly**

  Open Vine Tools > Price Settings tab.
  - The "AI Review Generator" section should show an "AI Provider" dropdown with "OpenAI" selected by default.
  - The OpenAI API key field should be visible; the DeepSeek fields should be hidden.
  - Switch the dropdown to "DeepSeek" — the OpenAI section should hide and the DeepSeek section (API key + model fields) should appear.
  - Switch back to "OpenAI" — OpenAI section reappears, DeepSeek section hides.
  - Note: toggling at this point does NOT persist — that is wired up in Task 4.

- [ ] **Step 3: Commit**

  ```bash
  git add amazon-vine-price-display.user.js
  git commit -m "Add provider dropdown and DeepSeek fields to Price Settings UI"
  ```

---

### Task 4: Wire up provider toggle listener and save handler

**Files:**
- Modify: `amazon-vine-price-display.user.js` — event listener setup block (~line 2103) and save handler (~line 2138)

- [ ] **Step 1: Add querySelector references for the new fields**

  Find this block (around line 2103):
  ```js
        const autoAdvanceCheckbox = dialog.querySelector('#vine-auto-advance');
        const openaiKeyInput = dialog.querySelector('#vine-openai-key');
        const githubTokenInput = dialog.querySelector('#vine-github-token');
  ```
  Replace it with:
  ```js
        const autoAdvanceCheckbox = dialog.querySelector('#vine-auto-advance');
        const openaiKeyInput = dialog.querySelector('#vine-openai-key');
        const githubTokenInput = dialog.querySelector('#vine-github-token');
        const aiProviderSelect = dialog.querySelector('#vine-ai-provider');
        const deepseekKeyInput = dialog.querySelector('#vine-deepseek-key');
        const deepseekModelInput = dialog.querySelector('#vine-deepseek-model');
        const openaiSection = dialog.querySelector('#vine-openai-section');
        const deepseekSection = dialog.querySelector('#vine-deepseek-section');
  ```

- [ ] **Step 2: Add the provider dropdown change listener**

  Find this line (around line 2108):
  ```js
        const showStatus = makeShowStatus(statusDiv, 3000);
        closeBtn.addEventListener('click', closeSettingsModal);
  ```
  Replace it with:
  ```js
        const showStatus = makeShowStatus(statusDiv, 3000);
        closeBtn.addEventListener('click', closeSettingsModal);

        if (aiProviderSelect) {
          aiProviderSelect.addEventListener('change', () => {
            if (aiProviderSelect.value === 'deepseek') {
              openaiSection.style.display = 'none';
              deepseekSection.style.display = '';
            } else {
              openaiSection.style.display = '';
              deepseekSection.style.display = 'none';
            }
          });
        }
  ```

- [ ] **Step 3: Persist new fields in the save handler**

  Find this line in the save handler (around line 2138):
  ```js
          setStorage(CONFIG.OPENAI_API_KEY, openaiKeyInput.value.trim());
          setStorage(CONFIG.GITHUB_TOKEN_KEY, githubTokenInput.value.trim());
  ```
  Replace it with:
  ```js
          setStorage(CONFIG.OPENAI_API_KEY, openaiKeyInput.value.trim());
          setStorage(CONFIG.GITHUB_TOKEN_KEY, githubTokenInput.value.trim());
          if (aiProviderSelect) setStorage(CONFIG.AI_PROVIDER, aiProviderSelect.value);
          if (deepseekKeyInput) setStorage(CONFIG.DEEPSEEK_API_KEY, deepseekKeyInput.value.trim());
          if (deepseekModelInput) setStorage(CONFIG.DEEPSEEK_MODEL, deepseekModelInput.value.trim());
  ```

- [ ] **Step 4: Manual verification — full end-to-end**

  1. Open Settings > Price Settings.
  2. Select "DeepSeek", enter a DeepSeek API key, leave model as `deepseek-v4-flash`, click Save.
  3. Close and reopen the modal — DeepSeek should still be selected, the key should be pre-filled, and the model field should show `deepseek-v4-flash`.
  4. On a product page, generate a review — it should call DeepSeek's endpoint and return a result.
  5. Switch back to "OpenAI", save, reopen — OpenAI fields appear, DeepSeek fields are hidden.
  6. If the DeepSeek key is missing while DeepSeek is the active provider, confirm the error reads: *"DeepSeek API key not configured. Please add your key in Vine Tools > Price Settings."*

- [ ] **Step 5: Commit**

  ```bash
  git add amazon-vine-price-display.user.js
  git commit -m "Wire provider toggle listener and persist DeepSeek fields on save"
  ```

---

### Task 5: Bump version and update CHANGES.md

**Files:**
- Modify: `amazon-vine-price-display.user.js:4` (`@version` header)
- Modify: `CHANGES.md` (prepend new entry)

- [ ] **Step 1: Bump the version in the userscript header**

  Find line 4:
  ```js
  // @version      1.41.6
  ```
  Replace with:
  ```js
  // @version      1.42.0
  ```

- [ ] **Step 2: Add CHANGES.md entry**

  Prepend the following block at the top of `CHANGES.md` (after the `# Amazon Vine Price Display - Change Log` heading):
  ```markdown
  ## Version 1.42.0 - DeepSeek Provider Support

  - **Feature**: AI Review Generator now supports DeepSeek as an alternative AI provider alongside OpenAI. Select the active provider in Vine Tools > Price Settings via a new "AI Provider" dropdown.
  - **Feature**: DeepSeek model is configurable in Settings (default: `deepseek-v4-flash`). Switching providers shows/hides the relevant API key and model fields inline — no page reload required.
  - **Enhancement**: Error messages when an API key is missing now name the active provider (e.g., "DeepSeek API key not configured") for clarity.
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add amazon-vine-price-display.user.js CHANGES.md
  git commit -m "Release v1.42.0 - DeepSeek provider support"
  ```
