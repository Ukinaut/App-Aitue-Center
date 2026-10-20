# Dirección visual AITUE

## Identidad vigente: Tienda AITUE España

Por indicación del usuario, la referencia principal es el index local de `C:\Users\Ukina\OneDrive\Escritorio\Tienda-Aitue-Espa-a` y sus estilos `variables.css`, `navigation.css` y `components.css`.

- Azul noche `#07162F`, superficies `#0C234A`, azul `#2C6EDB`, celeste `#59A8FF`, turquesa `#00F5D4`.
- Outfit para títulos, Inter para lectura y Share Tech Mono para etiquetas técnicas. Las fuentes se sirven localmente con sus licencias OFL en `public/fonts/`.
- Logos originales copiados sin modificación desde `Log-win-nav.png`, `logo-transparent.png` y `logo-icon-blue.jpg` a `public/brand/`.
- Navegación superior translúcida, botones compactos con borde luminoso, aplicaciones destacadas en una pastilla turquesa.
- Pie corporativo con cuatro columnas, línea superior de color, ondas de fondo, contactos y redes del index de referencia. Sus enlaces internos se adaptan a funciones existentes del portal. No se trasladan indicadores de disponibilidad de la tienda al portal.

### Cuerpo blanco y partículas

El cuerpo del portal usa fondo blanco y texto azul noche. Se mantienen oscuros el nav, el pie y el bloque destacado del panel. Los formularios y las tablas usan superficies blancas con bordes celestes. `public/particles.js` dibuja una constelación animada azul detrás del contenido, sin capturar clics. La animación se detiene cuando la pestaña está oculta y muestra una constelación estática cuando el dispositivo solicita movimiento reducido. El canvas permanece montado al cambiar de sección.

`public/chrome.js` comparte el nav y el pie entre login y panel. `public/theme.css` aporta la estructura base; `public/brand.css` aplica la identidad vigente y sus ajustes responsive. El proyecto de la tienda no se modifica.

El botón «Acceder» y los enlaces de acceso abren un diálogo con el mismo formulario y validaciones de la página. Antes de configurar el portal, muestra el alta del primer superadministrador; después, el inicio de sesión. El diálogo enfoca el primer campo, se puede cerrar con Escape o con la cruz y se cierra automáticamente al ingresar correctamente.

## Referencia inicial de composición

Referencia: [Ukinaut/Ner-repo-plug-skli](https://github.com/Ukinaut/Ner-repo-plug-skli), commit `23f0614370a79546031561f46db1c53673bb484a`.

Se aplicaron sus guías de diseño como referencia de trabajo, sin instalar servidores MCP ni modificar configuraciones globales de Codex o Antigravity.

- `taste`: contraste editorial, títulos con personalidad y composición asimétrica en el ingreso.
- `impeccable`: espaciado en escala de 4/8 px, contraste legible, estados de interacción y jerarquía de botones.
- `emil-kowalski`: transiciones breves de transform/opacity y respeto de `prefers-reduced-motion`.
- `frontend-design`: identidad coherente, formularios legibles y adaptación a escritorio y móvil.

## Sistema visual

La primera propuesta usaba marfil, tinta verde y lima, con Syne y Manrope. Esa paleta queda sustituida por la identidad de la tienda indicada arriba.

La pantalla de ingreso usa una composición dividida y un esquema visual de las tres funciones del portal: aplicaciones, equipo y permisos. El panel usa estadísticas separadas por líneas y reserva las tarjetas para grupos de información que lo necesitan.

Los formularios, identificadores de campos, llamadas a la API y controles de acceso se conservan.
