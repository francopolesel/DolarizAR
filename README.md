# DolarizAR

Extensión para navegadores Chromium (Brave, Chrome) que detecta automáticamente
precios en **pesos argentinos (ARS)** en cualquier página web y muestra su
equivalente en dólares al **dólar oficial**.

```text
$125.000 → US$81,17
```

Por defecto el valor se **reemplaza** directamente (`$ 27.540.000` → `US$17.883,12`;
el original queda en el tooltip y se restaura al desactivar).

Función extra: también convierte precios en **dólares explícitos** (`U$S`, `USD`,
`US$`, `dólares`) a pesos argentinos con la misma cotización oficial:

```text
U$S 12.500 → $19.250.000
```

Solo un modo activo por vez: **Pesos → Dólares** o **Dólares → Pesos**.
Se cambia con el botón **“Cambiar moneda”** del popup y la página se
re-convierte al instante. El popup también tiene master on/off
(**Extensión activada**).

La cotización se refresca sola: el service worker programa una alarma
(`chrome.alarms`) cada 15 minutos, consulta DolarAPI en segundo plano y
avisa a las pestañas abiertas solo si hay dato fresco. El usuario nunca
tiene que actualizar nada manualmente.

Conversión: `USD = ARS / cotización_oficial_venta` · inversa: `ARS = USD × cotización_oficial_venta`.

## Fuente de cotización

```text
https://dolarapi.com/v1/dolares/oficial
```

Se usa siempre el campo `venta`. La respuesta real (verificada el 2026-10-05) es:

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

## Instalación (1 minuto)

1. Descargá el ZIP desde [**Releases**](https://github.com/francopolesel/DolarizAR/releases) y descomprimilo (no borres la carpeta después).
2. Abrí `brave://extensions/` y activá **Developer mode**.
3. **Load unpacked** → elegí la carpeta. Listo: entrá a Mercado Libre y funciona.

Para compartirla pasá el ZIP + `INSTALAR-AMIGOS.txt` (va adentro, con estos
mismos pasos). El ZIP se regenera con `scripts/pack.ps1`.

## Cómo funciona

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
- `MutationObserver` con debounce + `pushState`/`replaceState`/`popstate` para SPAs.
- Sin frameworks, sin dependencias npm, sin backend.

## Detección (precisión > cobertura)

- Solo los números con marcador de moneda (`$`, `ARS`, `pesos`) son candidatos.
  Años (`2026`), cantidades (`1650`), cuotas (`12`), porcentajes, CP, IDs y
  teléfonos **nunca** se convierten.
- El `$` ambiguo se resuelve con scoring: formato AR de miles (`125.000`),
  `ARS`/`pesos`, sitio `.ar` / Mercado Libre / Frávega / etc., palabras
  (`precio`, `total`, `cuotas`), clases CSS de precio y JSON-LD `priceCurrency: ARS`.
- Moneda extranjera explícita (`USD`, `US$`, `dólares`, `€`, `EUR`, `£`) veta
  la conversión. Umbral: 60 puntos.

## Probar

```bash
npm test   # 101 tests, sin dependencias (node:test)
```

Página manual: abrir `tests/fixtures/test-page.html` en el navegador con la
extensión cargada. Incluye precios, falsos positivos y un precio agregado por
JS a los 2 segundos (prueba del MutationObserver).

Iconos: `npm run icons` (generador PNG puro en `icons/generate-icons.mjs`).

## Estructura

```text
manifest.json          Manifest V3 (storage + host dolarapi.com)
background.js          SW: DolarAPI, cache TTL, dedup, mensajes
content.js             DOM: pipeline, render, observer, SPA, toggle
content.css            .dolarizar-* namespaced, claro/oscuro
popup.html/js/css      cotización, toggle, actualizar, decimales
utils/currency.js      parseMoney, convertARS, formatUSD (es-AR)
utils/price-detector.js candidatos, moneda, confianza (puro, testeado)
utils/rate-cache.js    normalize + isCacheValid (puro, testeado)
utils/storage.js       chrome.storage + defaults
tests/                 currency, detector, cache, content, extensión + fixture
icons/                 16/32/48/128 PNG + SVG + generador
```

Mensajes: `GET_RATE`, `FORCE_REFRESH`, `GET_SETTINGS`, `SET_DIRECTION`, `SET_ENABLED`,
`RATE_UPDATED`, `DOLARIZAR_SETTINGS_CHANGED`.

El popup muestra el modo actual con ejemplos (`$125.000 → US$81,17`,
`U$S 500 → $770.000`).

La aplicación inicial es robusta en SPAs: el observer se attacha antes de
tener cotización, las ráfagas de mutaciones se acumulan (no se descartan) y
hay re-escaneos acotados a 1,5s y 4s para renders tardíos.

## Privacidad

- Sin cuenta, sin backend propio, sin datos personales.
- Solo se consulta la cotización a DolarAPI; los precios se procesan
  localmente en el navegador y nunca salen del equipo.

## Limitaciones conocidas

- Precios con símbolo y monto en spans anidados (Mercado Libre, `andes-money-amount`)
  se detectan desde la v1.1.1 a nivel contenedor (sube hasta 3 niveles).
- `$999` (sin separadores ni contexto AR) no se convierte por seguridad;
  en sitios argentinos sí.
- Precios dentro de imágenes, canvas o shadow DOM cerrado no se detectan.
- `file://` requiere habilitar "Allow access to file URLs" en la extensión
  (afecta solo a la prueba local del fixture).
- Si DolarAPI cae y no hay cache, no se muestra nada (nunca `US$NaN`/`US$0`).
