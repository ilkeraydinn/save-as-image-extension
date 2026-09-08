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
 * Binds UI interactions and debounced auto-save.
 */
function bindEvents() {
  // JPG Slider
  qualityJpgInput.addEventListener('input', () => {
    qualityJpgVal.textContent = `%${qualityJpgInput.value}`;
    triggerAutoSave();
  });

  // WEBP Slider
  qualityWebpInput.addEventListener('input', () => {
    qualityWebpVal.textContent = `%${qualityWebpInput.value}`;
    triggerAutoSave();
  });

  // Color Picker
  jpgBgColorInput.addEventListener('input', () => {
    jpgBgHex.textContent = jpgBgColorInput.value.toUpperCase();
    triggerAutoSave();
  });

  // Color Presets
  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.getAttribute('data-color');
      if (color) {
        jpgBgColorInput.value = color;
        jpgBgHex.textContent = color.toUpperCase();
        triggerAutoSave();
      }
    });
  });

  // Download Subfolder
  downloadSubfolderInput.addEventListener('input', () => {
    // Sanitize subfolder characters
    downloadSubfolderInput.value = downloadSubfolderInput.value.replace(/[<>:"|?*\\]/g, '');
    triggerAutoSave();
  });

  // Notifications
  notifyStartInput.addEventListener('change', triggerAutoSave);
  notifySuccessInput.addEventListener('change', triggerAutoSave);
  notifyErrorInput.addEventListener('change', triggerAutoSave);

  // Reset to Defaults
  btnReset.addEventListener('click', async () => {
    await resetSettings();
    await loadAndDisplaySettings();
    showSavedBadge();
  });
}

/**
 * Collects current form values and schedules an auto-save.
 */
function triggerAutoSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    const newSettings = {
      qualityJpg: parseInt(qualityJpgInput.value, 10),
      qualityWebp: parseInt(qualityWebpInput.value, 10),
      jpgBgColor: jpgBgColorInput.value.toLowerCase(),
      downloadSubfolder: downloadSubfolderInput.value.trim().replace(/^\/+|\/+$/g, ''),
      showStartNotification: notifyStartInput.checked,
      showSuccessNotification: notifySuccessInput.checked,
      showErrorNotification: notifyErrorInput.checked
    };

    const success = await saveSettings(newSettings);
    if (success) {
      showSavedBadge();
    }
  }, 150);
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
