# AITUE · Portal central

Primera base funcional para reunir las aplicaciones de AITUE con cuentas propias y permisos jerárquicos.

## Ejecutar

Requiere Node.js 24 o posterior. Ejecutar `npm ci` al instalar el proyecto para incorporar las dependencias de geometría.

```powershell
cd "C:\Users\Ukina\OneDrive\Escritorio\Apps AITUE\aitue-portal"
npm start
```

Abrir http://127.0.0.1:3100. En el primer ingreso, crear el superadministrador con un correo y una contraseña de al menos 12 caracteres. No hay cuentas predeterminadas. La configuración inicial se cierra después de crear esa cuenta. El servidor escucha en todas las interfaces IPv4 para permitir acceso desde la red local mediante la IP del equipo y el puerto 3100. Para limitarlo a esta computadora, ejecutar `$env:HOST='127.0.0.1'` antes de `npm start`. El acceso desde otros dispositivos también depende del firewall de Windows.

## Roles y alcance

| Rol | Alcance |
| --- | --- |
| Superadministrador | Registra aplicaciones, crea otros superadministradores y administra las demás cuentas. No modifica su propia cuenta desde la gestión de usuarios. |
| Administrador | Administra los roles inferiores en su propia rama. Crea cuentas si tiene habilitado ese permiso. |
| Controlador | Usa aplicaciones asignadas. Puede crear usuarios finales si tiene habilitado ese permiso. |
| Usuario final | Usa aplicaciones asignadas. No crea cuentas porque es el último nivel de la jerarquía. |

Cada cuenta puede recibir acceso a aplicaciones y permiso para crear subusuarios. Solo puede otorgar roles inferiores y accesos que posee. Los administradores ajenos a una rama no pueden verla ni editarla. Los roles no se modifican después de crear una cuenta en esta versión.

Los superadministradores son cuentas principales independientes, sin padre, y pueden crear otros superadministradores. Siempre tienen acceso a todas las aplicaciones y permiso para crear cuentas. Los límites de rol inferior y de rama se aplican a los demás roles.

Retirar una aplicación de una cuenta retira ese acceso de todos sus descendientes. Retirar el permiso de crear subusuarios también lo retira de sus descendientes. Desactivar una cuenta desactiva toda su rama y revoca sus sesiones. Reactivar una cuenta no reactiva sus descendientes; deben reactivarse por orden jerárquico.

## Seguridad implementada

- Contraseñas con scrypt, sal aleatoria por cuenta y comparación de tiempo constante.
- Sesiones opacas de 8 horas, guardadas como hash en SQLite; cookies HttpOnly y SameSite Strict.
- Comprobaciones de autorización en el servidor en cada operación, no solamente en la interfaz.
- Protección de solicitudes de escritura frente a orígenes externos, límites de tamaño, validación y consultas parametrizadas.
- Límite de 15 intentos de ingreso por IP cada 15 minutos y registro de actividad.
- Política de contenido y escape de contenido variable en la interfaz.

## Datos y operación

SQLite crea `data/aitue.sqlite`, `data/aitue.sqlite-wal` y `data/aitue.sqlite-shm`. La carpeta contiene información privada. Conviene alojar los datos fuera de una carpeta sincronizada por OneDrive al usarlo en producción: configurar `DATA_DIR` a una carpeta local del servidor. Los respaldos automáticos verificables y la restauración a una carpeta nueva se describen en [Operación local](docs/operacion-local.md). Para copiar directamente toda la carpeta de datos, detener primero el servidor. No subirla a Git ni compartirla como parte del código.

Variables opcionales: `PORT` (3100), `HOST` (0.0.0.0), `DATA_DIR` (ruta absoluta), `COOKIE_SECURE` (`true` cuando se publique con HTTPS). En producción, terminar HTTPS en un proxy confiable, configurar las cookies seguras y realizar el alta inicial antes de exponer el servidor. El limitador actual es por proceso e IP de conexión: detrás de un proxy se requiere un limitador acorde con su configuración.

## Integración de las demás aplicaciones

### Gestión de GB (aplicación integrada)

Se registra automáticamente en Aplicaciones con el ID estable `aitue-gestion-gb`. URL: `/?app=gestion-gb`. Comparte la sesión del portal y valida el permiso de aplicación y el alcance de los equipos en cada consulta y escritura.

- Superadministradores: acceso completo. Administradores con acceso: ven y gestionan todos los equipos y SIM, de todas las ramas. Controladores con acceso: ven exclusivamente los equipos asignados directamente a su cuenta y sus SIM vinculadas; registran consumos y consultan sus reportes. No heredan equipos de sus descendientes. Usuarios finales con acceso: consultan sus equipos y reportes.
- Los administradores asignan, reasignan o dejan sin controlador cada equipo desde Dispositivos → Asignar, o al crear/editar el equipo. El selector admite controladores activos con acceso a Gestión de GB. El responsable original y la asignación de controlador son independientes. La reasignación conserva saldos e historial; el controlador anterior pierde el acceso en su siguiente solicitud. El filtro «Todos los equipos» permite consultar todos, los de un controlador o los que están sin asignar. Los permisos del panel central de usuarios conservan su jerarquía.
- Cada SIM tiene número único, operador y capacidad del plan. Cada dispositivo tiene kit único, nombre, responsable, estado y presupuesto de GB. Cada kit puede tener servicio satelital, SIM o ambos a la vez. Cada conexión conserva su plan, asignación, consumo y saldo independientes.
- Una SIM se vincula a un solo equipo. Al asignarla, acompaña al responsable del equipo para mantener el alcance de permisos consistente. Los GB de una SIM vinculada se cuentan una sola vez en los totales.
- Las cantidades se guardan en milésimas de GB enteras (hasta tres decimales). Se rechazan asignaciones por encima del plan y consumos por encima de la asignación. Los consumos se cargan como incrementos, no como lecturas acumuladas, y se registran con fecha, conexión utilizada (satelital o SIM), observación y autor. En un equipo con ambas conexiones es obligatorio indicar cuál se consumió; el saldo de la otra conexión no compensa un exceso.
- Dashboard con desglose satelital y SIM, y un total combinado sin duplicar equipos. Dashboard acumulado: capacidad de planes, GB asignados, consumidos, saldo, cantidad de equipos y SIM, alertas desde el 80% y últimos movimientos. Los datos se cargan manualmente y no se consulta al operador. Las conexiones conservan el acumulado hasta que un administrador activa ciclos mensuales en Planes y ciclos.
- Gráficos del dashboard: distribución circular entre consumidos, asignados por consumir y sin asignar; barras de planes, asignación y consumo para satelital y SIM; y consumo por equipo, separado por conexión. Se actualizan al guardar cambios y muestran un estado vacío cuando aún no hay datos. Los gráficos tienen etiquetas accesibles y se dibujan localmente, sin servicios externos.
- Reportes por rango de fechas, equipo y conexión, con resumen y detalle, descarga CSV y vista para imprimir o guardar como PDF desde el navegador. El CSV protege los campos de texto frente a fórmulas de hoja de cálculo.
- Los consumos son un historial inmutable: los administradores pueden agregar correcciones de cantidad con motivo y autor, sin borrar el registro original. Se puede ampliar el plan o la asignación y desactivar equipos. Un equipo con consumos SIM conserva su vínculo; un equipo con consumos solo satelitales puede incorporar una SIM: el cambio de SIM con historial requiere un flujo específico de migración; las renovaciones mensuales ya se administran desde Planes y ciclos.

### Reporte satelital (aplicación integrada)

ID estable `aitue-reporte-satelital`, URL `/?app=reporte-satelital`. Se agrega automáticamente a Aplicaciones y comparte la sesión del portal. Los superadministradores ingresan directamente; los demás roles necesitan que se les habilite este acceso desde Usuarios y accesos. Es una aplicación de consulta: no modifica dispositivos ni permisos.

- Vista mundial inicial con mapa interactivo, botones de filtro por fenómeno junto al mapa (sincronizados con la lista), selector de zonas o centros y encuadre automático de los eventos filtrados. Se conservan los filtros por fenómeno, nivel comunicado por la fuente, fuente, texto y radio de referencia de 500 km alrededor del punto seleccionado. Los polígonos y multipolígonos publicados por GDACS y EONET se dibujan con borde continuo, conservando sus huecos. Los polígonos de viento muestran el último período disponible que no supere la fecha del evento; no se mezclan con pronósticos futuros. Las geometrías se validan, se cachean y se corrigen al cruzar el antimeridiano. Si no hay un perímetro publicado disponible, se utiliza un círculo discontinuo de referencia (10–250 km, 50 km por defecto), explícitamente separado de un área afectada medida. La extensión no se calcula a partir de magnitudes o superficies comunicadas. Ninguna de estas referencias define zonas de evacuación.
- NASA EONET: eventos abiertos con registros de los últimos siete días (hasta 200); incendios y otros fenómenos catalogados. No es un inventario exhaustivo de focos de calor ni video en vivo.
- GDACS: reportes de catástrofes de la última semana, con el nivel verde, naranja o rojo comunicado por la fuente. Los datos se atribuyen a Global Disaster Alert and Coordination System, GDACS.
- USGS: sismos de magnitud 2,5 o superior en los últimos siete días. Un nivel ausente se muestra como «sin clasificación», nunca como riesgo bajo. Un mismo fenómeno puede aparecer en varias fuentes; los contadores representan reportes, no catástrofes únicas.
- MET Norway Locationforecast: temperatura, humedad, presión, nubosidad, precipitación prevista y viento para un punto elegido en el mapa o mediante búsqueda. Pronósticos modelados, no mediciones de una estación. El viento se convierte de m/s a km/h, el gráfico usa horas UTC y las ráfagas se muestran solo donde la fuente las proporciona. Datos bajo [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), con atribución y cambios indicados en pantalla.
- Búsqueda manual mediante Nominatim / OpenStreetMap. Se limita a una petición por segundo para toda esta instancia y se cachea una hora; no hay autocompletado ni consultas masivas. La aplicación se identifica con su URL de GitHub.
- Mapa de OpenStreetMap y capa opcional NASA GIBS Blue Marble: mosaico satelital continuo de referencia, sin franjas orbitales; no representa una captura en vivo. Se limita el mapa a un solo mundo, con zoom mínimo adaptado al contenedor y actualización del tamaño al cambiar el ancho de la ventana. Leaflet 1.9.4 se sirve localmente junto con su licencia.
- Consulta automática cada cinco minutos mientras la pestaña esté visible. El servidor comparte caché entre usuarios (cinco minutos para eventos, diez para clima, respetando también `Expires`). Los errores tienen espera de reintento; la última consulta disponible se marca como anterior y deja de mostrarse después de 24 horas. Los proveedores no reciben cookies ni credenciales del portal. Las solicitudes tienen timeout, límite de tamaño y URLs de proveedor fijas.
- Se requiere acceso a internet para datos y mapas. No incluye alertas push, correos, detección automática de todos los peligros, integración con sensores privados ni carga de archivos. La ausencia de reportes no implica ausencia de peligro; las instrucciones de emergencia corresponden a las autoridades locales.

Documentación de fuentes: [NASA EONET](https://eonet.gsfc.nasa.gov/docs/v3), [GDACS](https://www.gdacs.org/Documents/2025/GDACS_API_quickstart_v2.pdf), [USGS](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php), [MET Norway](https://api.met.no/doc/TermsOfService), [Nominatim](https://operations.osmfoundation.org/policies/nominatim/), [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/access-basics/). Para escalar el servicio se deben revisar las cuotas y políticas de los proveedores y la capacidad de las teselas públicas; no hay SLA contratado.

### Aplicaciones externas

Registrar una aplicación agrega un enlace y permite asignarlo a personas. **Todavía no proporciona SSO ni protege una aplicación externa visitada directamente**. Cada futura aplicación debe integrarse con el proveedor de identidad central y validar sus permisos en su propio servidor. No enviar contraseñas, cookies ni tokens en URLs. Para un despliegue con varias aplicaciones, el siguiente paso es definir dominio e infraestructura y una integración estándar de identidad (por ejemplo OIDC).

La publicación queda pendiente de infraestructura para las cuentas propias de AITUE; el hosting Sites utiliza identidad de ChatGPT y no sustituye directamente este backend de correo y contraseña. Esta versión funciona localmente y no está publicada.

Todavía no incluye recuperación de contraseña por correo, MFA, invitaciones, cambios de rol, edición de aplicaciones ni un protocolo de SSO entre aplicaciones. No hay envío de correos: al crear una cuenta se establece una contraseña inicial.

## Verificar

```powershell
npm test
```

La prueba usa una base temporal aislada y verifica altas, inicio y cierre de sesión, solicitudes externas, delegación, aislamiento entre ramas, bloqueo de escaladas, acceso a aplicaciones y revocación de permisos y sesiones.

La migración a conexiones simultáneas conserva las asignaciones e identifica los consumos anteriores según la conexión del equipo en el modelo previo. Antes de aplicar esta migración se guardó un respaldo consistente en `data/backups/`.

La migración de asignaciones conserva como controlador al responsable anterior cuando su rol es controlador. Los demás equipos quedan sin controlador; los administradores conservan el acceso global.


### Colores y zonas de los sectores

Los paneles de Reporte satelital usan colores consistentes en las pestañas, leyenda y mapa: petrolera naranja, mineras violeta, agrícola verde, nuclear rojo y renovable azul. La cobertura disponible sigue siendo Argentina / Petrolera / Chubut; los otros sectores no muestran ubicaciones sin datos aportados.

El filtro «Zona / área petrolera» limita tanto el inventario y sus indicadores como los puntos y contornos del mapa. La capa «Zonas petroleras orientativas» se puede ocultar. Sus polígonos son envolventes convexas calculadas a partir de las ubicaciones de los pozos de cada área en la selección actual: se unen por sector para ocultar líneas interiores donde se superponen y no representan concesiones, jurisdicciones ni superficies de explotación verificadas. Menos de tres ubicaciones distintas no alineadas no producen un polígono. El seguimiento documental se distingue por el borde del punto, conservando el color del sector.


## Trackeo / Streaming de video

Aplicación integrada: /?app=trackeo-video (aitue-trackeo-video), con las mismas sesiones y permisos del portal. El inventario completo queda reservado a superadministradores y administradores con acceso; controladores y usuarios finales consultan exclusivamente las unidades asignadas directamente a su cuenta. Superadministradores y administradores con acceso gestionan el inventario, cámaras y sincronizaciones; las demás cuentas autorizadas consultan.

El centro de monitoreo tiene lista lateral, búsqueda por unidad/IMEI/PSN, filtro de tipo, selección y visibilidad de unidades en el mapa, vista ampliada y ficha de telemetría. Las unidades pueden ser vehículos, aeronaves, personas, equipos, cámaras heredadas u otras. Los dispositivos GPS son registros separados: cada uno tiene unidad asignada, nombre, IMEI de 15 dígitos, PSN como texto de hasta 64 caracteres, fabricante, modelo, proveedor e ID externo. Los identificadores se conservan con sus ceros iniciales y los duplicados se rechazan. Las cámaras pertenecen a un dispositivo y tienen nombre, canal, formato y URL opcional.

Las ubicaciones manuales siguen identificadas como tales. Las posiciones GPS recientes significan muestras de los últimos cinco minutos, no conexión confirmada. El portal consulta la base cada 30 segundos con la pestaña visible. Los recorridos muestran hasta 2.000 posiciones de las últimas 24 horas; las líneas unen muestras, sin reconstruir el camino real, y se separan al cruzar el antimeridiano. Archivar una unidad conserva sus datos e impide nuevas posiciones; reasignar un dispositivo conserva las posiciones históricas en su unidad original.

### Wialon Remote API

Copiar .env.example a .env y configurar WIALON_TOKEN con un token de lectura. npm start carga .env; nunca lo subas a Git. El token permanece en el backend. Se permiten los endpoints HTTPS https://hst-api.wialon.com/wialon/ajax.html y https://hst-api.wialon.us/wialon/ajax.html, configurables mediante WIALON_API_URL. No se aceptan endpoints enviados desde el navegador ni redirecciones.

La sincronización es bajo demanda desde Integraciones. Ejecuta token/login, core/search_items paginado (250 registros por página, límite 10.000, flags 1281) y core/logout. Importa unidades/dispositivos y la última posición con su fecha original, velocidad, rumbo y altitud; no importa todo el historial del proveedor. Evita repetir muestras y no enlaza silenciosamente IMEI conflictivos. Los registros importados quedan como tipo Equipo, editable por el administrador. No se descargan ni exponen contraseñas de hardware, teléfonos o datos adicionales de la respuesta del proveedor. Esta conexión se probó con respuestas controladas; la validación con una cuenta Wialon real requiere credenciales.

### Recepción directa de Spider compatibles

El receptor opcional implementa TCP de texto Wialon IPS 1.x sin CRC, coherente con el modo IPS 1.0 documentado para Spider IoT con firmware compatible. Es independiente de la cuenta y la API Wialon. No implementa formatos nativos Rinho CY/BP/CQ, IPS 2.x, UDP, compresión, fotos ni comandos de control. Antes de redirigir un equipo, confirmar modelo, firmware y una trama real. Los ejemplos de la documentación del fabricante tienen variantes; no se ha certificado un Spider físico.

Configuración del servidor: TRACKING_INGEST_ENABLED=true, TRACKING_INGEST_HOST=0.0.0.0 y TRACKING_INGEST_PORT=5101. Por defecto está deshabilitado y el host es 127.0.0.1. TRACKING_PUBLIC_HOST es solo el destino público a mostrar en el panel; no configura DNS, NAT ni firewall. Para equipos por SIM fuera de la LAN hace falta un servidor/destino público enrutable, conectividad, APN y reglas de red apropiadas. IPS TCP transmite en texto plano: el despliegue debe contemplar una red privada/APN o VPN y el alcance de la exposición.

Registrar el dispositivo con proveedor Rinho e IMEI, asignarlo a una unidad y generar su clave desde Dispositivos GPS. Se muestra una sola vez; solo se conserva su hash scrypt. El GPS debe usar ese IMEI y clave en el login IPS. Renovar la clave invalida nuevas posiciones de sesiones anteriores. Las muestras se guardan con su timestamp UTC y se confirman después de persistir. Login, D, SD, ping y lotes B se admiten en el subconjunto indicado; fechas, coordenadas y valores inválidos se rechazan. Los paquetes incompletos se ensamblan con límites de tamaño, tiempo, conexiones y mensajes. Sin fecha válida no se inventa la hora GPS.

Referencias oficiales: [modo de comunicación Rinho](https://docs.rinho.com.ar/comandos/comunicaciones/datos-moviles/comando-cxip), [autenticación y datos IPS en Rinho](https://docs.rinho.com.ar/comandos/comunicaciones/datos-moviles/comando-wl), [Wialon IPS 1.1](https://extapi.wialon.com/hw/cfg/Wialon%20IPS_en.pdf), [Remote API Wialon](https://help.wialon.com/en/api/user-guide/api-reference/core/search_items).

### Video

Reproducción bajo demanda de fuentes HLS mediante hls.js y video MP4 compatible mediante el navegador. Las fuentes HLS necesitan CORS y codecs compatibles. RTSP se puede registrar, pero requiere un gateway HLS para verse en el navegador. No hay grabación ni integración automática del API de video de Wialon. La reproducción contra una cámara real sigue pendiente de disponer de la fuente.

La CSP de la página de Trackeo permite media y conexiones HTTP/HTTPS para fuentes de video; otras páginas mantienen su política previa. El servidor no hace proxy ni consulta URLs de cámaras. Las URLs de reproducción se entregan a las cuentas con acceso a esta app: usar enlaces con el alcance apropiado. No se permiten usuarios o contraseñas incrustados en la URL. En HTTPS, las fuentes también deben usar HTTPS.

Antes de ampliar el esquema se guardó un respaldo consistente en data/backups/. Los datos, credenciales y respaldos permanecen fuera de Git. Leaflet conserva su licencia; hls.js se distribuye en public/vendor/hls con licencia Apache-2.0.


## Dashboards y reportes

Las dos apps abren en Dashboard y reportes. Reporte satelital usa /?app=reporte-satelital&sector=dashboard; Trackeo usa /?app=trackeo-video. Las vistas de monitoreo y los paneles anteriores siguen disponibles en sus pestañas.

Reporte satelital ofrece eventos/alertas del conjunto actual de NASA EONET, GDACS y USGS (hasta siete días, con fecha del evento, filtro de fenómeno, fuente y nivel), y un reporte del inventario petrolero de Chubut con filtros de empresa/área. Los gráficos muestran distribución y actividad diaria UTC. Los estados y fechas de consulta de cada fuente se conservan, incluyendo datos anteriores o fuentes no disponibles. No se crea un archivo histórico de consultas ni se deduplican fenómenos entre proveedores. Para este resumen se omite la descarga de polígonos GDACS; el mapa sigue consultándolos cuando corresponde.

El inventario petrolero muestra su actualización declarada y agrupa los pozos por estado, empresa, cuenca y área. No se presenta como dato en tiempo real ni se aplica una ventana móvil a la base. Los otros sectores aún no cuentan con datos incorporados.

Trackeo resume unidades y posiciones almacenadas con filtros de 24 horas, siete o treinta días, unidad, tipo, estado actual y fuente. Incluye unidades sin posiciones, muestras por fuente/día, primeras y últimas muestras, velocidad máxima recibida y GPS/cámaras del inventario actual. No se calculan kilómetros, horas de uso, conexión o grabación a partir de datos incompletos. Los endpoints GET /api/tracking/report, /api/satellite/report y /api/industry/oil/AR/report exigen el mismo permiso de app que sus pantallas.

La tabla muestra 25 filas por página. Descargar CSV incluye todas las filas, indicadores, valores de gráficos, filtros aplicados, generación UTC, estado de fuentes y notas de alcance. Se escapan fórmulas de planilla y se preservan cadenas de identificadores con ceros iniciales o longitud superior a la precisión de una hoja de cálculo. Imprimir / PDF usa el diálogo del navegador, con una copia del reporte que incluye todas las filas y una hoja de estilo de impresión; guardar como PDF depende de la opción del navegador. No se generan archivos en el servidor ni se envían reportes por correo.

Los reportes de Trackeo se actualizan cada 30 segundos y los satelitales cada cinco minutos, con la pestaña visible. Aplicar / actualizar permite una consulta manual. Una consulta fallida conserva el último reporte y su selección originales; CSV e impresión respetan esa instantánea.


## Identificación interna en Gestión de GB

Los administradores pueden asignar y editar un número interno único (hasta 40 letras, números, puntos, barras, guiones o guiones bajos). Se conserva como texto, incluidos los ceros iniciales. Si se omite al crear, se genera un código GB-000001 y siguientes; los equipos anteriores reciben uno automáticamente sin cambiar saldos, responsables, asignaciones ni historial.

Superadministradores y administradores con acceso a la app ven el código junto con el kit, nombre real y SIM. Controladores y usuarios finales reciben únicamente la identidad interna: el servidor sustituye kit y nombre, reserva el número de SIM y oculta las observaciones del historial. Esto se aplica al dashboard, inventarios, gráficos, selección de consumo, reportes, CSV e impresión. Los eventos de actividad de GB también reservan su detalle para estos roles, incluidos los registros anteriores. Los UUID siguen siendo referencias técnicas opacas; no son el kit ni la SIM. El alcance de equipos asignados y los permisos de escritura se conservan.

El código debe ser una referencia neutral: no cargar el kit, número de SIM ni otra identidad real como número interno. El operador de la SIM y los saldos siguen visibles para gestionar el servicio.


## Asignaciones y privacidad en Trackeo

Desde Unidades → Asignar acceso, administradores con acceso pueden seleccionar uno o varios controladores o usuarios finales activos que tengan habilitada la aplicación. También pueden asignar al crear una unidad o retirar todos los accesos. No se heredan accesos por jerarquía: un controlador no ve automáticamente las unidades de sus subusuarios. Las asignaciones se guardan por unidad; GPS y cámaras acompañan el vínculo actual de cada dispositivo. Cambiar el dispositivo de unidad no traslada las posiciones históricas. Archivar y reactivar conserva las asignaciones.

Cada unidad tiene un número interno único editable, conservado como texto. Al crear se puede omitir para generar TRK-000001 y siguientes. La migración añade códigos a unidades existentes conservando inventario e historial, sin asignarlas implícitamente a cuentas anteriores. Wialon también crea unidades sin asignar, visibles inicialmente solo para administradores. Elegir referencias neutrales que no contengan matrícula, nombre real, IMEI ni PSN.

El servidor filtra dashboard, GPS, cámaras, historial, opciones de filtros, gráficos, métricas y reportes por asignación. Las respuestas a cuentas no administrativas sustituyen el nombre e identificador por el número interno y omiten nombre real del GPS, IMEI, PSN, fabricante, modelo, ID externo, notas, nombres/canales reales de cámaras y detalles de integración. El CSV y la impresión usan esas mismas respuestas. Las asignaciones y configuración se editan exclusivamente por administradores. Las consultas por UUID ajenos no permiten leer historial ni fuentes de cámaras.

La fuente de video se solicita bajo demanda a un endpoint que comprueba el acceso actual; el dashboard de un usuario no entrega URLs. No se entregan a usuarios enlaces que contengan el IMEI, PSN, ID externo o identificador real de la unidad: el administrador debe configurar enlaces neutrales. El navegador reproduce directamente desde el proveedor, por lo que puede observar su URL una vez autorizado; no hay proxy ni garantía de revocar en el proveedor un enlace ya entregado. Para eso se requiere un gateway con enlaces temporales. El portal detiene reproductores al detectar cambios de acceso en su consulta cada 30 segundos, al ocultar la pestaña y al salir de la app. Los permisos se vuelven a comprobar en cada solicitud; retirar la app o desactivar una cuenta conserva el mecanismo de revocación de sesiones. Un reporte de Trackeo fallido se retira de pantalla y se deshabilitan exportaciones hasta obtener una consulta válida.


## Centro de alertas

Acceso desde la campana del menú o /?app=centro-alertas. Gestión de GB y Trackeo incluyen un enlace directo con su filtro de aplicación. No exige un permiso adicional: consulta únicamente los datos de las aplicaciones habilitadas y las asignaciones actuales de la cuenta. Superadministradores y administradores con acceso conservan la vista global de cada app; controladores y usuarios ven exclusivamente sus equipos. Los identificadores reales y nombres de zonas se reservan a administradores. Retirar la asignación también retira las alertas y su detalle de esa cuenta.

El servidor evalúa al iniciar y cada 30 segundos mientras permanece funcionando, aunque no haya una pestaña abierta. La bandeja también evalúa al consultar y actualiza cada 30 segundos con la pestaña visible. Los registros, condiciones, cursores de evaluación y acciones de seguimiento se guardan en SQLite. No se envían correos, SMS, mensajes ni notificaciones externas.

- GB: umbral inicial del 80% de la asignación, editable entre 1 y 100%; satelital y SIM se calculan por separado. Al alcanzar el 100%, la prioridad es crítica. No usa el saldo total del plan para inferir el presupuesto de un equipo.
- GPS: 30 minutos sin posiciones por defecto para unidades activas con GPS vinculado; configurable o deshabilitable por unidad. Usa la última muestra GPS de los dispositivos actualmente vinculados, o el alta del GPS si todavía no hay primera muestra. Las posiciones manuales no resuelven esta condición. La fecha corresponde al dato GPS: un mensaje atrasado puede seguir dando lugar al aviso; no se afirma que el equipo esté desconectado.
- Velocidad: deshabilitada hasta que un administrador configure el límite por unidad. Evalúa las muestras posteriores al guardado, incluidas las intermedias entre dos consultas; no calcula velocidad a partir del recorrido ni usa valores manuales.
- Zonas: círculos configurables con centro, radio (0,05–1.000 km), unidad y eventos de entrada/salida. La primera muestra GPS posterior al alta o edición establece la referencia; las siguientes detectan cambios dentro/fuera por comparación de posiciones. No reconstruye cruces entre muestras ni filtra el ruido del GPS cerca del borde. Los campos permiten cargar coordenadas sin mapa; el mapa requiere internet. Las zonas pueden desactivarse sin borrar su historial.

Para velocidad y zonas se procesan hasta 1.000 muestras por unidad/regla en cada evaluación, por fecha GPS e ID. Las muestras futuras se ignoran hasta su fecha y las que llegan fuera de orden antes del cursor no reescriben los eventos ya evaluados. Una acumulación grande puede necesitar varios ciclos. Los avisos de posición y velocidad no consideran muestras de dispositivos trasladados a otra unidad, conservando el historial original de posiciones.

Estados: abierta, reconocida y cerrada. Controladores y administradores pueden reconocer, cerrar y reabrir avisos dentro de su alcance; usuarios finales solo consultan. Cada cambio queda registrado con autor y fecha. Una condición puede dejar de detectarse sin cerrar automáticamente el seguimiento humano. Cerrar manualmente una alerta activa no la vuelve a generar en cada ciclo: se necesita que finalice esa condición y comience una nueva incidencia. Los eventos de zona son avisos puntuales, con un registro por transición. Ajustar reglas reinicia la evaluación de velocidad o la referencia de zona; los eventos anteriores se conservan.

La validación con un GPS y una cámara físicos continúa pendiente. El centro ya funciona con datos almacenados y con consumos manuales de GB, pero las alertas GPS dependen de la telemetría que reciba la plataforma. No integra todavía las catástrofes externas de Reporte satelital; el cruce con posiciones corresponde a la siguiente etapa de vinculación entre apps.


## Planes mensuales y correcciones de GB

Gestión de GB → Planes y ciclos permite consultar y administrar cada conexión por separado. Los registros existentes mantienen su cantidad y quedan como Acumulado anterior. No se asignan retroactivamente a un mes. Al activar ciclos, el primer período comienza en la fecha local de Argentina y con consumo registrado en cero; el administrador elige el día mensual de renovación (1–31), plan, asignación y si la renovación será automática. El primer período puede ser más corto para alcanzar ese día. En meses cortos se utiliza el último día, manteniendo el día ancla para los meses siguientes: 31 de enero → 28/29 de febrero → 31 de marzo. El fin de cada período es exclusivo.

La renovación automática se procesa con el servidor funcionando, al iniciar, cada 30 segundos junto al motor de alertas y al consultar Gestión de GB. Si el servidor estuvo detenido, abre los períodos que falten hasta la fecha actual (hasta 120 por conexión en cada evaluación). Una conexión de un equipo desactivado no se renueva automáticamente mientras esté desactivado. Sin renovación automática, el período vence y sus saldos dejan de contribuir al dashboard hasta la renovación manual. No se renueva anticipadamente para borrar consumos: un plan vigente puede ampliarse sin iniciar otro período. Los consumos y saldos no utilizados no se arrastran al mes siguiente. Las renovaciones registran períodos contables internos; no consultan, contratan ni confirman la renovación del operador.

Modificar plan vigente cambia únicamente la capacidad y asignación del período abierto, conservando su consumo. Configurar renovación cambia la plantilla de los próximos períodos y la opción automática, sin alterar el vigente. Ambos guardan autor, fecha, cantidades anteriores y nuevas y motivo. Las ediciones de planes acumulados desde el inventario también quedan registradas. Los cambios de plan anteriores a esta función no se inventan ni reconstruyen. El inventario y SIM cards no permiten modificar directamente los presupuestos de conexiones mensuales: usar Planes y ciclos. Los períodos finalizados conservan sus planes; los ajustes de consumos históricos mantienen su período original.

Cada consumo nuevo de una conexión mensual se vincula al período que corresponde a su fecha, y no puede superar la asignación de esa conexión y período. Se pueden agregar lecturas tardías de períodos existentes, pero no consumos futuros ni nuevas lecturas de un acumulado anterior una vez activados los ciclos. La SIM sigue vinculada si existe historial, para no atribuir lecturas de otra tarjeta al mismo período.

Desde Últimos consumos o Reportes → Corregir / historial, un administrador puede establecer la cantidad correcta de un registro (cero permite anularlo) e ingresar un motivo obligatorio. La cantidad original, fecha, conexión, autor y período no se modifican: se agrega un ajuste con cantidad anterior, nueva, diferencia, autor, fecha y motivo. Se impiden resultados negativos y consumos efectivos superiores a la asignación del período. Los reportes y balances usan el consumo efectivo. Corregir un período finalizado no altera el saldo del período actual; corregir el Acumulado anterior usa su asignación conservada al activar ciclos. Controladores y usuarios finales ven los importes efectivos y la marca de corrección, pero no pueden corregir ni consultar los motivos administrativos.

El dashboard y gráficos combinan los saldos vigentes de cada conexión y el acumulado de aquellas que todavía no usan ciclos; no representan un único mes común cuando los días de renovación difieren. Reportes permite filtrar por fechas, conexión y período concreto o Acumulado anterior. CSV conserva período, cantidad original, cantidad efectiva y marca de corrección; los importes anulados siguen visibles con cero y su historial. El Centro de alertas usa los saldos efectivos del período vigente, finaliza las condiciones al renovar o corregir por debajo del umbral y no arrastra alertas activas a un período nuevo.


## Cruce de eventos y unidades (paso 6)

Disponible en «Eventos y unidades» dentro de Trackeo y Reporte satelital. Requiere ambos permisos de aplicación; superadministradores y administradores habilitados consultan el inventario activo, y los demás roles solo sus unidades asignadas directamente. Las identidades visibles siguen las reglas de Trackeo. GET /api/exposure/report vuelve a comprobar sesión, permisos y asignaciones después de consultar fuentes externas; GET /api/exposure/access permite retirar los resultados tras una revocación (consulta del navegador cada 30 segundos mientras está visible).

Compara eventos de los últimos siete días con la última posición no futura de cada unidad activa. Descarta telemetría de GPS que ya no están vinculados a esa unidad y diferencia posiciones manuales. «Dentro del área publicada» usa Polygon/MultiPolygon de la fuente, incluidos huecos, bordes y antimeridiano. Solo cuando no hay un perímetro utilizable se aplica un radio de referencia configurable de 1 a 500 km (25 km iniciales). La distancia de la tabla es al punto del evento, no al borde de su área. Un radio no representa un área de afectación medida.

La posición se clasifica reciente hasta 30 minutos por defecto (configurable de 1 a 1440), anterior o manual. Fuentes anteriores/no disponibles y posiciones anteriores/manuales quedan para revisión. Se muestran fechas del evento, de la posición y de consulta, además del nivel original de la fuente; no se deduce gravedad a partir de la distancia. Las coincidencias son relaciones unidad/evento: no son incidentes únicos ni confirman presencia histórica o peligro actual. Sin coincidencias no significa ausencia de peligro. Este panel no genera alertas automáticas ni notificaciones externas.

Incluye filtros por unidad, fenómeno, fuente, relación y calidad de posición; indicadores, mapa, tabla paginada y CSV. Los resultados se actualizan cada cinco minutos y al volver a la pestaña. Si hay más de 2.000 coincidencias se informa la cobertura parcial en pantalla y CSV, conservando los totales del cálculo y permitiendo reducir filtros. No consulta proveedores cuando no hay unidades activas en alcance. No requiere cambiar el esquema de la base ni cargar muestras en el inventario real.


## Infraestructura local (paso 7)

El menú **Estado del sistema** (`/?app=sistema`) es exclusivo del superadministrador. Muestra disponibilidad de la base y del receptor GPS opcional, tiempo de actividad, configuración de cookies y respaldo automático/manual. El botón crea y verifica el respaldo en el almacenamiento del servidor; no entrega una descarga de los datos privados. Los intentos manuales se limitan a uno por minuto y las ejecuciones del panel y planificador no se superponen.

Por defecto se verifica el último respaldo al iniciar y se genera uno si corresponde, con intervalo de 24 horas mientras el servidor esté funcionando. Incluye la base transaccional y el conjunto sectorial activo. Los archivos sectoriales inmutables se comparten por hash entre copias. Las verificaciones comprueban SHA-256 y la integridad SQLite; las copias incompletas no se publican como terminadas. No hay eliminación automática de respaldos. Conservar la carpeta completa, incluidos sus objetos, en otro disco.

Comandos: `npm run backup`, `npm run backup:verify -- --backup RUTA` y `npm run backup:restore -- --backup RUTA --target CARPETA_NUEVA`. La restauración exige un destino nuevo, valida archivos y revoca las sesiones copiadas sin tocar los datos activos. El servidor no inicia desde una carpeta marcada como restauración incompleta. Variables nuevas: `BACKUP_DIR` y `BACKUP_INTERVAL_HOURS` (24; 0 para deshabilitar la programación). `.env.example` documenta también DATA_DIR y COOKIE_SECURE.

`/healthz` y `/readyz` permiten comprobar disponibilidad sin exponer detalles privados. SIGINT/SIGTERM solicitan el cierre de HTTP, recepción GPS, respaldos y base, con un límite de 30 segundos. Estos controles no mantienen encendido el equipo ni sustituyen un servicio con reinicio automático. No se ha publicado la plataforma: todavía no hay servidor ni dominio elegidos. Instrucciones completas, alcances y restauración en [Operación local](docs/operacion-local.md).
