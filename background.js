import {
  getFilenameFromUrl,
  sanitizeSubfolder,
  sanitizeHexColor,
  isValidImageMimeType,
  detectImageMimeFromBytes,
  isPngBlob,
  formatUrlForLog
} from './helpers.js';
import { getSettings } from './settings.js';
import { resolveLanguage, t } from './i18n.js';

// Thresholds and concurrency limits
const LARGE_SOURCE_THRESHOLD = 10 * 1024 * 1024; // 10 MB source threshold for SW vs Offscreen routing
const LARGE_OUTPUT_THRESHOLD = 15 * 1024 * 1024; // 15 MB output threshold for Data URL vs Blob URL
const MAX_CONCURRENT_CONVERSIONS = 2;
const CONVERSION_TIMEOUT_MS = 15000;
const OFFSCREEN_IDLE_TIMEOUT_MS = 15000;

// Session storage keys
const MENU_LANG_SESSION_KEY = '_menuLang';
const ACTIVE_BLOBS_SESSION_KEY = '_activeDownloadBlobUrls';

// Track active image conversions and serialize offscreen lifecycle operations
let activeConversionsCount = 0;
let offscreenLifecycleLock = Promise.resolve();
let offscreenCloseTimeoutId = null;

// Concurrency queue for Service Worker OffscreenCanvas conversions
let swActiveConversions = 0;
const swConversionQueue = [];

// Incrementing rule ID for temporary DNR Referer session rules
let nextDnrRuleId = 1000;

// Track context menu state to prevent duplicate creation race conditions
let currentMenuLang = null;
let menuSetupChain = Promise.resolve();
let badgeClearTimeoutId = null;

/**
 * Serializes all offscreen creation and closing operations through a single Promise chain.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runWithOffscreenLock(fn) {
  const next = offscreenLifecycleLock.then(fn, fn);
  offscreenLifecycleLock = next.catch(() => {});
  return next;
}

/**
 * Enqueues a Service Worker conversion task so at most MAX_CONCURRENT_CONVERSIONS run in parallel.
 * If a task times out, the caller receives the error immediately while the queue slot waits
 * for the underlying workPromise to finish and release bitmap/canvas memory.
 *
 * @template T
 * @param {(trackWork: (p: Promise<any>) => void) => Promise<T>} taskFn
 * @returns {Promise<T>}
 */
function enqueueSwConversion(taskFn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      swActiveConversions++;
      let backgroundWork = null;
      const trackWork = (promise) => {
        backgroundWork = promise;
      };

      try {
        const result = await taskFn(trackWork);
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        if (backgroundWork) {
          try {
            await backgroundWork;
          } catch (_) {
            // Ignore errors from timed-out work during cleanup wait
          }
        }
        swActiveConversions--;
        if (swConversionQueue.length > 0) {
          const nextTask = swConversionQueue.shift();
          nextTask();
        }
      }
    };

    if (swActiveConversions < MAX_CONCURRENT_CONVERSIONS) {
      run();
    } else {
      swConversionQueue.push(run);
    }
  });
}

/**
 * Reads active language and ensures context menus are up to date.
 * Skips redundant menu recreation on SW wakeup if the language in storage.session matches.
 *
 * @param {boolean} [force=false]
 */
async function initContextMenus(force = false) {
  const settings = await getSettings();
  const lang = resolveLanguage(settings.language);

  if (!force && chrome.storage && chrome.storage.session) {
    try {
      const sessionData = await chrome.storage.session.get(MENU_LANG_SESSION_KEY);
      if (sessionData && sessionData[MENU_LANG_SESSION_KEY] === lang) {
        currentMenuLang = lang;
        return;
      }
    } catch (e) {
      // Fallback to in-memory check if storage.session is unavailable
    }
  }

  setupContextMenus(lang, force);
}

// Setup context menus when extension is installed, updated, or browser starts
chrome.runtime.onInstalled.addListener(() => {
  initContextMenus(true);
});

chrome.runtime.onStartup.addListener(() => {
  clearActionBadge();
  initContextMenus(true);
});

// Ensure menus are synced when the service worker wakes up (no-op if already initialized in session)
initContextMenus(false);

// Clean up any orphaned offscreen document on SW wakeup (serialized via lock so it never races with a click)
Promise.resolve().then(() => {
  if (activeConversionsCount === 0) {
    closeOffscreenDocument();
  }
});

// Update context menus dynamically when language preference changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.language) {
    const newLang = resolveLanguage(changes.language.newValue);
    setupContextMenus(newLang, false);
  }
});

/**
 * Creates or updates the right-click context menu in the active language.
 *
 * @param {'tr' | 'en'} lang
 * @param {boolean} [force=false]
 */
function setupContextMenus(lang, force = false) {
  if (!force && currentMenuLang === lang) {
    return;
  }
  currentMenuLang = lang;

  menuSetupChain = menuSetupChain.then(
    () =>
      new Promise((resolve) => {
        chrome.contextMenus.removeAll(() => {
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

          if (chrome.storage && chrome.storage.session) {
            chrome.storage.session.set({ [MENU_LANG_SESSION_KEY]: lang }).catch(() => {});
          }

          console.log(`Save as Image context menus initialized for language: ${lang}`);
          resolve();
        });
      })
  );
}

/**
 * Tracks active downloadId -> blobUrl mappings in chrome.storage.session so blob URLs
 * are revoked only when the download completes or is interrupted.
 */
async function registerDownloadBlobUrl(downloadId, blobUrl) {
  if (typeof downloadId !== 'number' || !blobUrl || !chrome.storage || !chrome.storage.session) {
    return;
  }
  try {
    const data = await chrome.storage.session.get(ACTIVE_BLOBS_SESSION_KEY);
    const map = (data && data[ACTIVE_BLOBS_SESSION_KEY]) || {};
    map[String(downloadId)] = blobUrl;
    await chrome.storage.session.set({ [ACTIVE_BLOBS_SESSION_KEY]: map });
  } catch (e) {
    console.warn('Failed to store download blobUrl in session:', e);
  }
}

async function popDownloadBlobUrl(downloadId) {
  if (typeof downloadId !== 'number' || !chrome.storage || !chrome.storage.session) {
    return null;
  }
  try {
    const data = await chrome.storage.session.get(ACTIVE_BLOBS_SESSION_KEY);
    const map = (data && data[ACTIVE_BLOBS_SESSION_KEY]) || {};
    const key = String(downloadId);
    const blobUrl = map[key] || null;
    if (blobUrl) {
      delete map[key];
      await chrome.storage.session.set({ [ACTIVE_BLOBS_SESSION_KEY]: map });
    }
    return blobUrl;
  } catch (e) {
    return null;
  }
}

async function hasActiveDownloadBlobUrls() {
  if (!chrome.storage || !chrome.storage.session) {
    return false;
  }
  try {
    const data = await chrome.storage.session.get(ACTIVE_BLOBS_SESSION_KEY);
    const map = (data && data[ACTIVE_BLOBS_SESSION_KEY]) || {};
    return Object.keys(map).length > 0;
  } catch (e) {
    return false;
  }
}

// Top-level listener to revoke offscreen Blob URLs when downloads finish or fail
if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta || !delta.state) return;
    const state = delta.state.current;
    if (state === 'complete' || state === 'interrupted') {
      const blobUrl = await popDownloadBlobUrl(delta.id);
      if (blobUrl) {
        chrome.runtime.sendMessage({ type: 'revoke-blob-url', blobUrl }).catch(() => {});
        if (activeConversionsCount === 0 && !(await hasActiveDownloadBlobUrls())) {
          scheduleOffscreenClose();
        }
      }
    }
  });
}

// Listen for context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuItemId = info.menuItemId;
  const isSaveAction = ['save-as-jpg', 'save-as-png', 'save-as-webp'].includes(menuItemId);
  const isCopyAction = menuItemId === 'copy-to-clipboard';

  if (!isSaveAction && !isCopyAction) {
    return;
  }

  // Clear any leftover badge/title from previous actions
  clearActionBadge();

  let format = 'png';
  if (menuItemId === 'save-as-jpg') format = 'jpeg';
  if (menuItemId === 'save-as-webp') format = 'webp';

  const srcUrl = info.srcUrl;
  console.log(`Action initiated (${menuItemId}). Target format: ${format}, Source URL: ${formatUrlForLog(srcUrl)}`);

  const settings = await getSettings();
  const lang = resolveLanguage(settings.language);
  let cleanupDnr = null;

  try {
    activeConversionsCount++;
    cancelOffscreenClose();

    // 1. Fetch source image as a validated Blob
    console.log(`Fetching image: ${formatUrlForLog(srcUrl)}`);
    const fetchResult = await fetchImageAsBlob(srcUrl, tab, info.frameId, info.pageUrl, lang);
    const sourceBlob = fetchResult.blob;
    const effectiveUrl = fetchResult.effectiveUrl;
    cleanupDnr = fetchResult.cleanupDnr;

    const sniffedMime = fetchResult.sniffedMime;
    const realPng = format === 'png' && (sniffedMime === 'image/png' || (await isPngBlob(sourceBlob)));
    const isSvg =
      sniffedMime === 'image/svg+xml' ||
      sourceBlob.type.split(';')[0].trim().toLowerCase() === 'image/svg+xml' ||
      /^data:image\/svg\+xml[;,]/i.test(effectiveUrl);

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

    const bgColor = sanitizeHexColor(settings.jpgBgColor, '#ffffff');
    const returnType = isSaveAction ? 'blobUrl' : 'dataUrl';
    let finalOutputUrl = null;

    // 2. Route Decision (made before conversion)
    if (realPng && sourceBlob.size <= LARGE_SOURCE_THRESHOLD) {
      // Fast-path: Source is verified by magic bytes to be a real PNG and fits in SW memory
      console.log('Source image verified as PNG via magic bytes. Skipping Canvas re-encoding.');
      const pngBlob = sourceBlob.type === 'image/png' ? sourceBlob : new Blob([sourceBlob], { type: 'image/png' });
      finalOutputUrl = await blobToDataURL(pngBlob);
    } else if (!isSvg && sourceBlob.size <= LARGE_SOURCE_THRESHOLD && typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined') {
      // Primary Route: Convert raster image directly inside Service Worker without opening Offscreen Document
      console.log(`Converting raster image in Service Worker (Format: ${format}, Quality: ${targetQuality})...`);
      const outputBlob = await enqueueSwConversion((trackWork) =>
        convertBlobInServiceWorker(
          sourceBlob,
          format,
          { quality: targetQuality, backgroundColor: bgColor, lang },
          trackWork
        )
      );

      if (isSaveAction && outputBlob.size >= LARGE_OUTPUT_THRESHOLD) {
        // Safety valve: if a compressed source expanded to >= 15MB (e.g. large JPEG -> PNG), delegate to Offscreen for Object URL
        console.log('Converted output >= 15MB; delegating to Offscreen Document for Blob URL...');
        finalOutputUrl = await convertViaOffscreenUrl(effectiveUrl, format, targetQuality, bgColor, 'blobUrl', lang);
      } else {
        finalOutputUrl = await blobToDataURL(outputBlob);
      }
    } else {
      // Offscreen Route: Used for SVGs or large source images (> 10MB)
      console.log(`Routing conversion to Offscreen Document (isSvg: ${isSvg}, size: ${sourceBlob.size} bytes)...`);
      finalOutputUrl = await convertViaOffscreenUrl(effectiveUrl, format, targetQuality, bgColor, returnType, lang);
    }

    // Release temporary DNR Referer rule as soon as fetching/conversion is complete
    if (cleanupDnr) {
      await cleanupDnr();
      cleanupDnr = null;
    }

    if (isSaveAction) {
      // 3A. Generate clean filename and prepend optional subfolder
      let filename = getFilenameFromUrl(srcUrl, format);
      const cleanFolder = sanitizeSubfolder(settings.downloadSubfolder);
      if (cleanFolder) {
        filename = `${cleanFolder}/${filename}`;
      }

      console.log(`Starting download: ${filename}`);

      const downloadId = await chrome.downloads.download({
        url: finalOutputUrl,
        filename: filename,
        conflictAction: 'uniquify'
      });

      if (finalOutputUrl && finalOutputUrl.startsWith('blob:')) {
        await registerDownloadBlobUrl(downloadId, finalOutputUrl);
      }
    } else if (isCopyAction) {
      // 3B. Copy PNG Data URL to system clipboard in active tab
      await copyPngDataUrlToClipboard(finalOutputUrl, tab, lang);
      console.log('Image copied to clipboard successfully.');
      await notifyUser(tab, t('msgCopySuccess', lang), 'success');
    }
  } catch (error) {
    console.error(`Failed to execute ${menuItemId}:`, error);
    const errMsg = (error && error.message) ? error.message : t('errGraphicEngine', lang);
    await notifyUser(tab, errMsg, 'error');
  } finally {
    if (cleanupDnr) {
      try {
        await cleanupDnr();
      } catch (_) {
        // ignore
      }
    }
    activeConversionsCount = Math.max(0, activeConversionsCount - 1);
    if (activeConversionsCount === 0 && !(await hasActiveDownloadBlobUrls())) {
      scheduleOffscreenClose();
    }
  }
});

/**
 * Converts a raster Blob directly inside the Service Worker using createImageBitmap + OffscreenCanvas.
 *
 * @param {Blob} sourceBlob
 * @param {string} format
 * @param {{ quality: number, backgroundColor: string, lang: string }} options
 * @param {(p: Promise<any>) => void} [trackWork]
 * @returns {Promise<Blob>}
 */
async function convertBlobInServiceWorker(sourceBlob, format, options, trackWork) {
  const lang = options.lang || 'en';
  let aborted = false;

  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      aborted = true;
      const err = new Error(t('errTimeout', lang));
      err.isTimeout = true;
      reject(err);
    }, CONVERSION_TIMEOUT_MS);
  });

  const workPromise = (async () => {
    let bitmap = null;
    try {
      try {
        bitmap = await createImageBitmap(sourceBlob);
      } catch (decodeErr) {
        throw new Error(t('errGraphicEngine', lang));
      }

      if (aborted) {
        throw new Error(t('errTimeout', lang));
      }

      const width = bitmap.width;
      const height = bitmap.height;
      if (!width || !height) {
        throw new Error(t('errDimensions', lang));
      }

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error(t('errCanvasContext', lang));
      }

      if (format === 'jpeg') {
        ctx.fillStyle = sanitizeHexColor(options.backgroundColor, '#ffffff');
        ctx.fillRect(0, 0, width, height);
      }

      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      bitmap = null;

      if (aborted) {
        canvas.width = 0;
        canvas.height = 0;
        throw new Error(t('errTimeout', lang));
      }

      let qualityParam = undefined;
      if (format === 'jpeg' || format === 'webp') {
        qualityParam = typeof options.quality === 'number' ? options.quality : 0.95;
      }

      const outputBlob = await canvas.convertToBlob({
        type: `image/${format}`,
        quality: qualityParam
      });

      canvas.width = 0;
      canvas.height = 0;

      if (!outputBlob || outputBlob.size === 0) {
        throw new Error(t('errCanvasLimit', lang));
      }

      return outputBlob;
    } finally {
      if (bitmap) {
        try {
          bitmap.close();
        } catch (_) {
          // ignore
        }
      }
    }
  })();

  if (typeof trackWork === 'function') {
    trackWork(workPromise);
  }

  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Delegates conversion to the Offscreen Document by sending only the URL (not raw image bytes).
 */
async function convertViaOffscreenUrl(srcUrl, format, quality, backgroundColor, returnType, lang) {
  await ensureOffscreenDocumentWithTimeout();
  const response = await sendMessageWithRetry(
    {
      type: 'convert-url',
      srcUrl,
      format,
      quality,
      backgroundColor,
      returnType,
      lang
    },
    10,
    100,
    lang
  );

  if (!response || !response.success) {
    throw new Error(response ? response.error : t('errOffscreenResponse', lang));
  }
  return response.dataUrl;
}

/**
 * Copies a PNG Data URL to the system clipboard in the focused tab using the Async Clipboard API.
 * Does not use execCommand('copy') fallbacks that falsely copy HTML instead of image/png data.
 */
async function copyPngDataUrlToClipboard(pngDataUrl, tab, lang) {
  if (!tab || !tab.id || !chrome.scripting) {
    throw new Error(t('errClipboardCopy', lang));
  }

  let copied = false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (dataUrl) => {
        try {
          try {
            window.focus();
          } catch (_) {
            /* ignore */
          }
          if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
            return { success: false, error: 'ClipboardItem API not supported in tab' };
          }
          const res = await fetch(dataUrl);
          const rawBlob = await res.blob();
          const pngBlob = rawBlob.type === 'image/png' ? rawBlob : new Blob([rawBlob], { type: 'image/png' });
          const item = new ClipboardItem({ 'image/png': pngBlob });
          await navigator.clipboard.write([item]);
          return { success: true };
        } catch (err) {
          return { success: false, error: err.message || String(err) };
        }
      },
      args: [pngDataUrl]
    });

    if (results && results[0] && results[0].result && results[0].result.success) {
      copied = true;
    } else if (results && results[0] && results[0].result && results[0].result.error) {
      console.warn('Tab clipboard write failed:', results[0].result.error);
    }
  } catch (scriptErr) {
    console.warn('Tab executeScript unavailable for clipboard copy:', scriptErr);
  }

  if (!copied) {
    throw new Error(t('errClipboardCopy', lang));
  }
}

/**
 * Clears the extension action badge and resets its tooltip title.
 */
function clearActionBadge() {
  if (badgeClearTimeoutId) {
    clearTimeout(badgeClearTimeoutId);
    badgeClearTimeoutId = null;
  }
  if (chrome.action) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    chrome.action.setTitle({ title: 'Save as Image' }).catch(() => {});
  }
}

/**
 * Provides dual-layer user feedback without requiring the 'notifications' permission:
 * 1. Action badge + tooltip (always works, even on restricted pages)
 * 2. Isolated Shadow DOM toast notification inside the active tab
 *
 * @param {chrome.tabs.Tab | undefined} tab
 * @param {string} message
 * @param {'success' | 'error'} [type='error']
 */
async function notifyUser(tab, message, type = 'error') {
  const isSuccess = type === 'success';

  if (chrome.action) {
    try {
      if (badgeClearTimeoutId) {
        clearTimeout(badgeClearTimeoutId);
      }
      await chrome.action.setBadgeBackgroundColor({
        color: isSuccess ? '#16a34a' : '#dc2626'
      });
      await chrome.action.setBadgeText({
        text: isSuccess ? '✓' : '!'
      });
      await chrome.action.setTitle({
        title: `Save as Image — ${message}`
      });
      badgeClearTimeoutId = setTimeout(() => {
        clearActionBadge();
      }, 3500);
    } catch (_) {
      // ignore badge errors
    }
  }

  if (tab && tab.id && chrome.scripting) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (msg, kind) => {
          try {
            const hostId = 'save-as-image-ext-toast-host';
            const existing = document.getElementById(hostId);
            if (existing) {
              existing.remove();
            }

            const host = document.createElement('div');
            host.id = hostId;
            host.style.cssText = 'all: initial; position: fixed; top: 18px; right: 18px; z-index: 2147483647; pointer-events: none;';

            const shadow = host.attachShadow({ mode: 'closed' });
            const style = document.createElement('style');
            style.textContent = `
              .toast {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                max-width: 360px;
                padding: 10px 14px;
                border-radius: 8px;
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                font-weight: 500;
                line-height: 1.4;
                color: #FBF9F5;
                background: #141413;
                border: 1px solid ${kind === 'success' ? '#22c55e' : '#ef4444'};
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
                opacity: 0;
                transform: translateY(-8px);
                transition: opacity 0.2s ease, transform 0.2s ease;
              }
              .toast.show {
                opacity: 1;
                transform: translateY(0);
              }
              .icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                border-radius: 50%;
                font-size: 11px;
                font-weight: 700;
                flex-shrink: 0;
                background: ${kind === 'success' ? '#16a34a' : '#dc2626'};
                color: #ffffff;
              }
            `;

            const toast = document.createElement('div');
            toast.className = 'toast';

            const icon = document.createElement('span');
            icon.className = 'icon';
            icon.textContent = kind === 'success' ? '✓' : '!';

            const text = document.createElement('span');
            text.textContent = msg;

            toast.appendChild(icon);
            toast.appendChild(text);
            shadow.appendChild(style);
            shadow.appendChild(toast);

            (document.documentElement || document.body).appendChild(host);
            requestAnimationFrame(() => {
              toast.classList.add('show');
            });

            setTimeout(() => {
              toast.classList.remove('show');
              setTimeout(() => host.remove(), 220);
            }, 3200);
          } catch (_) {
            // ignore DOM errors
          }
        },
        args: [message, type]
      });
    } catch (_) {
      // Restricted tab (chrome://, Web Store, PDF viewer); badge fallback already active
    }
  }
}

/**
 * Validates that a fetched Blob has an acceptable image MIME type and does not contain disguised HTML.
 *
 * @param {Blob} blob
 * @param {string} lang
 * @returns {Promise<string | null>} Detected magic-byte MIME type (if any)
 */
async function validateImageBlob(blob, lang) {
  if (!blob || blob.size === 0) {
    throw new Error(t('errGraphicEngine', lang));
  }

  if (!isValidImageMimeType(blob.type)) {
    const cleanType = blob.type.split(';')[0].trim();
    const err = new Error(t('errNotAnImage', lang, { type: cleanType }));
    err.isHotlinkCandidate = true;
    throw err;
  }

  const sniffedMime = await detectImageMimeFromBytes(blob);
  if (sniffedMime === 'text/html') {
    const err = new Error(t('errNotAnImage', lang, { type: 'text/html' }));
    err.isHotlinkCandidate = true;
    throw err;
  }

  return sniffedMime;
}

/**
 * Fetches an image from a URL (http/https, data:, or page-scoped blob:) and returns a validated Blob.
 * Uses DNR Referer injection on hotlink-protected (403 / HTML response) cross-origin images.
 *
 * @param {string} srcUrl
 * @param {chrome.tabs.Tab | undefined} tab
 * @param {number | undefined} frameId
 * @param {string | undefined} pageUrl
 * @param {string} lang
 * @returns {Promise<{ blob: Blob, effectiveUrl: string, sniffedMime: string | null, cleanupDnr: (() => Promise<void>) | null }>}
 */
async function fetchImageAsBlob(srcUrl, tab, frameId, pageUrl, lang) {
  if (srcUrl.startsWith('data:')) {
    let blob;
    try {
      const response = await fetch(srcUrl);
      blob = await response.blob();
    } catch (e) {
      throw new Error(t('errDataUrl', lang, { err: e.message || String(e) }));
    }
    const sniffedMime = await validateImageBlob(blob, lang);
    return { blob, effectiveUrl: srcUrl, sniffedMime, cleanupDnr: null };
  }

  // Handle page-scoped blob: URLs by reading them inside the origin tab/frame
  if (srcUrl.startsWith('blob:')) {
    const tabDataUrl = await fetchImageViaTabScript(srcUrl, tab, frameId);
    if (tabDataUrl) {
      const res = await fetch(tabDataUrl);
      const blob = await res.blob();
      const sniffedMime = await validateImageBlob(blob, lang);
      return { blob, effectiveUrl: tabDataUrl, sniffedMime, cleanupDnr: null };
    }
    throw new Error(t('errBlobUrl', lang));
  }

  try {
    const blob = await fetchWithTimeoutAndFallback(srcUrl, lang);
    const sniffedMime = await validateImageBlob(blob, lang);
    return { blob, effectiveUrl: srcUrl, sniffedMime, cleanupDnr: null };
  } catch (fetchErr) {
    if (fetchErr.isNotFound) {
      throw fetchErr;
    }

    // Fallback 1: Inject page Referer header via temporary DNR session rule for hotlink-protected CDNs
    const refererUrl = pageUrl || (tab && tab.url) || '';
    if (refererUrl && refererUrl.startsWith('http') && chrome.declarativeNetRequest) {
      let dnrRuleId = null;
      try {
        dnrRuleId = await addTemporaryRefererRule(srcUrl, refererUrl);
        const blob = await fetchStreamWithStallTimeout(srcUrl, { credentials: 'include' }, lang);
        const sniffedMime = await validateImageBlob(blob, lang);
        return {
          blob,
          effectiveUrl: srcUrl,
          sniffedMime,
          cleanupDnr: () => removeTemporaryRefererRule(dnrRuleId)
        };
      } catch (dnrErr) {
        if (dnrRuleId !== null) {
          await removeTemporaryRefererRule(dnrRuleId);
        }
        console.warn('DNR Referer retry failed:', dnrErr);
      }
    }

    // Fallback 2: Same-origin in-tab fetch fallback
    if (tab && tab.id) {
      const tabDataUrl = await fetchImageViaTabScript(srcUrl, tab, frameId);
      if (tabDataUrl) {
        const res = await fetch(tabDataUrl);
        const blob = await res.blob();
        const sniffedMime = await validateImageBlob(blob, lang);
        return { blob, effectiveUrl: tabDataUrl, sniffedMime, cleanupDnr: null };
      }
    }

    throw fetchErr;
  }
}

/**
 * Adds a temporary session DNR rule setting the Referer header for SW/Offscreen requests to targetUrl's host.
 *
 * @param {string} targetUrl
 * @param {string} refererUrl
 * @returns {Promise<number>} Rule ID
 */
async function addTemporaryRefererRule(targetUrl, refererUrl) {
  const parsed = new URL(targetUrl);
  const ruleId = nextDnrRuleId++;
  if (nextDnrRuleId > 900000) {
    nextDnrRuleId = 1000;
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 100,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set',
              value: refererUrl
            }
          ]
        },
        condition: {
          requestDomains: [parsed.hostname],
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: ['xmlhttprequest', 'other', 'image']
        }
      }
    ]
  });

  return ruleId;
}

/**
 * Removes a temporary session DNR rule by ID.
 *
 * @param {number} ruleId
 */
async function removeTemporaryRefererRule(ruleId) {
  if (typeof ruleId !== 'number' || !chrome.declarativeNetRequest) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId]
    });
  } catch (e) {
    console.warn(`Failed to remove temporary DNR rule ${ruleId}:`, e);
  }
}

/**
 * Attempts to fetch a page-scoped blob: URL or same-origin image within the active tab/frame context.
 */
async function fetchImageViaTabScript(url, tab, frameId) {
  if (!tab || !tab.id || !chrome.scripting) return null;
  try {
    const target =
      typeof frameId === 'number' && frameId > 0
        ? { tabId: tab.id, frameIds: [frameId] }
        : { tabId: tab.id };

    const results = await chrome.scripting.executeScript({
      target,
      func: async (targetUrl) => {
        try {
          const response = await fetch(targetUrl);
          if (!response.ok) return null;
          const blob = await response.blob();
          const baseType = (blob.type || '').split(';')[0].trim().toLowerCase();
          if (
            baseType &&
            !baseType.startsWith('image/') &&
            baseType !== 'application/octet-stream' &&
            baseType !== 'binary/octet-stream'
          ) {
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
 * Performs a single fetch with an 8s header connection timeout and a 10s per-chunk stream stall timeout.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} lang
 * @param {number} [headerTimeoutMs=8000]
 * @param {number} [stallTimeoutMs=10000]
 * @returns {Promise<Blob>}
 */
async function fetchStreamWithStallTimeout(url, init, lang, headerTimeoutMs = 8000, stallTimeoutMs = 10000) {
  const controller = new AbortController();
  let timerId = setTimeout(() => controller.abort(), headerTimeoutMs);

  const resetStallTimer = () => {
    clearTimeout(timerId);
    timerId = setTimeout(() => controller.abort(), stallTimeoutMs);
  };

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timerId);

    if (response.status === 404) {
      const notFoundErr = new Error(t('errNotFound', lang));
      notFoundErr.isNotFound = true;
      throw notFoundErr;
    }

    if (!response.ok) {
      const httpErr = new Error(`HTTP ${response.status}`);
      httpErr.httpStatus = response.status;
      if (response.status === 401 || response.status === 403) {
        httpErr.isHotlinkCandidate = true;
      }
      throw httpErr;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!isValidImageMimeType(contentType)) {
      const cleanType = contentType.split(';')[0].trim();
      const mimeErr = new Error(t('errNotAnImage', lang, { type: cleanType }));
      mimeErr.isHotlinkCandidate = true;
      mimeErr.noCredentialRetry = true;
      throw mimeErr;
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
      resetStallTimer();
      const blob = await response.blob();
      clearTimeout(timerId);
      return blob;
    }

    const reader = response.body.getReader();
    const chunks = [];
    while (true) {
      resetStallTimer();
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    clearTimeout(timerId);

    const mimeType = contentType.split(';')[0].trim().toLowerCase();
    return new Blob(chunks, mimeType ? { type: mimeType } : undefined);
  } catch (err) {
    clearTimeout(timerId);
    throw err;
  }
}

/**
 * Robust fetch utility with connection + stream stall timeout and selective credential fallback.
 * Retries without credentials only on network TypeError or HTTP 401/403 (skips 404 and 5xx).
 */
async function fetchWithTimeoutAndFallback(url, lang = 'en') {
  try {
    return await fetchStreamWithStallTimeout(url, { credentials: 'include' }, lang);
  } catch (err) {
    if (err.isNotFound || err.noCredentialRetry || (err.httpStatus && err.httpStatus >= 500)) {
      if (err.isNotFound || err.noCredentialRetry) {
        throw err;
      }
      throw new Error(t('errNetwork', lang, { err: err.message || String(err) }));
    }

    const shouldRetryWithoutCredentials =
      err instanceof TypeError || err.httpStatus === 401 || err.httpStatus === 403;

    if (!shouldRetryWithoutCredentials) {
      throw new Error(t('errNetwork', lang, { err: err.message || String(err) }));
    }

    console.warn('Fetch with credentials failed. Retrying without credentials...', err);

    try {
      return await fetchStreamWithStallTimeout(url, {}, lang);
    } catch (fallbackErr) {
      if (fallbackErr.isNotFound || fallbackErr.isHotlinkCandidate) {
        throw fallbackErr;
      }
      const netErr = new Error(t('errNetwork', lang, { err: fallbackErr.message || String(fallbackErr) }));
      if (err.isHotlinkCandidate) {
        netErr.isHotlinkCandidate = true;
      }
      throw netErr;
    }
  }
}

/**
 * Sends a message to the offscreen document with retry support.
 * Connection errors retry up to maxRetries; 'message port closed' retries at most once
 * after re-ensuring the offscreen document is open.
 */
async function sendMessageWithRetry(message, maxRetries = 10, delayMs = 100, lang = 'en') {
  let portClosedRetried = false;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      return response;
    } catch (err) {
      const msg = (err && err.message) || '';
      const isConnectionError =
        msg.includes('Could not establish connection') ||
        msg.includes('Receiving end does not exist');
      const isPortClosedError = msg.includes('message port closed');

      if (isPortClosedError) {
        if (!portClosedRetried) {
          portClosedRetried = true;
          console.warn('Offscreen message port closed; re-ensuring document and retrying once...');
          await ensureOffscreenDocumentWithTimeout();
          continue;
        }
        throw new Error(t('errCanvasLimit', lang));
      }

      if (isConnectionError) {
        console.log(`Offscreen document loading... Retrying in ${delayMs}ms (Attempt ${i + 1}/${maxRetries})`);
        await ensureOffscreenDocumentWithTimeout();
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw new Error(t('errOffscreenConnect', lang));
}

/**
 * Ensures that the offscreen document is created and active, serialized via offscreenLifecycleLock.
 */
function ensureOffscreenDocumentWithTimeout(timeoutMs = 4000) {
  return runWithOffscreenLock(async () => {
    if (chrome.runtime.getContexts) {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });
      if (existingContexts && existingContexts.length > 0) {
        return;
      }
    }

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
          reasons: ['BLOBS'],
          justification: 'Rendering SVGs onto canvas and creating temporary Object URLs for large image downloads.'
        }),
        timeoutPromise
      ]);
    } catch (err) {
      if (err.message && err.message.includes('Only one offscreen document may be created')) {
        return;
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  });
}

/**
 * Schedules closing of the offscreen document after 15 seconds of inactivity.
 */
function scheduleOffscreenClose(delayMs = OFFSCREEN_IDLE_TIMEOUT_MS) {
  cancelOffscreenClose();
  offscreenCloseTimeoutId = setTimeout(async () => {
    if (activeConversionsCount === 0 && !(await hasActiveDownloadBlobUrls())) {
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
 * Safely closes the offscreen document inside the lifecycle lock, re-verifying counts after awaits.
 */
function closeOffscreenDocument() {
  return runWithOffscreenLock(async () => {
    try {
      if (activeConversionsCount > 0 || (await hasActiveDownloadBlobUrls())) {
        return;
      }

      if (chrome.runtime.getContexts) {
        const existingContexts = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        if (!existingContexts || existingContexts.length === 0) return;
      }

      // Re-check after async getContexts() and hasActiveDownloadBlobUrls() to prevent race conditions (B3)
      if (activeConversionsCount > 0 || (await hasActiveDownloadBlobUrls())) {
        return;
      }

      console.log('Closing idle offscreen document to free memory...');
      await chrome.offscreen.closeDocument();
    } catch (err) {
      if (!err.message || !err.message.includes('No current offscreen document')) {
        console.warn('Notice while closing offscreen document:', err);
      }
    }
  });
}
