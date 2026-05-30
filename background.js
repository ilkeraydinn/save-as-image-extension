import { getFilenameFromUrl } from './helpers.js';

// Track active image conversions to safely manage offscreen document lifecycle
let activeConversionsCount = 0;
let isOffscreenCreating = null; // Promise lock for offscreen creation to avoid race conditions

// Setup context menus when extension is installed
chrome.runtime.onInstalled.addListener(() => {
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

// Listen for context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuItemId = info.menuItemId;
  
  if (['save-as-jpg', 'save-as-png', 'save-as-webp'].includes(menuItemId)) {
    let format = 'png';
    if (menuItemId === 'save-as-jpg') format = 'jpeg';
    if (menuItemId === 'save-as-webp') format = 'webp';

    const srcUrl = info.srcUrl;
    console.log(`Conversion initiated. Target format: ${format}, Source URL: ${srcUrl}`);

    try {
      activeConversionsCount++;

      // 1. Show starting notification
      showNotification('conversion-start', 'Görsel Hazırlanıyor', 'Görsel indiriliyor ve dönüştürülüyor...');

      // 2. Fetch the image directly in the service worker context with timeout and credential fallback
      console.log(`Fetching image: ${srcUrl}`);
      let blob = await fetchWithTimeoutAndFallback(srcUrl);
      
      // Safety check: Ensure the fetched file is actually an image (e.g. not an HTML error or CAPTCHA page)
      if (!blob.type.startsWith('image/')) {
        throw new Error(`Sunucu görsel yerine desteklenmeyen bir dosya türü döndürdü (Mime: ${blob.type}). Web sitesi görseli doğrudan çekmemizi engelliyor olabilir.`);
      }

      // Convert Blob to Data URL using FileReader in Service Worker.
      // This is highly robust and avoids structured-clone issues with ArrayBuffers in Chrome extension messaging.
      console.log('Converting blob to data URL...');
      const sourceDataUrl = await blobToDataURL(blob);

      // 3. Open offscreen document with timeout protection
      await ensureOffscreenDocumentWithTimeout();

      // 4. Send conversion request with retry mechanism to offscreen document
      console.log('Sending data URL to offscreen canvas...');
      const response = await sendMessageWithRetry({
        type: 'convert-image',
        sourceDataUrl: sourceDataUrl,
        format: format
      });

      if (response && response.success) {
        // 5. Generate a clean filename close to the original
        const filename = getFilenameFromUrl(srcUrl, format);
        console.log(`Conversion successful. Starting download: ${filename}`);

        // 6. Download the file using returned self-contained Data URL
        await chrome.downloads.download({
          url: response.dataUrl,
          filename: filename,
          conflictAction: 'uniquify'
        });

        // 7. Show success notification
        showNotification('conversion-success', 'Görsel İndirildi', `${filename} başarıyla kaydedildi.`);
      } else {
        throw new Error(response ? response.error : 'Dönüştürme modülünden yanıt alınamadı.');
      }
    } catch (error) {
      console.error('Failed to convert and download image:', error);
      // Show failure notification to the user with detailed error
      showNotification('conversion-error', 'Dönüştürme Hatası', error.message || 'Görsel dönüştürülürken bir hata oluştu.');
    } finally {
      activeConversionsCount--;
      // Close offscreen document if no other conversions are actively running
      if (activeConversionsCount === 0) {
        await closeOffscreenDocument();
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
      throw new Error(`Data URL okunurken hata: ${err.message}`);
    }
  }

  // Attempt 1: Fetch with credentials (handles private/session images)
  const controller1 = new AbortController();
  const timeoutId1 = setTimeout(() => controller1.abort(), timeoutMs);
  
  try {
    console.log('Attempting fetch with credentials...');
    const response = await fetch(url, { 
      credentials: 'include',
      signal: controller1.signal 
    });
    
    clearTimeout(timeoutId1);
    
    if (response.ok) {
      return await response.blob();
    }
    throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    clearTimeout(timeoutId1);
    console.warn('Fetch with credentials failed. Retrying without credentials...', err);
    
    // Attempt 2: Fallback to standard fetch (handles public CDNs with wildcard ACAO headers)
    const controller2 = new AbortController();
    const timeoutId2 = setTimeout(() => controller2.abort(), timeoutMs);
    
    try {
      console.log('Attempting fallback fetch without credentials...');
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
      const isConnectionError = err.message.includes("Could not establish connection") || 
                              err.message.includes("Receiving end does not exist");
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
 * Employs a safety timeout to prevent indefinite hangs and supports older Chrome versions.
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
    if (existingContexts.length > 0) {
      return;
    }
  }

  // Lock creation to prevent race conditions
  isOffscreenCreating = new Promise(async (resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Offscreen penceresi açılış zaman aşımı (4 saniye).'));
    }, timeoutMs);

    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Drawing image onto HTML canvas to perform cross-format conversion.'
      });
      clearTimeout(timeoutId);
      resolve();
    } catch (err) {
      clearTimeout(timeoutId);
      // If it already exists, ignore error and resolve
      if (err.message && err.message.includes('Only one offscreen document may be created')) {
        resolve();
      } else {
        reject(err);
      }
    }
  });

  try {
    await isOffscreenCreating;
  } finally {
    isOffscreenCreating = null;
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
      if (existingContexts.length === 0) return;
    }

    console.log('Closing offscreen document...');
    await chrome.offscreen.closeDocument();
  } catch (err) {
    console.error('Error closing offscreen document:', err);
  }
}

/**
 * Utility to display standard system notifications.
 */
function showNotification(id, title, message) {
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: title,
      message: message,
      priority: 0
    });
  } catch (err) {
    console.error('Notification failed to show:', err);
  }
}
