# AITUE · Portal central

Primera base funcional para reunir las aplicaciones de AITUE con cuentas propias y permisos jerárquicos.

## Ejecutar

Requiere Node.js 24 o posterior. No necesita instalar paquetes externos.

```powershell
cd "C:\Users\Ukina\OneDrive\Escritorio\Apps AITUE\aitue-portal"
npm start
```

Abrir http://127.0.0.1:3100. En el primer ingreso, crear el superadministrador con un correo y una contraseña de al menos 12 caracteres. No hay cuentas predeterminadas. La configuración inicial se cierra después de crear esa cuenta. El servidor escucha únicamente en esta computadora por defecto.

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

SQLite crea `data/aitue.sqlite`, `data/aitue.sqlite-wal` y `data/aitue.sqlite-shm`. La carpeta contiene información privada. Conviene alojar los datos fuera de una carpeta sincronizada por OneDrive al usarlo en producción: configurar `DATA_DIR` a una carpeta local del servidor. Para respaldar de forma simple, detener el servidor y copiar toda la carpeta de datos; restaurarla con el servidor detenido. No subirla a Git ni compartirla como parte del código.

Variables opcionales: `PORT` (3100), `HOST` (127.0.0.1), `DATA_DIR` (ruta absoluta), `COOKIE_SECURE` (`true` cuando se publique con HTTPS). En producción, terminar HTTPS en un proxy confiable, configurar las cookies seguras y realizar el alta inicial antes de exponer el servidor. El limitador actual es por proceso e IP de conexión: detrás de un proxy se requiere un limitador acorde con su configuración.

## Integración de las demás aplicaciones

### Gestión de GB (aplicación integrada)

Se registra automáticamente en Aplicaciones con el ID estable `aitue-gestion-gb`. URL: `/?app=gestion-gb`. Comparte la sesión del portal y valida el permiso de aplicación y el alcance de los equipos en cada consulta y escritura.

- Superadministradores: acceso completo. Administradores con acceso: ven y gestionan todos los equipos y SIM, de todas las ramas. Controladores con acceso: ven exclusivamente los equipos asignados directamente a su cuenta y sus SIM vinculadas; registran consumos y consultan sus reportes. No heredan equipos de sus descendientes. Usuarios finales con acceso: consultan sus equipos y reportes.
- Los administradores asignan, reasignan o dejan sin controlador cada equipo desde Dispositivos → Asignar, o al crear/editar el equipo. El selector admite controladores activos con acceso a Gestión de GB. El responsable original y la asignación de controlador son independientes. La reasignación conserva saldos e historial; el controlador anterior pierde el acceso en su siguiente solicitud. El filtro «Todos los equipos» permite consultar todos, los de un controlador o los que están sin asignar. Los permisos del panel central de usuarios conservan su jerarquía.
- Cada SIM tiene número único, operador y capacidad del plan. Cada dispositivo tiene kit único, nombre, responsable, estado y presupuesto de GB. Cada kit puede tener servicio satelital, SIM o ambos a la vez. Cada conexión conserva su plan, asignación, consumo y saldo independientes.
- Una SIM se vincula a un solo equipo. Al asignarla, acompaña al responsable del equipo para mantener el alcance de permisos consistente. Los GB de una SIM vinculada se cuentan una sola vez en los totales.
- Las cantidades se guardan en milésimas de GB enteras (hasta tres decimales). Se rechazan asignaciones por encima del plan y consumos por encima de la asignación. Los consumos se cargan como incrementos, no como lecturas acumuladas, y se registran con fecha, conexión utilizada (satelital o SIM), observación y autor. En un equipo con ambas conexiones es obligatorio indicar cuál se consumió; el saldo de la otra conexión no compensa un exceso.
- Dashboard con desglose satelital y SIM, y un total combinado sin duplicar equipos. Dashboard acumulado: capacidad de planes, GB asignados, consumidos, saldo, cantidad de equipos y SIM, alertas desde el 80% y últimos movimientos. Los datos se cargan manualmente; no se consulta a operadores ni se reinician saldos automáticamente por mes.
- Gráficos del dashboard: distribución circular entre consumidos, asignados por consumir y sin asignar; barras de planes, asignación y consumo para satelital y SIM; y consumo por equipo, separado por conexión. Se actualizan al guardar cambios y muestran un estado vacío cuando aún no hay datos. Los gráficos tienen etiquetas accesibles y se dibujan localmente, sin servicios externos.
- Reportes por rango de fechas, equipo y conexión, con resumen y detalle, descarga CSV y vista para imprimir o guardar como PDF desde el navegador. El CSV protege los campos de texto frente a fórmulas de hoja de cálculo.
- Los consumos son un historial de movimientos y no se borran ni editan desde esta primera versión. Se puede ampliar el plan o la asignación y desactivar equipos. Un equipo con consumos SIM conserva su vínculo; un equipo con consumos solo satelitales puede incorporar una SIM: el cambio de SIM y las renovaciones por período requieren un flujo posterior de migración.

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
