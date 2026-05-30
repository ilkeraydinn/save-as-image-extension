# Save as Image - Chrome Extension

A modern, highly optimized Google Chrome browser extension (Manifest V3) that allows you to easily convert and save any image on the web to **JPG**, **PNG**, or **WEBP** format directly from the right-click context menu.

---

## 🎨 Premium App Icon
The extension features a custom AI-designed 3D glassmorphic neon camera lens and download arrow icon, giving it a sleek and modern look in your Extensions panel and system notification toasts.

---

## ✨ Features

*   **Multi-Format Conversion:** Convert and save any web image to JPG, PNG, or WEBP with a single click.
*   **Smart Transparency Handling:** Automatically adds a clean **white background** when converting transparent PNG or WEBP images to JPG, preventing black backgrounds or artifact issues.
*   **Original Filename Preservation:** Intelligently extracts and sanitizes the original filename from the image URL, stripping illegal characters (e.g. `< > : " / \ | ? *` for Windows compatibility) and appending the correct new extension.
*   **Modern Manifest V3 Architecture:** Built using the recommended **Offscreen Document API** to handle HTML5 Canvas operations securely without blocking the main background service worker.
*   **Full CORS & Authentication Support:** Bypasses CORS limitations using extension host privileges (`host_permissions`) and includes your active session cookies (`credentials: 'include'`) to allow downloads of authenticated or private images behind logins.
*   **Native Desktop Notifications:** Displays beautiful Windows/macOS notification toasts for conversion start, download success, or explicit error details (with safety timeouts to prevent hanging).

---

## 📂 Folder Structure

```text
save-as-image-extension/
├── manifest.json       # Extension configuration, permissions, and service worker definitions
├── background.js       # Context menus management, network fetching, and offscreen coordination
├── helpers.js          # Filename parsing and sanitization utilities
├── offscreen.html      # HTML container for the offscreen canvas element
├── offscreen.js        # Canvas drawing, quality optimization, and format conversion script
├── icon16.png          # Resized extension icon (16x16 pixels)
├── icon48.png          # Resized extension icon (48x48 pixels)
├── icon128.png         # Resized extension icon (128x128 pixels)
└── .gitignore          # Git exclusion file for clean repositories
```

---

## 🚀 Installation Guide

To load the extension locally in your Google Chrome browser:

1.  Open **Google Chrome**.
2.  Navigate to `chrome://extensions/` by typing it into the address bar and hitting Enter (or via the top-right menu -> Extensions -> Manage Extensions).
3.  Enable **"Developer mode"** by toggling the switch in the top-right corner of the page.
4.  Click the **"Load unpacked"** button in the top-left corner.
5.  Select the project directory:
    `C:\Users\ilker\.gemini\antigravity\scratch\save-as-image-extension`
6.  The extension is now installed! You will see the beautiful neon 3D logo in your extensions list.

---

## 🛠️ How to Use

1.  Navigate to any website (e.g., Wikipedia, Unsplash, or Google Images).
2.  **Right-click** on any image you wish to save.
3.  Hover over the **"Save as Image"** context menu option.
4.  Select your desired format (**JPG**, **PNG**, or **WEBP**).
5.  A system notification saying **"Görsel Hazırlanıyor"** (Preparing Image) will appear, and your converted image will be automatically downloaded to your default **Downloads** directory with the correct extension!

---

## 🧠 Technical Under the Hood (How It Works)

1.  **Context Menu Click:** The user clicks a format, and `background.js` (Service Worker) catches the source URL.
2.  **Direct Privilege Fetch:** `background.js` fetches the image directly in the service worker context using extension host permissions to bypass CORS entirely, automatically carrying over your active login sessions if needed.
3.  **Base64 Conversion:** The fetched binary Blob is natively converted to a Base64 Data URL using `FileReader` within the Service Worker. This bypasses Chrome's structured clone message length limitations for large images.
4.  **Offscreen Canvas Conversion:** The Base64 string is sent to `offscreen.html` (Offscreen Document) where it is loaded into an `HTMLImageElement` and drawn onto a `<canvas>`.
    *   *If the target format is JPEG, the canvas is pre-filled with white to handle transparency.*
5.  **Data URL Export & Download:** The canvas exports the new image at **95% High Quality** back to the Service Worker, which triggers `chrome.downloads.download` to automatically save the file. The offscreen document is immediately closed to free up browser memory.
