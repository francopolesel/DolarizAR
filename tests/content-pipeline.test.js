'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// La currency debe existir como global para buildTooltip (como en el navegador).
globalThis.DolarizarCurrency = require('../utils/currency.js');
globalThis.DolarizarDetector = require('../utils/price-detector.js');
const Content = require('../content.js');

/** Mini-DOM: solo lo que usa shouldSkipTextNode/isProcessedNode. */
function makeEl(tagName, opts) {
  opts = opts || {};
  return {
    nodeType: 1,
    tagName: tagName,
    className: opts.className || '',
    id: opts.id || '',
    getAttribute: function (name) {
      if (name === 'data-dolarizar-processed') return opts.processed ? 'true' : null;
      if (name === 'aria-hidden') return opts.ariaHidden ? 'true' : null;
      return null;
    },
    hasAttribute: function (name) {
      if (name === 'hidden') return !!opts.hidden;
      return false;
    },
    parentNode: opts.parent || null
  };
}

function makeText(data, parentTag, parentOpts) {
  return {
    nodeType: 3,
    data: data,
    parentNode: makeEl(parentTag || 'SPAN', Object.assign({ parent: makeEl('BODY') }, parentOpts))
  };
}

describe('content helpers — exclusiones', () => {
  it('isExcludedTag cubre SCRIPT/STYLE/SVG/INPUT/etc.', () => {
    for (const t of ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'CODE', 'PRE']) {
      assert.equal(Content.isExcludedTag(t), true, t);
    }
    assert.equal(Content.isExcludedTag('DIV'), false);
    assert.equal(Content.isExcludedTag('STRONG'), false);
  });

  it('salta texto sin dígitos y nodos no-texto', () => {
    assert.equal(Content.shouldSkipTextNode(makeText('Hola mundo', 'SPAN')), true);
    assert.equal(Content.shouldSkipTextNode({ nodeType: 1 }), true);
    assert.equal(Content.shouldSkipTextNode(null), true);
  });

  it('salta SCRIPT y CODE/PRE', () => {
    assert.equal(Content.shouldSkipTextNode(makeText('var x = "$125.000";', 'SCRIPT')), true);
    assert.equal(Content.shouldSkipTextNode(makeText('$125.000', 'CODE')), true);
  });

  it('NO salta precio normal en SPAN/STRONG/DIV', () => {
    assert.equal(Content.shouldSkipTextNode(makeText('$125.000', 'SPAN')), false);
    assert.equal(Content.shouldSkipTextNode(makeText('$25.999', 'STRONG')), false);
    assert.equal(Content.shouldSkipTextNode(makeText('12 cuotas de $125.000', 'DIV')), false);
  });

  it('salta nodos ocultos y aria-hidden', () => {
    assert.equal(Content.shouldSkipTextNode(makeText('$125.000', 'SPAN', { hidden: true })), true);
    assert.equal(Content.shouldSkipTextNode(makeText('$125.000', 'SPAN', { ariaHidden: true })), true);
  });
});

describe('content helpers — no duplicación', () => {
  it('ignora subárboles .dolarizar-conversion (loop del observer)', () => {
    const t = makeText('$125.000', 'SPAN', { className: 'dolarizar-conversion' });
    assert.equal(Content.isProcessedNode(t), true);
    assert.equal(Content.shouldSkipTextNode(t), true);
  });

  it('markProcessed -> isProcessedNode (scan/scan/scan sin duplicar)', () => {
    const t = makeText('$1.250.000', 'STRONG');
    assert.equal(Content.isProcessedNode(t), false);
    Content.markProcessed(t);
    assert.equal(Content.isProcessedNode(t), true);
  });
});

describe('content helpers — dominio y tooltip', () => {
  it('analyzeDomain detecta sitios argentinos', () => {
    assert.equal(Content.analyzeDomain('https://www.fravega.com/producto'), true);
    assert.equal(Content.analyzeDomain('https://tienda.com.ar/item'), true);
    assert.equal(Content.analyzeDomain('https://articulo.mercadolibre.com.ar/x'), true);
    assert.equal(Content.analyzeDomain('https://example.com/'), false);
    assert.equal(Content.analyzeDomain('https://www.amazon.com/'), false);
  });

  it('buildTooltip incluye venta, cuenta y fecha real', () => {
    const tip = Content.buildTooltip('$125.000', 1540, '2026-10-05T18:10:00.000Z');
    assert.ok(tip.includes('Venta: $1.540'), tip);
    assert.ok(tip.includes('$125.000 / $1.540'), tip);
    assert.ok(/Actualizado: \d{2}\/\d{2}\/2026/.test(tip), tip);
  });

  it('buildTooltip sin fecha no inventa timestamps', () => {
    const tip = Content.buildTooltip('$125.000', 1540, null);
    assert.ok(tip.includes('recientemente'), tip);
  });
});

describe('precios partidos estilo Mercado Libre (símbolo y monto en spans hermanos)', () => {
  // Mini-DOM con semántica de movimiento real (appendChild/insertBefore mueven).
  function FakeEl(tag, cls) {
    const el = {
      nodeType: 1,
      tagName: tag,
      className: cls || '',
      id: '',
      childNodes: [],
      parentNode: null,
      _attrs: {},
      get textContent() {
        if (this._leafText !== undefined && this.childNodes.length === 0) return this._leafText;
        return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join('');
      },
      set textContent(v) { this._leafText = String(v); },
      appendChild(c) {
        if (c.parentNode && c.parentNode !== this && typeof c.parentNode.removeChild === 'function') {
          c.parentNode.removeChild(c);
        } else if (c.parentNode === this) {
          const ix = this.childNodes.indexOf(c);
          if (ix !== -1) this.childNodes.splice(ix, 1);
        }
        c.parentNode = this;
        this.childNodes.push(c);
        return c;
      },
      insertBefore(c, ref) {
        this.appendChild(c);
        const cur = this.childNodes.indexOf(c);
        this.childNodes.splice(cur, 1);
        const at = this.childNodes.indexOf(ref);
        this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, c);
        return c;
      },
      removeChild(c) {
        const ix = this.childNodes.indexOf(c);
        if (ix !== -1) this.childNodes.splice(ix, 1);
        c.parentNode = null;
        return c;
      },
      getElementsByClassName(cn) {
        const out = [];
        (function walk(e) {
          for (const k of e.childNodes) {
            if (k.nodeType === 1) {
              if (String(k.className || '').split(' ').includes(cn)) out.push(k);
              walk(k);
            }
          }
        })(this);
        return out;
      },
      querySelectorAll(sel) {
        if (sel && sel[0] === '.' ) return this.getElementsByClassName(sel.slice(1));
        return [];
      },
      createTextNode(data) { return FakeText(data); },
      replaceChild(n, o) {
        const ix = this.childNodes.indexOf(o);
        if (ix === -1) throw new Error('NotFoundError');
        if (n.parentNode && typeof n.parentNode.removeChild === 'function') n.parentNode.removeChild(n);
        n.parentNode = this;
        this.childNodes[ix] = n;
        o.parentNode = null;
        return o;
      },
      getAttribute(name) { return (this._attrs && name in this._attrs) ? this._attrs[name] : null; },
      removeAttribute(name) { if (this._attrs) delete this._attrs[name]; },
      hasAttribute() { return false; },
      setAttribute(k, v) { this._attrs[k] = v; }
    };
    return el;
  }

  function FakeText(data) {
    return {
      nodeType: 3,
      data: data,
      parentNode: null,
      splitText(offset) {
        const t2 = FakeText(this.data.slice(offset));
        this.data = this.data.slice(0, offset);
        const p = this.parentNode;
        if (p) {
          const ix = p.childNodes.indexOf(this);
          p.childNodes.splice(ix + 1, 0, t2);
          t2.parentNode = p;
        }
        return t2;
      }
    };
  }

  const fakeDoc = {
    createElement: (t) => FakeEl(t),
    createDocumentFragment: () => FakeEl('FRAG'),
    createTextNode: (data) => FakeText(data)
  };

  function setupRate(direction) {
    Content._state.enabled = true;
    Content._state.direction = direction || 'ars-to-usd';
    Content._state.decimals = 2;
    Content._state.pageCtx = { isArgentineSite: true, priceClassHint: false, jsonLdARS: false };
    Content._state.rate = { venta: 1540, compra: 1490, fechaActualizacion: '2026-10-05T18:10:00.000Z', fetchedAt: Date.now() };
  }

  function conversionsOf(parent) {
    return parent.getElementsByClassName('dolarizar-conversion');
  }

  it('isSymbolNode / isSmallContainer / shouldCollectTextNode', () => {
    const parent = FakeEl('SPAN', 'andes-money-amount');
    const sym = FakeText('$');
    const amt = FakeText('12.500.000');
    parent.appendChild(sym);
    parent.appendChild(amt);
    assert.equal(Content.isSymbolNode(sym), true);
    assert.equal(Content.isSymbolNode(amt), false);
    assert.equal(Content.isSmallContainer(parent), true);
    assert.equal(Content.shouldCollectTextNode(sym), true);
    assert.equal(Content.directTextContent(parent), '$12.500.000');
  });

  it('reemplaza "$" + "27.500.000" anidados (caso real ML)', () => {
    setupRate();
    // Estructura real andes-money-amount: el símbolo y el monto viven en
    // spans HIJOS, no como texto directo del contenedor.
    const container = FakeEl('SPAN', 'andes-money-amount');
    const symWrap = FakeEl('SPAN', 'andes-money-amount__currency-symbol');
    const amtWrap = FakeEl('SPAN', 'andes-money-amount__fraction');
    const sym = FakeText('$');
    symWrap.appendChild(sym);
    amtWrap.appendChild(FakeText('27.500.000'));
    container.appendChild(symWrap);
    container.appendChild(amtWrap);
    assert.equal(Content.isSmallContainer(container), true);
    assert.equal(Content.processTextNode(fakeDoc, sym), 1);
    assert.equal(conversionsOf(container).length, 0); // sin píldora
    assert.equal(container.textContent, 'US$17.857,14'); // 27500000/1540
    assert.ok(String(container.getAttribute('title')).startsWith('Original: $27.500.000'));
  });

  it('también dispara desde el nodo del monto ("27.500.000" sin marcador)', () => {
    setupRate();
    const container = FakeEl('SPAN', 'andes-money-amount');
    const symWrap = FakeEl('SPAN', '');
    const amtWrap = FakeEl('SPAN', '');
    symWrap.appendChild(FakeText('$'));
    const amt = FakeText('27.500.000');
    amtWrap.appendChild(amt);
    container.appendChild(symWrap);
    container.appendChild(amtWrap);
    assert.equal(Content.processTextNode(fakeDoc, amt), 1);
    assert.equal(container.textContent, 'US$17.857,14');
    // Segundo disparo (el otro nodo) no duplica.
    assert.equal(Content.processTextNode(fakeDoc, symWrap.childNodes[0]), 0);
    assert.equal(container.textContent, 'US$17.857,14');
  });

  function mlContainer(symText, amtText) {
    const container = FakeEl('SPAN', 'andes-money-amount');
    const symWrap = FakeEl('SPAN', 'sym');
    const amtWrap = FakeEl('SPAN', 'amt');
    const sym = FakeText(symText);
    symWrap.appendChild(sym);
    amtWrap.appendChild(FakeText(amtText));
    container.appendChild(symWrap);
    container.appendChild(amtWrap);
    return { container: container, sym: sym };
  }

  it('no duplica al reprocesar (scan/scan/observer)', () => {
    setupRate();
    const t = mlContainer('$', '89.999');
    assert.equal(Content.processTextNode(fakeDoc, t.sym), 1);
    assert.equal(t.container.textContent, 'US$58,44'); // 89999/1540
    assert.equal(Content.processTextNode(fakeDoc, t.sym), 0);
    assert.equal(t.container.textContent, 'US$58,44');
  });

  it('reemplaza "U$S" + monto anidado por ARS (modo dólares→pesos)', () => {
    setupRate('usd-to-ars');
    const t = mlContainer('U$S', '15.000');
    assert.equal(Content.processTextNode(fakeDoc, t.sym), 1);
    assert.equal(conversionsOf(t.container).length, 0);
    assert.equal(t.container.textContent, '$23.100.000'); // 15000×1540, con $ nativo
  });

  it('modos excluyentes: en pesos→dólares, U$S no se convierte', () => {
    setupRate('ars-to-usd');
    const t = mlContainer('U$S', '15.000');
    assert.equal(Content.processTextNode(fakeDoc, t.sym), 0);
    assert.equal(conversionsOf(t.container).length, 0);
  });

  it('modos excluyentes: en dólares→pesos, $ARS no se convierte', () => {
    setupRate('usd-to-ars');
    const parent = FakeEl('STRONG', 'price');
    const node = FakeText('Precio $25.999');
    parent.appendChild(node);
    assert.equal(Content.processTextNode(fakeDoc, node), 0);
    assert.equal(conversionsOf(parent).length, 0);
  });

  it('texto simple en USD: "U$S 500" -> "$770.000"', () => {
    setupRate('usd-to-ars');
    const parent = FakeEl('DIV', '');
    const node = FakeText('Auto U$S 500 único dueño');
    parent.appendChild(node);
    assert.equal(Content.processTextNode(fakeDoc, node), 1);
    assert.equal(parent.getElementsByClassName('dolarizar-converted')[0].textContent, '$770.000');
    assert.equal(parent.textContent, 'Auto $770.000 único dueño');
  });

  it('la ruta normal reemplaza en un solo nodo', () => {
    setupRate();
    const parent = FakeEl('STRONG', 'price');
    const node = FakeText('Precio $25.999');
    parent.appendChild(node);
    assert.equal(Content.processTextNode(fakeDoc, node), 1);
    assert.equal(parent.getElementsByClassName('dolarizar-converted')[0].textContent, 'US$16,88'); // 25999/1540
    assert.equal(Content.processTextNode(fakeDoc, node), 0); // sin duplicar
  });

describe('reemplazo y restauración del original', () => {
  function setupReplace(direction) {
    setupRate(direction || 'ars-to-usd');
    Content._state.replacements = [];
  }

  function convertedOf(parent) {
    return parent.getElementsByClassName('dolarizar-converted');
  }

  it('reemplaza "$25.999" por "US$16,88" guardando el original', () => {
    setupReplace();
    const parent = FakeEl('STRONG', 'price');
    parent.appendChild(FakeText('Precio $25.999'));
    assert.equal(Content.processTextNode(fakeDoc, parent.childNodes[0]), 1);
    assert.equal(conversionsOf(parent).length, 0); // sin píldora
    const spans = convertedOf(parent);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].textContent, 'US$16,88');
    assert.equal(spans[0].getAttribute('data-dolarizar-original'), '$25.999');
    assert.ok(String(spans[0].getAttribute('title')).startsWith('Original: $25.999'));
    assert.equal(parent.textContent, 'Precio US$16,88');
  });

  it('removeConversions restaura el texto original (modo simple)', () => {
    setupReplace();
    const parent = FakeEl('STRONG', 'price');
    parent.appendChild(FakeText('Precio $25.999'));
    assert.equal(Content.processTextNode(fakeDoc, parent.childNodes[0]), 1);
    Content.removeConversions(parent);
    assert.equal(convertedOf(parent).length, 0);
    assert.equal(parent.textContent, 'Precio $25.999');
  });

  it('reemplaza en contenedor ML anidado y restaura todo', () => {
    setupReplace();
    const container = FakeEl('SPAN', 'andes-money-amount');
    const symWrap = FakeEl('SPAN', 's');
    const amtWrap = FakeEl('SPAN', 'a');
    symWrap.appendChild(FakeText('$'));
    amtWrap.appendChild(FakeText('27.500.000'));
    container.appendChild(symWrap);
    container.appendChild(amtWrap);
    assert.equal(Content.processTextNode(fakeDoc, symWrap.childNodes[0]), 1);
    assert.equal(conversionsOf(container).length, 0);
    assert.equal(container.textContent, 'US$17.857,14');
    assert.ok(String(container.getAttribute('title')).startsWith('Original: $27.500.000'));
    Content.removeConversions(container);
    assert.equal(container.textContent, '$27.500.000');
    assert.equal(container.getAttribute('title'), null);
  });

  it('reemplazo inverso: "U$S 500" -> "$770.000"', () => {
    setupReplace('usd-to-ars');
    const parent = FakeEl('DIV', '');
    parent.appendChild(FakeText('Auto U$S 500 único dueño'));
    assert.equal(Content.processTextNode(fakeDoc, parent.childNodes[0]), 1);
    assert.equal(convertedOf(parent)[0].textContent, '$770.000');
    assert.equal(parent.textContent, 'Auto $770.000 único dueño');
  });
});

describe('dirección única y cola de mutaciones', () => {
  function setupDirection(direction) {
    Content._state.direction = direction;
    Content._state.decimals = 2;
    Content._state.pageCtx = {};
    Content._state.rate = { venta: 1540, compra: 1490, fechaActualizacion: null, fetchedAt: Date.now() };
  }

  it('collectPlans solo usa el pipeline del modo activo', () => {
    setupDirection('ars-to-usd');
    assert.equal(Content.collectPlans('$125.000', '', {}).length, 1);
    assert.equal(Content.collectPlans('U$S 500', '', {}).length, 0);
    setupDirection('usd-to-ars');
    assert.equal(Content.collectPlans('U$S 500', '', {}).length, 1);
    assert.equal(Content.collectPlans('$125.000', '', {}).length, 0);
  });

  it('apagada: processTextNode no convierte nada', () => {
    setupDirection('ars-to-usd');
    Content._state.enabled = false;
    const parent = FakeEl('STRONG', 'price');
    const node = FakeText('Precio $25.999');
    parent.appendChild(node);
    assert.equal(Content.processTextNode(fakeDoc, node), 0);
    assert.equal(conversionsOf(parent).length, 0);
    Content._state.enabled = true;
  });

  it('onMutations acumula ráfagas en vez de descartarlas', () => {
    Content._state.pendingMutations = [];
    Content._state.pendingNodes = [];
    const mkText = (data) => {
      const t = FakeText(data);
      FakeEl('DIV', '').appendChild(t);
      return t;
    };
    Content.onMutations([{ addedNodes: [mkText('$25.999')] }]);
    Content.onMutations([{ addedNodes: [mkText('$30.000')] }]);
    // Las dos ráfagas siguen encoladas: ninguna se perdió.
    assert.equal(Content._state.pendingMutations.length, 2);
    Content._state.pendingMutations = [];
    Content._state.pendingNodes = [];
  });
});
});
