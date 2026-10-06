/**
 * DolarizAR — Content Script.
 * Pipeline: candidatos -> parseo -> moneda -> contexto -> confianza ->
 * descarte -> conversión -> render -> marcado como procesado.
 * Nunca modifica el texto original: inserta un <span> adyacente.
 * UMD parcial: expone helpers puros como DolarizarContent (testeable en Node).
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DolarizarContent = api;
  }
  if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    api.init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DEBUG = false;
  function log() {
    if (DEBUG) console.log.apply(console, ['[DolarizAR]'].concat(Array.prototype.slice.call(arguments)));
  }

  var PROCESSED_ATTR = 'data-dolarizar-processed';
  var EXCLUDED_TAGS = {
    SCRIPT: true, STYLE: true, NOSCRIPT: true, SVG: true,
    INPUT: true, TEXTAREA: true, SELECT: true, OPTION: true,
    CODE: true, PRE: true
  };
  var PRICE_CLASS_RE = /(price|precio|amount|cost|value| oferta|cuota|product-price|price-container)/i;

  var MAX_NODES_PER_SCAN = 4000;
  var NODES_PER_BATCH = 150;
  var MUTATION_DEBOUNCE_MS = 250;
  // Contenedores de precio partido (ej. ML: <span>$</span><span>12.500.000</span>).
  var SPLIT_CONTAINER_MAX_CHARS = 80;
  var SPLIT_CONTAINER_MAX_CHILDREN = 8;
  // Re-escaneos de seguridad para SPAs de render tardío (acotados).
  var FOLLOW_UP_DELAYS_MS = [1500, 4000];

  var state = {
    started: false,
    enabled: true, // master switch: apagado = página intacta
    direction: 'ars-to-usd', // único modo activo: 'ars-to-usd' | 'usd-to-ars'
    decimals: 2,
    replacements: [],
    rate: null, // { venta, compra, fechaActualizacion, fetchedAt }
    pageCtx: null,
    observer: null,
    pendingNodes: [],
    pendingMutations: [],
    scheduled: false,
    processedNodes: null // Set/WeakSet según disponibilidad
  };

  function getDetector() { return root.DolarizarDetector; }
  function getCurrency() { return root.DolarizarCurrency; }
  function getStorage() { return root.DolarizarStorage; }

  function newProcessedSet() {
    try {
      if (typeof WeakSet !== 'undefined') return new WeakSet();
    } catch (e) { /* fallback */ }
    // Fallback testeable: Set simple.
    var arr = [];
    return {
      has: function (n) { return arr.indexOf(n) !== -1; },
      add: function (n) { if (arr.indexOf(n) === -1) arr.push(n); },
      delete: function (n) { var i = arr.indexOf(n); if (i !== -1) arr.splice(i, 1); }
    };
  }

  /* ---------- Helpers puros (testeables) ---------- */

  function isExcludedTag(tagName) {
    return !!EXCLUDED_TAGS[String(tagName || '').toUpperCase()];
  }

  /** true si el nodo ya fue procesado o vive dentro de una conversión propia. */
  function isProcessedNode(node) {
    if (!node) return true;
    try {
      if (state.processedNodes && state.processedNodes.has(node)) return true;
    } catch (e) { /* nodos fakes sin identidad estable */ }
    var el = node.nodeType === 3 ? node.parentNode : node;
    while (el) {
      try {
        if (state.processedNodes && state.processedNodes.has(el)) return true;
      } catch (e) { /* noop */ }
      if (el.className && typeof el.className === 'string' &&
        (el.className.indexOf('dolarizar-conversion') !== -1 || el.className.indexOf('dolarizar-price') !== -1)) {
        return true;
      }
      if (el.getAttribute && el.getAttribute(PROCESSED_ATTR) === 'true') return true;
      el = el.parentNode;
    }
    return false;
  }

  function markProcessed(node) {
    try {
      if (!state.processedNodes) state.processedNodes = newProcessedSet();
      state.processedNodes.add(node);
    } catch (e) { /* noop */ }
  }

  function hasPriceClassHint(el) {
    while (el && el.getAttribute) {
      var hay = (el.className || '') + ' ' + (el.id || '');
      if (PRICE_CLASS_RE.test(hay)) return true;
      var aria = el.getAttribute('aria-label') || '';
      if (PRICE_CLASS_RE.test(aria)) return true;
      el = el.parentNode;
      if (el && el.tagName === 'BODY') break;
    }
    return false;
  }

  function isEditable(el) {
    while (el) {
      if (el.isContentEditable) return true;
      el = el.parentNode;
    }
    return false;
  }

  function shouldSkipTextNode(node) {
    if (!node || node.nodeType !== 3) return true;
    if (!node.data || !/\d/.test(node.data)) return true;
    if (isProcessedNode(node)) return true;
    var parent = node.parentNode;
    if (!parent || !parent.tagName) return true;
    if (isExcludedTag(parent.tagName)) return true;
    if (parent.closest) {
      try {
        if (parent.closest('.dolarizar-conversion,.dolarizar-price,code,pre,input,textarea,select,[contenteditable="true"]')) return true;
      } catch (e) { /* selector no soportado */ }
    }
    if (isEditable(parent)) return true;
    if (parent.getAttribute) {
      if (parent.hasAttribute && parent.hasAttribute('hidden')) return true;
      if (parent.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  }

  function buildTooltip(amountText, sellRate, fechaActualizacion) {
    var C = getCurrency();
    var fecha = C.formatFechaES(fechaActualizacion);
    var lines = [
      'Dólar oficial — Venta: ' + C.formatARSWhole(sellRate),
      'Conversión: ' + amountText + ' / ' + C.formatARSWhole(sellRate),
      'Actualizado: ' + (fecha || 'recientemente')
    ];
    return lines.join('\n');
  }

  function buildInverseTooltip(amountText, sellRate, fechaActualizacion) {
    var C = getCurrency();
    var fecha = C.formatFechaES(fechaActualizacion);
    var lines = [
      'Equivalente en pesos argentinos',
      'Dólar oficial — Venta: ' + C.formatARSWhole(sellRate),
      'Conversión: ' + amountText + ' × ' + C.formatARSWhole(sellRate),
      'Actualizado: ' + (fecha || 'recientemente')
    ];
    return lines.join('\n');
  }

  function conversionLabel(plan) {
    if (plan && plan.kind === 'ars') return plan.arsText;
    return plan.usdText;
  }

  function conversionKindName(plan) {
    return plan && plan.kind === 'ars' ? 'pesos argentinos' : 'dólares';
  }

  function conversionTooltip(plan, priceText, rate) {
    if (plan && plan.kind === 'ars') {
      return buildInverseTooltip(priceText, rate.venta, rate.fechaActualizacion);
    }
    return buildTooltip(priceText, rate.venta, rate.fechaActualizacion);
  }

  /**
   * Junta planes según el modo activo (mutuamente excluyentes) evitando solapes.
   */
  function collectPlans(text, nearbyText, basePageCtx) {
    var Detector = getDetector();
    var opts = {
      nearbyText: nearbyText || '',
      pageCtx: basePageCtx || {},
      rate: state.rate.venta,
      decimals: state.decimals
    };
    var plans = [];
    var occupied = [];
    function take(list) {
      list = list || [];
      for (var k = 0; k < list.length; k++) {
        var p = list[k];
        var clash = occupied.some(function (r) { return p.start < r[1] && p.end > r[0]; });
        if (!clash) {
          occupied.push([p.start, p.end]);
          plans.push(p);
        }
      }
    }
    try {
      if (state.direction === 'usd-to-ars') {
        take(Detector.planInverseReplacements(text, opts));
      } else {
        take(Detector.planTextReplacements(text, opts));
      }
    } catch (e) { /* noop */ }
    plans.sort(function (a, b) { return a.start - b.start; });
    return plans;
  }

  /* ---------- Precios partidos en spans hermanos (ej. Mercado Libre) ---------- */

  /**
   * Nodo con símbolo "$" pero sin dígitos: posible mitad de un precio partido
   * (<span>$</span><span>12.500.000</span>). Nunca se convierte por sí solo.
   */
  function isSymbolNode(node) {
    if (!node || node.nodeType !== 3) return false;
    var t = node.data || '';
    return t.indexOf('$') !== -1 && !/\d/.test(t);
  }

  /** Contenedor chico y seguro para analizar texto combinado (anti-ruido). */
  function isSmallContainer(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!el.tagName || isExcludedTag(el.tagName)) return false;
    var kids = el.childNodes;
    if (!kids || kids.length === 0 || kids.length > SPLIT_CONTAINER_MAX_CHILDREN) return false;
    try {
      var t = el.textContent || '';
      if (t.length === 0 || t.length > SPLIT_CONTAINER_MAX_CHARS) return false;
    } catch (e) {
      return false;
    }
    return true;
  }

  /** Une solo los hijos de texto directos (sin bajar a subárboles). */
  function directTextContent(el) {
    var parts = [];
    var kids = el.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 3 && typeof kids[i].data === 'string') parts.push(kids[i].data);
    }
    return parts.join('');
  }

  /** true si algún nodo de texto del subárbol contiene el match completo. */
  function subtreeSingleNodeCovers(el, priceText) {
    if (!priceText) return true;
    var stack = [el];
    while (stack.length) {
      var cur = stack.pop();
      var kids = (cur && cur.childNodes) || [];
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.nodeType === 3) {
          if (String(k.data || '').indexOf(priceText) !== -1) return true;
        } else if (k.nodeType === 1) {
          stack.push(k);
        }
      }
    }
    return false;
  }

  function containerHasConversion(el) {
    try {
      var found = el.getElementsByClassName('dolarizar-conversion');
      return !!(found && found.length);
    } catch (e) {
      return false;
    }
  }

  function shouldCollectTextNode(node) {
    if (!node || node.nodeType !== 3) return false;
    if (!shouldSkipTextNode(node)) return true;
    // Símbolos sueltos en contenedores chicos: candidatos a precio partido.
    return isSymbolNode(node) && !isProcessedNode(node) && isSmallContainer(node.parentNode);
  }

  /**
   * Precio partido en el subárbol (ej. ML: contenedor con <span>$</span> y
   * <span>27.500.000</span> en hijos anidados). Sube hasta 3 niveles buscando
   * un contenedor chico cuyo texto COMPLETO sea un precio confiable que ningún
   * nodo individual cubre; agrega la conversión como último hijo del contenedor.
   */
  function tryContainerPrice(doc, node) {
    var el = node && node.parentNode;
    for (var depth = 0; depth < 3 && el && el.nodeType === 1; depth++) {
      if (el.tagName && isExcludedTag(el.tagName)) break;
      if (isSmallContainer(el)) {
        var full = '';
        try { full = el.textContent || ''; } catch (e) { full = ''; }
        if (full.indexOf('$') !== -1 && /\d/.test(full) && !containerHasConversion(el)) {
          var nearby = '';
          try { nearby = ((el.parentNode && el.parentNode.textContent) || '').slice(0, 300); } catch (e) { /* noop */ }
          // Símbolo/monto en spans propios = señal de widget de precio.
          var pageCtx = Object.assign({}, state.pageCtx, { priceClassHint: true });
          var plans = collectPlans(full, nearby, pageCtx);
          var fresh = [];
          for (var i = 0; i < plans.length; i++) {
            if (!subtreeSingleNodeCovers(el, full.slice(plans[i].start, plans[i].end))) fresh.push(plans[i]);
          }
          if (fresh.length) {
            var count = 0;
            for (var j = 0; j < fresh.length; j++) {
              if (replaceInContainer(doc, el, full, fresh[j])) count++;
            }
            markProcessed(node);
            if (count > 0) markProcessed(el);
            return count;
          }
        } else if (containerHasConversion(el)) {
          markProcessed(node);
          return 0;
        }
      }
      el = el.parentNode;
    }
    markProcessed(node);
    return 0;
  }

  /**
   * Reemplazo dentro de un contenedor partido: reescribe el nodo del símbolo
   * ("$" -> "US$") y el del monto ("27.500.000" -> "17.883,12"), limpiando
   * restos no-blancos del rango (ej. "pesos" suelto). Todo queda registrado
   * para restaurar el original. Conservador: ante la duda no toca nada.
   */
  function replaceInContainer(doc, el, full, plan) {
    var entries = [];
    var offset = 0;
    (function walk(node) {
      var kids = (node && node.childNodes) || [];
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.nodeType === 3) {
          entries.push({ node: k, start: offset, end: offset + String(k.data || '').length });
          offset += String(k.data || '').length;
        } else if (k.nodeType === 1) {
          walk(k);
        }
      }
    })(el);
    if (offset !== full.length) return false; // el texto cambió bajo nuestros pies

    var label = conversionLabel(plan);
    var parts = splitLabel(label, plan.kind);
    var inRange = entries.filter(function (e) { return e.start < plan.end && e.end > plan.start; });
    if (!inRange.length) return false;
    // Todo nodo tocado debe estar íntegramente dentro del rango.
    for (var a = 0; a < inRange.length; a++) {
      if (inRange[a].start < plan.start || inRange[a].end > plan.end) return false;
    }
    var digitEntries = inRange.filter(function (e) { return /\d/.test(e.node.data || ''); });
    if (!digitEntries.length) return false;
    var amountEntry = digitEntries[digitEntries.length - 1];
    var symbolEntry = null;
    for (var s = 0; s < inRange.length; s++) {
      if (inRange[s] !== amountEntry && String(inRange[s].node.data || '').indexOf('$') !== -1) {
        symbolEntry = inRange[s];
        break;
      }
    }
    if (!symbolEntry) return false;

    try {
      recordReplacement({ type: 'text', node: symbolEntry.node, original: symbolEntry.node.data });
      symbolEntry.node.data = parts.symbol;
      recordReplacement({ type: 'text', node: amountEntry.node, original: amountEntry.node.data });
      amountEntry.node.data = parts.digits;
      for (var c = 0; c < inRange.length; c++) {
        var other = inRange[c];
        if (other === symbolEntry || other === amountEntry) continue;
        if (/^\s*$/.test(other.node.data || '')) continue; // conserva espacios
        recordReplacement({ type: 'text', node: other.node, original: other.node.data });
        other.node.data = '';
      }
      var priceText = full.slice(plan.start, plan.end);
      var tip = conversionTooltip(plan, priceText, state.rate);
      var prevTitle = el.getAttribute ? el.getAttribute('title') : null;
      recordReplacement({ type: 'title', el: el, original: prevTitle });
      el.setAttribute('title', 'Original: ' + priceText + '\n' + tip);
      log('Precio detectado:', priceText, '->', label);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- Contexto de página (una vez por documento) ---------- */

  function analyzeDomain(url) {
    var host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (e) { host = String(url || '').toLowerCase(); }
    if (/(^|\.)com\.ar$/.test(host) || /\.ar$/.test(host)) return true;
    var known = ['mercadolibre', 'fravega', 'musimundo', 'coto', 'carrefour', 'diaonline',
      'pedidosya', 'despegar', 'aerolineas', 'uala', 'mercadopago', 'tarjetanaranja',
      'garbarino', 'compumundo', 'redmegatone', 'tiendanube'];
    return known.some(function (k) { return host.indexOf(k) !== -1; });
  }

  function computePageContext(doc, url) {
    var lang = '';
    try { lang = (doc.documentElement && doc.documentElement.lang) || ''; } catch (e) { /* noop */ }
    var ctx = {
      isArgentineSite: analyzeDomain(url || ''),
      priceClassHint: false,
      jsonLdARS: false
    };
    if (/^es[-_]AR/i.test(lang)) ctx.isArgentineSite = true;

    // Muestra de texto para marcadores AR (barato: primeros 50k caracteres).
    try {
      var sample = (doc.body ? doc.body.innerText : '') || '';
      if (sample.length > 50000) sample = sample.slice(0, 50000);
      var low = sample.toLowerCase();
      var markers = ['pesos', 'argentina', 'mercado libre', 'mercadolibre', 'cuotas', 'envío', 'envio'];
      var hits = markers.filter(function (mk) { return low.indexOf(mk) !== -1; }).length;
      if (hits >= 2) ctx.isArgentineSite = true;
    } catch (e) { /* innerText puede fallar en XML */ }

    // JSON-LD como refuerzo (nunca como única señal).
    try {
      var scripts = doc.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < scripts.length && i < 10; i++) {
        var raw = scripts[i].textContent || '';
        if (/pricecurrency/i.test(raw) && /ars/i.test(raw)) { ctx.jsonLdARS = true; break; }
      }
    } catch (e) { /* noop */ }
    return ctx;
  }

  /* ---------- Render (sin innerHTML, sin tocar listeners) ---------- */

  var MAX_REPLACEMENT_RECORDS = 10000;

  function recordReplacement(rec) {
    if (state.replacements.length >= MAX_REPLACEMENT_RECORDS) return false;
    state.replacements.push(rec);
    return true;
  }

  /** Divide "US$17.883,12" -> { symbol: "US$", digits: "17.883,12" }. */
  function splitLabel(label, kind) {
    var symbol = kind === 'ars' ? '$' : 'US$';
    var digits = String(label || '').slice(symbol.length).trim();
    if (!digits) digits = String(label || '');
    return { symbol: symbol, digits: digits };
  }

  function renderPlan(doc, textNode, plan, rate) {
    // El match se sustituye por el valor convertido. El original queda en
    // data-dolarizar-original (tooltip + restauración al desactivar).
    var priceText = textNode.data.slice(plan.start, plan.end);
    var middle;
    try {
      textNode.splitText(plan.end);
      middle = textNode.splitText(plan.start);
    } catch (e) {
      return false;
    }
    var label = conversionLabel(plan);
    var tooltip = conversionTooltip(plan, priceText, rate);
    var ariaText = 'Equivalente en ' + conversionKindName(plan) + ': ' + label + '. ' + tooltip.replace(/\n/g, '. ');
    if (state.replacements.length >= MAX_REPLACEMENT_RECORDS) return false;
    try {
      var replaced = doc.createElement('span');
      replaced.className = 'dolarizar-converted';
      replaced.setAttribute(PROCESSED_ATTR, 'true');
      replaced.setAttribute('data-dolarizar-original', priceText);
      replaced.textContent = label;
      replaced.setAttribute('title', 'Original: ' + priceText + '\n' + tooltip);
      replaced.setAttribute('aria-label', ariaText);
      middle.parentNode.insertBefore(replaced, middle);
      middle.parentNode.removeChild(middle);
      recordReplacement({ type: 'wrap', span: replaced, original: priceText });
      markProcessed(textNode);
      log('Precio detectado:', priceText, '->', label);
      return true;
    } catch (e) {
      return false;
    }
  }

  function processTextNode(doc, node) {
    if (!node || node.nodeType !== 3) return 0;
    if (!state.enabled) return 0;
    if (isProcessedNode(node)) return 0;
    if (!state.rate || !Number.isFinite(state.rate.venta) || state.rate.venta <= 0) return 0;
    if (!/\d/.test(node.data || '')) {
      // Sin dígitos: solo interesa el símbolo suelto de un precio partido.
      if (isSymbolNode(node)) {
        return tryContainerPrice(doc, node);
      }
      markProcessed(node);
      return 0;
    }
    if (shouldSkipTextNode(node)) return 0;
    var parent = node.parentNode;
    var nearby = '';
    try { nearby = (parent.textContent || '').slice(0, 300); } catch (e) { /* noop */ }
    var pageCtx = Object.assign({}, state.pageCtx, { priceClassHint: hasPriceClassHint(parent) });
    var plans = collectPlans(node.data, nearby, pageCtx);
    if (!plans.length) {
      // Monto sin marcador en este nodo: puede ser mitad de un precio partido.
      return tryContainerPrice(doc, node);
    }
    var count = 0;
    for (var i = plans.length - 1; i >= 0; i--) {
      if (renderPlan(doc, node, plans[i], state.rate)) count++;
    }
    return count;
  }

  function collectTextNodes(rootEl, limit) {
    var doc = rootEl.ownerDocument || document;
    var walker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var node;
    var visited = 0;
    while ((node = walker.nextNode())) {
      visited++;
      if (visited > MAX_NODES_PER_SCAN) break;
      if (nodes.length >= limit) break;
      if (shouldCollectTextNode(node)) nodes.push(node);
    }
    return nodes;
  }

  function processNodes(doc, nodes) {
    var converted = 0;
    for (var i = 0; i < nodes.length; i++) {
      try { converted += processTextNode(doc, nodes[i]); } catch (e) { /* un nodo roto no frena el batch */ }
    }
    return converted;
  }

  function scheduleScan() {
    if (state.scheduled) return;
    state.scheduled = true;
    var run = function () {
      state.scheduled = false;
      var nodes = state.pendingNodes.splice(0, NODES_PER_BATCH);
      if (nodes.length && state.rate) processNodes(document, nodes);
      if (state.pendingNodes.length) scheduleScan();
    };
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(run, { timeout: 1000 });
    } else {
      setTimeout(run, 50);
    }
  }

  function scanRoot(rootEl) {
    if (!state.enabled || !state.rate) return;
    var nodes = collectTextNodes(rootEl || document.body, MAX_NODES_PER_SCAN);
    state.pendingNodes = state.pendingNodes.concat(nodes);
    scheduleScan();
  }

  /* ---------- Observación dinámica + SPA ---------- */

  /**
   * Recibe nodos agregados ya acumulados (ver onMutations) y encola
   * los recolectables para procesarlos en batches.
   */
  function handleAddedNodes(added) {
    for (var i = 0; i < added.length; i++) {
      var n = added[i];
      if (!n) continue;
      if (n.nodeType === 3) {
        if (shouldCollectTextNode(n)) state.pendingNodes.push(n);
      } else if (n.nodeType === 1) {
        if (n.className && typeof n.className === 'string' &&
          (n.className.indexOf('dolarizar-conversion') !== -1 || n.className.indexOf('dolarizar-price') !== -1 ||
           n.className.indexOf('dolarizar-converted') !== -1)) {
          continue; // loop propio: ignorar nodos insertados por DolarizAR
        }
        if (isExcludedTag(n.tagName)) continue;
        var found = collectTextNodes(n, NODES_PER_BATCH);
        if (found.length) state.pendingNodes = state.pendingNodes.concat(found);
      }
    }
    if (state.pendingNodes.length) scheduleScan();
  }

  var mutationTimer = null;
  function onMutations(mutations) {
    // Acumula TODAS las ráfagas: antes se descartaban las que llegaban
    // durante el debounce y esos precios no se convertían nunca.
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i] && mutations[i].addedNodes;
      for (var j = 0; added && j < added.length; j++) {
        state.pendingMutations.push(added[j]);
      }
    }
    if (mutationTimer) return;
    mutationTimer = setTimeout(function () {
      mutationTimer = null;
      var batch = state.pendingMutations.splice(0, state.pendingMutations.length);
      try { handleAddedNodes(batch); } catch (e) { /* noop */ }
    }, MUTATION_DEBOUNCE_MS);
  }

  function hookSPANavigation(onNavigate) {
    function wrap(obj, method) {
      if (!obj || typeof obj[method] !== 'function' || obj[method]._dolarizarWrapped) return;
      var original = obj[method];
      var wrapped = function () {
        var result = original.apply(this, arguments);
        onNavigate();
        return result;
      };
      wrapped._dolarizarWrapped = true;
      try { obj[method] = wrapped; } catch (e) { /* noop */ }
    }
    wrap(window.history, 'pushState');
    wrap(window.history, 'replaceState');
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);
  }

  /* ---------- Activar / desactivar ---------- */

  function removeConversions(doc) {
    // 1. Restaura reemplazos directos (texto y títulos) desde los registros.
    var recs = state.replacements;
    state.replacements = [];
    for (var r = 0; r < recs.length; r++) {
      var rec = recs[r];
      try {
        if (rec.type === 'text' && rec.node) {
          rec.node.data = rec.original;
        } else if (rec.type === 'title' && rec.el) {
          if (rec.original === null || rec.original === undefined) {
            if (rec.el.removeAttribute) rec.el.removeAttribute('title');
          } else {
            rec.el.setAttribute('title', rec.original);
          }
        }
      } catch (e) { /* mejor esfuerzo */ }
    }
    try {
      // 2. Restaura wraps de modo reemplazo a su texto original.
      var replaced = doc.querySelectorAll('.dolarizar-converted');
      for (var k = 0; k < replaced.length; k++) {
        var span = replaced[k];
        var original = span.getAttribute ? span.getAttribute('data-dolarizar-original') : null;
        if (original !== null && original !== undefined && span.parentNode) {
          span.parentNode.replaceChild(doc.createTextNode(original), span);
        }
      }
      var convs = doc.querySelectorAll('.dolarizar-conversion');
      for (var i = 0; i < convs.length; i++) {
        var el = convs[i];
        if (el.parentNode) el.parentNode.removeChild(el);
      }
      var prices = doc.querySelectorAll('.dolarizar-price');
      for (var j = 0; j < prices.length; j++) {
        var span = prices[j];
        var frag = doc.createDocumentFragment();
        while (span.firstChild) frag.appendChild(span.firstChild);
        if (span.parentNode) span.parentNode.replaceChild(frag, span);
      }
    } catch (e) { /* noop */ }
    state.processedNodes = newProcessedSet();
  }

  function attachObserver() {
    if (state.observer) return;
    try {
      state.observer = new MutationObserver(onMutations);
      state.observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { state.observer = null; }
  }

  function rescanPage() {
    state.pageCtx = computePageContext(document, location.href);
    scanRoot(document.body);
  }

  /** Re-escaneos acotados para SPAs de render tardío (ML, ecommerce). */
  function scheduleFollowUpScans() {
    FOLLOW_UP_DELAYS_MS.forEach(function (ms) {
      setTimeout(function () {
        if (!state.rate) return;
        rescanPage();
      }, ms);
    });
  }

  function refreshRate() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'GET_RATE' }, function (res) {
          if (res && res.ok && res.rate && Number.isFinite(res.rate.venta)) {
            resolve(res.rate);
          } else {
            resolve(null);
          }
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /* ---------- Init ---------- */

  function init() {
    if (state.started) return;
    state.started = true;
    state.processedNodes = newProcessedSet();

    var Storage = null;
    try { Storage = getStorage(); } catch (e) { /* tests */ }

    function applySettings(settings) {
      state.enabled = !settings || settings.enabled !== false;
      state.direction = settings && settings.direction === 'usd-to-ars' ? 'usd-to-ars' : 'ars-to-usd';
      state.decimals = settings && settings.decimals === 0 ? 0 : 2;
    }

    function clearQueues() {
      state.pendingNodes = [];
      state.pendingMutations = [];
    }

    function boot(settings) {
      applySettings(settings);
      state.pageCtx = computePageContext(document, location.href);
      // El observer se attacha ANTES de tener cotización para no perder
      // mutaciones tempranas; los nodos esperan encolados hasta el scan.
      attachObserver();

      var navTimer = null;
      hookSPANavigation(function () {
        if (navTimer) clearTimeout(navTimer);
        navTimer = setTimeout(rescanPage, 500);
      });

      // Apagado: página intacta, pero se sigue escuchando por si se enciende.
      if (!state.enabled) return;

      refreshRate().then(function (rate) {
        // Sin cache y sin red: no convertir (Caso B). Sin logs ruidosos.
        if (!rate) return;
        state.rate = rate;
        scanRoot(document.body);
        scheduleFollowUpScans();
      });
    }

    if (Storage) {
      Storage.getSettings().then(boot).catch(function () { boot(null); });
    } else {
      boot(null);
    }

    try {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'RATE_UPDATED' && msg.rate && Number.isFinite(msg.rate.venta)) {
          state.rate = msg.rate;
          if (!state.enabled) return;
          removeConversions(document);
          clearQueues();
          rescanPage();
          scheduleFollowUpScans();
        }
        if (msg.type === 'DOLARIZAR_SETTINGS_CHANGED' && msg.settings) {
          var wasEnabled = state.enabled;
          applySettings(msg.settings);
          removeConversions(document);
          clearQueues();
          if (!state.enabled) return;
          if (!wasEnabled) {
            // Recién encendido: consigue cotización y convierte.
            state.pageCtx = computePageContext(document, location.href);
            refreshRate().then(function (rate) {
              if (!rate) return;
              state.rate = rate;
              scanRoot(document.body);
              scheduleFollowUpScans();
            });
            return;
          }
          rescanPage();
        }
      });
    } catch (e) { /* noop */ }
  }

  return {
    init: init,
    isExcludedTag: isExcludedTag,
    isProcessedNode: isProcessedNode,
    markProcessed: markProcessed,
    shouldSkipTextNode: shouldSkipTextNode,
    shouldCollectTextNode: shouldCollectTextNode,
    onMutations: onMutations,
    handleAddedNodes: handleAddedNodes,
    isSymbolNode: isSymbolNode,
    isSmallContainer: isSmallContainer,
    directTextContent: directTextContent,
    subtreeSingleNodeCovers: subtreeSingleNodeCovers,
    containerHasConversion: containerHasConversion,
    tryContainerPrice: tryContainerPrice,
    processTextNode: processTextNode,
    collectPlans: collectPlans,
    conversionLabel: conversionLabel,
    conversionKindName: conversionKindName,
    splitLabel: splitLabel,
    replaceInContainer: replaceInContainer,
    removeConversions: removeConversions,
    recordReplacement: recordReplacement,
    buildInverseTooltip: buildInverseTooltip,
    buildTooltip: buildTooltip,
    analyzeDomain: analyzeDomain,
    _state: state
  };
});
