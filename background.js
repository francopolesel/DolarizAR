/**
 * DolarizAR — Service Worker (Manifest V3).
 * Único responsable de consultar DolarAPI, cachear y responder mensajes.
 * El content script NUNCA hace fetch directo.
 */
'use strict';

try {
  importScripts('utils/currency.js', 'utils/rate-cache.js', 'utils/storage.js');
} catch (e) {
  console.error('[DolarizAR] No se pudieron cargar los utils del SW:', e);
}

var DOLAR_API_URL = 'https://dolarapi.com/v1/dolares/oficial';
var FETCH_TIMEOUT_MS = 10000;

/** Deduplicación: requests concurrentes comparten la misma Promise. */
var inflightRateRequest = null;

function log() {
  // Activar manualmente durante desarrollo.
  var DEBUG = false;
  if (DEBUG) console.log.apply(console, ['[DolarizAR]'].concat(Array.prototype.slice.call(arguments)));
}

function fetchWithTimeout(url, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  return fetch(url, { signal: controller.signal, cache: 'no-store' }).finally(function () {
    clearTimeout(timer);
  });
}

function readSettings() {
  return DolarizarStorage.getSettings().catch(function () {
    return Object.assign({}, DolarizarStorage.DEFAULT_SETTINGS);
  });
}

/**
 * Equivalente a getOfficialDollarRate().
 * { forceRefresh } -> Promise<{ venta, compra, fechaActualizacion, fetchedAt, source }>
 * source: 'cache' | 'network' | 'stale-cache'. Nunca inventa cotizaciones:
 * sin cache y con API caída, rechaza con NO_RATE.
 */
function getOfficialDollarRate(options) {
  var forceRefresh = !!(options && options.forceRefresh);

  function fromCache() {
    return DolarizarStorage.getCachedRate().catch(function () { return null; });
  }

  if (!forceRefresh) {
    return readSettings().then(function (settings) {
      return fromCache().then(function (cached) {
        if (DolarizarRateCache.isCacheValid(cached, settings.cacheTtlMinutes, Date.now())) {
          log('Cotización desde cache:', cached.venta);
          return Object.assign({}, cached, { source: 'cache' });
        }
        return fetchAndStore();
      });
    });
  }
  return fetchAndStore();

  function fetchAndStore() {
    if (inflightRateRequest) return inflightRateRequest;
    inflightRateRequest = fetchWithTimeout(DOLAR_API_URL, FETCH_TIMEOUT_MS)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        var rate = DolarizarRateCache.normalizeRateResponse(json);
        if (!rate) throw new Error('Respuesta inválida de DolarAPI');
        var stored = {
          venta: rate.venta,
          compra: rate.compra,
          fechaActualizacion: rate.fechaActualizacion,
          fetchedAt: Date.now()
        };
        return DolarizarStorage.setCachedRate(stored).catch(function () {
          /* storage lleno/bloqueado: igual entregar la cotización */
        }).then(function () {
          log('Cotización obtenida:', stored.venta);
          return Object.assign({}, stored, { source: 'network' });
        });
      })
      .catch(function (err) {
        // Caso A: API caída pero hay cache (aunque expirado) -> usarlo.
        return fromCache().then(function (cached) {
          if (cached && Number.isFinite(cached.venta) && cached.venta > 0) {
            return Object.assign({}, cached, { source: 'stale-cache' });
          }
          // Caso B: sin cache -> no convertir.
          var noRate = new Error('NO_RATE');
          noRate.cause = err;
          throw noRate;
        });
      })
      .finally(function () {
        inflightRateRequest = null;
      });
    return inflightRateRequest;
  }
}

function broadcastToTabs(message) {
  if (!chrome.tabs || !chrome.tabs.query) return Promise.resolve();
  return chrome.tabs.query({}).then(function (tabs) {
    tabs.forEach(function (tab) {
      if (tab.id != null) chrome.tabs.sendMessage(tab.id, message).catch(function () { /* tab sin content script */ });
    });
  }).catch(function () { /* sin permiso de tabs en algún contexto */ });
}

function isValidMessage(msg) {
  return !!msg && typeof msg === 'object' && typeof msg.type === 'string';
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!isValidMessage(msg)) {
    sendResponse({ ok: false, error: 'INVALID_MESSAGE' });
    return false;
  }

  if (msg.type === 'GET_RATE') {
    getOfficialDollarRate({ forceRefresh: false }).then(function (rate) {
      sendResponse({ ok: true, rate: rate });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message === 'NO_RATE' ? 'NO_RATE' : 'RATE_ERROR' });
    });
    return true;
  }

  if (msg.type === 'FORCE_REFRESH') {
    getOfficialDollarRate({ forceRefresh: true }).then(function (rate) {
      sendResponse({ ok: true, rate: rate });
      broadcastToTabs({ type: 'RATE_UPDATED', rate: rate });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message === 'NO_RATE' ? 'NO_RATE' : 'RATE_ERROR' });
    });
    return true;
  }

  if (msg.type === 'GET_SETTINGS') {
    readSettings().then(function (settings) {
      sendResponse({ ok: true, settings: settings });
    }).catch(function () {
      sendResponse({ ok: false, error: 'SETTINGS_ERROR' });
    });
    return true;
  }

  if (msg.type === 'SET_DIRECTION') {
    if (msg.direction !== 'ars-to-usd' && msg.direction !== 'usd-to-ars') {
      sendResponse({ ok: false, error: 'INVALID_MESSAGE' });
      return false;
    }
    DolarizarStorage.saveSettings({ direction: msg.direction }).then(function (settings) {
      sendResponse({ ok: true, settings: settings });
      broadcastToTabs({ type: 'DOLARIZAR_SETTINGS_CHANGED', settings: settings });
    }).catch(function () {
      sendResponse({ ok: false, error: 'SETTINGS_ERROR' });
    });
    return true;
  }

  if (msg.type === 'SET_ENABLED') {
    if (typeof msg.enabled !== 'boolean') {
      sendResponse({ ok: false, error: 'INVALID_MESSAGE' });
      return false;
    }
    DolarizarStorage.saveSettings({ enabled: msg.enabled }).then(function (settings) {
      sendResponse({ ok: true, settings: settings });
      broadcastToTabs({ type: 'DOLARIZAR_SETTINGS_CHANGED', settings: settings });
    }).catch(function () {
      sendResponse({ ok: false, error: 'SETTINGS_ERROR' });
    });
    return true;
  }

  sendResponse({ ok: false, error: 'UNKNOWN_MESSAGE' });
  return false;
});

/* ---------- Auto-actualización en segundo plano (sin acción del usuario) ---------- */

var REFRESH_ALARM_NAME = 'dolarizar-refresh';
var REFRESH_PERIOD_MINUTES = 15; // igual que el TTL del cache

function ensureRefreshAlarm() {
  try {
    if (!chrome.alarms) return;
    chrome.alarms.get(REFRESH_ALARM_NAME, function (alarm) {
      if (!alarm) {
        chrome.alarms.create(REFRESH_ALARM_NAME, { periodInMinutes: REFRESH_PERIOD_MINUTES });
      }
    });
  } catch (e) { /* alarms no disponible: el cache TTL sigue funcionando */ }
}

if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (!alarm || alarm.name !== REFRESH_ALARM_NAME) return;
    // Fuerza red y avisa a las tabs SOLO si hay cotización fresca:
    // sin red se sigue usando el cache sin re-renderizar de más.
    getOfficialDollarRate({ forceRefresh: true }).then(function (rate) {
      if (rate && rate.source === 'network') {
        broadcastToTabs({ type: 'RATE_UPDATED', rate: rate });
      }
    }).catch(function () { /* sin red: silencio, el cache sigue vigente */ });
  });
}

chrome.runtime.onInstalled.addListener(function () {
  readSettings().then(function (settings) {
    return DolarizarStorage.saveSettings(settings);
  }).catch(function () { /* no crítico */ });
  ensureRefreshAlarm();
});

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(function () {
    ensureRefreshAlarm();
  });
}
