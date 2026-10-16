const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

/**
 * Safely decodes a URI component without throwing on malformed percent sequences.
 *
 * @param {string} str
 * @returns {string}
 */
function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return str;
  }
}

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
    const pathname = safeDecodeURIComponent(url.pathname);
    
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
          const decodedVal = safeDecodeURIComponent(val.trim());
          filename = decodedVal.substring(decodedVal.lastIndexOf('/') + 1);
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
    
    // Limit length first, then strip leading/trailing dots and spaces (forbidden on Windows filesystems)
    filename = filename.substring(0, 100).replace(/^[\.\s]+|[\.\s]+$/g, '').trim();

    // Check Windows reserved filenames (including "CON.backup" style base names)
    const basePart = filename.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(basePart)) {
      filename = `${filename}_image`;
    }

    if (!filename) {
      return defaultName;
    }

    return `${filename}.${ext}`;
  } catch (e) {
    console.error('Error parsing filename from URL:', e);
    return defaultName;
  }
}

/**
 * Sanitizes a user-provided relative subfolder path for chrome.downloads.download.
 *
 * @param {string} folderStr
 * @returns {string}
 */
export function sanitizeSubfolder(folderStr) {
  if (!folderStr || typeof folderStr !== 'string') return '';

  const segments = folderStr
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => {
      let clean = segment
        .replace(/\.\.+/g, '')
        .replace(/[<>:"|?*\x00-\x1F]/g, '')
        .replace(/^[\.\s]+|[\.\s]+$/g, '')
        .trim();
      if (!clean) return '';
      const basePart = clean.split('.')[0].toUpperCase();
      if (WINDOWS_RESERVED_NAMES.has(basePart)) {
        clean = `${clean}_folder`;
      }
      return clean;
    })
    .filter(Boolean);

  return segments.join('/');
}
