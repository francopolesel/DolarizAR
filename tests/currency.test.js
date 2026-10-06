'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../utils/currency.js');

describe('parseMoney — formato argentino', () => {
  const cases = [
    ['125.000', 125000],
    ['125.000,00', 125000],
    ['125.000,50', 125000.5],
    ['125,000', 125000],
    ['1.250.500', 1250500],
    ['999', 999],
    ['999,50', 999.5],
    ['25.999', 25999],
    ['1.400.000', 1400000],
    ['1,250.50', 1250.5],
    ['999.50', 999.5]
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => assert.equal(C.parseMoney(input), expected));
  }

  it('rechaza formatos ambiguos o inválidos', () => {
    assert.ok(Number.isNaN(C.parseMoney('')));
    assert.ok(Number.isNaN(C.parseMoney('abc')));
    assert.ok(Number.isNaN(C.parseMoney('1.2.3')));
    assert.ok(Number.isNaN(C.parseMoney('1250.000')));
    assert.ok(Number.isNaN(C.parseMoney(125)));
  });
});

describe('convertARS', () => {
  it('125000 / 1540 ≈ 81.1688', () => {
    assert.ok(Math.abs(C.convertARS(125000, 1540) - 81.168831) < 1e-4);
  });
  it('nunca devuelve valores inventados con tasa inválida', () => {
    assert.ok(Number.isNaN(C.convertARS(125000, 0)));
    assert.ok(Number.isNaN(C.convertARS(125000, -5)));
    assert.ok(Number.isNaN(C.convertARS(NaN, 1540)));
  });
  it('inversa: 12500 × 1540 = 19.250.000', () => {
    assert.equal(C.convertUSD(12500, 1540), 19250000);
    assert.ok(Number.isNaN(C.convertUSD(12500, 0)));
  });
});

describe('formatUSD — formato argentino', () => {
  it('US$81,17 con 2 decimales', () => assert.equal(C.formatUSD(81.168831, 2), 'US$81,17'));
  it('agrupa miles con punto: US$1.250,50', () => assert.equal(C.formatUSD(1250.5, 2), 'US$1.250,50'));
  it('soporta 0 decimales', () => assert.equal(C.formatUSD(100, 0), 'US$100'));
  it('NaN -> string vacío (nunca US$NaN)', () => assert.equal(C.formatUSD(NaN, 2), ''));
});

describe('formatARS — equivalente en pesos con $ nativo', () => {
  it('$19.250.000', () => assert.equal(C.formatARS(19250000), '$19.250.000'));
  it('sin decimales forzados: $770,5', () => assert.equal(C.formatARS(770.5), '$770,5'));
  it('NaN -> string vacío', () => assert.equal(C.formatARS(NaN), ''));
});

describe('formatARSWhole / formatFechaES / relativeTimeES', () => {
  it('$1.540', () => assert.equal(C.formatARSWhole(1540), '$1.540'));
  it('fecha ISO -> es-AR', () => {
    const s = C.formatFechaES('2026-10-05T18:10:00.000Z');
    assert.ok(typeof s === 'string' && /\d{2}\/\d{2}\/2026/.test(s), `inesperado: ${s}`);
  });
  it('fecha inválida -> null (no inventa)', () => {
    assert.equal(C.formatFechaES('no-fecha'), null);
    assert.equal(C.formatFechaES(null), null);
  });
  it('relativeTimeES', () => {
    assert.equal(C.relativeTimeES(Date.now() - 4 * 60000), 'hace 4 minutos');
    assert.equal(C.relativeTimeES(Date.now() - 60000), 'hace 1 minuto');
  });
});
