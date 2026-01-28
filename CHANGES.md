# Amazon Vine Price Display - Change Log

## Version 1.29.00 - Native Filter Design

- **UI Overhaul**: Redesigned the "Price Filter" UI to be subtle and blend in with Amazon's native design.
  - The filters are now injected directly into the **Search Toolbar**, placing them neatly between the "Additional Items" buttons and the Search box.
  - Removed the large gradient-colored floating box.
  - Checkboxes now use standard styling with dark gray text to look like they belong on the page.
  - Filters are less intrusive but still easily accessible.

## Version 1.28.01 - Auto-Sync

- **Feature**: Cloud Sync now runs automatically (in the background) when you load a Vine page, provided you have a GitHub token saved.
- **Improved**: Added a 2-second delay to auto-sync to prioritize loading the page interface first.

## Version 1.28.00 - Cloud Sync

- **Feature**: Added Cloud Sync using private GitHub Gists to synchronize price cache across multiple devices/browsers.
- **UI**: Added "Cloud Sync" tab to Settings modal for token management and manual syncing.
- **Logic**: Implemented intelligent cache merging (union of keys, preferring newer timestamps).

## Version 1.27.01 - Filter UI Improvement

- **Fix**: The price filter bar at the top of the grid is now pinned (`position: relative`) so it scrolls with the page content rather than floating over it (`sticky`), preventing it from obscuring content on smaller screens.

## Version 1.27.00 - Intelligent Caching

- **Optimization**: The script now only caches item prices if the item is visible under the current color filters.
- **Benefit**: Prevents the cache from filling up with "junk" items (e.g. low value/red items) that the user has filtered out, keeping the cache smaller and more relevant.
  - If a filter hides an item, its price is fetched for display determination but **not saved** to the 7-day cache.
  - This allows re-checking for better filtering decisions in future sessions without stale hidden data.

## Version 1.26.02 - Keyboard Navigation

### New Features

1. **Keyboard Shortcuts for Pagination**:
   - **Right Arrow (→)**: Navigate to the next page
   - **Left Arrow (←)**: Navigate to the previous page
   - Shortcuts are disabled when typing in input fields (search, comments, etc.)
   - Works on all Vine browsing pages

### Technical Changes

1. **Version**: Updated from 1.26.01 to 1.26.02

2. **New Function**: `setupKeyboardNavigation()`
   - Listens for arrow key presses
   - Intelligently detects when user is typing and disables shortcuts
   - Finds and clicks pagination buttons

---

## Version 1.26.01 - Auto-Advance Fix

### Fixes

1. **Auto-Advance Logic**:
    - The "Auto-advance when all items hidden" feature now works **independently** of the "Hide Cached" filter.
    - It now correctly advances to the next page if all items are hidden by **ANY** filter (including the new Purple $0 filter, Green/Yellow/Red price filters, or Hide Cached).

## Version 1.26.00 - Support for $0 ETV Items

### Enhancements

1. **Purple Highlight for $0 Items**:
   - Items with a confirmed price/ETV of $0.00 are now highlighted in **Purple**.
   - These items are distinct from the "Red" (Low Price) category.
   - Example: A $0.00 item will show a purple badge with the tax value.

2. **$0 ETV Filter**:
   - Added a "🟣 Purple ($0)" filter toggle to the top bar.
   - Allows unique filtering for free items (often highly desirable in Vine).

### Technical Changes

1. **Version**: Updated from 1.25.08 to 1.26.01

2. **Logic Updates**:
   - `extractPriceFromHTML`: Now accepts `0` or `0.00` as a valid price (previously ignored).
   - `getPriceColorSync`: Added logic to return `'purple'` specifically when `price === 0`.
   - `CONFIG`: Updated default filters to include `purple: true`.
   - CSS: Added `.vine-price-purple` class with specific styling.

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

---

## Version 1.25.08 - UX Improvements

### UI Changes

- **Improved Filter Controls**: Moved the "Hide Cached Items" toggle from the Settings menu to the sticky top filter bar. You can now toggle visibility of previously seen items instantly alongside the price color filters.

## Version 1.25.07 - Minor UI Improvements

### Fixes

- **Color Filter Visibility**: Restricted the Green/Yellow/Red price filter checkboxes to only appear on Vine browsing pages (`/vine/vine-items`), preventing them from cluttering other pages like Orders or Account.

## Version 1.25.06 - AI Review Generator Enhancements

### New Features

1. **Universal AI Review Generator**:
    - Now works on **all** Amazon product pages (`/dp/*`), not just Vine-specific URLs.
    - Added support for **Review Creation Pages** (`/review/create-review*`). You can now generate reviews directly correctly on the submission form.
2. **Smart Context & UI Improvements**:
    - **Context Awareness**: On review pages, the script automatically fetches the product description from the product page using the ASIN, ensuring the AI has full context.
    - **Split Output**: Generated reviews are now separated into "Review Title" and "Review Body" fields, each with its own "Copy" button for easier pasting.
    - **Close Button**: Added a close (✕) button to the generator UI.
3. **Settings Integration**:
    - Added an **OpenAI API Key** input field directly in the "Vine Tools" settings menu for easier configuration.

## Version 1.25.03 - Natural Language Improvements

### Enhancements

1. **Significantly Improved AI Prompt for More Natural Reviews**:
   - Reviews now sound much more human and less AI-generated
   - Emphasizes casual, conversational language
   - Uses personal pronouns, contractions, and varied sentence structure
   - Includes specific instructions to avoid common "AI tells"
   - Maintains all Amazon Vine Voice guidelines

2. **Anti-AI Detection Features**:
   - Avoids phrases like "As a...", "overall", "in conclusion"
   - Prevents overly balanced pro/con structure
   - Encourages authentic imperfections
   - Focuses on specific personal observations
   - Writes like texting a friend

3. **Enhanced Prompt Engineering**:
   - System prompt positions AI as actual customer
   - User prompt emphasizes personal testing experience
   - Better integration of user comments
   - More natural sentiment handling

### Technical Changes

1. **Version**: Updated from 1.25.02 to 1.25.03

2. **Prompt Improvements**:
   - Expanded system prompt with natural language guidelines
   - Added explicit list of AI tells to avoid
   - Reframed user prompt to sound more personal
   - Maintained all Amazon Vine Voice requirements

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

---

## Version 1.25.02 - Review Page Support

### Enhancements

1. **AI Review Generator Now Works on Review Creation Pages**:
   - Appears on Amazon's review creation page (`/review/create-review`)
   - Perfect for Vine reviewers - generate reviews directly on the review form page
   - Also works on regular product pages and review pages for non-Vine purchases
   - Automatically detects page type and finds appropriate elements

### Technical Changes

1. **Version**: Updated from 1.25.01 to 1.25.02

2. **New @match Directives**:
   - Added `@match https://www.amazon.com/review/create-review*`
   - Added `@match https://www.amazon.com/*/review/create-review*`

3. **Smart Page Detection**:
   - Detects if on product page (`/dp/`) or review page (`/review/create-review`)
   - Different element selectors for each page type
   - Extracts product title/description from review page when available

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

---

## Version 1.25.01 - Universal Review Generator

### Enhancements

1. **AI Review Generator Now Works on All Amazon Product Pages**:
   - Previously limited to Vine pages only
   - Now available on ANY Amazon product page (/dp/ URLs)
   - Useful for writing reviews for all Amazon purchases, not just Vine items
   - Other features (price display, color filter, etc.) remain Vine-only

### Technical Changes

1. **Version**: Updated from 1.25.00 to 1.25.01

2. **New @match Directives**:
   - Added `@match https://www.amazon.com/*/dp/*`
   - Added `@match https://www.amazon.com/dp/*`
   - Allows script to run on all Amazon product pages

3. **Conditional Feature Loading**:
   - Added `isVinePage` check in init function
   - Vine-specific features only load on Vine pages
   - AI Review Generator loads on all product pages

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

---

## Version 1.25.00 - AI Review Generator

### New Features Added

1. **AI-Powered Review Generator**:
   - Automatically generates Amazon Vine reviews using OpenAI's GPT-3.5
   - Appears on product detail pages (when viewing /dp/ URLs)
   - Beautiful gradient UI matching the Vine Tools theme
   - Follows Amazon Vine Voice guidelines for quality reviews

2. **Review Customization**:
   - **Star Rating Selector**: Choose 1-5 stars for your review sentiment
   - **Comments Field**: Add specific points you want mentioned (e.g., "Used for 2 weeks", "Great battery life")
   - **Product Description**: Automatically extracts product details from the page
   - **Copy to Clipboard**: One-click copy of generated review

3. **OpenAI Integration**:
   - Configure your OpenAI API key in Vine Tools > Price Settings
   - Uses GPT-3.5-turbo model for cost-effective generation
   - Secure API key storage (stored locally, never shared)
   - Clear error messages if API key is missing or invalid

4. **Review Quality**:
   - Follows Vine Voice guidelines: unbiased, honest, insightful
   - Generates title + 2 paragraphs or less
   - Natural writing voice that sounds genuine
   - Avoids mentioning star rating numbers
   - Proper grammar and sentence structure

### Technical Changes

1. **Version**: Updated from 1.24.01 to 1.25.00

2. **New Storage Key**: `OPENAI_API_KEY: 'vine_openai_api_key'`
   - Stores user's OpenAI API key securely

3. **New Functions**:
   - `generateReview(productDescription, starRating, userComments)`: Calls OpenAI API to generate review
   - `createReviewGeneratorUI()`: Creates the review generator interface on product pages

4. **API Integration**:
   - Uses OpenAI Chat Completions API
   - Model: gpt-3.5-turbo
   - Temperature: 0.7 for natural variation
   - Max tokens: 500 for concise reviews

5. **UI Components**:
   - Star rating dropdown (1-5 stars with emoji)
   - Comments textarea with placeholder examples
   - Generate button with loading state
   - Review output area with copy button
   - Status messages for success/error feedback

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

### Usage

1. Navigate to any Amazon product page (/dp/ URL)
2. Scroll to find the "🤖 AI Review Generator" section
3. First time: Add your OpenAI API key in Vine Tools > Price Settings
4. Select your star rating (1-5 stars)
5. Optionally add specific comments you want included
6. Click "Generate Review"
7. Copy the generated review to your clipboard
8. Paste into Amazon's review form

**Note**: This feature requires an OpenAI API key. Get yours at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). GPT-3.5-turbo is very affordable for occasional use.

---

## Version 1.24.01 - Filter UI Improvements

### UI Enhancements

1. **Right-Aligned Filter**:
   - Filter bar now appears on the right side of the page instead of spanning full width
   - More compact and unobtrusive design
   - Better visual hierarchy

2. **Compact Box Design**:
   - Filter container now only wraps around the content (label + checkboxes)
   - Changed from full-width to inline-flex layout
   - Cleaner, more polished appearance

### Technical Changes

1. **Version**: Updated from 1.24.00 to 1.24.01

2. **UI Structure**:
   - Added wrapper div for right alignment (`vine-color-filter-wrapper`)
   - Changed filter container from `display: flex` to `display: inline-flex`
   - Moved sticky positioning to wrapper for better control

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)
- `README.md` (updated feature description)

---

## Version 1.24 - Color Filter Feature

### New Features Added

1. **Color Filter Bar**:
   - Prominent filter bar displayed at the top of the grid view
   - Three checkboxes for filtering items by price color:
     - 🟢 Green ($90+)
     - 🟡 Yellow ($50-89)
     - 🔴 Red (<$50)
   - Checkboxes can be selected in any combination
   - Sticky positioning keeps filter visible while scrolling
   - Beautiful gradient design matching the Vine Tools theme

2. **Real-time Filtering**:
   - Instantly shows/hides items based on selected filters
   - Works seamlessly with existing "Hide cached items" feature
   - Filter state persists across page reloads and sessions

### Technical Changes

1. **Version**: Updated from 1.23 to 1.24

2. **New Storage Key**: `COLOR_FILTER_KEY: 'vine_color_filter'`
   - Stores object: `{ green: boolean, yellow: boolean, red: boolean }`
   - Default: all colors enabled

3. **New Functions**:
   - `getColorFilter(callback)`: Retrieves color filter settings with caching
   - `applyColorFilter(item, color)`: Applies filter to individual item
   - `createColorFilterUI()`: Creates and inserts the filter bar UI
   - `applyColorFilterToAllItems()`: Applies filter to all processed items

4. **Enhanced Badge System**:
   - Added `data-price-color` attribute to price badges
   - Enables efficient filtering by color category
   - Added `data-vine-color-filtered` attribute to track filter state

5. **UI Design**:
   - Gradient purple background matching Vine Tools
   - Hover effects on checkbox labels
   - Responsive layout with flexbox
   - Smooth transitions

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

### Usage

1. Navigate to any Amazon Vine items page
2. The color filter bar appears automatically at the top of the grid
3. Check/uncheck color boxes to show/hide items by price range
4. Filter settings are saved automatically

This feature allows Vine reviewers to quickly focus on items in their preferred price ranges without scrolling through unwanted items.

---

## Version 1.21 - Auto-Advance Feature

### New Features Added

1. **Auto-Advance Toggle**:
   - New checkbox in Price Settings: "Auto-advance when all items hidden"
   - When enabled (along with "Hide cached items"), automatically navigates to the next page when all items on the current page are hidden
   - Repeats until it finds a page with non-hidden items
   - Helpful for quickly skipping through pages of already-viewed items

### Technical Changes

1. **Version**: Updated from 1.20 to 1.21

2. **New Storage Key**: `AUTO_ADVANCE_KEY: 'vine_auto_advance'`
   - Stores boolean value for auto-advance preference

3. **New Functions**:
   - `getAutoAdvance(callback)`: Retrieves auto-advance setting
   - `checkAndAutoAdvance()`: Checks if all items are hidden and navigates to next page

4. **Logic Flow**:
   - After processing items in `processBatch()`, calls `checkAndAutoAdvance()`
   - After saving settings, calls `checkAndAutoAdvance()` to immediately check current page
   - Waits 1 second after page load to ensure all items are processed
   - Finds next page button using multiple selectors for compatibility
   - Only advances if next page button exists and is not disabled

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

### Usage

1. Click "Vine Tools" in the Vine header
2. Go to "Price Settings" tab
3. Enable "Hide cached items"
4. Enable "Auto-advance when all items hidden"
5. Click "Save Settings"
6. The script will automatically skip to the next page if all items are hidden

---

## Version 1.15 - Saved Searches Feature

### New Features Added

1. **Renamed Menu**: "Price Settings" → "Vine Tools"
   - Better reflects the expanded functionality

2. **Tabbed Interface**:
   - Tab 1: Price Settings (existing functionality)
   - Tab 2: Saved Searches (new functionality)

3. **Saved Searches Management**:
   - **Add Searches**: Users can create custom search shortcuts with:
     - Custom name (e.g., "Electronics")
     - Search term (e.g., "laptop")
   - **Quick Navigation**: Click any saved search to navigate to:
     - `https://www.amazon.com/vine/vine-items?search={searchterm}`
   - **Edit**: Rename saved searches using the ✏️ button
   - **Delete**: Remove saved searches using the 🗑️ button
   - **Keyboard Shortcut**: Press Enter in either input field to add search

### Technical Changes

1. **Version**: Updated from 1.14 to 1.15

2. **New Storage Key**: `SAVED_SEARCHES_KEY: 'vine_saved_searches'`
   - Stores array of objects: `[{ name: string, term: string }]`

3. **UI Components**:
   - Tab switching logic with visual feedback
   - Dynamic search list rendering
   - Event listeners for add/edit/delete operations
   - Responsive button layout with color-coded actions:
     - Green gradient: Navigate to search
     - Orange: Edit search name
     - Red: Delete search

4. **User Experience**:
   - Empty state message when no searches exist
   - Confirmation dialog before deleting
   - Success/error status messages
   - Persistent storage across sessions

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

### Usage

1. Click "Vine Tools" in the Vine header
2. Switch to "Saved Searches" tab
3. Enter a name and search term
4. Click "Add Search" or press Enter
5. Click the green button to navigate to that search
6. Use ✏️ to rename or 🗑️ to delete

This feature helps Vine reviewers quickly access their frequently-used searches without typing them repeatedly.
