# Amazon Vine Price Display - Saved Searches Feature

## Summary of Changes (v1.15)

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
