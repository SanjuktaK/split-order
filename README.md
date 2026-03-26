# Order Splitter for Splitwise

A Chrome extension that scans your Amazon and Walmart order history pages, lets you annotate each item as **Mine**, **Shared**, or **Roommates**, and exports the result for [Splitwise](https://www.splitwise.com/).

## How It Works

1. Navigate to your order history on Amazon or Walmart.
2. Click the **"Split Orders"** floating button that appears in the top-right corner.
3. The extension scrapes product names, quantities, and prices from the page.
4. Assign each item: Mine, Shared, or Roommates.
5. **Copy Splitwise Text** to paste into Splitwise, or **Download CSV** for a spreadsheet.

## Installation (Developer Mode)

1. Clone this repo.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension/` folder.
5. The extension icon will appear in your toolbar.

## Supported Sites

| Site | Status |
|------|--------|
| Amazon (amazon.com) | Supported |
| Walmart (walmart.com) | Supported |

## Features

- **On-page overlay** — annotate items without leaving the order page
- **Roommate management** — add roommate names in the options page for quick assignment
- **Copy for Splitwise** — generates formatted text ready to paste
- **CSV export** — download a spreadsheet of your split
- **Per-session delete** — hide items you don't want to include (resets on page reload)
- **Local storage only** — no data leaves your browser

## Project Structure

```
extension/
  manifest.json       # Chrome MV3 manifest
  background.js       # Service worker (minimal)
  popup.html/js/css   # Extension popup UI
  options.html/js/css  # Roommate settings page
  content/
    inject.js         # Content script — page scraping + overlay UI
    common.css        # Overlay styles
```

## Limitations

- Scraping is best-effort — Amazon and Walmart change their page layouts periodically, which may require selector updates.
- Amazon uses client-side encryption on some order pages. The extension reads the DOM after decryption, so it works when you can see your orders in the browser.
- Prices may not be captured for every item depending on the page layout.

## License

MIT
