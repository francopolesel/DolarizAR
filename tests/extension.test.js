'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('extensión — manifest y estructura', () => {
  const manifest = JSON.parse(read('manifest.json'));

  it('Manifest V3 con service worker', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.background && manifest.background.service_worker, 'falta service_worker');
  });

  it('permisos mínimos (storage + alarms + dolarapi)', () => {
    assert.ok((manifest.permissions || []).includes('storage'));
    assert.ok((manifest.permissions || []).includes('alarms'));
    const hosts = manifest.host_permissions || [];
    assert.ok(hosts.some((h) => h.includes('dolarapi.com')), 'falta host_permissions a dolarapi');
  });

  it('content scripts + popup + iconos declarados existen', () => {
    const js = (manifest.content_scripts || []).flatMap((cs) => cs.js || []);
    assert.ok(js.includes('content.js'));
    for (const f of [...js, ...(manifest.content_scripts || []).flatMap((cs) => cs.css || [])]) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `falta archivo: ${f}`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, manifest.action.default_popup)), 'falta popup');
    for (const icon of Object.values(manifest.icons || {})) {
      assert.ok(fs.existsSync(path.join(ROOT, icon)), `falta icono: ${icon}`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, manifest.background.service_worker)), 'falta background');
  });
});

describe('extensión — seguridad (sin innerHTML/eval)', () => {
  for (const f of ['content.js', 'background.js', 'popup.js']) {
    it(`${f} no usa innerHTML ni eval`, () => {
      const src = read(f);
      assert.ok(!/\.innerHTML\s*=/.test(src), `${f} usa innerHTML`);
      assert.ok(!/(^|[^a-zA-Z_$])eval\s*\(/.test(src), `${f} usa eval`);
    });
  }
  it('content.js no hace fetch directo (solo el SW)', () => {
    assert.ok(!/(^|[^a-zA-Z_$])fetch\s*\(/.test(read('content.js')), 'content.js hace fetch');
    assert.ok(/(^|[^a-zA-Z_$])fetch\s*\(/.test(read('background.js')), 'background.js debería hacer fetch');
  });
});
