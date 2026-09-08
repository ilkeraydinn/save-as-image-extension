import { getFilenameFromUrl } from './helpers.js';
import { getSettings } from './settings.js';

// Track active image conversions to safely manage offscreen document lifecycle
let activeConversionsCount = 0;
let isOffscreenCreating = null; // Promise lock for offscreen creation to avoid race conditions
let offscreenCloseTimeoutId = null; // 30s idle timer to keep offscreen warm for consecutive saves

// Setup context menus safely when extension is installed or reloaded
chrome.runtime.onInstalled.addListener(() => {
  // Clear any existing menus first to prevent duplicate ID errors on reload
  chrome.contextMenus.removeAll(() => {
    // Create parent menu
    chrome.contextMenus.create({
      id: 'save-as-image',
      title: 'Save as Image',
      contexts: ['image']
    });

    // Create child menus for each format
    chrome.contextMenus.create({
      id: 'save-as-jpg',
      parentId: 'save-as-image',
      title: 'JPG',
      contexts: ['image']
    });

    chrome.contextMenus.create({
      id: 'save-as-png',
      parentId: 'save-as-image',
      title: 'PNG',
      contexts: ['image']
    });

    chrome.contextMenus.create({
      id: 'save-as-webp',
      parentId: 'save-as-image',
      title: 'WEBP',
      contexts: ['image']
    });

    console.log('Save as Image context menus initialized.');
  });
});

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

    try {
      activeConversionsCount++;
      cancelOffscreenClose(); // Keep document active while in use

      // 1. Show starting notification if enabled
      if (settings.showStartNotification) {
        showNotification('conversion-start', 'Görsel Hazırlanıyor', 'Görsel indiriliyor ve dönüştürülüyor...', 0);
      }

      // 2. Fetch the image directly in the service worker context with timeout and credential fallback
      console.log(`Fetching image: ${srcUrl}`);
      let blob = await fetchWithTimeoutAndFallback(srcUrl);
      
      // Safety check: Reject only explicit non-image MIME types (HTML error pages, JSON, XML)
      // Allow image/*, application/octet-stream, or empty MIME (common on raw CDNs and S3)
      const nonImageTypes = ['text/html', 'text/plain', 'application/json', 'application/xml', 'text/xml'];
      if (blob.type && nonImageTypes.includes(blob.type.toLowerCase())) {
        throw new Error(`Sunucu görsel yerine web sayfası döndürdü (${blob.type}). Doğrudan erişim engellenmiş veya CAPTCHA sayfası olabilir.`);
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
        backgroundColor: settings.jpgBgColor || '#ffffff'
      });

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
          showNotification('conversion-success', 'Görsel İndirildi', `${displayFileName} başarıyla kaydedildi.`, 4000);
        }
      } else {
        throw new Error(response ? response.error : 'Dönüştürme modülünden yanıt alınamadı.');
      }
    } catch (error) {
      console.error('Failed to convert and download image:', error);
      // Clear starting notification on error
      chrome.notifications.clear('conversion-start');

      // Show failure notification if enabled (auto-clears after 6 seconds)
      if (settings.showErrorNotification) {
        showNotification('conversion-error', 'Dönüştürme Hatası', error.message || 'Görsel dönüştürülürken bir hata oluştu.', 6000);
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
    reader.onerror = () => reject(new Error('Görsel verisi veri adresine dönüştürülemedi.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Robust fetch utility with abort timeout and CORS/credential fallbacks.
 * Prevents hanging fetches and bypasses strict CDN credential policies.
 */
async function fetchWithTimeoutAndFallback(url, timeoutMs = 8000) {
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
      throw new Error(`Data URL okunamadı: ${err.message}`);
    }
  }

  // Blob URLs from pages cannot be fetched in Service Worker context directly
  if (url.startsWith('blob:')) {
    throw new Error('Bu görsel sayfa içi geçici bir bellek nesnesidir (blob URL). Tarayıcı güvenlik kısıtlamaları nedeniyle doğrudan indirilemedi.');
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
      throw new Error('Görsel sunucuda bulunamadı (404 Not Found).');
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
        throw new Error(`Sunucu hata kodu döndürdü: ${response.status} ${response.statusText}`);
      }
      return await response.blob();
    } catch (fallbackErr) {
      clearTimeout(timeoutId2);
      throw new Error(`Görsel indirilemedi (CORS veya Bağlantı Hatası): ${fallbackErr.message || fallbackErr}`);
    }
  }
}

/**
 * Sends a message with a robust retry mechanism to handle document initialization lag.
 */
async function sendMessageWithRetry(message, maxRetries = 10, delayMs = 100) {
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
  throw new Error("Dönüştürme modülü ile bağlantı kurulamadı. Lütfen eklentiyi yenileyip tekrar deneyin.");
}

/**
 * Ensures that the offscreen document is created and active.
 * Employs a safety timeout to prevent indefinite hangs and handles race conditions safely.
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
        reject(new Error('Offscreen penceresi açılış zaman aşımı (4 saniye).'));
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
 * Keeps document warm for consecutive image saves while ensuring no memory leak.
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
    // Ignore already closed errors
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
