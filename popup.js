import { getSettings, saveSettings, resetSettings } from './settings.js';
import { resolveLanguage, t } from './i18n.js';
import { sanitizeSubfolder } from './helpers.js';

// DOM Element References
const themeToggleBtn = document.getElementById('theme-toggle');
const langSwitch = document.getElementById('lang-switch');
const langButtons = document.querySelectorAll('.lang-btn');

const qualityJpgInput = document.getElementById('quality-jpg');
const qualityJpgVal = document.getElementById('quality-jpg-val');

const qualityWebpInput = document.getElementById('quality-webp');
const qualityWebpVal = document.getElementById('quality-webp-val');

const jpgBgColorInput = document.getElementById('jpg-bg-color');
const jpgBgHex = document.getElementById('jpg-bg-hex');
const presetButtons = document.querySelectorAll('.preset-btn');

const downloadSubfolderInput = document.getElementById('download-subfolder');

const btnReset = document.getElementById('btn-reset');
const saveStatus = document.getElementById('save-status');

let storedLangPref = 'auto';
let currentLang = 'en';
let storedThemePref = 'auto';
let currentTheme = 'light';
let saveTimeout = null;
let statusTimeout = null;

/**
 * Resolves the effective theme ('light' or 'dark') given user preference.
 *
 * @param {string} [pref] - 'auto', 'light', or 'dark'
 * @returns {'light' | 'dark'}
 */
function resolveTheme(pref) {
  if (pref === 'dark' || pref === 'light') {
    return pref;
  }
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

/**
 * Applies the active theme to the root HTML element.
 *
 * @param {'light' | 'dark'} theme
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Initializes the popup by reading saved settings, applying language, and binding events.
 */
document.addEventListener('DOMContentLoaded', async () => {
  await loadAndDisplaySettings();
  bindEvents();
});

// Flush any pending save immediately when popup loses visibility or is about to close
function flushPendingSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
    saveSettings(getCurrentSettingsFromDOM());
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushPendingSave();
  }
});
window.addEventListener('pagehide', flushPendingSave);

/**
 * Applies translations to all tagged DOM elements.
 * 
 * @param {'tr' | 'en'} lang
 */
function applyTranslations(lang) {
  document.documentElement.lang = lang;

  // Translate text content
  const i18nElements = document.querySelectorAll('[data-i18n]');
  i18nElements.forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) {
      el.textContent = t(key, lang);
    }
  });

  // Translate placeholders
  const placeholderElements = document.querySelectorAll('[data-i18n-placeholder]');
  placeholderElements.forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) {
      el.placeholder = t(key, lang);
    }
  });

  // Translate title tooltips
  const titleElements = document.querySelectorAll('[data-i18n-title]');
  titleElements.forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) {
      el.title = t(key, lang);
    }
  });

  // Update data-active attribute on container for sliding animation
  if (langSwitch) {
    langSwitch.setAttribute('data-active', lang);
  }

  // Update active button state in language switcher
  langButtons.forEach(btn => {
    if (btn.getAttribute('data-lang') === lang) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

/**
 * Loads current settings from storage and populates the form elements.
 */
async function loadAndDisplaySettings() {
  const settings = await getSettings();
  
  // Preserve stored language preference ('auto', 'tr', or 'en') while resolving active UI language
  storedLangPref = settings.language || 'auto';
  currentLang = resolveLanguage(storedLangPref);
  applyTranslations(currentLang);

  // Preserve stored theme preference ('auto', 'light', or 'dark') while resolving active UI theme
  storedThemePref = settings.theme || 'auto';
  currentTheme = resolveTheme(storedThemePref);
  applyTheme(currentTheme);

  // Sliders
  qualityJpgInput.value = settings.qualityJpg;
  qualityJpgVal.textContent = `%${settings.qualityJpg}`;
  
  qualityWebpInput.value = settings.qualityWebp;
  qualityWebpVal.textContent = `%${settings.qualityWebp}`;

  // Color picker
  jpgBgColorInput.value = settings.jpgBgColor;
  jpgBgHex.textContent = settings.jpgBgColor.toUpperCase();
  updateActivePreset(settings.jpgBgColor);

  // Subfolder
  downloadSubfolderInput.value = settings.downloadSubfolder || '';
}

/**
 * Updates the active ring and checkmark on preset color buttons.
 * 
 * @param {string} activeColor
 */
function updateActivePreset(activeColor) {
  const normalized = (activeColor || '').toLowerCase().trim();
  presetButtons.forEach(btn => {
    const btnColor = (btn.getAttribute('data-color') || '').toLowerCase().trim();
    if (btnColor === normalized) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

/**
 * Reads values from DOM and returns a clean settings object.
 */
function getCurrentSettingsFromDOM() {
  const cleanSubfolder = sanitizeSubfolder(downloadSubfolderInput.value);

  return {
    language: storedLangPref,
    theme: storedThemePref,
    qualityJpg: parseInt(qualityJpgInput.value, 10) || 95,
    qualityWebp: parseInt(qualityWebpInput.value, 10) || 95,
    jpgBgColor: jpgBgColorInput.value.toLowerCase(),
    downloadSubfolder: cleanSubfolder
  };
}

/**
 * Immediately saves the current settings and shows confirmation.
 */
async function saveCurrentSettingsSync() {
  saveTimeout = null;
  const settings = getCurrentSettingsFromDOM();
  const success = await saveSettings(settings);
  if (success) {
    showSavedBadge();
  }
}

/**
 * Binds UI interactions with instant saves for presets and debounced saves for sliders/text.
 */
function bindEvents() {
  // Theme Toggle Button
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', async () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      storedThemePref = currentTheme;
      applyTheme(currentTheme);
      clearTimeout(saveTimeout);
      await saveCurrentSettingsSync();
    });
  }

  // Language Switcher
  langButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const selectedLang = btn.getAttribute('data-lang');
      if (selectedLang && (selectedLang !== currentLang || storedLangPref === 'auto')) {
        storedLangPref = selectedLang;
        currentLang = selectedLang;
        applyTranslations(currentLang);
        clearTimeout(saveTimeout);
        await saveCurrentSettingsSync();
      }
    });
  });

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
    updateActivePreset(jpgBgColorInput.value);
    triggerDebouncedSave();
  });
  jpgBgColorInput.addEventListener('change', () => {
    updateActivePreset(jpgBgColorInput.value);
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
        updateActivePreset(color);
        clearTimeout(saveTimeout);
        saveCurrentSettingsSync();
      }
    });
  });

  // Download Subfolder (Preserve cursor position while stripping forbidden characters)
  downloadSubfolderInput.addEventListener('input', () => {
    const rawVal = downloadSubfolderInput.value;
    const cleanedVal = rawVal
      .replace(/\.\.+/g, '')
      .replace(/[<>:"|?*\\\x00-\x1F]/g, '');

    if (cleanedVal !== rawVal) {
      const cursorPos = downloadSubfolderInput.selectionStart || 0;
      const diff = rawVal.length - cleanedVal.length;
      downloadSubfolderInput.value = cleanedVal;
      const newPos = Math.max(0, cursorPos - diff);
      downloadSubfolderInput.setSelectionRange(newPos, newPos);
    }
    triggerDebouncedSave();
  });
  downloadSubfolderInput.addEventListener('change', () => {
    downloadSubfolderInput.value = sanitizeSubfolder(downloadSubfolderInput.value);
    clearTimeout(saveTimeout);
    saveCurrentSettingsSync();
  });

  // Reset to Defaults
  btnReset.addEventListener('click', async () => {
    clearTimeout(saveTimeout);
    saveTimeout = null;
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
