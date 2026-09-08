/**
 * Default settings configuration for Save as Image extension.
 */
export const DEFAULT_SETTINGS = {
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
    const storage = (chrome.storage && chrome.storage.sync) || (chrome.storage && chrome.storage.local);
    if (!storage) {
      return { ...DEFAULT_SETTINGS };
    }
    const result = await storage.get(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...result };
  } catch (error) {
    console.warn('Failed to load settings from storage, using defaults:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Saves given settings object to chrome.storage.
 * 
 * @param {Partial<typeof DEFAULT_SETTINGS>} settings
 * @returns {Promise<boolean>}
 */
export async function saveSettings(settings) {
  try {
    const storage = (chrome.storage && chrome.storage.sync) || (chrome.storage && chrome.storage.local);
    if (!storage) {
      return false;
    }
    await storage.set(settings);
    return true;
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
    const storage = (chrome.storage && chrome.storage.sync) || (chrome.storage && chrome.storage.local);
    if (!storage) {
      return false;
    }
    await storage.clear();
    await storage.set(DEFAULT_SETTINGS);
    return true;
  } catch (error) {
    console.error('Failed to reset settings:', error);
    return false;
  }
}
