/**
 * Parses an image URL and generates a clean, safe filename with the target extension.
 * Ensures strict compatibility with Windows and Unix file systems.
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
  const defaultName = `image_${Date.now()}.${ext}`;

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
    
    // If path ends in slash or has no filename or is generic, check common query params
    const genericEndpoints = ['image', 'images', 'download', 'media', 'api', 'photo', 'get', 'view', 'show'];
    if (!filename || genericEndpoints.includes(filename.toLowerCase())) {
      const searchParams = url.searchParams;
      const paramCandidates = ['file', 'filename', 'name', 'title', 'id'];
      for (const param of paramCandidates) {
        const val = searchParams.get(param);
        if (val && val.trim()) {
          filename = val.trim();
          break;
        }
      }
    }

    if (!filename) {
      return defaultName;
    }

    // Remove existing extension if present
    const lastDotIndex = filename.lastIndexOf('.');
    if (lastDotIndex !== -1) {
      const currentExt = filename.substring(lastDotIndex + 1).toLowerCase();
      // List of common image extensions to strip
      const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'tiff', 'ico', 'avif'];
      if (imageExtensions.includes(currentExt)) {
        filename = filename.substring(0, lastDotIndex);
      }
    }

    // Clean up illegal filename characters (especially Windows: < > : " / \ | ? *)
    filename = filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    
    // Strip trailing dots and spaces (forbidden on Windows filesystems)
    filename = filename.replace(/[\.\s]+$/g, '').trim();

    // Check Windows reserved filenames
    const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
    if (reservedNames.includes(filename.toUpperCase())) {
      filename = `${filename}_image`;
    }

    // Limit length
    filename = filename.substring(0, 100).trim();

    if (!filename) {
      return defaultName;
    }

    return `${filename}.${ext}`;
  } catch (e) {
    console.error('Error parsing filename from URL:', e);
    return defaultName;
  }
}
