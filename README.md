# Save as Image - Chrome Extension (v1.3.0)

A modern, highly optimized Google Chrome browser extension (Manifest V3) that allows you to easily convert and save any image on the web to **JPG**, **PNG**, or **WEBP** format directly from the right-click context menu, with full customization via a sleek neon settings popup.

---

## 🎨 Premium App Icon & Modern Neon UI
The extension features a custom AI-designed 3D glassmorphic neon camera lens icon and a matching dark/glassmorphic popup settings panel, providing an intuitive, polished user experience.

---

## ✨ Features

*   **Multi-Format Conversion:** Convert and save any web image to JPG, PNG, or WEBP with a single click from the context menu.
*   **🎛️ Interactive Settings Popup:** Access quick settings directly from the Chrome extensions toolbar:
    *   **Customizable Image Quality:** Independent sliders for JPG and WEBP compression (50% to 100%).
    *   **Smart Transparency Color Picker:** Choose background color (default `#FFFFFF`, black, or custom hex) when converting transparent PNG or WEBP images to JPG.
    *   **Download Subfolder:** Specify an optional subfolder within your `Downloads` directory (e.g. `Downloads/Images/`).
    *   **Granular Notifications Control:** Toggle Start, Success, and Error desktop notifications independently.
    *   **One-Click Reset:** Quickly revert all settings back to recommended defaults.
*   **Original Filename Preservation:** Intelligently extracts and sanitizes the original filename from the image URL, stripping illegal characters (e.g. `< > : " / \ | ? *` for Windows compatibility) and appending the correct new extension.
*   **Modern Manifest V3 Architecture:** Built using the recommended **Offscreen Document API** to handle HTML5 Canvas operations securely without blocking the main background service worker.
*   **Full CORS & Authentication Support:** Bypasses CORS limitations using extension host privileges (`host_permissions`) and includes your active session cookies (`credentials: 'include'`) to allow downloads of authenticated or private images behind logins.
*   **Persistent Configuration:** Automatically saves and synchronizes your preferences across browser sessions using `chrome.storage.sync`.

---

## 📂 Folder Structure

```text
save-as-image-extension/
├── manifest.json       # Extension configuration, permissions, and service worker definitions
├── background.js       # Context menus management, network fetching, and offscreen coordination
├── helpers.js          # Filename parsing and sanitization utilities
├── settings.js         # Settings schema, defaults, and chrome.storage sync helpers
├── popup.html          # Extension settings popup UI
├── popup.css           # Glassmorphic neon stylesheet for settings
├── popup.js            # Settings UI controller and auto-save handler
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

1.  **Configure Preferences (Optional):** Click the "Save as Image" icon in your browser toolbar to open the settings popup and adjust image quality, transparency background color, or notification preferences.
2.  **Save Any Web Image:**
    *   Navigate to any website.
    *   **Right-click** on any image.
    *   Hover over **"Save as Image"** in the context menu.
    *   Select your desired format (**JPG**, **PNG**, or **WEBP**).
3.  Your converted image is automatically processed and downloaded to your `Downloads` directory (or configured subfolder).

---

## 🧠 Technical Under the Hood (How It Works)

1.  **Context Menu Click:** The user clicks a format, and `background.js` (Service Worker) catches the source URL and retrieves the user's active preferences from `chrome.storage.sync`.
2.  **Direct Privilege Fetch:** `background.js` fetches the image directly in the service worker context using extension host permissions to bypass CORS entirely, automatically carrying over active login sessions if needed.
3.  **Base64 Conversion:** The fetched binary Blob is natively converted to a Base64 Data URL using `FileReader` within the Service Worker. This bypasses Chrome's structured clone message length limitations for large images.
4.  **Offscreen Canvas Conversion:** The Base64 string and user parameters (quality, background fill color) are sent to `offscreen.html` (Offscreen Document) where it is loaded into an `HTMLImageElement` and drawn onto a `<canvas>`.
    *   *If the target format is JPEG, the canvas is pre-filled with the user's selected background color.*
5.  **Data URL Export & Download:** The canvas exports the new image at the configured compression quality back to the Service Worker, which triggers `chrome.downloads.download` to automatically save the file. The offscreen document is immediately closed to free up browser memory.
