/**
 * Internationalization (i18n) dictionary and helper module for Save as Image.
 * Supports Turkish (tr) and English (en).
 */

export const TRANSLATIONS = {
  tr: {
    // Header & Badges
    appName: "Save as Image",
    savedBadge: "Kaydedildi",

    // Language & Theme Selector
    langTitle: "Dil",
    themeToggle: "Temayı Değiştir",

    // Card Category Tags
    tagQuality: "KALİTE",
    tagColor: "RENK",
    tagDirectory: "KLASÖR",

    // Section: Image Quality
    qualityTitle: "Görsel Kalitesi",
    qualityJpgLabel: "JPG Kalitesi",
    qualityWebpLabel: "WEBP Kalitesi",

    // Section: Transparency
    transparencyTitle: "Şeffaf Görseller (JPG için)",
    transparencyDesc: "Şeffaf PNG veya WEBP görseller JPG'ye dönüştürülürken arkaya eklenecek renk:",
    colorWhite: "Beyaz",
    colorBlack: "Siyah",

    // Section: Download Folder
    folderTitle: "İndirme Klasörü",
    folderDesc: "İndirilenler klasörünüzün içine isteğe bağlı alt klasör adı:",
    folderPlaceholder: "Örn: Görseller",

    // Footer
    btnReset: "Varsayılanlara Sıfırla",
    footerHint: "Görselin üzerine sağ tıklayıp istediğiniz formatta kaydedin veya panoya kopyalayın.",

    // Context Menus
    menuParent: "Görseli Farklı Kaydet",
    menuJpg: "JPG olarak kaydet",
    menuPng: "PNG olarak kaydet",
    menuWebp: "WEBP olarak kaydet",
    menuCopy: "Görseli panoya kopyala",

    // Feedback & Error Messages
    msgCopySuccess: "Görsel panoya kopyalandı.",
    errNotAnImage: "Sunucu görsel yerine web sayfası döndürdü ({type}). Doğrudan erişim engellenmiş veya CAPTCHA sayfası olabilir.",
    errBlobUrl: "Bu görsel sayfa içi geçici bir bellek nesnesidir (blob URL). Tarayıcı güvenlik kısıtlamaları nedeniyle doğrudan indirilemedi.",
    errDataUrl: "Data URL okunamadı: {err}",
    errNotFound: "Görsel sunucuda bulunamadı (404 Not Found).",
    errClipboardCopy: "Görsel panoya kopyalanamadı. Tarayıcı veya sayfa panoya erişim izni vermemiş olabilir.",
    errOffscreenConnect: "Dönüştürme modülü ile bağlantı kurulamadı. Lütfen eklentiyi yenileyip tekrar deneyin.",
    errOffscreenResponse: "Dönüştürme modülünden yanıt alınamadı.",
    errDimensions: "Görsel boyutları geçersiz veya 0 piksel.",
    errGraphicEngine: "Görsel grafik motoruna yüklenemedi. Bozuk veya desteklenmeyen bir dosya formatı olabilir.",
    errTimeout: "Görsel işleme zaman aşımına uğradı (15 saniye).",
    errCanvasContext: "Canvas 2D grafik bağlamı oluşturulamadı.",
    errCanvasLimit: "Görsel çok büyük olduğu için dönüştürülemedi (tarayıcı Canvas sınırını aştı).",
    errNetwork: "Ağ veya erişim hatası: {err}"
  },

  en: {
    // Header & Badges
    appName: "Save as Image",
    savedBadge: "Saved",

    // Language & Theme Selector
    langTitle: "Language",
    themeToggle: "Toggle Theme",

    // Card Category Tags
    tagQuality: "QUALITY",
    tagColor: "COLOR",
    tagDirectory: "DIRECTORY",

    // Section: Image Quality
    qualityTitle: "Image Quality",
    qualityJpgLabel: "JPG Quality",
    qualityWebpLabel: "WEBP Quality",

    // Section: Transparency
    transparencyTitle: "Transparent Images (for JPG)",
    transparencyDesc: "Background fill color when saving transparent PNG or WEBP images as JPG:",
    colorWhite: "White",
    colorBlack: "Black",

    // Section: Download Folder
    folderTitle: "Download Folder",
    folderDesc: "Optional subfolder inside your Downloads directory:",
    folderPlaceholder: "e.g. Images",

    // Footer
    btnReset: "Reset to Defaults",
    footerHint: "Right-click any web image and save it in your preferred format or copy to clipboard.",

    // Context Menus
    menuParent: "Save as Image",
    menuJpg: "Save as JPG",
    menuPng: "Save as PNG",
    menuWebp: "Save as WEBP",
    menuCopy: "Copy image to clipboard",

    // Feedback & Error Messages
    msgCopySuccess: "Image copied to clipboard.",
    errNotAnImage: "Server returned a web page instead of an image ({type}). Direct access may be blocked or protected by CAPTCHA.",
    errBlobUrl: "This image is a temporary page-scoped blob URL and cannot be downloaded directly due to browser security restrictions.",
    errDataUrl: "Failed to read Data URL: {err}",
    errNotFound: "Image not found on server (404 Not Found).",
    errClipboardCopy: "Failed to copy image to clipboard. Browser or page may not have granted clipboard access.",
    errOffscreenConnect: "Could not establish connection with converter module. Please reload the extension.",
    errOffscreenResponse: "No response received from converter module.",
    errDimensions: "Invalid or zero-dimension image.",
    errGraphicEngine: "Failed to load image into graphics engine. The file may be corrupt or unsupported.",
    errTimeout: "Image processing timed out (15 seconds).",
    errCanvasContext: "Canvas 2D context unavailable.",
    errCanvasLimit: "Image is too large to convert (exceeded browser Canvas limit).",
    errNetwork: "Network or access error: {err}"
  }
};

/**
 * Resolves the effective language ('tr' or 'en') given user preference.
 * Defaults to 'tr' if system/browser is Turkish, otherwise 'en'.
 * 
 * @param {string} [pref] - 'auto', 'tr', or 'en'
 * @returns {'tr' | 'en'}
 */
export function resolveLanguage(pref) {
  if (pref === 'tr' || pref === 'en') {
    return pref;
  }
  
  // Auto-detect from environment
  try {
    const uiLang = (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage)
      ? chrome.i18n.getUILanguage()
      : '';
    const sysLang = (uiLang || navigator.language || navigator.userLanguage || '').toLowerCase();
    if (sysLang.startsWith('tr')) {
      return 'tr';
    }
  } catch (e) {
    // ignore
  }
  return 'en';
}

/**
 * Translates a key for a given language with parameter substitution.
 * 
 * @param {string} key - Translation key
 * @param {string} lang - 'tr' or 'en'
 * @param {Object} [params] - Replacement variables, e.g. { name: 'photo.jpg' }
 * @returns {string}
 */
export function t(key, lang = 'en', params = {}) {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;
  let text = dict[key] || TRANSLATIONS.en[key] || key;
  
  for (const [paramKey, paramVal] of Object.entries(params)) {
    text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), () => String(paramVal));
  }
  
  return text;
}
