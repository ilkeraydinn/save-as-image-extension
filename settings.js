/**
 * Default settings configuration for Save as Image extension.
 */
export const DEFAULT_SETTINGS = {
  // Language preference: 'auto', 'tr', or 'en'
  language: 'auto',

  // Quality options (50 to 100)
  qualityJpg: 95,
  qualityWebp: 95,
  
  // Background fill color when saving transparent images as JPG
  jpgBgColor: '#ffffff',
  
  // Notification toggles
  showStartNotification: true,
  showSuccessNotification: true,
  showErrorNotification: true,
  
  // Optional subfolder inside Downloads directory (e.g. "SaveAsImage")
  downloadSubfolder: ''
};

/**
 * Retrieves the current settings merged with default values.
 * Uses chrome.storage.sync with fallback to chrome.storage.local.
 * 
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getSettings() {
  try {
    if (chrome.storage && chrome.storage.sync) {
      try {
        const result = await chrome.storage.sync.get(DEFAULT_SETTINGS);
        return { ...DEFAULT_SETTINGS, ...result };
      } catch (syncErr) {
        console.warn('storage.sync read failed, checking storage.local:', syncErr);
      }
    }
    
    if (chrome.storage && chrome.storage.local) {
      const localResult = await chrome.storage.local.get(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS, ...localResult };
    }

    return { ...DEFAULT_SETTINGS };
  } catch (error) {
    console.warn('Failed to load settings from storage, using defaults:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Saves given settings object to chrome.storage.
 * Uses chrome.storage.sync and mirrors to chrome.storage.local for reliability.
 * 
 * @param {Partial<typeof DEFAULT_SETTINGS>} settings
 * @returns {Promise<boolean>}
 */
export async function saveSettings(settings) {
  try {
    let saved = false;

    if (chrome.storage && chrome.storage.sync) {
      try {
        await chrome.storage.sync.set(settings);
        saved = true;
      } catch (syncErr) {
        console.warn('chrome.storage.sync write failed:', syncErr);
      }
    }

    if (chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.set(settings);
        saved = true;
      } catch (localErr) {
        console.warn('chrome.storage.local write failed:', localErr);
      }
    }

    return saved;
  } catch (error) {
    console.error('Failed to save settings:', error);
    return false;
  }
}

/**
 * Resets all settings back to default values.
 * 
 * @returns {Promise<boolean>}
 */
export async function resetSettings() {
  try {
    if (chrome.storage && chrome.storage.sync) {
      try {
        await chrome.storage.sync.clear();
      } catch (e) { /* ignore */ }
    }
    if (chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.clear();
      } catch (e) { /* ignore */ }
    }
    return await saveSettings(DEFAULT_SETTINGS);
  } catch (error) {
    console.error('Failed to reset settings:', error);
    return false;
  }
}
