/**
 * Wrapper de chrome.storage con defaults y normalización. UMD.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DolarizarStorage = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_SETTINGS = {
    enabled: true,
    direction: 'ars-to-usd',
    decimals: 2,
    cacheTtlMinutes: 15
  };

  /**
   * Un solo modo activo por vez: 'ars-to-usd' o 'usd-to-ars'.
   * Migra settings viejos { enabled, inverseEnabled } al nuevo modelo.
   */
  function normalizeSettings(raw) {
    var s = raw && typeof raw === 'object' ? raw : {};
    var direction = 'ars-to-usd';
    if (s.direction === 'usd-to-ars' || s.direction === 'ars-to-usd') {
      direction = s.direction;
    } else if (s.inverseEnabled === true && s.enabled === false) {
      direction = 'usd-to-ars';
    }
    return {
      enabled: s.enabled !== false,
      direction: direction,
      decimals: s.decimals === 0 ? 0 : 2,
      cacheTtlMinutes: Number.isFinite(s.cacheTtlMinutes) && s.cacheTtlMinutes > 0
        ? Math.min(1440, s.cacheTtlMinutes)
        : DEFAULT_SETTINGS.cacheTtlMinutes
    };
  }

  function storageArea(area) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage[area]) {
      return chrome.storage[area];
    }
    throw new Error('[DolarizAR] chrome.storage.' + area + ' no disponible');
  }

  function getAll(area, keys) {
    return new Promise(function (resolve, reject) {
      try {
        storageArea(area).get(keys, function (items) {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(items || {});
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function setAll(area, items) {
    return new Promise(function (resolve, reject) {
      try {
        storageArea(area).set(items, function () {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function getSettings() {
    return getAll('sync', { dolarizarSettings: DEFAULT_SETTINGS }).then(function (items) {
      return normalizeSettings(items.dolarizarSettings);
    });
  }

  function saveSettings(patch) {
    return getSettings().then(function (current) {
      var next = normalizeSettings(Object.assign({}, current, patch));
      return setAll('sync', { dolarizarSettings: next }).then(function () { return next; });
    });
  }

  function getCachedRate() {
    return getAll('local', { dolarizarRate: null }).then(function (items) {
      return items.dolarizarRate || null;
    });
  }

  function setCachedRate(rate) {
    return setAll('local', { dolarizarRate: rate });
  }

  return {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeSettings: normalizeSettings,
    getSettings: getSettings,
    saveSettings: saveSettings,
    getCachedRate: getCachedRate,
    setCachedRate: setCachedRate
  };
});
