/**
 * Default settings configuration for Save as Image extension.
 */
export const DEFAULT_SETTINGS = {
  // Language preference: 'auto', 'tr', or 'en'
  language: 'auto',

  // Theme preference: 'auto', 'light', or 'dark'
  theme: 'auto',

  // Quality options (50 to 100)
  qualityJpg: 95,
  qualityWebp: 95,
  
  // Background fill color when saving transparent images as JPG
  jpgBgColor: '#ffffff',
  
  // Optional subfolder inside Downloads directory (e.g. "SaveAsImage")
  downloadSubfolder: ''
};

// In-memory cache to avoid redundant storage I/O on every right-click action
let cachedSettings = null;

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(() => {
    cachedSettings = null;
  });
}

/**
 * Retrieves the current settings merged with default values.
 * Uses in-memory cache and parallel reads from chrome.storage.sync and chrome.storage.local.
 * 
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getSettings() {
  if (cachedSettings) {
    return { ...cachedSettings };
  }

  try {
    const readLocal = (chrome.storage && chrome.storage.local)
      ? chrome.storage.local.get(null).catch(err => {
          console.warn('storage.local read failed:', err);
          return {};
        })
      : Promise.resolve({});

    const readSync = (chrome.storage && chrome.storage.sync)
      ? chrome.storage.sync.get(null).catch(err => {
          console.warn('storage.sync read failed, using storage.local:', err);
          return {};
        })
      : Promise.resolve({});

    const [localRaw, syncRaw] = await Promise.all([readLocal, readSync]);
    const localData = localRaw || {};
    const syncData = syncRaw || {};
    const { _preferLocal, ...cleanLocal } = localData;

    // If last save failed on sync, prefer localData; otherwise prefer syncData (for cross-device sync)
    cachedSettings = _preferLocal
      ? { ...DEFAULT_SETTINGS, ...syncData, ...cleanLocal }
      : { ...DEFAULT_SETTINGS, ...cleanLocal, ...syncData };

    return { ...cachedSettings };
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
    let syncSaved = false;
    let localSaved = false;

    if (chrome.storage && chrome.storage.sync) {
      try {
        await chrome.storage.sync.set(settings);
        syncSaved = true;
      } catch (syncErr) {
        console.warn('chrome.storage.sync write failed:', syncErr);
      }
    }

    if (chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.set({
          ...settings,
          _preferLocal: !syncSaved
        });
        localSaved = true;
      } catch (localErr) {
        console.warn('chrome.storage.local write failed:', localErr);
      }
    }

    if (syncSaved || localSaved) {
      cachedSettings = { ...(cachedSettings || DEFAULT_SETTINGS), ...settings };
    }

    return syncSaved || localSaved;
  } catch (error) {
    console.error('Failed to save settings:', error);
    return false;
  }
}

/**
 * Resets all settings back to default values without triggering redundant clear events.
 * 
 * @returns {Promise<boolean>}
 */
export async function resetSettings() {
  try {
    return await saveSettings(DEFAULT_SETTINGS);
  } catch (error) {
    console.error('Failed to reset settings:', error);
    return false;
  }
}
