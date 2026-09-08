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
          reasons: ['DOM_PARSER'],
          justification: 'Drawing image onto HTML canvas to perform cross-format conversion.'
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
