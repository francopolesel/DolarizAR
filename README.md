# DolarizAR

Extensión para Brave y Chrome que convierte automáticamente los precios de
las páginas web usando la cotización del **dólar oficial**.

- Ves un precio en pesos → lo muestra en dólares: `$125.000 → US$81,17`
- Ves un precio en dólares → lo muestra en pesos: `U$S 12.500 → $19.250.000`

El valor original no se pierde: pasá el mouse por encima para verlo junto
con el detalle de la cotización usada.

## Instalación (1 minuto)

1. Descargá el ZIP desde [**Releases**](https://github.com/francopolesel/DolarizAR/releases) y descomprimilo (no borres la carpeta después).
2. Abrí `brave://extensions/` y activá **Developer mode**.
3. **Load unpacked** → elegí la carpeta. Listo: entrá a Mercado Libre y funciona.

## Cómo usarla

Tocá el icono de DolarizAR en la barra del navegador:

- **Pesos → Dólares** o **Dólares → Pesos**: el botón **Cambiar moneda**
  alterna entre ambos modos. Solo uno está activo por vez.
- **Extensión activada**: para pausarla y ver las páginas intactas.
- **Decimales**: 2 o ninguno, a gusto.
- La cotización se actualiza sola cada 15 minutos, no hay que hacer nada.

## Preguntas frecuentes

**¿De dónde sale la cotización?**
Del dólar oficial publicado por [DolarAPI](https://dolarapi.com/v1/dolares/oficial)
(campo `venta`). El popup muestra el valor y la fecha de actualización.

**¿Por qué algunos números no se convierten?**
Por seguridad: años, cantidades, cuotas, porcentajes, códigos postales y
precios en otra moneda (`USD`, `€`) nunca se tocan. Ante la duda, la extensión
prefiere no convertir.

**¿Y si se cae internet?**
Se sigue usando la última cotización guardada. Si nunca hubo una, no se
muestra nada (nunca vas a ver `US$NaN` ni `US$0`).

**¿Qué páginas soporta?**
Cualquiera: Mercado Libre, Frávega, Musimundo, inmobiliarias, noticias,
clasificados y sitios con carga dinámica.

## Privacidad

- Sin cuenta, sin registro, sin datos personales.
- Sin servidor propio: lo único que sale de tu navegador es la consulta de
  la cotización a DolarAPI.
- Los precios se detectan y convierten localmente, en tu equipo.
