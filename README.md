# Amazon Vine Price Display - Userscript Version

This is a userscript version of the Amazon Vine Price Display extension. It works with Tampermonkey, Violentmonkey, or Greasemonkey.

## Installation

1. **Install a userscript manager:**
   - **Tampermonkey**: [Chrome](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) | [Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) | [Safari](https://apps.apple.com/us/app/tampermonkey/id1482490089)
   - **Violentmonkey**: [Chrome](https://chrome.google.com/webstore/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag) | [Firefox](https://addons.mozilla.org/en-US/firefox/addon/violentmonkey/)
   - **Greasemonkey**: [Firefox](https://addons.mozilla.org/en-US/firefox/addon/greasemonkey/)
   - **Userscripts**: [Safari (iOS/macOS)](https://apps.apple.com/us/app/userscripts/id1463298887)

2. **Install the script:**
   - Open `amazon-vine-price-display.user.js` in a text editor
   - Copy the entire contents
   - Open your userscript manager (Tampermonkey/Violentmonkey/Greasemonkey)
   - Click "Create a new script" or "Add new script"
   - Paste the code
   - Save the script (Ctrl+S / Cmd+S)

3. **Verify installation:**
   - Navigate to `https://vine.amazon.com` or `https://www.amazon.com/vine/`
   - You should see a "Vine Tools" link in the header navigation
   - Price badges should appear on Vine items

## Screenshots

![Amazon Vine Price Display Preview](vine_extension_preview.png)
*Color-coded price badges on Amazon Vine items*

## Features

- **Price Display**: Shows product prices on Amazon Vine items with color-coded badges
  - 🟢 Green: High value items (default: $90+)
  - 🟡 Yellow: Medium value items (default: $50-$89.99)
  - 🔴 Red: Lower value items (below $50)
- **Color Filter**: Filter items by price range with convenient checkboxes (right-aligned, compact design)
  - Show/hide green, yellow, and red items in any combination
  - Filter bar stays visible while scrolling (sticky positioning)
  - Settings persist across sessions
- **AI Review Generator**: Generate high-quality Amazon Vine reviews using AI
  - **Works on ALL Amazon product pages** (not just Vine items)
  - Powered by OpenAI GPT-3.5-turbo
  - Follows Vine Voice guidelines (unbiased, honest, insightful)
  - Customizable with star rating and your own comments
  - One-click copy to clipboard
  - Appears automatically on product pages
- **Customizable Price Ranges**: Set custom minimum prices for each color category
- **Caching**: Caches prices for 7 days to avoid repeated fetches
- **Cache Indicator**: Shows 📦 icon for cached prices
- **Saved Searches**: Save your favorite search terms for quick 1-click access
- **Settings UI**: Access settings from the "Vine Tools" link in the header navigation
- **Hide Cached Items**: Toggle to hide items you've already viewed
- **Auto-Advance Pages**: Automatically skip to the next page when all items are hidden (requires "Hide Cached Items" to be enabled)
- **Auto-updates**: Automatically processes new items as you scroll

## Usage

1. **Color Filter**: Use the checkboxes at the top of the grid to filter items by price range (green/yellow/red)
2. **AI Review Generator**: On product pages, use the AI generator to create reviews (requires OpenAI API key in settings)
3. **Access Settings**: Click the "Vine Tools" link in the header navigation on any Amazon Vine page
4. **Saved Searches**: Use the "Saved Searches" tab to add and manage your favorite search terms
5. **Configure Price Ranges**: Set custom minimum prices for Green, Yellow, and Red categories in the "Price Settings" tab
6. **OpenAI API Key**: Add your API key in "Price Settings" to enable AI review generation
7. **Hide Cached Items**: Toggle the checkbox to hide items you've already viewed (cached prices)
8. **Auto-Advance Pages**: Enable this option to automatically advance to the next page when all items on the current page are hidden (only works when "Hide Cached Items" is enabled)
9. **Clear Cache**: Click "Clear Cache" to remove all cached prices if needed

## How It Works

The script extracts product ASINs from Vine item links, checks a local cache first, and if not cached, fetches the product page HTML to extract the price. Prices are parsed from multiple CSS selectors to handle different Amazon page layouts. The script uses `GM_xmlhttpRequest` (with localStorage fallback) for cross-origin requests and storage.

## Browser Compatibility

- ✅ Chrome/Edge (with Tampermonkey or Violentmonkey)
- ✅ Firefox (with Tampermonkey, Violentmonkey, or Greasemonkey)
- ✅ Safari (with Tampermonkey or Userscripts)
- ✅ Opera (with Tampermonkey or Violentmonkey)

## Troubleshooting

- **Prices not showing**: Make sure the script is enabled in your userscript manager
- **Settings link not visible**: Check that you're on an Amazon Vine page (`vine.amazon.com` or `amazon.com/vine/*`). The script will automatically add the link when the page loads.
- **Cache not working**: Check browser console for errors (F12)

## Notes

- The script runs on both `vine.amazon.com` and `www.amazon.com/vine/*`
- Prices are cached for 7 days
- Maximum cache size is 1000 items (oldest entries are removed automatically)
- The script uses `GM_xmlhttpRequest` to fetch prices (with localStorage fallback for storage)
- Compatible with userscript managers that don't support all GM APIs (automatic fallbacks included)
- Settings are stored locally using GM storage API or localStorage as fallback
