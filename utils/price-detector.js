/**
 * Detector de precios ARS. Lógica pura (sin DOM): extraer candidatos,
 * determinar moneda, calcular confianza y planificar reemplazos.
 * UMD: usa DolarizarCurrency si está disponible globalmente o por require.
 */
(function (root, factory) {
  var Currency = null;
  try {
    if (typeof require === 'function') Currency = require('./currency.js');
  } catch (e) { /* contexto navegador: se usa el global */ }
  var api = factory(root, Currency);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DolarizarDetector = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, RequiredCurrency) {
  'use strict';

  function getCurrency() {
    if (RequiredCurrency) return RequiredCurrency;
    if (root && root.DolarizarCurrency) return root.DolarizarCurrency;
    throw new Error('[DolarizAR] DolarizarCurrency no disponible');
  }

  /** Umbral: solo convertir si el score lo alcanza. */
  var CONFIDENCE_THRESHOLD = 60;

  var AR_THOUSANDS_RE = /^\d{1,3}(\.\d{3})+$/; // 125.000 | 1.250.500
  var COMMA_DECIMAL_RE = /,\d{1,2}$/; // 999,50 | 125.000,50

  // Palabras que indican precio cerca del candidato (ventana de contexto).
  var PRICE_WORDS = ['precio', 'precios', 'total', 'totales', 'desde', 'oferta', 'ofertas',
    'cuota', 'cuotas', 'descuento', 'descuentos', 'valor', 'costo', 'costos', 'pagar', 'paga'];
  var AR_MARKERS = ['peso', 'pesos', 'argentina', 'argentino', 'argentinos', 'argentinas',
    'mercado libre', 'mercadolibre', 'cuotas', 'envío', 'envio', 'caba', 'buenos aires'];

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function hasAny(haystack, words) {
    var h = norm(haystack);
    for (var i = 0; i < words.length; i++) {
      if (h.indexOf(words[i]) !== -1) return true;
    }
    return false;
  }

  /**
   * Extrae candidatos monetarios de un string.
   * Solo matchea números con marcador de moneda ($ o palabra); los números
   * sueltos (años, cantidades, CP) nunca son candidatos.
   * Devuelve [{ raw, amountStr, prefix, suffix, start, end }].
   */
  function extractPriceCandidates(text) {
    if (typeof text !== 'string' || !text) return [];
    var out = [];
    var seen = []; // rangos ocupados [start,end]

    function overlaps(start, end) {
      for (var i = 0; i < seen.length; i++) {
        if (start < seen[i][1] && end > seen[i][0]) return true;
      }
      return false;
    }

    function push(m, prefix, amountStr, suffix) {
      var start = m.index;
      var end = start + m[0].length;
      if (overlaps(start, end)) return;
      seen.push([start, end]);
      out.push({
        raw: m[0],
        prefix: prefix || '',
        amountStr: amountStr || '',
        suffix: suffix || '',
        start: start,
        end: end
      });
    }

    var rePrefixed = /(ARS|US\$|USD|U\$S)\s*\$?\s*(\d[\d.,]*)/gi;
    var reDollar = /\$\s*(\d[\d.,]*)/g;
    var reSuffixed = /(\d[\d.,]*)\s*(ARS|pesos argentinos|pesos|d[oó]lares|d[oó]lar|dollars?|USD|US\$|EUR|€|GBP|£)\b/gi;
    var reSymbolPrefix = /(€|£)\s*(\d[\d.,]*)/g;
    var m;

    while ((m = rePrefixed.exec(text)) !== null) push(m, m[1], m[2], '');
    while ((m = reDollar.exec(text)) !== null) push(m, '$', m[1], '');
    while ((m = reSuffixed.exec(text)) !== null) push(m, '', m[1], m[2]);
    while ((m = reSymbolPrefix.exec(text)) !== null) push(m, m[1], m[2], '');

    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /**
   * Clasifica la moneda del candidato.
   * 'ARS' | 'USD' | 'EUR' | 'GBP' | 'FOREIGN' | 'AMBIGUOUS_DOLLAR'
   */
  function detectCurrency(candidate) {
    var pre = norm(candidate.prefix);
    var suf = norm(candidate.suffix);
    var both = pre + ' ' + suf;

    if (both.indexOf('us$') !== -1 || both.indexOf('u$s') !== -1) return 'USD';
    if (/\busd\b/.test(both)) return 'USD';
    if (both.indexOf('dolar') !== -1 || both.indexOf('dollar') !== -1) return 'USD';
    if (both.indexOf('eur') !== -1 || both.indexOf('euro') !== -1 || both.indexOf('€') !== -1) return 'EUR';
    if (both.indexOf('gbp') !== -1 || both.indexOf('£') !== -1 || both.indexOf('libra') !== -1) return 'GBP';
    if (/\b(clp|mxn|brl|uyu|pen|cop)\b/.test(both)) return 'FOREIGN';

    if (/\bars\b/.test(both)) return 'ARS';
    if (both.indexOf('peso') !== -1) return 'ARS'; // pesos, pesos argentinos
    if (pre.indexOf('$') !== -1) return 'AMBIGUOUS_DOLLAR';
    return 'ARS'; // ej. "125.000 pesos" ya capturado arriba; fallback seguro
  }

  function isARThousandsFormat(amountStr) {
    return AR_THOUSANDS_RE.test(amountStr);
  }

  function isCommaDecimalFormat(amountStr) {
    return COMMA_DECIMAL_RE.test(amountStr);
  }

  /**
   * Scoring de confianza. ctx: { isArgentineSite, nearbyText, priceClassHint,
   * jsonLdARS, afterText }.
   * Devuelve { score, convertible, veto, reasons[] }.
   */
  function calculateConfidence(candidate, amount, ctx) {
    ctx = ctx || {};
    var reasons = [];
    var score = 0;
    var veto = null;

    var currency = detectCurrency(candidate);
    if (currency === 'USD' || currency === 'EUR' || currency === 'GBP' || currency === 'FOREIGN') {
      return { score: -100, convertible: false, veto: 'foreign-currency', reasons: ['moneda extranjera explícita'] };
    }

    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e12) {
      return { score: -100, convertible: false, veto: 'invalid-amount', reasons: ['monto inválido'] };
    }

    var digitsOnly = candidate.amountStr.replace(/[.,]/g, '');

    // Año sin separadores: 2026, 1998...
    if (/^\d{4}$/.test(digitsOnly) && amount >= 1900 && amount <= 2100 && candidate.amountStr.indexOf('.') === -1 && candidate.amountStr.indexOf(',') === -1) {
      return { score: -100, convertible: false, veto: 'year-like', reasons: ['parece un año'] };
    }
    // IDs, teléfonos, SKUs.
    if (digitsOnly.length > 8) {
      return { score: -100, convertible: false, veto: 'too-long', reasons: ['demasiados dígitos (ID/teléfono)'] };
    }
    // Porcentaje: "$100 %" o "$100%".
    var after = String(ctx.afterText || '');
    if (/^\s*%/.test(after)) {
      return { score: -100, convertible: false, veto: 'percent', reasons: ['es un porcentaje'] };
    }
    // Sufijo de moneda extranjera pegado después ("$20 USD").
    if (/(us\$|u\$s|usd|d[oó]lar|dollar|eur|€|gbp|£)/i.test(after.slice(0, 8))) {
      return { score: -100, convertible: false, veto: 'foreign-currency', reasons: ['moneda extranjera adyacente'] };
    }

    // Señales positivas.
    var both = norm(candidate.prefix + ' ' + candidate.suffix);
    if (/\bars\b/.test(both)) { score += 100; reasons.push('código ARS'); }
    else if (both.indexOf('pesos argentinos') !== -1) { score += 90; reasons.push('pesos argentinos'); }
    else if (both.indexOf('pesos') !== -1 || both.indexOf('peso') !== -1) { score += 80; reasons.push('pesos'); }

    if (isARThousandsFormat(candidate.amountStr)) { score += 60; reasons.push('formato AR de miles'); }
    else if (isCommaDecimalFormat(candidate.amountStr)) { score += 50; reasons.push('decimal con coma'); }

    if (ctx.isArgentineSite) { score += 60; reasons.push('sitio argentino'); }
    if (hasAny(ctx.nearbyText, PRICE_WORDS)) { score += 40; reasons.push('palabra de precio cercana'); }
    if (ctx.priceClassHint) { score += 30; reasons.push('clase CSS de precio'); }
    if (ctx.jsonLdARS) { score += 40; reasons.push('JSON-LD ARS'); }

    return { score: score, convertible: score >= CONFIDENCE_THRESHOLD, veto: veto, reasons: reasons };
  }

  /**
   * Pipeline puro sobre un string: detecta, parsea, puntúa y devuelve los
   * reemplazos a renderizar. opts: { nearbyText, pageCtx, rate, decimals }.
   * pageCtx: { isArgentineSite, priceClassHint, jsonLdARS }.
   */
  function planTextReplacements(text, opts) {
    opts = opts || {};
    var Currency = getCurrency();
    var plans = [];
    if (typeof text !== 'string' || !text) return plans;
    var rate = Number(opts.rate);
    if (!Number.isFinite(rate) || rate <= 0) return plans;

    var decimals = opts.decimals === 0 ? 0 : 2;
    var pageCtx = opts.pageCtx || {};
    var candidates = extractPriceCandidates(text);
    var occupied = [];

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var overlapped = occupied.some(function (r) { return c.start < r[1] && c.end > r[0]; });
      if (overlapped) continue;

      var amount = Currency.parseMoney(c.amountStr);
      if (!Number.isFinite(amount)) continue;

      var conf = calculateConfidence(c, amount, {
        isArgentineSite: !!pageCtx.isArgentineSite,
        nearbyText: opts.nearbyText || '',
        priceClassHint: !!pageCtx.priceClassHint,
        jsonLdARS: !!pageCtx.jsonLdARS,
        afterText: text.slice(c.end, c.end + 8)
      });
      if (!conf.convertible) continue;

      var usd = Currency.convertARS(amount, rate);
      if (!Number.isFinite(usd)) continue;

      occupied.push([c.start, c.end]);
      plans.push({
        start: c.start,
        end: c.end,
        amount: amount,
        kind: 'usd',
        usdText: Currency.formatUSD(usd, decimals),
        score: conf.score
      });
    }
    return plans;
  }

  /**
   * true si el candidato es un precio en dólares explícito (USD, US$, U$S,
   * dólares, dollar) ya sea en el propio match o pegado justo después
   * ("$20 USD"). EUR/GBP y el "$" ambiguo quedan fuera.
   */
  function isExplicitUSD(candidate, afterText) {
    if (detectCurrency(candidate) === 'USD') return true;
    var after = String(afterText || '').slice(0, 10);
    return /^\s*(US\$|U\$S|USD|d[oó]lares?|dollars?)\b/i.test(after);
  }

  /**
   * Confianza para la función inversa (USD -> ARS). El marcador USD explícito
   * ya es señal suficiente (+100); se mantienen los vetos de seguridad
   * (porcentaje, año, IDs/teléfonos, montos inválidos).
   */
  function calculateInverseConfidence(candidate, amount, ctx) {
    ctx = ctx || {};
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e12) {
      return { score: -100, convertible: false, veto: 'invalid-amount', reasons: ['monto inválido'] };
    }
    var digitsOnly = candidate.amountStr.replace(/[.,]/g, '');
    if (/^\d{4}$/.test(digitsOnly) && amount >= 1900 && amount <= 2100 && candidate.amountStr.indexOf('.') === -1 && candidate.amountStr.indexOf(',') === -1) {
      return { score: -100, convertible: false, veto: 'year-like', reasons: ['parece un año'] };
    }
    if (digitsOnly.length > 8) {
      return { score: -100, convertible: false, veto: 'too-long', reasons: ['demasiados dígitos (ID/teléfono)'] };
    }
    var after = String(ctx.afterText || '');
    if (/^\s*%/.test(after)) {
      return { score: -100, convertible: false, veto: 'percent', reasons: ['es un porcentaje'] };
    }
    return { score: 100, convertible: true, veto: null, reasons: ['moneda USD explícita'] };
  }

  /**
   * Pipeline inverso: precios USD explícitos -> equivalente en ARS
   * (ARS = USD × venta oficial). EUR/GBP y "$" ambiguo -> [].
   * Plan: { start, end, amount, kind: 'ars', arsText, score }.
   */
  function planInverseReplacements(text, opts) {
    opts = opts || {};
    var Currency = getCurrency();
    var plans = [];
    if (typeof text !== 'string' || !text) return plans;
    var rate = Number(opts.rate);
    if (!Number.isFinite(rate) || rate <= 0) return plans;

    var candidates = extractPriceCandidates(text);
    var occupied = [];

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var overlapped = occupied.some(function (r) { return c.start < r[1] && c.end > r[0]; });
      if (overlapped) continue;

      var afterText = text.slice(c.end, c.end + 10);
      if (!isExplicitUSD(c, afterText)) continue;

      var amount = Currency.parseMoney(c.amountStr);
      if (!Number.isFinite(amount)) continue;

      var conf = calculateInverseConfidence(c, amount, { afterText: afterText });
      if (!conf.convertible) continue;

      var ars = Currency.convertUSD(amount, rate);
      if (!Number.isFinite(ars)) continue;

      occupied.push([c.start, c.end]);
      plans.push({
        start: c.start,
        end: c.end,
        amount: amount,
        kind: 'ars',
        arsText: Currency.formatARS(ars),
        score: conf.score
      });
    }
    return plans;
  }

  return {
    CONFIDENCE_THRESHOLD: CONFIDENCE_THRESHOLD,
    extractPriceCandidates: extractPriceCandidates,
    detectCurrency: detectCurrency,
    calculateConfidence: calculateConfidence,
    planTextReplacements: planTextReplacements,
    isExplicitUSD: isExplicitUSD,
    calculateInverseConfidence: calculateInverseConfidence,
    planInverseReplacements: planInverseReplacements,
    isARThousandsFormat: isARThousandsFormat,
    isCommaDecimalFormat: isCommaDecimalFormat
  };
});
