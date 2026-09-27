import { getFilenameFromUrl } from './helpers.js';
import { getSettings } from './settings.js';
import { resolveLanguage, t } from './i18n.js';

// Track active image conversions to safely manage offscreen document lifecycle
let activeConversionsCount = 0;
let isOffscreenCreating = null; // Promise lock for offscreen creation to avoid race conditions
let offscreenCloseTimeoutId = null; // 30s idle timer to keep offscreen warm for consecutive saves

// Setup context menus safely when extension is installed or reloaded
chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  const lang = resolveLanguage(settings.language);
  setupContextMenus(lang);
});

// Update context menus dynamically when language preference changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (changes.language) {
    const newLang = resolveLanguage(changes.language.newValue);
    setupContextMenus(newLang);
  }
});

/**
 * Creates or updates the right-click context menu in the active language.
 * 
 * @param {'tr' | 'en'} lang
 */
function setupContextMenus(lang) {
  chrome.contextMenus.removeAll(() => {
    // Parent menu
    chrome.contextMenus.create({
      id: 'save-as-image',
      title: t('menuParent', lang),
      contexts: ['image']
    });

    // Submenu options
    chrome.contextMenus.create({
      id: 'save-as-jpg',
      parentId: 'save-as-image',
      title: t('menuJpg', lang),
      contexts: ['image']
    });

    chrome.contextMenus.create({
      id: 'save-as-png',
      parentId: 'save-as-image',
      title: t('menuPng', lang),
      contexts: ['image']
    });

    chrome.contextMenus.create({
      id: 'save-as-webp',
      parentId: 'save-as-image',
      title: t('menuWebp', lang),
      contexts: ['image']
    });

    chrome.contextMenus.create({
      id: 'copy-to-clipboard',
      parentId: 'save-as-image',
      title: t('menuCopy', lang),
      contexts: ['image']
    });

    console.log(`Save as Image context menus initialized for language: ${lang}`);
  });
}

// Listen for context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuItemId = info.menuItemId;
  
  if (['save-as-jpg', 'save-as-png', 'save-as-webp'].includes(menuItemId)) {
    let format = 'png';
    if (menuItemId === 'save-as-jpg') format = 'jpeg';
    if (menuItemId === 'save-as-webp') format = 'webp';

    const srcUrl = info.srcUrl;
    console.log(`Conversion initiated. Target format: ${format}, Source URL: ${srcUrl}`);

    // Load active user preferences
    const settings = await getSettings();
    const lang = resolveLanguage(settings.language);

    try {
      activeConversionsCount++;
      cancelOffscreenClose(); // Keep document active while in use

      // 1. Show starting notification if enabled
      if (settings.showStartNotification) {
        showNotification(
          'conversion-start',
          t('notifStartTitle', lang),
          t('notifStartBody', lang),
          0
        );
      }

      // 2. Fetch the image directly in the service worker context with timeout and credential fallback
      console.log(`Fetching image: ${srcUrl}`);
      let blob = await fetchWithTimeoutAndFallback(srcUrl, lang);
      
      // Safety check: Reject only explicit non-image MIME types (HTML error pages, JSON, XML)
      const nonImageTypes = ['text/html', 'text/plain', 'application/json', 'application/xml', 'text/xml'];
      if (blob.type && nonImageTypes.includes(blob.type.toLowerCase())) {
        throw new Error(t('errNotAnImage', lang, { type: blob.type }));
      }

      // Convert Blob to Data URL using FileReader in Service Worker
      console.log('Converting blob to data URL...');
      const sourceDataUrl = await blobToDataURL(blob);

      // 3. Open offscreen document with timeout protection (or reuse existing)
      await ensureOffscreenDocumentWithTimeout();

      // Determine compression quality based on format and user settings
      let targetQuality = 0.95;
      if (format === 'jpeg') {
        targetQuality = (settings.qualityJpg || 95) / 100;
      } else if (format === 'webp') {
        targetQuality = (settings.qualityWebp || 95) / 100;
      }

      // 4. Send conversion request with retry mechanism to offscreen document
      console.log(`Sending data URL to offscreen canvas (Quality: ${targetQuality}, Bg: ${settings.jpgBgColor})...`);
      const response = await sendMessageWithRetry({
        type: 'convert-image',
        sourceDataUrl: sourceDataUrl,
        format: format,
        quality: targetQuality,
        backgroundColor: settings.jpgBgColor || '#ffffff',
        lang: lang
      }, 10, 100, lang);

      if (response && response.success) {
        // Clear starting notification as soon as conversion succeeds
        chrome.notifications.clear('conversion-start');

        // 5. Generate clean filename
        let filename = getFilenameFromUrl(srcUrl, format);

        // Prepend custom subfolder if configured (sanitizing directory traversal)
        if (settings.downloadSubfolder && settings.downloadSubfolder.trim()) {
          const cleanFolder = settings.downloadSubfolder
            .trim()
            .replace(/\.\.+/g, '') // remove directory traversal
            .replace(/[<>:"|?*\\]/g, '')
            .replace(/^\/+|\/+$/g, '')
            .replace(/\/+/g, '/'); // collapse consecutive slashes
            
          if (cleanFolder) {
            filename = `${cleanFolder}/${filename}`;
          }
        }

        console.log(`Conversion successful. Starting download: ${filename}`);

        // 6. Download the file using returned self-contained Data URL
        await chrome.downloads.download({
          url: response.dataUrl,
          filename: filename,
          conflictAction: 'uniquify'
        });

        // 7. Show success notification if enabled (auto-clears after 4 seconds)
        if (settings.showSuccessNotification) {
          const displayFileName = filename.includes('/') ? filename.substring(filename.lastIndexOf('/') + 1) : filename;
          showNotification(
            'conversion-success',
            t('notifSuccessTitle', lang),
            t('notifSuccessBody', lang, { name: displayFileName }),
            4000
          );
        }
      } else {
        throw new Error(response ? response.error : t('errOffscreenResponse', lang));
      }
    } catch (error) {
      console.error('Failed to convert and download image:', error);
      // Clear starting notification on error
      chrome.notifications.clear('conversion-start');

      // Show failure notification if enabled (auto-clears after 6 seconds)
      if (settings.showErrorNotification) {
        showNotification(
          'conversion-error',
          t('notifErrorTitle', lang),
          error.message || t('notifGenericError', lang),
          6000
        );
      }
    } finally {
      activeConversionsCount = Math.max(0, activeConversionsCount - 1);
      // Schedule offscreen document closure after 30 seconds of inactivity to keep it warm for consecutive saves
      if (activeConversionsCount === 0) {
        scheduleOffscreenClose();
      }
    }
  }

  // Handle Copy to Clipboard (converts image to PNG and writes directly to clipboard without downloading)
  if (menuItemId === 'copy-to-clipboard') {
    const srcUrl = info.srcUrl;
    console.log(`Copy to clipboard initiated for: ${srcUrl}`);

    const settings = await getSettings();
    const lang = resolveLanguage(settings.language);

    try {
      activeConversionsCount++;
      cancelOffscreenClose();

      // Show starting notification if enabled
      if (settings.showStartNotification) {
        showNotification(
          'conversion-start',
          t('notifStartTitle', lang),
          t('notifStartBody', lang),
          0
        );
      }

      console.log(`Fetching image for clipboard: ${srcUrl}`);
      const blob = await fetchWithTimeoutAndFallback(srcUrl, lang);

      const nonImageTypes = ['text/html', 'text/plain', 'application/json', 'application/xml', 'text/xml'];
      if (blob.type && nonImageTypes.includes(blob.type.toLowerCase())) {
        throw new Error(t('errNotAnImage', lang, { type: blob.type }));
      }

      const sourceDataUrl = await blobToDataURL(blob);
      await ensureOffscreenDocumentWithTimeout();

      // Convert to clean PNG Data URL for system clipboard
      const convertResponse = await sendMessageWithRetry({
        type: 'convert-image',
        sourceDataUrl: sourceDataUrl,
        format: 'png',
        quality: 1.0,
        backgroundColor: '#ffffff',
        lang: lang
      }, 10, 100, lang);

      if (!convertResponse || !convertResponse.success) {
        throw new Error(convertResponse ? convertResponse.error : t('errOffscreenResponse', lang));
      }

      const pngDataUrl = convertResponse.dataUrl;

      // Primary attempt: copy via offscreen document
      let copied = false;
      try {
        const offscreenCopyRes = await sendMessageWithRetry({
          type: 'copy-to-clipboard',
          dataUrl: pngDataUrl
        }, 5, 100, lang);
        if (offscreenCopyRes && offscreenCopyRes.success) {
          copied = true;
        }
      } catch (offErr) {
        console.warn('Offscreen direct copy failed, attempting tab execution fallback:', offErr);
      }

      // Secondary attempt: execute script in active tab where document has user focus
      if (!copied && tab && tab.id && chrome.scripting) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (dataUrl) => {
              try {
                try { window.focus(); } catch (f) { /* ignore */ }
                const res = await fetch(dataUrl);
                const b = await res.blob();
                if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
                  const item = new ClipboardItem({ 'image/png': b });
                  await navigator.clipboard.write([item]);
                  return { success: true };
                }
              } catch (e) {
                // Secondary fallback: image element selection copy
                try {
                  const img = document.createElement('img');
                  img.src = dataUrl;
                  const div = document.createElement('div');
                  div.contentEditable = 'true';
                  div.style.position = 'fixed';
                  div.style.left = '-9999px';
                  div.appendChild(img);
                  document.body.appendChild(div);
                  const range = document.createRange();
                  range.selectNode(img);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                  const ok = document.execCommand('copy');
                  div.remove();
                  if (ok) return { success: true };
                } catch (e2) {
                  /* ignore fallback error */
                }
                return { success: false, error: e.message };
              }
              return { success: false, error: 'Clipboard API not supported in tab' };
            },
            args: [pngDataUrl]
          });

          if (results && results[0] && results[0].result && results[0].result.success) {
            copied = true;
          } else if (results && results[0] && results[0].result && results[0].result.error) {
            console.warn('Tab executeScript clipboard write returned error:', results[0].result.error);
          }
        } catch (scriptErr) {
          console.warn('Tab executeScript failed:', scriptErr);
        }
      }

      if (!copied) {
        throw new Error(t('errClipboardCopy', lang));
      }

      // Clear start notification as soon as copy succeeds
      chrome.notifications.clear('conversion-start');

      // Show success notification if enabled (auto-clears after 4 seconds)
      if (settings.showSuccessNotification) {
        showNotification(
          'copy-success',
          t('notifCopySuccessTitle', lang),
          t('notifCopySuccessBody', lang),
          4000
        );
      }
    } catch (error) {
      console.error('Failed to copy image to clipboard:', error);
      chrome.notifications.clear('conversion-start');

      if (settings.showErrorNotification) {
        showNotification(
          'conversion-error',
          t('notifErrorTitle', lang),
          error.message || t('notifGenericError', lang),
          6000
        );
      }
    } finally {
      activeConversionsCount = Math.max(0, activeConversionsCount - 1);
      if (activeConversionsCount === 0) {
        scheduleOffscreenClose();
      }
    }
  }
});

/**
 * Converts a Blob to a Base64 Data URL using FileReader.
 */
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Data URL conversion failed.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Robust fetch utility with abort timeout and CORS/credential fallbacks.
 */
async function fetchWithTimeoutAndFallback(url, lang = 'en', timeoutMs = 8000) {
  // Direct Data URLs need no special fetch options
  if (url.startsWith('data:')) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      return await response.blob();
    } catch (err) {
      clearTimeout(timeoutId);
      throw new Error(t('errDataUrl', lang, { err: err.message }));
    }
  }

  // Blob URLs from pages cannot be fetched in Service Worker context directly
  if (url.startsWith('blob:')) {
    throw new Error(t('errBlobUrl', lang));
  }

  // Attempt 1: Fetch with credentials (handles private/session images)
  const controller1 = new AbortController();
  const timeoutId1 = setTimeout(() => controller1.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { 
      credentials: 'include',
      signal: controller1.signal 
    });
    
    clearTimeout(timeoutId1);
    
    if (response.ok) {
      return await response.blob();
    }
    // If not found, fail immediately without useless retry
    if (response.status === 404) {
      throw new Error(t('errNotFound', lang));
    }
    throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    clearTimeout(timeoutId1);
    
    // If 404, re-throw immediately
    if (err.message && err.message.includes('404')) {
      throw err;
    }

    console.warn('Fetch with credentials failed. Retrying without credentials...', err);
    
    // Attempt 2: Fallback to standard fetch (handles public CDNs with wildcard ACAO headers)
    const controller2 = new AbortController();
    const timeoutId2 = setTimeout(() => controller2.abort(), timeoutMs);
    
    try {
      const response = await fetch(url, { 
        signal: controller2.signal 
      });
      
      clearTimeout(timeoutId2);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.blob();
    } catch (fallbackErr) {
      clearTimeout(timeoutId2);
      throw new Error(`CORS / Network Error: ${fallbackErr.message || fallbackErr}`);
    }
  }
}

/**
 * Sends a message with a robust retry mechanism to handle document initialization lag.
 */
async function sendMessageWithRetry(message, maxRetries = 10, delayMs = 100, lang = 'en') {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      return response;
    } catch (err) {
      const isConnectionError = err.message && (
        err.message.includes("Could not establish connection") || 
        err.message.includes("Receiving end does not exist")
      );
      if (isConnectionError) {
        console.log(`Offscreen document loading... Retrying in ${delayMs}ms (Attempt ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw new Error(t('errOffscreenConnect', lang));
}

/**
 * Ensures that the offscreen document is created and active.
 */
async function ensureOffscreenDocumentWithTimeout(timeoutMs = 4000) {
  if (isOffscreenCreating) {
    await isOffscreenCreating;
    return;
  }

  // Check if context is already open (Chrome 116+)
  if (chrome.runtime.getContexts) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existingContexts && existingContexts.length > 0) {
      return;
    }
  }

  // Lock creation to prevent race conditions
  const createPromise = (async () => {
    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('Offscreen creation timeout (4s).'));
      }, timeoutMs);
    });

    try {
      await Promise.race([
        chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['DOM_PARSER', 'CLIPBOARD'],
          justification: 'Drawing image onto HTML canvas and interacting with clipboard.'
        }),
        timeoutPromise
      ]);
    } catch (err) {
      // If it already exists, ignore error
      if (err.message && err.message.includes('Only one offscreen document may be created')) {
        return;
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  })();

  isOffscreenCreating = createPromise;

  try {
    await createPromise;
  } finally {
    isOffscreenCreating = null;
  }
}

/**
 * Schedules closing of the offscreen document after 30 seconds of inactivity.
 */
function scheduleOffscreenClose(delayMs = 30000) {
  cancelOffscreenClose();
  offscreenCloseTimeoutId = setTimeout(async () => {
    if (activeConversionsCount === 0) {
      await closeOffscreenDocument();
    }
  }, delayMs);
}

/**
 * Cancels any pending offscreen closure.
 */
function cancelOffscreenClose() {
  if (offscreenCloseTimeoutId) {
    clearTimeout(offscreenCloseTimeoutId);
    offscreenCloseTimeoutId = null;
  }
}

/**
 * Safely closes the offscreen document.
 */
async function closeOffscreenDocument() {
  try {
    if (chrome.runtime.getContexts) {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });
      if (!existingContexts || existingContexts.length === 0) return;
    }

    console.log('Closing idle offscreen document to free memory...');
    await chrome.offscreen.closeDocument();
  } catch (err) {
    if (!err.message || !err.message.includes('No current offscreen document')) {
      console.warn('Notice while closing offscreen document:', err);
    }
  }
}

/**
 * Utility to display system notifications with optional auto-dismiss timer.
 */
function showNotification(id, title, message, autoClearMs = 4000) {
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: title,
      message: message,
      priority: 0
    }, (createdId) => {
      if (autoClearMs > 0 && createdId) {
        setTimeout(() => {
          chrome.notifications.clear(createdId);
        }, autoClearMs);
      }
    });
  } catch (err) {
    console.error('Notification failed to show:', err);
  }
}
