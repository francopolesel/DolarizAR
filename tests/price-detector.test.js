'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../utils/price-detector.js');
const C = require('../utils/currency.js');

const RATE = 1540; // venta de referencia (verificada contra DolarAPI)

function firstCandidate(text) {
  const c = D.extractPriceCandidates(text);
  assert.ok(c.length > 0, `sin candidatos en: ${text}`);
  return c[0];
}

function confidenceOf(rawText, candidate, ctx) {
  const amount = C.parseMoney(candidate.amountStr);
  return D.calculateConfidence(candidate, amount, Object.assign(
    { afterText: rawText.slice(candidate.end, candidate.end + 8) }, ctx));
}

describe('extractPriceCandidates — formatos positivos', () => {
  const positives = [
    '$125.000', '$ 125.000', '$125,000', '$ 125,000', '$125.000,00',
    'ARS 125.000', 'ARS 125000', '125.000 ARS', '125000 pesos',
    '125.000 pesos', '125.000 pesos argentinos', 'Precio: $125.000',
    'Desde $125.000', 'Total $125.000', '$1.250.500', '$999', '$999,50'
  ];
  for (const text of positives) {
    it(`detecta "${text}"`, () => {
      const c = D.extractPriceCandidates(text);
      assert.ok(c.length >= 1, 'debería haber al menos un candidato');
      assert.ok(Number.isFinite(C.parseMoney(c[0].amountStr)), 'monto parseable');
    });
  }
});

describe('extractPriceCandidates — números sueltos no son candidatos', () => {
  for (const text of ['2026', '1650', '15', '100%', '123456789', 'Código Postal: 1650', '12 cuotas']) {
    it(`ignora "${text}"`, () => {
      assert.equal(D.extractPriceCandidates(text).length, 0);
    });
  }
  it('en "12 cuotas de $10.499" solo el precio es candidato', () => {
    const c = D.extractPriceCandidates('12 cuotas de $10.499');
    assert.equal(c.length, 1);
    assert.equal(c[0].amountStr, '10.499');
  });
});

describe('detectCurrency', () => {
  const cases = [
    ['US$125', 'USD'], ['USD 125', 'USD'], ['125 dólares', 'USD'],
    ['€125', 'EUR'], ['125 EUR', 'EUR'], ['£125', 'GBP'],
    ['ARS 125.000', 'ARS'], ['125.000 pesos', 'ARS'], ['$125.000', 'AMBIGUOUS_DOLLAR']
  ];
  for (const [text, expected] of cases) {
    it(`"${text}" -> ${expected}`, () => {
      assert.equal(D.detectCurrency(firstCandidate(text)), expected);
    });
  }
});

describe('calculateConfidence — convierte precios ARS reales', () => {
  it('$125.000 con formato AR convierte sin más contexto', () => {
    const text = '$125.000';
    const r = confidenceOf(text, firstCandidate(text), {});
    assert.equal(r.convertible, true);
  });
  it('$999 solo en sitio argentino', () => {
    const text = '$999';
    assert.equal(confidenceOf(text, firstCandidate(text), {}).convertible, false);
    assert.equal(confidenceOf(text, firstCandidate(text), { isArgentineSite: true }).convertible, true);
  });
  it('ARS explícito convierte en cualquier sitio', () => {
    const text = 'ARS 125.000';
    assert.equal(confidenceOf(text, firstCandidate(text), {}).convertible, true);
  });
  it('"125.000 pesos argentinos" convierte', () => {
    const text = 'Lleva 125.000 pesos argentinos';
    const cands = D.extractPriceCandidates(text);
    assert.ok(cands.length > 0);
    assert.equal(confidenceOf(text, cands[0], {}).convertible, true);
  });
});

describe('calculateConfidence — vetos (nunca convertir)', () => {
  const vetoes = [
    ['US$125', {}, 'foreign-currency'],
    ['USD 125', {}, 'foreign-currency'],
    ['€125', {}, 'foreign-currency'],
    ['125 EUR', {}, 'foreign-currency'],
    ['125 dólares', {}, 'foreign-currency'],
    ['$2026', {}, 'year-like'],
    ['$123456789', {}, 'too-long']
  ];
  for (const [text, ctx, veto] of vetoes) {
    it(`veta "${text}" (${veto})`, () => {
      const r = confidenceOf(text, firstCandidate(text), ctx);
      assert.equal(r.convertible, false);
      assert.equal(r.veto, veto);
    });
  }
  it('veta "$20 USD" por sufijo extranjero adyacente', () => {
    const text = '$20 USD';
    const r = confidenceOf(text, firstCandidate(text), {});
    assert.equal(r.convertible, false);
    assert.equal(r.veto, 'foreign-currency');
  });
  it('veta porcentaje "$100%"', () => {
    const text = 'Descuento $100% hoy';
    const r = confidenceOf(text, firstCandidate(text), {});
    assert.equal(r.convertible, false);
    assert.equal(r.veto, 'percent');
  });
});

describe('planInverseReplacements — USD -> ARS (función extra)', () => {
  it('U$S 12.500 -> $19.250.000 (venta 1540)', () => {
    const plans = D.planInverseReplacements('U$S 12.500', { rate: RATE });
    assert.equal(plans.length, 1);
    assert.equal(plans[0].kind, 'ars');
    assert.equal(plans[0].arsText, '$19.250.000');
  });
  it('convierte "USD 500", "US$500" y "500 dólares"', () => {
    assert.equal(D.planInverseReplacements('USD 500', { rate: RATE })[0].arsText, '$770.000');
    assert.equal(D.planInverseReplacements('US$500', { rate: RATE }).length, 1);
    assert.equal(D.planInverseReplacements('Auto a 500 dólares', { rate: RATE }).length, 1);
  });
  it('convierte "$20 USD" por sufijo adyacente', () => {
    const plans = D.planInverseReplacements('$20 USD', { rate: RATE });
    assert.equal(plans.length, 1);
    assert.equal(plans[0].arsText, '$30.800');
  });
  it('NO toca EUR/GBP ni "$" ambiguo', () => {
    assert.equal(D.planInverseReplacements('€500', { rate: RATE }).length, 0);
    assert.equal(D.planInverseReplacements('500 EUR', { rate: RATE }).length, 0);
    assert.equal(D.planInverseReplacements('£500', { rate: RATE }).length, 0);
    assert.equal(D.planInverseReplacements('$125.000', { rate: RATE }).length, 0);
  });
  it('mantiene vetos: porcentaje y año', () => {
    assert.equal(D.planInverseReplacements('USD 100%', { rate: RATE }).length, 0);
    assert.equal(D.planInverseReplacements('USD 2026', { rate: RATE }).length, 0);
  });
  it('sin tasa válida -> []', () => {
    assert.equal(D.planInverseReplacements('U$S 100', { rate: 0 }).length, 0);
  });
});

describe('planTextReplacements — pipeline completo', () => {
  it('$125.000 -> ≈ US$81,17 (venta 1540)', () => {
    const plans = D.planTextReplacements('$125.000', { rate: RATE });
    assert.equal(plans.length, 1);
    assert.equal(plans[0].usdText, 'US$81,17');
  });
  it('$1.250.000 -> ≈ US$811,69', () => {
    const plans = D.planTextReplacements('$1.250.000', { rate: RATE });
    assert.equal(plans.length, 1);
    assert.equal(plans[0].usdText, 'US$811,69');
  });
  it('cuotas: convierte el precio, no el "12"', () => {
    const text = '12 cuotas de $10.499';
    const plans = D.planTextReplacements(text, { nearbyText: text, rate: RATE });
    assert.equal(plans.length, 1);
    assert.equal(plans[0].usdText, 'US$6,82');
  });
  it('rango "$100.000 - $150.000" -> dos conversiones', () => {
    const plans = D.planTextReplacements('$100.000 - $150.000', { rate: RATE });
    assert.equal(plans.length, 2);
    assert.equal(plans[0].usdText, 'US$64,94');
    assert.equal(plans[1].usdText, 'US$97,40');
  });
  it('sin tasa válida -> no hay planes (Caso B)', () => {
    assert.equal(D.planTextReplacements('$125.000', { rate: 0 }).length, 0);
    assert.equal(D.planTextReplacements('$125.000', { rate: NaN }).length, 0);
    assert.equal(D.planTextReplacements('$125.000', {}).length, 0);
  });
  it('texto sin precios -> sin planes', () => {
    assert.equal(D.planTextReplacements('Código Postal: 1650. Año 2026.', { rate: RATE }).length, 0);
  });
});
