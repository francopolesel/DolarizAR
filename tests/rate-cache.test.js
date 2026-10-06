'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../utils/rate-cache.js');
const S = require('../utils/storage.js');

const NOW = 1800000000000;
const FRESH = { venta: 1540, compra: 1490, fechaActualizacion: '2026-10-05T18:10:00.000Z', fetchedAt: NOW - 4 * 60000 };
const EXPIRED = Object.assign({}, FRESH, { fetchedAt: NOW - 20 * 60000 });

describe('normalizeRateResponse — valida DolarAPI', () => {
  it('acepta la respuesta real {compra, venta, ...}', () => {
    const r = R.normalizeRateResponse({
      moneda: 'USD', casa: 'oficial', nombre: 'Oficial',
      compra: 1490, venta: 1540, fechaActualizacion: '2026-10-05T18:10:00.000Z'
    });
    assert.deepEqual(r, { venta: 1540, compra: 1490, fechaActualizacion: '2026-10-05T18:10:00.000Z' });
  });
  it('rechaza venta 0, ausente o inválida (nunca US$0)', () => {
    assert.equal(R.normalizeRateResponse({ venta: 0, compra: 1 }), null);
    assert.equal(R.normalizeRateResponse({ compra: 1 }), null);
    assert.equal(R.normalizeRateResponse({ venta: 'abc' }), null);
    assert.equal(R.normalizeRateResponse(null), null);
    assert.equal(R.normalizeRateResponse({ venta: 1540, compra: 0 }).compra, null);
  });
});

describe('isCacheValid — TTL 15 minutos', () => {
  it('cache válido -> no fetch', () => assert.equal(R.isCacheValid(FRESH, 15, NOW), true));
  it('cache expirado -> fetch', () => assert.equal(R.isCacheValid(EXPIRED, 15, NOW), false));
  it('sin cache o corrupto -> fetch', () => {
    assert.equal(R.isCacheValid(null, 15, NOW), false);
    assert.equal(R.isCacheValid({ venta: 0, fetchedAt: NOW }, 15, NOW), false);
    assert.equal(R.isCacheValid({ venta: 1540 }, 15, NOW), false);
  });
  it('TTL configurable', () => {
    assert.equal(R.isCacheValid(EXPIRED, 30, NOW), true);
    assert.equal(R.isCacheValid(FRESH, 0, NOW), false);
  });
});

describe('normalizeSettings', () => {
  it('defaults: activada, pesos→dólares', () => {
    assert.deepEqual(S.normalizeSettings(null), { enabled: true, direction: 'ars-to-usd', decimals: 2, cacheTtlMinutes: 15 });
  });
  it('respeta apagado, dirección y decimales válidos', () => {
    assert.deepEqual(
      S.normalizeSettings({ enabled: false, direction: 'usd-to-ars', decimals: 0, cacheTtlMinutes: 30 }),
      { enabled: false, direction: 'usd-to-ars', decimals: 0, cacheTtlMinutes: 30 });
  });
  it('migra settings viejos {enabled:false, inverseEnabled:true} a usd-to-ars', () => {
    assert.equal(
      S.normalizeSettings({ enabled: false, inverseEnabled: true }).direction, 'usd-to-ars');
  });
  it('migra settings viejos con ambos activos (o default) a ars-to-usd', () => {
    assert.equal(
      S.normalizeSettings({ enabled: true, inverseEnabled: true }).direction, 'ars-to-usd');
    assert.equal(S.normalizeSettings({}).direction, 'ars-to-usd');
  });
  it('sanea valores inválidos', () => {
    assert.deepEqual(
      S.normalizeSettings({ direction: 'lateral', decimals: 5, cacheTtlMinutes: -3 }),
      { enabled: true, direction: 'ars-to-usd', decimals: 2, cacheTtlMinutes: 15 });
  });
});
