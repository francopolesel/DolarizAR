/* DolarizAR popup: estado, toggle y actualización forzada. Sin frameworks. */
'use strict';

(function () {
  var els = {};
  ['dz-rate-value', 'dz-rate-date', 'dz-rate-ago', 'dz-source-note', 'dz-error',
   'dz-enabled', 'dz-mode-label', 'dz-mode-example', 'dz-mode-hint', 'dz-switch',
   'dz-decimals'].forEach(function (id) {
    els[id] = document.getElementById(id);
  });

  var currentDirection = 'ars-to-usd';

  var Currency = window.DolarizarCurrency;

  function sendMessage(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          resolve(res || { ok: false, error: 'NO_RESPONSE' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'NO_RESPONSE' });
      }
    });
  }

  function showError(text) {
    if (!text) {
      els['dz-error'].hidden = true;
      els['dz-error'].textContent = '';
    } else {
      els['dz-error'].hidden = false;
      els['dz-error'].textContent = text;
    }
  }

  function renderRate(rate) {
    if (!rate || !Number.isFinite(rate.venta)) {
      els['dz-rate-value'].textContent = '—';
      els['dz-rate-date'].textContent = 'sin datos';
      els['dz-rate-ago'].textContent = '—';
      return;
    }
    els['dz-rate-value'].textContent = Currency.formatARSWhole(rate.venta);
    var fecha = Currency.formatFechaES(rate.fechaActualizacion);
    els['dz-rate-date'].textContent = fecha || 'Actualizado recientemente';
    els['dz-rate-ago'].textContent = rate.fetchedAt
      ? Currency.relativeTimeES(rate.fetchedAt)
      : '—';
    if (rate.source === 'stale-cache') {
      els['dz-source-note'].hidden = false;
      els['dz-source-note'].textContent = 'Sin conexión: mostrando última cotización guardada.';
    } else {
      els['dz-source-note'].hidden = true;
    }
  }

  function renderSettings(settings) {
    var on = settings.enabled !== false;
    els['dz-enabled'].classList.toggle('is-on', on);
    els['dz-enabled'].setAttribute('aria-checked', String(on));
    currentDirection = settings.direction === 'usd-to-ars' ? 'usd-to-ars' : 'ars-to-usd';
    if (currentDirection === 'usd-to-ars') {
      els['dz-mode-label'].textContent = 'Dólares → Pesos';
      els['dz-mode-example'].textContent = 'U$S 500 → $770.000';
      els['dz-mode-hint'].textContent = 'Los precios en dólares se muestran en pesos.';
    } else {
      els['dz-mode-label'].textContent = 'Pesos → Dólares';
      els['dz-mode-example'].textContent = '$125.000 → US$81,17';
      els['dz-mode-hint'].textContent = 'Los precios en pesos se muestran en dólares.';
    }
    els['dz-decimals'].value = settings.decimals === 0 ? '0' : '2';
  }

  function setSwitchLoading(loading) {
    els['dz-switch'].disabled = loading;
    els['dz-switch'].textContent = loading ? 'Cambiando…' : 'Cambiar moneda';
  }

  function loadAll() {
    return Promise.all([sendMessage({ type: 'GET_SETTINGS' }), sendMessage({ type: 'GET_RATE' })])
      .then(function (results) {
        var settingsRes = results[0];
        var rateRes = results[1];
        if (settingsRes && settingsRes.ok) renderSettings(settingsRes.settings);
        if (rateRes && rateRes.ok) {
          showError(null);
          renderRate(rateRes.rate);
        } else if (rateRes && rateRes.error === 'NO_RATE') {
          showError('Sin cotización: revisá tu conexión. Se reintentará automáticamente.');
          renderRate(null);
        } else {
          showError('No se pudo obtener la cotización.');
          renderRate(null);
        }
      });
  }

  els['dz-enabled'].addEventListener('click', function () {
    var willEnable = !els['dz-enabled'].classList.contains('is-on');
    sendMessage({ type: 'SET_ENABLED', enabled: willEnable }).then(function (res) {
      if (res && res.ok) renderSettings(res.settings);
    });
  });

  els['dz-switch'].addEventListener('click', function () {
    var next = currentDirection === 'usd-to-ars' ? 'ars-to-usd' : 'usd-to-ars';
    setSwitchLoading(true);
    showError(null);
    // Cambia el modo; la página se re-renderiza al instante con el cache.
    // La cotización se refresca sola por alarma, sin acción del usuario.
    sendMessage({ type: 'SET_DIRECTION', direction: next }).then(function (res) {
      setSwitchLoading(false);
      if (res && res.ok) renderSettings(res.settings);
    });
  });

  els['dz-decimals'].addEventListener('change', function () {
    var decimals = els['dz-decimals'].value === '0' ? 0 : 2;
    try {
      chrome.storage.sync.get({ dolarizarSettings: null }, function (items) {
        var current = (items && items.dolarizarSettings) || {};
        current.decimals = decimals;
        chrome.storage.sync.set({ dolarizarSettings: current });
      });
    } catch (e) { /* noop */ }
  });

  document.addEventListener('DOMContentLoaded', loadAll);
  loadAll();
})();
