import { t } from './i18n.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'convert-image') {
    convertImage(message.sourceDataUrl, message.format, {
      quality: message.quality,
      backgroundColor: message.backgroundColor,
      returnType: message.returnType || 'dataUrl',
      lang: message.lang || 'en'
    })
      .then(resultUrl => {
        sendResponse({ success: true, dataUrl: resultUrl });
      })
      .catch(error => {
        console.error('Error during image conversion in offscreen:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keeps the message channel open for asynchronous response
  }

  if (message.type === 'revoke-blob-url') {
    if (message.blobUrl && message.blobUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(message.blobUrl);
      } catch (e) {
        // ignore
      }
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'copy-to-clipboard') {
    copyDataUrlToClipboard(message.dataUrl)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch(error => {
        console.warn('Offscreen direct clipboard write failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

/**
 * Converts an image into the target format via Canvas using async canvas.toBlob().
 * Returns either a lightweight Object URL ('blobUrl') for downloads or a Data URL ('dataUrl') for clipboard.
 * 
 * @param {string} sourceDataUrl - The Data URL of the source image.
 * @param {string} format - Target format ('jpeg', 'png', 'webp').
 * @param {Object} [options] - Conversion options.
 * @param {number} [options.quality] - Compression quality (0.5 to 1.0) for JPEG and WEBP.
 * @param {string} [options.backgroundColor] - Background fill color for JPEG (default '#FFFFFF').
 * @param {'blobUrl' | 'dataUrl'} [options.returnType] - Output URL format.
 * @param {string} [options.lang] - Language code ('tr' or 'en').
 * @returns {Promise<string>} The converted Blob URL or Data URL.
 */
async function convertImage(sourceDataUrl, format, options = {}) {
  const lang = options.lang || 'en';
  const returnType = options.returnType || 'dataUrl';

  return new Promise((resolve, reject) => {
    const img = new Image();
    
    // Set a safety timeout of 8 seconds to prevent hanging
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(t('errTimeout', lang)));
    }, 8000);

    function cleanup() {
      img.onload = null;
      img.onerror = null;
      try {
        img.src = '';
      } catch (e) {
        // ignore
      }
    }
    
    img.onload = () => {
      try {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;

        // Fallback for SVG images without explicit width/height attributes (only viewBox)
        if ((!width || !height) && sourceDataUrl.startsWith('data:image/svg+xml')) {
          const svgDims = extractSvgDimensions(sourceDataUrl);
          width = svgDims.width;
          height = svgDims.height;
        }

        if (!width || !height) {
          clearTimeout(timeoutId);
          cleanup();
          throw new Error(t('errDimensions', lang));
        }

        // Create canvas matching image dimensions
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          clearTimeout(timeoutId);
          cleanup();
          throw new Error(t('errCanvasContext', lang));
        }
        
        // Transparent background fill for JPG conversions
        if (format === 'jpeg') {
          ctx.fillStyle = options.backgroundColor || '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        
        // Draw image onto canvas
        ctx.drawImage(img, 0, 0, width, height);
        cleanup();
        
        // Determine quality parameter
        let qualityParam = undefined;
        if (format === 'jpeg' || format === 'webp') {
          qualityParam = typeof options.quality === 'number' ? options.quality : 0.95;
        }

        const mimeType = `image/${format}`;

        // Use asynchronous toBlob instead of synchronous toDataURL to avoid blocking main thread
        canvas.toBlob((blob) => {
          clearTimeout(timeoutId);
          canvas.width = 0;
          canvas.height = 0;

          if (!blob || blob.size === 0) {
            reject(new Error(t('errCanvasLimit', lang)));
            return;
          }

          // Use Object URL only when asked AND when blob is large (>= 15MB) to avoid 64MB IPC limit,
          // otherwise return a self-contained Data URL so Chrome's "Save As" dialog never loses the blob if kept open
          const LARGE_BLOB_THRESHOLD = 15 * 1024 * 1024;
          if (returnType === 'blobUrl' && blob.size >= LARGE_BLOB_THRESHOLD) {
            const blobUrl = URL.createObjectURL(blob);
            setTimeout(() => {
              try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ }
            }, 300000); // 5 minutes safety window for Save-As dialog
            resolve(blobUrl);
          } else {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(new Error(t('errCanvasLimit', lang)));
            reader.readAsDataURL(blob);
          }
        }, mimeType, qualityParam);
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
    
    img.src = sourceDataUrl;
  });
}

/**
 * Extracts fallback width and height from an SVG data URL's viewBox if intrinsic dimensions are 0.
 *
 * @param {string} svgDataUrl
 * @returns {{ width: number, height: number }}
 */
function extractSvgDimensions(svgDataUrl) {
  try {
    const commaIdx = svgDataUrl.indexOf(',');
    if (commaIdx !== -1) {
      const header = svgDataUrl.substring(0, commaIdx);
      const rawData = svgDataUrl.substring(commaIdx + 1);
      const svgText = header.includes(';base64') ? atob(rawData) : decodeURIComponent(rawData);
      const viewBoxMatch = svgText.match(/viewBox\s*=\s*["']\s*[-+]?\d*\.?\d+[\s,]+[-+]?\d*\.?\d+[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*["']/i);
      if (viewBoxMatch) {
        const w = Math.round(parseFloat(viewBoxMatch[1]));
        const h = Math.round(parseFloat(viewBoxMatch[2]));
        if (w > 0 && h > 0) {
          return { width: w, height: h };
        }
      }
    }
  } catch (e) {
    // ignore and fallback
  }
  return { width: 800, height: 600 };
}

/**
 * Copies a PNG Data URL to the system clipboard.
 * Uses Async Clipboard API if focused, otherwise falls back to DOM selection + execCommand('copy')
 * which is supported in Offscreen Documents with the 'CLIPBOARD' reason.
 * 
 * @param {string} dataUrl 
 * @returns {Promise<void>}
 */
async function copyDataUrlToClipboard(dataUrl) {
  if (document.hasFocus && document.hasFocus() && typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const item = new ClipboardItem({ 'image/png': blob });
      await navigator.clipboard.write([item]);
      return;
    } catch (e) {
      // Fall through to execCommand fallback
    }
  }

  // Offscreen document fallback: wait for image to load in DOM, select it, and run execCommand('copy')
  await new Promise((resolve, reject) => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    div.style.position = 'fixed';
    div.style.left = '-9999px';
    div.style.top = '0';
    div.style.opacity = '0';

    const img = document.createElement('img');
    img.onload = () => {
      try {
        document.body.appendChild(div);
        div.focus();
        const range = document.createRange();
        range.selectNode(img);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = document.execCommand('copy');
        sel.removeAllRanges();
        div.remove();
        if (ok) {
          resolve();
        } else {
          reject(new Error('execCommand("copy") returned false in offscreen document.'));
        }
      } catch (err) {
        div.remove();
        reject(err);
      }
    };
    img.onerror = () => {
      div.remove();
      reject(new Error('Failed to load image for offscreen clipboard copy.'));
    };
    div.appendChild(img);
    img.src = dataUrl;
  });
}
