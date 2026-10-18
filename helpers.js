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

/**
 * Validates and normalizes a 6-digit hex color string (e.g. '#ffffff').
 * Returns the fallback color if input is invalid so canvas fillStyle never silently defaults to black.
 *
 * @param {string} color
 * @param {string} [fallback='#ffffff']
 * @returns {string}
 */
export function sanitizeHexColor(color, fallback = '#ffffff') {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color.trim())) {
    return color.trim().toLowerCase();
  }
  return fallback;
}

/**
 * Checks whether a Content-Type / Blob MIME string is an acceptable image or raw binary stream.
 * Strips parameters such as "; charset=UTF-8" before checking.
 *
 * @param {string} [mimeType]
 * @returns {boolean}
 */
export function isValidImageMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') {
    return true;
  }
  const baseType = mimeType.split(';')[0].trim().toLowerCase();
  if (!baseType) {
    return true;
  }
  return (
    baseType.startsWith('image/') ||
    baseType === 'application/octet-stream' ||
    baseType === 'binary/octet-stream'
  );
}

/**
 * Inspects the magic bytes of a Blob to determine its actual MIME type.
 * Detects PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG, and disguised HTML documents.
 *
 * @param {Blob} blob
 * @returns {Promise<string | null>} Detected MIME type or null if unrecognized.
 */
export async function detectImageMimeFromBytes(blob) {
  if (!blob || typeof blob.slice !== 'function' || blob.size === 0) {
    return null;
  }

  const slice = blob.slice(0, 512);
  const buffer = await slice.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return 'image/png';
  }

  if (bytes.length >= 3 &&
      bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }

  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }

  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }

  if (bytes.length >= 12 &&
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1' || brand === 'heic') {
      return 'image/avif';
    }
  }

  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return 'image/bmp';
  }

  if (bytes.length >= 4 &&
      bytes[0] === 0x00 && bytes[1] === 0x00 &&
      (bytes[2] === 0x01 || bytes[2] === 0x02) && bytes[3] === 0x00) {
    return 'image/x-icon';
  }

  // Inspect leading text for disguised HTML error pages or SVG markup
  try {
    const text = new TextDecoder('utf-8', { fatal: false })
      .decode(bytes)
      .replace(/^\uFEFF/, '')
      .trimStart()
      .toLowerCase();

    if (
      text.startsWith('<!doctype html') ||
      text.startsWith('<html') ||
      text.startsWith('<head') ||
      text.startsWith('<body') ||
      text.startsWith('<script')
    ) {
      return 'text/html';
    }

    if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg')) || (text.startsWith('<!doctype svg') && text.includes('<svg'))) {
      return 'image/svg+xml';
    }
  } catch (e) {
    // ignore text decoding errors on binary streams
  }

  return null;
}

/**
 * Checks whether a Blob begins with the exact 8-byte PNG signature (89 50 4E 47 0D 0A 1A 0A).
 *
 * @param {Blob} blob
 * @returns {Promise<boolean>}
 */
export async function isPngBlob(blob) {
  if (!blob || typeof blob.slice !== 'function' || blob.size < 8) {
    return false;
  }
  const buffer = await blob.slice(0, 8).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4E &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0D &&
    bytes[5] === 0x0A &&
    bytes[6] === 0x1A &&
    bytes[7] === 0x0A
  );
}

/**
 * Formats a URL for safe console logging by truncating data: URLs to prevent memory bloat.
 *
 * @param {string} url
 * @param {number} [maxLen=80]
 * @returns {string}
 */
export function formatUrlForLog(url, maxLen = 80) {
  if (!url || typeof url !== 'string') return String(url);
  if (url.startsWith('data:') && url.length > maxLen) {
    return `${url.slice(0, maxLen)}...[truncated ${url.length} chars]`;
  }
  return url;
}

