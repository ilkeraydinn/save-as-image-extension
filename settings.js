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

// In-memory cache and version counter to prevent race conditions during concurrent storage events
let cachedSettings = null;
let cacheVersion = 0;

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(() => {
    cacheVersion++;
    cachedSettings = null;
  });
}

/**
 * Retrieves the current settings merged with default values.
 * Uses a versioned in-memory cache and parallel reads from chrome.storage.sync and chrome.storage.local.
 *
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getSettings() {
  if (cachedSettings) {
    return { ...cachedSettings };
  }

  const startVersion = cacheVersion;

  try {
    const readLocal =
      chrome.storage && chrome.storage.local
        ? chrome.storage.local.get(null).catch((err) => {
            console.warn('storage.local read failed:', err);
            return {};
          })
        : Promise.resolve({});

    const readSync =
      chrome.storage && chrome.storage.sync
        ? chrome.storage.sync.get(null).catch((err) => {
            console.warn('storage.sync read failed, using storage.local:', err);
            return {};
          })
        : Promise.resolve({});

    const [localRaw, syncRaw] = await Promise.all([readLocal, readSync]);
    const localData = localRaw || {};
    const syncData = syncRaw || {};
    const { _preferLocal, ...cleanLocal } = localData;

    // If last save failed on sync, prefer localData; otherwise prefer syncData (for cross-device sync)
    const merged = _preferLocal
      ? { ...DEFAULT_SETTINGS, ...syncData, ...cleanLocal }
      : { ...DEFAULT_SETTINGS, ...cleanLocal, ...syncData };

    // Only populate cache if no storage.onChanged event invalidated it while reading (B10)
    if (startVersion === cacheVersion) {
      cachedSettings = merged;
    }

    return { ...(cachedSettings || merged) };
  } catch (error) {
    console.warn('Failed to load settings from storage, using defaults:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Saves given settings object to chrome.storage.
 * Writes only changed keys to respect chrome.storage.sync write quotas (P3).
 *
 * @param {Partial<typeof DEFAULT_SETTINGS>} settings
 * @param {boolean} [forceAll=false]
 * @returns {Promise<boolean>}
 */
export async function saveSettings(settings, forceAll = false) {
  try {
    const baseline = cachedSettings || (await getSettings());
    const patch = {};

    for (const [key, value] of Object.entries(settings)) {
      if (forceAll || !cachedSettings || baseline[key] !== value) {
        patch[key] = value;
      }
    }

    if (Object.keys(patch).length === 0) {
      return true;
    }

    let syncSaved = false;
    let localSaved = false;

    if (chrome.storage && chrome.storage.sync) {
      try {
        await chrome.storage.sync.set(patch);
        syncSaved = true;
      } catch (syncErr) {
        console.warn('chrome.storage.sync write failed:', syncErr);
      }
    }

    if (chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.set({
          ...patch,
          _preferLocal: !syncSaved
        });
        localSaved = true;
      } catch (localErr) {
        console.warn('chrome.storage.local write failed:', localErr);
      }
    }

    if (syncSaved || localSaved) {
      cacheVersion++;
      cachedSettings = { ...DEFAULT_SETTINGS, ...baseline, ...patch };
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
    return await saveSettings(DEFAULT_SETTINGS, true);
  } catch (error) {
    console.error('Failed to reset settings:', error);
    return false;
  }
}
