import { t } from './i18n.js';
import {
  sanitizeHexColor,
  isValidImageMimeType,
  detectImageMimeFromBytes
} from './helpers.js';

// Concurrency queue: limits simultaneous heavy canvas conversions to prevent memory spikes
const MAX_CONCURRENT_CONVERSIONS = 2;
const CONVERSION_TIMEOUT_MS = 15000;
let activeConversions = 0;
const conversionQueue = [];

// Track active blob URL safety timers so they can be cleared on explicit revocation
const blobRevokeTimers = new Map();

/**
 * Enqueues a conversion task so at most MAX_CONCURRENT_CONVERSIONS run in parallel.
 * If a task times out, the caller receives the error immediately, while the queue slot
 * waits for the underlying decoding/encoding workPromise to settle and release memory.
 *
 * @template T
 * @param {(trackWork: (p: Promise<any>) => void) => Promise<T>} taskFn
 * @returns {Promise<T>}
 */
function enqueueConversion(taskFn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeConversions++;
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
            // Ignore errors from timed-out background work during cleanup wait
          }
        }
        activeConversions--;
        if (conversionQueue.length > 0) {
          const nextTask = conversionQueue.shift();
          nextTask();
        }
      }
    };

    if (activeConversions < MAX_CONCURRENT_CONVERSIONS) {
      run();
    } else {
      conversionQueue.push(run);
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'convert-url') {
    enqueueConversion((trackWork) =>
      convertImageFromUrl(
        message.srcUrl,
        message.format,
        {
          quality: message.quality,
          backgroundColor: message.backgroundColor,
          returnType: message.returnType || 'blobUrl',
          lang: message.lang || 'en'
        },
        trackWork
      )
    )
      .then((resultUrl) => {
        sendResponse({ success: true, dataUrl: resultUrl });
      })
      .catch((error) => {
        console.error('Error during image conversion in offscreen:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keeps the message channel open for asynchronous response
  }

  if (message.type === 'revoke-blob-url') {
    if (message.blobUrl && message.blobUrl.startsWith('blob:')) {
      const timerId = blobRevokeTimers.get(message.blobUrl);
      if (timerId) {
        clearTimeout(timerId);
        blobRevokeTimers.delete(message.blobUrl);
      }
      try {
        URL.revokeObjectURL(message.blobUrl);
      } catch (e) {
        // ignore
      }
    }
    sendResponse({ success: true });
    return false;
  }
});

/**
 * Fetches an image URL in the offscreen document with connection + stream stall timeouts.
 *
 * @param {string} srcUrl
 * @param {string} lang
 * @returns {Promise<Blob>}
 */
async function fetchSourceBlobInOffscreen(srcUrl, lang) {
  if (srcUrl.startsWith('data:')) {
    try {
      const res = await fetch(srcUrl);
      return await res.blob();
    } catch (err) {
      throw new Error(t('errDataUrl', lang, { err: err.message || String(err) }));
    }
  }

  // Attempt 1: with credentials; Attempt 2: without credentials on network/auth errors
  try {
    return await fetchStreamWithStallTimeout(srcUrl, { credentials: 'include' }, lang);
  } catch (err) {
    if (err.noRetry) {
      throw err;
    }
    return await fetchStreamWithStallTimeout(srcUrl, {}, lang);
  }
}

/**
 * Performs a fetch with an 8s header timeout and a 10s per-chunk stream stall timeout.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} lang
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
      const err = new Error(t('errNotFound', lang));
      err.noRetry = true;
      throw err;
    }

    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`);
      if (response.status >= 500) {
        err.noRetry = true;
      }
      throw err;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!isValidImageMimeType(contentType)) {
      const err = new Error(t('errNotAnImage', lang, { type: contentType.split(';')[0].trim() }));
      err.noRetry = true;
      throw err;
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
    if (err.noRetry) {
      throw err;
    }
    throw new Error(t('errNetwork', lang, { err: err.message || String(err) }));
  }
}

/**
 * Fetches and converts an image from srcUrl into the target format.
 * Uses createImageBitmap + OffscreenCanvas for large raster images, and falls back to
 * DOM Image + HTMLCanvasElement for SVGs or formats requiring DOM rendering.
 *
 * @param {string} srcUrl
 * @param {string} format - 'jpeg', 'png', or 'webp'
 * @param {Object} options
 * @param {(p: Promise<any>) => void} [trackWork]
 * @returns {Promise<string>}
 */
async function convertImageFromUrl(srcUrl, format, options = {}, trackWork) {
  const lang = options.lang || 'en';
  let sourceBlob = await fetchSourceBlobInOffscreen(srcUrl, lang);

  if (!isValidImageMimeType(sourceBlob.type)) {
    throw new Error(t('errNotAnImage', lang, { type: sourceBlob.type.split(';')[0].trim() }));
  }

  const sniffedMime = await detectImageMimeFromBytes(sourceBlob);
  if (sniffedMime === 'text/html') {
    throw new Error(t('errNotAnImage', lang, { type: 'text/html' }));
  }

  const isSvg =
    sniffedMime === 'image/svg+xml' ||
    sourceBlob.type.split(';')[0].trim().toLowerCase() === 'image/svg+xml' ||
    /^data:image\/svg\+xml[;,]/i.test(srcUrl);

  if (isSvg && sourceBlob.type !== 'image/svg+xml') {
    sourceBlob = new Blob([sourceBlob], { type: 'image/svg+xml' });
  }

  const canUseOffscreenCanvas =
    !isSvg &&
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas !== 'undefined';

  if (canUseOffscreenCanvas) {
    try {
      return await convertWithBitmap(sourceBlob, format, options, trackWork);
    } catch (bitmapErr) {
      if (bitmapErr && bitmapErr.isTimeout) {
        throw bitmapErr;
      }
      console.warn('OffscreenCanvas path failed in offscreen, falling back to DOM Canvas:', bitmapErr);
    }
  }

  return await convertWithDomImage(sourceBlob, format, options);
}

/**
 * Hardware-accelerated conversion using createImageBitmap() + OffscreenCanvas.convertToBlob().
 *
 * @param {Blob} sourceBlob
 * @param {string} format
 * @param {Object} options
 * @param {(p: Promise<any>) => void} [trackWork]
 * @returns {Promise<string>}
 */
async function convertWithBitmap(sourceBlob, format, options = {}, trackWork) {
  const lang = options.lang || 'en';
  const returnType = options.returnType || 'blobUrl';
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
    if (sourceBlob.type === 'image/svg+xml') {
      throw new Error('SVG requires DOM Image renderer');
    }

    let bitmap = await createImageBitmap(sourceBlob);
    try {
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

      // Immediately release decoded bitmap memory before encoding output blob
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

      const mimeType = `image/${format}`;
      const outputBlob = await canvas.convertToBlob({
        type: mimeType,
        quality: qualityParam
      });

      canvas.width = 0;
      canvas.height = 0;

      if (aborted) {
        throw new Error(t('errTimeout', lang));
      }

      return await formatOutputBlob(outputBlob, returnType, lang);
    } finally {
      if (bitmap) {
        try {
          bitmap.close();
        } catch (e) {
          /* ignore */
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
 * Fallback conversion using DOM <img> + HTMLCanvasElement (used for SVGs and fallback cases).
 *
 * @param {Blob} sourceBlob
 * @param {string} format
 * @param {Object} options
 * @returns {Promise<string>}
 */
async function convertWithDomImage(sourceBlob, format, options = {}) {
  const lang = options.lang || 'en';
  const returnType = options.returnType || 'blobUrl';
  const isSvg = sourceBlob.type === 'image/svg+xml';

  let svgFallbackDims = null;
  if (isSvg) {
    svgFallbackDims = await extractSvgDimensionsFromBlob(sourceBlob);
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const tempObjectUrl = URL.createObjectURL(sourceBlob);

    const timeoutId = setTimeout(() => {
      cleanup();
      const err = new Error(t('errTimeout', lang));
      err.isTimeout = true;
      reject(err);
    }, CONVERSION_TIMEOUT_MS);

    function cleanup() {
      img.onload = null;
      img.onerror = null;
      try {
        img.src = '';
      } catch (e) {
        // ignore
      }
      try {
        URL.revokeObjectURL(tempObjectUrl);
      } catch (e) {
        // ignore
      }
    }

    img.onload = () => {
      try {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;

        if ((!width || !height) && svgFallbackDims) {
          width = svgFallbackDims.width;
          height = svgFallbackDims.height;
        }

        if (!width || !height) {
          clearTimeout(timeoutId);
          cleanup();
          throw new Error(t('errDimensions', lang));
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          clearTimeout(timeoutId);
          cleanup();
          throw new Error(t('errCanvasContext', lang));
        }

        if (format === 'jpeg') {
          ctx.fillStyle = sanitizeHexColor(options.backgroundColor, '#ffffff');
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        ctx.drawImage(img, 0, 0, width, height);
        cleanup();

        let qualityParam = undefined;
        if (format === 'jpeg' || format === 'webp') {
          qualityParam = typeof options.quality === 'number' ? options.quality : 0.95;
        }

        const mimeType = `image/${format}`;

        canvas.toBlob(
          (blob) => {
            clearTimeout(timeoutId);
            canvas.width = 0;
            canvas.height = 0;

            formatOutputBlob(blob, returnType, lang).then(resolve, reject);
          },
          mimeType,
          qualityParam
        );
      } catch (err) {
        clearTimeout(timeoutId);
        cleanup();
        reject(err);
      }
    };

    img.onerror = () => {
      clearTimeout(timeoutId);
      cleanup();
      reject(new Error(t('errGraphicEngine', lang)));
    };

    img.src = tempObjectUrl;
  });
}

/**
 * Formats the encoded output Blob into a temporary Object URL (for downloads)
 * or a Base64 Data URL (for clipboard copy).
 *
 * @param {Blob | null} blob
 * @param {'blobUrl' | 'dataUrl'} returnType
 * @param {string} lang
 * @returns {Promise<string>}
 */
function formatOutputBlob(blob, returnType, lang) {
  return new Promise((resolve, reject) => {
    if (!blob || blob.size === 0) {
      reject(new Error(t('errCanvasLimit', lang)));
      return;
    }

    if (returnType === 'blobUrl') {
      const blobUrl = URL.createObjectURL(blob);
      const timerId = setTimeout(() => {
        blobRevokeTimers.delete(blobUrl);
        try {
          URL.revokeObjectURL(blobUrl);
        } catch (e) {
          /* ignore */
        }
      }, 300000); // 5 minutes safety window for Save-As dialog
      blobRevokeTimers.set(blobUrl, timerId);
      resolve(blobUrl);
    } else {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(t('errCanvasLimit', lang)));
      reader.readAsDataURL(blob);
    }
  });
}

/**
 * Extracts fallback width and height from an SVG Blob's viewBox if intrinsic dimensions are 0.
 *
 * @param {Blob} svgBlob
 * @returns {Promise<{ width: number, height: number }>}
 */
async function extractSvgDimensionsFromBlob(svgBlob) {
  try {
    const svgText = await svgBlob.slice(0, 65536).text();
    const viewBoxMatch = svgText.match(
      /viewBox\s*=\s*["']\s*[-+]?\d*\.?\d+[\s,]+[-+]?\d*\.?\d+[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*["']/i
    );
    if (viewBoxMatch) {
      const w = Math.round(parseFloat(viewBoxMatch[1]));
      const h = Math.round(parseFloat(viewBoxMatch[2]));
      if (w > 0 && h > 0) {
        return { width: w, height: h };
      }
    }
  } catch (e) {
    // ignore and fallback
  }
  return { width: 800, height: 600 };
}
