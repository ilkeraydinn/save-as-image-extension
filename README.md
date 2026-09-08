# Save as Image - Chrome Extension (v1.4.0)

A modern, high-performance Google Chrome browser extension (Manifest V3) that allows you to easily convert and save any image on the web to **JPG**, **PNG**, or **WEBP** format directly from the right-click context menu, with full customization via a sleek neon settings popup.

Now with full **Bilingual Support (English 🇬🇧 & Turkish 🇹🇷)**!

---

## 🎨 Premium App Icon & Modern Neon UI
The extension features a custom AI-designed 3D glassmorphic neon camera lens icon and a matching dark/glassmorphic popup settings panel, providing an intuitive, polished user experience.

---

## ✨ Features

*   **Multi-Format Conversion:** Convert and save any web image to JPG, PNG, or WEBP with a single click from the context menu.
*   **🌍 Bilingual Support (EN & TR):** Switch seamlessly between English and Turkish directly from the popup header `[ TR | EN ]`. All UI labels, right-click context menus, and desktop notifications adapt immediately!
*   **🎛️ Interactive Settings Popup:** Access quick settings directly from the Chrome extensions toolbar:
    *   **Customizable Image Quality:** Independent sliders for JPG and WEBP compression (50% to 100%).
    *   **Smart Transparency Color Picker:** Choose background fill color (default `#FFFFFF`, black, or custom hex) when converting transparent PNG or WEBP images to JPG.
    *   **Download Subfolder:** Specify an optional subfolder within your `Downloads` directory (e.g. `Downloads/Images/`).
    *   **Granular Notifications Control:** Toggle Start, Success, and Error desktop notifications independently.
    *   **One-Click Reset:** Quickly revert all settings back to recommended defaults.
*   **⚡ Ultra-Low Resource Usage (0 MB Idle RAM):** Built with MV3 Service Worker architecture. Automatically hibernates when not in use. Offscreen canvas document shuts down after 30 seconds of inactivity to keep RAM footprint minimal.
*   **Original Filename Preservation:** Intelligently extracts and sanitizes the original filename from the image URL, stripping illegal characters (e.g. `< > : " / \ | ? *` for Windows compatibility) and appending the correct new extension.
*   **Modern Manifest V3 Architecture:** Built using the recommended **Offscreen Document API** to handle HTML5 Canvas operations securely without blocking the main background service worker.
*   **Full CORS & Authentication Support:** Bypasses CORS limitations using extension host privileges (`host_permissions`) and includes active session cookies (`credentials: 'include'`) to allow downloads of authenticated images behind logins.
*   **Persistent Configuration:** Automatically saves and synchronizes your preferences across browser sessions using `chrome.storage.sync` (with local storage fallback).

---

## 📂 Folder Structure

```text
save-as-image-extension/
├── manifest.json       # Extension configuration, permissions, and service worker definitions
├── background.js       # Context menus management, network fetching, and offscreen coordination
├── helpers.js          # Filename parsing and Windows sanitization utilities
├── settings.js         # Settings schema, defaults, and chrome.storage sync helpers
├── i18n.js             # Bilingual (English & Turkish) translation dictionary and helpers
├── popup.html          # Extension settings popup UI with language switcher
├── popup.css           # Glassmorphic neon stylesheet for settings
├── popup.js            # Settings UI controller, language switcher, and auto-save handler
├── offscreen.html      # HTML container for the offscreen canvas element
├── offscreen.js        # Canvas drawing, dynamic quality, and format conversion script
├── icon16.png          # Extension icon (16x16 pixels)
├── icon48.png          # Extension icon (48x48 pixels)
├── icon128.png         # Extension icon (128x128 pixels)
└── .gitignore          # Git exclusion file for clean repositories
```

---

## 🚀 Installation Guide

To load the extension locally in your Google Chrome browser:

1.  Open **Google Chrome**.
2.  Navigate to `chrome://extensions/` by typing it into the address bar and hitting Enter (or via the top-right menu -> Extensions -> Manage Extensions).
3.  Enable **"Developer mode"** by toggling the switch in the top-right corner of the page.
4.  Click the **"Load unpacked"** button in the top-left corner.
5.  Select this project directory (`save-as-image-extension`).
6.  The extension is now installed! You will see the 3D neon logo in your extensions toolbar.

---

## 🛠️ How to Use

1.  **Configure Preferences & Language:** Click the "Save as Image" icon in your browser toolbar to open the settings popup. Switch between **TR** and **EN**, adjust image quality, transparency background color, or notification preferences.
2.  **Save Any Web Image:**
    *   Navigate to any website.
    *   **Right-click** on any image.
    *   Hover over **"Save as Image"** (or **"Görseli Farklı Kaydet"** in TR) in the context menu.
    *   Select your desired format (**JPG**, **PNG**, or **WEBP**).
3.  Your converted image is automatically processed and downloaded to your `Downloads` directory (or configured subfolder).
