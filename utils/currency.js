/**
 * Utilidades monetarias de DolarizAR.
 * UMD: funciona como content script / service worker (global) y en Node (require).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DolarizarCurrency = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Parsea un string numérico con formato argentino/americano a Number.
   * "125.000" -> 125000 | "125.000,50" -> 125000.5 | "125,000" -> 125000
   * "999,50" -> 999.5 | "1,250.50" -> 1250.5
   * Devuelve NaN si el formato es ambiguo o inválido.
   */
  function parseMoney(raw) {
    if (typeof raw !== 'string') return NaN;
    var s = raw.trim().replace(/[^\d.,]/g, '');
    if (!s || !/\d/.test(s)) return NaN;

    var hasDot = s.indexOf('.') !== -1;
    var hasComma = s.indexOf(',') !== -1;
    var normalized = null;

    if (hasDot && hasComma) {
      // El último separador es el decimal.
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        normalized = s.replace(/\./g, '').replace(',', '.'); // 125.000,50
      } else {
        normalized = s.replace(/,/g, ''); // 1,250.50
      }
    } else if (hasComma) {
      var cparts = s.split(',');
      if (cparts.length === 2 && cparts[1].length <= 2) {
        normalized = cparts[0] + '.' + cparts[1]; // 999,50
      } else if (cparts.length > 2 || (cparts.length === 2 && cparts[1].length === 3)) {
        normalized = s.replace(/,/g, ''); // 125,000 / 1,250,500
      } else {
        return NaN;
      }
    } else if (hasDot) {
      var dparts = s.split('.');
      if (dparts.length > 2) {
        var rest = dparts.slice(1);
        var allThousands = rest.every(function (p) { return p.length === 3; });
        if (!allThousands) return NaN;
        normalized = s.replace(/\./g, ''); // 1.250.500
      } else {
        var left = dparts[0];
        var right = dparts[1];
        if (right.length === 3 && left.length >= 1 && left.length <= 3) {
          normalized = left + right; // 125.000 (miles, formato AR)
        } else if (right.length === 3) {
          return NaN; // p.ej. 1250.000: malformado
        } else if (right.length >= 1 && right.length <= 2) {
          normalized = left + '.' + right; // 999.50 (decimal con punto)
        } else {
          return NaN;
        }
      }
    } else {
      normalized = s;
    }

    if (!/^\d+(\.\d+)?$/.test(normalized)) return NaN;
    var value = Number(normalized);
    return Number.isFinite(value) ? value : NaN;
  }

  /** USD = ARS / cotización oficial de venta. */
  function convertARS(ars, sellRate) {
    if (!Number.isFinite(ars) || !Number.isFinite(sellRate) || sellRate <= 0) return NaN;
    return ars / sellRate;
  }

  /** Inversa: ARS = USD × cotización oficial de venta. */
  function convertUSD(usd, sellRate) {
    if (!Number.isFinite(usd) || !Number.isFinite(sellRate) || sellRate <= 0) return NaN;
    return usd * sellRate;
  }

  /** "US$81,17" — formato argentino (punto miles, coma decimal). */
  function formatUSD(value, decimals) {
    if (decimals !== 0 && decimals !== 2) decimals = 2;
    if (!Number.isFinite(value)) return '';
    var formatted = new Intl.NumberFormat('es-AR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(value);
    return 'US$' + formatted;
  }

  /** "$1.540" — cotización entera en formato argentino. */
  function formatARSWhole(value) {
    if (!Number.isFinite(value)) return '';
    return '$' + new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(value);
  }

  /** "$19.250.000" — equivalente en pesos con el mismo símbolo $ nativo. */
  function formatARS(value) {
    if (!Number.isFinite(value)) return '';
    var formatted = new Intl.NumberFormat('es-AR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(value);
    return '$' + formatted;
  }

  /**
   * Fecha ISO de DolarAPI -> "05/10/2026 14:32" (es-AR).
   * Devuelve null si no se puede interpretar (no inventar timestamps).
   */
  function formatFechaES(iso) {
    if (typeof iso !== 'string' || !iso) return null;
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    try {
      return d.toLocaleString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return null;
    }
  }

  /** "hace 4 minutos" a partir de un timestamp local. */
  function relativeTimeES(timestamp) {
    if (!Number.isFinite(timestamp)) return '';
    var diffMin = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    if (diffMin < 1) return 'recién';
    if (diffMin === 1) return 'hace 1 minuto';
    if (diffMin < 60) return 'hace ' + diffMin + ' minutos';
    var h = Math.floor(diffMin / 60);
    if (h === 1) return 'hace 1 hora';
    if (h < 24) return 'hace ' + h + ' horas';
    return 'hace más de un día';
  }

  return {
    parseMoney: parseMoney,
    convertARS: convertARS,
    convertUSD: convertUSD,
    formatUSD: formatUSD,
    formatARS: formatARS,
    formatARSWhole: formatARSWhole,
    formatFechaES: formatFechaES,
    relativeTimeES: relativeTimeES
  };
});
