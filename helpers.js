/**
 * Parses an image URL and generates a clean, safe filename with the target extension.
 * 
 * @param {string} urlStr - The source URL of the image (can be http, https, data URL, etc.)
 * @param {string} format - The target format ('jpeg', 'png', 'webp')
 * @returns {string} The formatted filename.
 */
export function getFilenameFromUrl(urlStr, format) {
  const extensionMap = {
    'jpeg': 'jpg',
    'png': 'png',
    'webp': 'webp'
  };
  const ext = extensionMap[format] || 'jpg';
  const defaultName = `downloaded_image_${Date.now()}.${ext}`;

  if (!urlStr) {
    return defaultName;
  }

  // Handle data URLs
  if (urlStr.startsWith('data:')) {
    return `data_image_${Date.now()}.${ext}`;
  }

  try {
    const url = new URL(urlStr);
    let pathname = decodeURIComponent(url.pathname);
    
    // Get the last segment of the path
    let filename = pathname.substring(pathname.lastIndexOf('/') + 1);
    
    if (!filename) {
      return defaultName;
    }

    // Remove existing extension if present
    const lastDotIndex = filename.lastIndexOf('.');
    if (lastDotIndex !== -1) {
      const currentExt = filename.substring(lastDotIndex + 1).toLowerCase();
      // List of common image extensions to remove
      const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'tiff', 'ico'];
      if (imageExtensions.includes(currentExt)) {
        filename = filename.substring(0, lastDotIndex);
      }
    }

    // Clean up illegal filename characters (especially for Windows: < > : " / \ | ? *)
    filename = filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    
    // Trim spaces and limit length
    filename = filename.trim().substring(0, 100);

    if (!filename) {
      return defaultName;
    }

    return `${filename}.${ext}`;
  } catch (e) {
    console.error('Error parsing filename from URL:', e);
    return defaultName;
  }
}
