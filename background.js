import { getFilenameFromUrl, sanitizeSubfolder } from './helpers.js';
import { getSettings } from './settings.js';
import { resolveLanguage, t } from './i18n.js';

// Track active image conversions to safely manage offscreen document lifecycle
let activeConversionsCount = 0;
let isOffscreenCreating = null; // Promise lock for offscreen creation to avoid race conditions
let offscreenCloseTimeoutId = null; // 30s idle timer to keep offscreen warm for consecutive saves

// Track context menu state to prevent duplicate creation race conditions
let currentMenuLang = null;
let menuSetupChain = Promise.resolve();

// Setup context menus safely when extension is installed or reloaded
chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  const lang = resolveLanguage(settings.language);
  setupContextMenus(lang, true);
});

// Update context menus dynamically when language preference changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (changes.language) {
    const newLang = resolveLanguage(changes.language.newValue);
    setupContextMenus(newLang, false);
  }
});

/**
 * Creates or updates the right-click context menu in the active language.
 * Serialized and deduplicated to prevent duplicate menu ID errors when sync & local storage both fire.
 * 
 * @param {'tr' | 'en'} lang
 * @param {boolean} [force=false]
 */
function setupContextMenus(lang, force = false) {
  if (!force && currentMenuLang === lang) {
    return;
  }
  currentMenuLang = lang;

  menuSetupChain = menuSetupChain.then(() => new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      // Ignore any runtime.lastError from removeAll
      void chrome.runtime.lastError;

      const items = [
        {
          id: 'save-as-image',
          title: t('menuParent', lang),
          contexts: ['image']
        },
        {
          id: 'save-as-jpg',
          parentId: 'save-as-image',
          title: t('menuJpg', lang),
          contexts: ['image']
        },
        {
          id: 'save-as-png',
          parentId: 'save-as-image',
          title: t('menuPng', lang),
          contexts: ['image']
        },
        {
          id: 'save-as-webp',
          parentId: 'save-as-image',
          title: t('menuWebp', lang),
          contexts: ['image']
        },
        {
          id: 'copy-to-clipboard',
          parentId: 'save-as-image',
          title: t('menuCopy', lang),
          contexts: ['image']
        }
      ];

      for (const item of items) {
        chrome.contextMenus.create(item, () => {
          void chrome.runtime.lastError;
        });
      }

      console.log(`Save as Image context menus initialized for language: ${lang}`);
      resolve();
    });
  }));
}

// Listen for context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuItemId = info.menuItemId;
  const isSaveAction = ['save-as-jpg', 'save-as-png', 'save-as-webp'].includes(menuItemId);
  const isCopyAction = menuItemId === 'copy-to-clipboard';

  if (!isSaveAction && !isCopyAction) {
    return;
  }

  let format = 'png';
  if (menuItemId === 'save-as-jpg') format = 'jpeg';
  if (menuItemId === 'save-as-webp') format = 'webp';

  const srcUrl = info.srcUrl;
  console.log(`Action initiated (${menuItemId}). Target format: ${format}, Source URL: ${srcUrl}`);

  const settings = await getSettings();
  const lang = resolveLanguage(settings.language);

  try {
    activeConversionsCount++;
    cancelOffscreenClose(); // Keep document active while in use

    // 1. Fetch the image and convert to Data URL (supports http/https, data:, and tab/frame-scoped blob: URLs)
    console.log(`Fetching image: ${srcUrl}`);
    const sourceDataUrl = await fetchImageAsDataUrl(srcUrl, tab, info.frameId, lang);

    // Fast-path: If target format is PNG and source is already a valid PNG, skip Offscreen Canvas re-encoding
    const isAlreadyPng = /^data:image\/png[;,]/i.test(sourceDataUrl);
    let finalOutputUrl = null;

    if (format === 'png' && isAlreadyPng) {
      console.log('Source image is already PNG. Skipping Canvas re-encoding for optimal speed and lossless quality.');
      finalOutputUrl = sourceDataUrl;
    } else {
      // 2. Open offscreen document with timeout protection (or reuse existing)
      await ensureOffscreenDocumentWithTimeout();

      // Determine compression quality based on format and user settings
      let targetQuality = 1.0;
      if (isSaveAction) {
        if (format === 'jpeg') {
          targetQuality = (settings.qualityJpg || 95) / 100;
        } else if (format === 'webp') {
          targetQuality = (settings.qualityWebp || 95) / 100;
        } else {
          targetQuality = 0.95;
        }
      }

      // 3. Send conversion request with retry mechanism to offscreen document
      // Request lightweight 'blobUrl' for downloads to avoid 2nd Base64 encoding & IPC overhead
      const returnType = isSaveAction ? 'blobUrl' : 'dataUrl';
      console.log(`Sending data URL to offscreen canvas (Format: ${format}, Quality: ${targetQuality}, Return: ${returnType})...`);
      const response = await sendMessageWithRetry({
        type: 'convert-image',
        sourceDataUrl: sourceDataUrl,
        format: format,
        quality: targetQuality,
        backgroundColor: settings.jpgBgColor || '#ffffff',
        returnType: returnType,
        lang: lang
      }, 10, 100, lang);

      if (!response || !response.success) {
        throw new Error(response ? response.error : t('errOffscreenResponse', lang));
      }

      finalOutputUrl = response.dataUrl;
    }

    if (isSaveAction) {
      // 4A. Generate clean filename and prepend optional subfolder
      let filename = getFilenameFromUrl(srcUrl, format);
      const cleanFolder = sanitizeSubfolder(settings.downloadSubfolder);
      if (cleanFolder) {
        filename = `${cleanFolder}/${filename}`;
      }

      console.log(`Starting download: ${filename}`);

      await chrome.downloads.download({
        url: finalOutputUrl,
        filename: filename,
        conflictAction: 'uniquify'
      });

      // Revoke temporary offscreen Object URL after download stream has started
      if (finalOutputUrl && finalOutputUrl.startsWith('blob:')) {
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'revoke-blob-url', blobUrl: finalOutputUrl }).catch(() => {});
        }, 10000);
      }
    } else if (isCopyAction) {
      // 4B. Copy PNG Data URL to system clipboard
      await copyPngDataUrlToClipboard(finalOutputUrl, tab, lang);
      console.log('Image copied to clipboard successfully.');
    }
  } catch (error) {
    console.error(`Failed to execute ${menuItemId}:`, error);
  } finally {
    activeConversionsCount = Math.max(0, activeConversionsCount - 1);
    if (activeConversionsCount === 0) {
      scheduleOffscreenClose();
    }
  }
});

/**
 * Copies a PNG Data URL to the system clipboard, preferring focused tab execution and falling back to offscreen.
 */
async function copyPngDataUrlToClipboard(pngDataUrl, tab, lang) {
  let copied = false;

  // Primary attempt: execute script in active tab where document has user focus (required by navigator.clipboard.write)
  if (tab && tab.id && chrome.scripting) {
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
            // Fallback inside tab: wait for image element to decode before running execCommand('copy')
            try {
              const ok = await new Promise((resolve) => {
                const div = document.createElement('div');
                div.contentEditable = 'true';
                div.style.position = 'fixed';
                div.style.left = '-9999px';
                div.style.top = '0';
                div.style.opacity = '0';
                const img = document.createElement('img');
                img.onload = () => {
                  document.body.appendChild(div);
                  const range = document.createRange();
                  range.selectNode(img);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                  const copiedOk = document.execCommand('copy');
                  sel.removeAllRanges();
                  div.remove();
                  resolve(copiedOk);
                };
                img.onerror = () => resolve(false);
                div.appendChild(img);
                img.src = dataUrl;
              });
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
        console.warn('Tab executeScript clipboard write returned error, falling back to offscreen:', results[0].result.error);
      }
    } catch (scriptErr) {
      console.warn('Tab executeScript unavailable, falling back to offscreen copy:', scriptErr);
    }
  }

  // Secondary attempt: copy via offscreen document (uses DOM selection + execCommand('copy') with CLIPBOARD permission)
  if (!copied) {
    try {
      await ensureOffscreenDocumentWithTimeout();
      const offscreenCopyRes = await sendMessageWithRetry({
        type: 'copy-to-clipboard',
        dataUrl: pngDataUrl
      }, 5, 100, lang);
      if (offscreenCopyRes && offscreenCopyRes.success) {
        copied = true;
      }
    } catch (offErr) {
      console.warn('Offscreen copy fallback failed:', offErr);
    }
  }

  if (!copied) {
    throw new Error(t('errClipboardCopy', lang));
  }
}

/**
 * Fetches an image from a URL (http/https, data:, or page-scoped blob:) and returns a Base64 Data URL.
 */
async function fetchImageAsDataUrl(srcUrl, tab, frameId, lang) {
  if (srcUrl.startsWith('data:')) {
    return srcUrl;
  }

  // Handle page-scoped blob: URLs by reading them inside the origin tab/frame
  if (srcUrl.startsWith('blob:')) {
    const tabDataUrl = await fetchImageViaTabScript(srcUrl, tab, frameId);
    if (tabDataUrl) {
      return tabDataUrl;
    }
    throw new Error(t('errBlobUrl', lang));
  }

  try {
    const blob = await fetchWithTimeoutAndFallback(srcUrl, lang);

    // Safety check: Reject explicit non-image MIME types (HTML error pages, JSON, XML)
    const nonImageTypes = ['text/html', 'text/plain', 'application/json', 'application/xml', 'text/xml'];
    if (blob.type && nonImageTypes.includes(blob.type.toLowerCase())) {
      throw new Error(t('errNotAnImage', lang, { type: blob.type }));
    }

    return await blobToDataURL(blob);
  } catch (fetchErr) {
    // If service worker fetch failed due to hotlink protection (403) or CORS, try fetching inside the tab/frame context
    if (!fetchErr.isNotFound && tab && tab.id) {
      const tabDataUrl = await fetchImageViaTabScript(srcUrl, tab, frameId);
      if (tabDataUrl) {
        return tabDataUrl;
      }
    }
    throw fetchErr;
  }
}

/**
 * Attempts to fetch an image URL (such as a blob: URL or Referer-protected image) within the active tab/frame context.
 */
async function fetchImageViaTabScript(url, tab, frameId) {
  if (!tab || !tab.id || !chrome.scripting) return null;
  try {
    const target = typeof frameId === 'number' && frameId > 0
      ? { tabId: tab.id, frameIds: [frameId] }
      : { tabId: tab.id };

    const results = await chrome.scripting.executeScript({
      target: target,
      func: async (targetUrl) => {
        try {
          const response = await fetch(targetUrl);
          if (!response.ok) return null;
          const blob = await response.blob();
          const nonImageTypes = ['text/html', 'text/plain', 'application/json', 'application/xml', 'text/xml'];
          if (blob.type && nonImageTypes.includes(blob.type.toLowerCase())) {
            return null;
          }
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('FileReader error'));
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          return null;
        }
      },
      args: [url]
    });
    if (results && results[0] && typeof results[0].result === 'string' && results[0].result.startsWith('data:')) {
      return results[0].result;
    }
  } catch (e) {
    console.warn('In-tab image fetch fallback failed:', e);
  }
  return null;
}

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
      const notFoundErr = new Error(t('errNotFound', lang));
      notFoundErr.isNotFound = true;
      throw notFoundErr;
    }
    throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    clearTimeout(timeoutId1);
    
    // If explicit 404, re-throw immediately
    if (err.isNotFound) {
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
      
      if (response.status === 404) {
        const notFoundErr = new Error(t('errNotFound', lang));
        notFoundErr.isNotFound = true;
        throw notFoundErr;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.blob();
    } catch (fallbackErr) {
      clearTimeout(timeoutId2);
      if (fallbackErr.isNotFound) {
        throw fallbackErr;
      }
      throw new Error(t('errNetwork', lang, { err: fallbackErr.message || String(fallbackErr) }));
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
