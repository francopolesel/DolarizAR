/**
 * Lógica pura de cache de cotización (testeable en Node y reutilizable
 * en el service worker). Sin dependencias de chrome.*.
 * UMD.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DolarizarRateCache = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CACHE_KEY = 'dolarizarRate';

  /**
   * Valida y normaliza la respuesta de DolarAPI.
   * Esperado: { compra, venta, fechaActualizacion, ... }
   * Devuelve { venta, compra, fechaActualizacion } o null si inválida.
   */
  function normalizeRateResponse(json) {
    if (!json || typeof json !== 'object') return null;
    var venta = Number(json.venta);
    if (!Number.isFinite(venta) || venta <= 0) return null;
    var compra = Number(json.compra);
    return {
      venta: venta,
      compra: Number.isFinite(compra) && compra > 0 ? compra : null,
      fechaActualizacion: typeof json.fechaActualizacion === 'string' ? json.fechaActualizacion : null
    };
  }

  /**
   * true si existe cache con venta válida y no expiró el TTL.
   */
  function isCacheValid(cached, ttlMinutes, now) {
    if (!cached || typeof cached !== 'object') return false;
    if (!Number.isFinite(cached.venta) || cached.venta <= 0) return false;
    if (!Number.isFinite(cached.fetchedAt)) return false;
    var ttl = Number(ttlMinutes);
    if (!Number.isFinite(ttl) || ttl <= 0) return false;
    var at = Number(now);
    if (!Number.isFinite(at)) at = Date.now();
    return at - cached.fetchedAt < ttl * 60000;
  }

  return {
    CACHE_KEY: CACHE_KEY,
    normalizeRateResponse: normalizeRateResponse,
    isCacheValid: isCacheValid
  };
});
