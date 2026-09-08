import { getSettings, saveSettings, resetSettings, DEFAULT_SETTINGS } from './settings.js';

// DOM Element References
const qualityJpgInput = document.getElementById('quality-jpg');
const qualityJpgVal = document.getElementById('quality-jpg-val');

const qualityWebpInput = document.getElementById('quality-webp');
const qualityWebpVal = document.getElementById('quality-webp-val');

const jpgBgColorInput = document.getElementById('jpg-bg-color');
const jpgBgHex = document.getElementById('jpg-bg-hex');
const presetButtons = document.querySelectorAll('.preset-btn');

const downloadSubfolderInput = document.getElementById('download-subfolder');

const notifyStartInput = document.getElementById('notify-start');
const notifySuccessInput = document.getElementById('notify-success');
const notifyErrorInput = document.getElementById('notify-error');

const btnReset = document.getElementById('btn-reset');
const saveStatus = document.getElementById('save-status');

let saveTimeout = null;
let statusTimeout = null;

/**
 * Initializes the popup by reading saved settings and binding events.
 */
document.addEventListener('DOMContentLoaded', async () => {
  await loadAndDisplaySettings();
  bindEvents();
});

// Flush any pending save immediately when popup is about to close
window.addEventListener('pagehide', () => {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveCurrentSettingsSync();
  }
});

/**
 * Loads current settings from storage and populates the form elements.
 */
async function loadAndDisplaySettings() {
  const settings = await getSettings();
  
  // Sliders
  qualityJpgInput.value = settings.qualityJpg;
  qualityJpgVal.textContent = `%${settings.qualityJpg}`;
  
  qualityWebpInput.value = settings.qualityWebp;
  qualityWebpVal.textContent = `%${settings.qualityWebp}`;

  // Color picker
  jpgBgColorInput.value = settings.jpgBgColor;
  jpgBgHex.textContent = settings.jpgBgColor.toUpperCase();

  // Subfolder
  downloadSubfolderInput.value = settings.downloadSubfolder || '';

  // Notification toggles
  notifyStartInput.checked = Boolean(settings.showStartNotification);
  notifySuccessInput.checked = Boolean(settings.showSuccessNotification);
  notifyErrorInput.checked = Boolean(settings.showErrorNotification);
}

/**
 * Reads values from DOM and returns a clean settings object.
 */
function getCurrentSettingsFromDOM() {
  const cleanSubfolder = downloadSubfolderInput.value
    .trim()
    .replace(/\.\.+/g, '')
    .replace(/[<>:"|?*\\]/g, '')
    .replace(/^\/+|\/+$/g, '');

  return {
    qualityJpg: parseInt(qualityJpgInput.value, 10) || 95,
    qualityWebp: parseInt(qualityWebpInput.value, 10) || 95,
    jpgBgColor: jpgBgColorInput.value.toLowerCase(),
    downloadSubfolder: cleanSubfolder,
    showStartNotification: notifyStartInput.checked,
    showSuccessNotification: notifySuccessInput.checked,
    showErrorNotification: notifyErrorInput.checked
  };
}

/**
 * Immediately saves the current settings and shows confirmation.
 */
async function saveCurrentSettingsSync() {
  const settings = getCurrentSettingsFromDOM();
  const success = await saveSettings(settings);
  if (success) {
    showSavedBadge();
  }
}

/**
 * Binds UI interactions with instant saves for toggles/presets and debounced saves for sliders/text.
 */
function bindEvents() {
  // JPG Slider: Live label on input, save on release / debounce
  qualityJpgInput.addEventListener('input', () => {
    qualityJpgVal.textContent = `%${qualityJpgInput.value}`;
    triggerDebouncedSave();
  });
  qualityJpgInput.addEventListener('change', () => {
    clearTimeout(saveTimeout);
    saveCurrentSettingsSync();
  });

  // WEBP Slider: Live label on input, save on release / debounce
  qualityWebpInput.addEventListener('input', () => {
    qualityWebpVal.textContent = `%${qualityWebpInput.value}`;
    triggerDebouncedSave();
  });
  qualityWebpInput.addEventListener('change', () => {
    clearTimeout(saveTimeout);
    saveCurrentSettingsSync();
  });

  // Color Picker
  jpgBgColorInput.addEventListener('input', () => {
    jpgBgHex.textContent = jpgBgColorInput.value.toUpperCase();
    triggerDebouncedSave();
  });
  jpgBgColorInput.addEventListener('change', () => {
    clearTimeout(saveTimeout);
    saveCurrentSettingsSync();
  });

  // Color Presets (Instant Save)
  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.getAttribute('data-color');
      if (color) {
        jpgBgColorInput.value = color;
        jpgBgHex.textContent = color.toUpperCase();
        clearTimeout(saveTimeout);
        saveCurrentSettingsSync();
      }
    });
  });

  // Download Subfolder
  downloadSubfolderInput.addEventListener('input', () => {
    downloadSubfolderInput.value = downloadSubfolderInput.value
      .replace(/\.\.+/g, '')
      .replace(/[<>:"|?*\\]/g, '');
    triggerDebouncedSave();
  });
  downloadSubfolderInput.addEventListener('change', () => {
    clearTimeout(saveTimeout);
    saveCurrentSettingsSync();
  });

  // Notifications (Instant Save on Toggle)
  notifyStartInput.addEventListener('change', () => {
    clearTimeout(saveTimeout);
    saveCurrentSettingsSync();
  });
  notifySuccessInput.addEventListener('change', () => {
    clearTimeout(saveTimeout);
    saveCurrentSettingsSync();
  });
  notifyErrorInput.addEventListener('change', () => {
    clearTimeout(saveTimeout);
    saveCurrentSettingsSync();
  });

  // Reset to Defaults
  btnReset.addEventListener('click', async () => {
    await resetSettings();
    await loadAndDisplaySettings();
    showSavedBadge();
  });
}

/**
 * Debounced save for high-frequency events like dragging sliders or typing.
 */
function triggerDebouncedSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    await saveCurrentSettingsSync();
  }, 200);
}

/**
 * Shows the "Kaydedildi" status badge temporarily.
 */
function showSavedBadge() {
  saveStatus.classList.add('visible');
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => {
    saveStatus.classList.remove('visible');
  }, 1800);
}
