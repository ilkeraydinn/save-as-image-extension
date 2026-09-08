// Listen for messages from the service worker (background.js)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'convert-image') {
    convertImage(message.sourceDataUrl, message.format, {
      quality: message.quality,
      backgroundColor: message.backgroundColor
    })
      .then(dataUrl => {
        sendResponse({ success: true, dataUrl: dataUrl });
      })
      .catch(error => {
        console.error('Error during image conversion in offscreen:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keeps the message channel open for asynchronous response
  }
});

/**
 * Converts an image passed as a Base64 Data URL into the target format via Canvas and returns a Data URL.
 * 
 * @param {string} sourceDataUrl - The Base64 Data URL of the source image.
 * @param {string} format - Target format ('jpeg', 'png', 'webp').
 * @param {Object} [options] - Conversion options.
 * @param {number} [options.quality] - Compression quality (0.5 to 1.0) for JPEG and WEBP.
 * @param {string} [options.backgroundColor] - Background fill color for JPEG (default '#FFFFFF').
 * @returns {Promise<string>} The converted Data URL.
 */
async function convertImage(sourceDataUrl, format, options = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    
    // Set a safety timeout of 8 seconds to prevent hanging
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Görsel işleme zaman aşımına uğradı (8 saniye).'));
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
      clearTimeout(timeoutId);
      try {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;

        if (!width || !height) {
          cleanup();
          throw new Error('Görsel boyutları geçersiz veya 0 piksel.');
        }

        // Create canvas matching image dimensions
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          throw new Error('Canvas 2D context alınamadı.');
        }
        
        // Transparent background fill for JPG conversions
        if (format === 'jpeg') {
          ctx.fillStyle = options.backgroundColor || '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        
        // Draw image onto canvas
        ctx.drawImage(img, 0, 0);
        
        // Determine quality parameter
        let qualityParam = undefined;
        if (format === 'jpeg' || format === 'webp') {
          qualityParam = typeof options.quality === 'number' ? options.quality : 0.95;
        }

        // Convert canvas to target format Data URL
        const mimeType = `image/${format}`;
        const dataUrl = canvas.toDataURL(mimeType, qualityParam);
        
        // Clean up canvas and image immediately to free GPU and RAM
        cleanup();
        canvas.width = 0;
        canvas.height = 0;
        
        resolve(dataUrl);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    
    img.onerror = () => {
      clearTimeout(timeoutId);
      cleanup();
      reject(new Error('Görsel grafik motoruna yüklenemedi. Bozuk veya desteklenmeyen bir dosya formatı olabilir.'));
    };
    
    img.src = sourceDataUrl;
  });
}
