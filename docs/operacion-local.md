# Operación local de AITUE CENTRAL

La instancia sigue en esta computadora y en su red local. No requiere dominio ni publica datos en internet.

## Panel de operación

Ingresar con una cuenta superadministradora y abrir **Estado del sistema** en el menú, o `/?app=sistema`. Permite consultar disponibilidad de la base, tiempo de actividad, receptor GPS opcional y respaldos, además de crear un respaldo manual. Las demás cuentas no pueden acceder a estas operaciones, aunque conozcan su URL. No se descargan bases ni contraseñas desde este panel.

`/healthz` y `/readyz` admiten GET/HEAD sin sesión y responden únicamente `{"status":"ok"}` o HTTP 503 con `{"status":"unavailable"}`. Comprobarán la lectura de la base y, si se habilitó la recepción directa, que el receptor GPS esté abierto. No prueban cámaras, conectividad de un GPS físico, proveedores externos, espacio libre ni todas las escrituras de la base. Ambos endpoints usan hoy el mismo criterio de disponibilidad.

## Respaldos

Al iniciar el servidor se verifica el último respaldo terminado. Si no existe uno válido o ya transcurrió el intervalo configurado, se crea otro. Por defecto, cada 24 horas. El planificador comprueba cada minuto mientras el servidor esté encendido. Tras un error reintenta como mínimo un minuto después; el panel muestra el fallo. No reemplaza un servicio del sistema operativo que mantenga Node encendido.

El respaldo contiene una instantánea consistente de `aitue.sqlite`, incluyendo cambios confirmados del WAL, y el catálogo sectorial activo con su conjunto completo: índice, fuente y archivos originales. Utiliza [`node:sqlite.backup`](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html), SHA-256 por archivo y `PRAGMA quick_check` en las bases. No copia `.env`, tokens de proveedores, código del programa, archivos temporales ni conjuntos sectoriales inactivos. Conservar el código y las credenciales de integración por separado.

Estructura dentro de `BACKUP_DIR` (por defecto `DATA_DIR/backups`):

```text
backups/
  aitue-FECHA-UUID/
    manifest.json
    aitue.sqlite
  objects/
    HASH_SHA256
    ...
```

Los archivos sectoriales se guardan por su hash en `objects/`, compartidos entre respaldos. Así, el conjunto petrolero no se duplica en cada ejecución. **Copiar siempre toda la carpeta `backups/`, incluyendo `objects/`**, para llevarla a otro disco o servidor. Una carpeta individual `aitue-FECHA-UUID` no constituye por sí sola una copia completa cuando hay datos sectoriales. El tamaño lógico del panel cuenta archivos compartidos; no representa el incremento de disco de cada ejecución.

Las carpetas `.partial` indican una operación que no se completó y nunca aparecen como respaldos terminados. No hay borrado ni retención automática: revisar espacio disponible y conservar al menos una copia completa en otro disco. Los respaldos locales no protegen frente a la pérdida del disco que contiene datos y copias. Las comprobaciones detectan corrupción accidental; el manifiesto no está firmado y no autentica una copia frente a quien pueda modificar tanto archivos como hashes.

Los respaldos contienen información privada: usuarios, hashes de contraseñas y claves, posiciones y permisos. Mantener acceso al almacenamiento limitado a los responsables del servidor. En Windows se heredan los permisos de la carpeta elegida. No subir respaldos a GitHub ni compartirlos como código.

### Crear y comprobar desde la consola

Desde la carpeta del proyecto, con Node 24 o posterior:

```powershell
npm run backup
npm run backup:verify -- --backup "RUTA_COMPLETA\backups\aitue-FECHA-UUID"
```

Crear y verificar pueden hacerse con el portal encendido. La consola muestra la carpeta del respaldo; no imprime cuentas, contraseñas ni posiciones. Si falla una operación, devuelve código de salida distinto de cero. Evitar lanzar varias copias desde consolas a la vez: cada consola es independiente; el panel y planificador sí comparten exclusión de ejecución dentro del servidor.

### Restaurar o trasladar datos

1. Elegir un respaldo terminado y conservar su carpeta `backups` completa. Mantener el código de la aplicación correspondiente a esa versión o una posterior compatible; no restaurar esquemas nuevos sobre código anterior.
2. Detener el portal antes de cambiar la carpeta activa o iniciar otra instancia que use esos datos. No reemplazar archivos de una base que esté abierta.
3. Restaurar en una **carpeta nueva cuyo directorio padre ya exista**:

```powershell
npm run backup:restore -- --backup "D:\Copias-AITUE\aitue-FECHA-UUID" --target "C:\AITUE\datos-restaurados"
```

4. La herramienta comprueba todos los hashes y bases antes de crear el destino, copia y comprueba nuevamente cada archivo. Invalida las sesiones de la copia: todos deberán iniciar sesión otra vez. No cambia los usuarios, contraseñas, permisos ni registros originales. No acepta destinos existentes. Si falla después de crear la carpeta, deja `.restore-incomplete`; el servidor rechaza iniciar desde esa carpeta. Resolver la causa y restaurar otra vez en un destino nuevo.
5. Configurar `DATA_DIR` con el destino restaurado y arrancar una única instancia. Verificar `/readyz`, iniciar sesión y revisar las aplicaciones. Guardar los datos originales para poder volver a la configuración anterior. Los respaldos previos no se importan al destino: conservar también su carpeta original.

Ejemplo de `.env` para una instalación local permanente (crear previamente `C:\AITUE` y restringir sus permisos):

```dotenv
HOST=0.0.0.0
PORT=3100
DATA_DIR=C:/AITUE/datos-restaurados
BACKUP_DIR=D:/Copias-AITUE
BACKUP_INTERVAL_HOURS=24
COOKIE_SECURE=false
TRACKING_INGEST_ENABLED=false
```

Usar una ruta de respaldo existente en el equipo: `D:` es solo un ejemplo. Si se omite `BACKUP_DIR`, se utiliza la subcarpeta `backups` de `DATA_DIR`. `BACKUP_INTERVAL_HOURS=0` deshabilita únicamente la programación, manteniendo el respaldo manual. La configuración no se modifica desde el navegador.

Evitar OneDrive u otras carpetas sincronizadas para una base activa. El panel detecta «OneDrive» en la ruta como ayuda; no garantiza detectar todos los servicios de sincronización. Para salir de esa carpeta, seguir el flujo de restauración; no mover ni borrar el original automáticamente.

## Inicio, parada y acceso desde la LAN

`npm start` inicia el servidor. `Ctrl+C`, SIGINT o SIGTERM solicitan una parada ordenada: se deja de recibir tráfico nuevo, se cierra el receptor y se espera a solicitudes y respaldos antes de cerrar SQLite, con límite de 30 segundos. Cerrar forzosamente el proceso o la ventana puede impedir esta secuencia; una copia incompleta quedará como `.partial`.

Con `HOST=0.0.0.0`, ingresar desde la LAN con la IP IPv4 actual de esta computadora y el puerto 3100. La IP puede cambiar; `ipconfig` permite consultarla. El firewall y la red deben permitir esa conexión. No se abren puertos, cambian reglas del firewall ni configuran NAT automáticamente.

## Publicación futura

Cuando haya servidor y dominio se podrá preparar HTTPS, cookies seguras, servicio con reinicio automático, almacenamiento privado y una copia externa de respaldos. La versión actual sigue usando SQLite en una sola instancia; no lanzar varios procesos sobre la misma carpeta ni montar la base en un disco de red. Antes de publicar deben definirse también el acceso inicial, los límites detrás del proxy y la red privada/APN/VPN de los GPS. No se configura un proxy público ni se declara un despliegue en producción en esta etapa.
