# Amazon Vine Price Display - Change Log

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
