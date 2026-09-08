# Save as Image

A Google Chrome extension (Manifest V3) that allows you to convert and save images on the web directly as **JPG**, **PNG**, or **WEBP** via the right-click context menu.

---

## Features

- **Context Menu Conversion:** Right-click any image and save it as JPG, PNG, or WEBP.
- **Settings Popup:**
  - Adjust compression quality for JPG and WEBP.
  - Set a background fill color (white, black, or custom) when saving transparent images as JPG.
  - Choose an optional subfolder within your Downloads directory.
  - Toggle desktop notifications (start, success, error).
- **Bilingual Support:** Switch easily between English and Turkish from the popup.
- **Safe Filenames:** Automatically extracts and cleans filenames from URLs, removing illegal characters and preserving the name.
- **Manifest V3:** Uses Chrome's Offscreen Document API for canvas-based conversions without running heavy background scripts.

---

## Installation

1. Clone or download this repository.
2. Open **Google Chrome** and go to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select this folder.

---

## Usage

1. **(Optional)** Click the extension icon in your toolbar to adjust settings (language, quality, folder, etc.).
2. Right-click on any image on a webpage.
3. Hover over **Save as Image** and choose your desired format (**JPG**, **PNG**, or **WEBP**).
4. The converted image will be saved to your Downloads folder.

---

## Project Structure

```text
save-as-image-extension/
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Service worker & context menu handler
├── helpers.js          # Filename parsing and sanitization utilities
├── settings.js         # User settings and storage helpers
├── i18n.js             # English & Turkish translations
├── popup.html          # Settings popup interface
├── popup.css           # Popup styles
├── popup.js            # Popup logic & language switching
├── offscreen.html      # Offscreen canvas container
├── offscreen.js        # Canvas conversion logic
├── icon16.png          # Extension icon (16x16)
├── icon48.png          # Extension icon (48x48)
├── icon128.png         # Extension icon (128x128)
└── .gitignore          # Git ignore file
```
