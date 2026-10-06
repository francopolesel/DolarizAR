# DolarizAR — notas de desarrollo

Documentación técnica. Para uso de la extensión ver [README](../README.md).

## Arquitectura

```text
Content Script (content.js)
  → detector (utils/price-detector.js): candidatos → parseo → moneda → confianza
  → pide cotización al Service Worker (background.js) via chrome.runtime.sendMessage
  → Service Worker consulta DolarAPI (con cache TTL 15 min + deduplicación)
  → content.js sustituye el valor por el convertido (original en tooltip +
  registros para restaurar; nunca innerHTML ni listeners rotos)
```

- El content script **nunca** hace fetch directo; el endpoint vive solo en el SW.
- Configuración en `chrome.storage.sync`; cotización en `chrome.storage.local`.
- `MutationObserver` con debounce y cola acumulativa + `pushState`/`replaceState`/`popstate` para SPAs.
- Auto-refresh: `chrome.alarms` cada 15 min → `FORCE_REFRESH` interno → `RATE_UPDATED` a las tabs solo con dato fresco de red.
- Sin frameworks, sin dependencias npm, sin backend.

## Detección (precisión > cobertura)

- Solo los números con marcador de moneda (`$`, `ARS`, `pesos`) son candidatos.
  Años (`2026`), cantidades (`1650`), cuotas (`12`), porcentajes, CP, IDs y
  teléfonos **nunca** se convierten.
- El `$` ambiguo se resuelve con scoring: formato AR de miles (`125.000`),
  `ARS`/`pesos`, sitio `.ar` / Mercado Libre / Frávega / etc., palabras
  (`precio`, `total`, `cuotas`), clases CSS de precio y JSON-LD `priceCurrency: ARS`.
- Moneda extranjera explícita (`USD`, `US$`, `dólares`, `€`, `EUR`, `£`) veta
  la conversión forward y habilita la inversa. Umbral: 60 puntos.
- Precios partidos en spans anidados (ML `andes-money-amount`) se resuelven a
  nivel contenedor (sube hasta 3 niveles, solo contenedores chicos).

## Probar

```bash
npm test   # 129 tests, sin dependencias (node:test)
```

Página manual: abrir `tests/fixtures/test-page.html` en el navegador con la
extensión cargada. Incluye precios, falsos positivos y un precio agregado por
JS a los 2 segundos (prueba del MutationObserver).

Iconos: `npm run icons` (generador PNG puro en `icons/generate-icons.mjs`).

## Estructura

```text
manifest.json          Manifest V3 (storage + alarms + host dolarapi.com)
background.js          SW: DolarAPI, cache TTL, dedup, alarmas, mensajes
content.js             DOM: pipeline, render, observer, SPA, settings
content.css            .dolarizar-* namespaced
popup.html/js/css      cotización, modo, on/off, decimales
utils/currency.js      parseMoney, convertARS/USD, formatUSD/ARS (es-AR)
utils/price-detector.js candidatos, moneda, confianza (puro, testeado)
utils/rate-cache.js    normalize + isCacheValid (puro, testeado)
utils/storage.js       chrome.storage + defaults + migración
tests/                 currency, detector, cache, content, extensión + fixture
icons/                 16/32/48/128 PNG + SVG + generador
```

Mensajes: `GET_RATE`, `FORCE_REFRESH`, `GET_SETTINGS`, `SET_DIRECTION`, `SET_ENABLED`,
`RATE_UPDATED`, `DOLARIZAR_SETTINGS_CHANGED`.

Settings: `{ enabled, direction: 'ars-to-usd' | 'usd-to-ars', decimals, cacheTtlMinutes }`
con migración de los formatos viejos (`enabled`/`inverseEnabled`/`displayMode`).

## Fuente de cotización

```text
https://dolarapi.com/v1/dolares/oficial
```

Se usa siempre el campo `venta`. Respuesta verificada el 2026-10-05:

```json
{
  "moneda": "USD",
  "casa": "oficial",
  "nombre": "Oficial",
  "compra": 1490,
  "venta": 1540,
  "fechaActualizacion": "2026-10-05T18:10:00.000Z"
}
```

## Distribuir

El ZIP para usuarios se genera con `powershell -ExecutionPolicy Bypass -File scripts/pack.ps1`
(sale a `dist/` con `INSTALAR-AMIGOS.txt` adentro) y se publica como asset de un
GitHub Release.

## Limitaciones conocidas

- `$999` (sin separadores ni contexto AR) no se convierte por seguridad;
  en sitios argentinos sí.
- Precios dentro de imágenes, canvas o shadow DOM cerrado no se detectan.
- `file://` requiere habilitar "Allow access to file URLs" en la extensión
  (solo afecta a la prueba local del fixture).
- Si DolarAPI cae y no hay cache, no se muestra nada (nunca `US$NaN`/`US$0`).
