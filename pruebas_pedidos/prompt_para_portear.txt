# Prompt / Guía para portear la App de Clientes de Todo Delivery

## 0. Contexto y objetivo

Hay que construir la app de Clientes definitiva de "Todo Delivery" replicando la funcionalidad del prototipo
`pruebas_pedidos/prueba_insercion_pedidos.html` (un solo HTML con Supabase JS v2, Leaflet y Tailwind).

La app es independiente del framework que se elija, pero debe respetar AL PIE DE LA LETRA:
- El modelo de datos y los estados de la sección 2.
- El motor de asignación de cadetes de la sección 7 (es la parte crítica: coordina con la app de cadetes).
- Los nombres de canales, eventos y payloads de Realtime de las secciones 7, 8 y 9. La app de cadetes
  (`Templates/dashboard.html`, `Templates/pedido_activo.html`, `Scripts/conexion_rt_*.js`) ya depende de ellos.

Funcionalidades a portear:
1. Login del cliente y sincronización con la tabla `Clientes`.
2. Selección de retiro (A) y entrega (B) en un mapa.
3. Cotización automática según la tabla `Datos_cotiz` (con tarifa nocturna).
4. Creación del pedido y asignación secuencial de cadetes (uno a la vez).
5. Seguimiento en vivo: estado, datos y patente del cadete, GPS.
6. Chat en tiempo real con el cadete.
7. Historial de pedidos, con acceso al seguimiento de los que siguen activos.

Estructura de navegación del prototipo: 3 pestañas → "Solicitar Envío", "Seguimiento" y "Mis Pedidos".

---

## 1. Stack y conexión

- Supabase JS v2 (`createClient(URL, ANON_KEY, { realtime: { params: { eventsPerSecond: 10 } } })`).
  URL y clave pública deben venir de variables de entorno, no hardcodeadas.
- Mapas: Leaflet 1.9.4 con tiles de OpenStreetMap (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`).
  El prototipo aplica un filtro CSS para modo oscuro sobre `.leaflet-tile`.
- Realtime debe estar habilitado para la tabla `Pedidos` (se usa `postgres_changes` sobre UPDATE).
- Las políticas RLS deben permitir al cliente autenticado: leer/insertar/actualizar SUS pedidos, leer
  `Datos_cotiz`, leer de `Cadetes` las columnas indicadas en la sección 2 e insertar su fila en `Clientes`.

---

## 2. Modelo de datos

### Tablas (solo columnas relevantes)

**Clientes**
| Columna            | Tipo        | Notas                                   |
|--------------------|-------------|-----------------------------------------|
| id_cliente         | uuid (PK)   | = `auth.users.id`                       |
| nombre_cliente     | text        |                                         |
| telefono_cliente   | text        |                                         |
| f_loggueo_cliente  | timestamptz | NOT NULL                                |

**Pedidos**
| Columna         | Tipo        | Notas                                                        |
|-----------------|-------------|--------------------------------------------------------------|
| id_pedido       | int8 (PK)   | autogenerado                                                 |
| id_cliente      | uuid        | FK Clientes                                                  |
| id_cadete       | int8 NULL   | FK Cadetes. Cadete al que se le OFRECE o que TIENE el pedido |
| coste_pedido    | float8      | total cotizado                                               |
| inform_pedido   | text        | descripción / comercio                                       |
| tipo_paquete    | text        |                                                              |
| estado_pedido   | text        | ver tabla de estados                                         |
| fecha_pedido    | timestamptz | NOT NULL, se envía al insertar                               |
| latitud_org / longitud_org   | float8 | punto A (retiro)                                 |
| latitud_dest / longitud_dest | float8 | punto B (entrega)                                |
| tiempo_pedido   | int8        | minutos del viaje, lo escribe el cadete al entregar          |

**Cadetes** (el cliente solo LEE, nunca usar `select('*')`)
- Para asignar: `id_cad, nombre_cad, alias_cad, estado_cad`.
- Para mostrar el cadete asignado: `id_cad, nombre_cad, alias_cad, telef_cad, vehiculo_cad, patente`.

**Datos_cotiz**: `bajada_band`, `tarifa_km`, `porc_tarif_dinamica` (se usa la primera fila).

### Estados de `Pedidos.estado_pedido`

| Estado             | id_cadete | Significado                                            | Lo escribe            |
|--------------------|-----------|--------------------------------------------------------|-----------------------|
| `pendiente`        | null      | Sin oferta vigente (recién creado o entre ofertas)     | Cliente / Cadete      |
| `libre`            | X         | Ofrecido al cadete X, todavía no abrió la oferta       | Cliente               |
| `en_confirmacion`  | X         | El cadete X tiene el modal de la oferta abierto        | Cadete                |
| `asignado`         | X         | X aceptó; va a retirar el pedido                       | Cadete                |
| `en_camino_entrega`| X         | X retiró el paquete y va al destino                    | Cadete                |
| `entregado`        | X         | Entregado (con `tiempo_pedido`)                        | Cadete                |
| `rendido`          | X         | El cadete rindió el efectivo del turno                 | Cadete (cashout)      |
| `cancelado`        | null o X  | Sin cadetes / todos rechazaron / cancelado por cliente | Cliente               |

Los tres primeros son la **fase de búsqueda**: `ESTADOS_BUSQUEDA = ['pendiente', 'libre', 'en_confirmacion']`.
Una **oferta vigente** es `estado_pedido IN ('libre','en_confirmacion') AND id_cadete IS NOT NULL`.

### Estados de `Cadetes.estado_cad` (los escribe la app de cadetes)
`disponible` (en turno y libre), `en_confirmacion` (viendo una oferta), `ocupado` (con viaje), `desconectado`.

---

## 3. Autenticación y perfil del cliente

- Proveedor: Google OAuth (`supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })`),
  con `redirectTo` = URL actual sin hash ni query.
- Al iniciar: `supabase.auth.getSession()`. Además escuchar `supabase.auth.onAuthStateChange`.
- Nombre a mostrar: `user_metadata.full_name || user_metadata.name || parte local del email`.
- Sincronizar `Clientes`: si no existe una fila con `id_cliente = user.id`, insertarla con
  `{ id_cliente, nombre_cliente, telefono_cliente, f_loggueo_cliente: now }`.
  El prototipo usa un teléfono placeholder si `user.phone` viene vacío; en la app real conviene pedirlo.
- Sin sesión no se puede crear pedidos ni ver historial.
- Logout: `supabase.auth.signOut()`. Si hay una búsqueda de cadete en curso, detenerla (sección 7).

NO portear: el botón "Login 1-Click" del prototipo (credenciales de demo hardcodeadas, solo para pruebas).

---

## 4. Selección de retiro y entrega (mapa)

- Coordenadas por defecto (San Juan): A = (-31.5375, -68.5364), B = (-31.5390, -68.5320). Zoom 14.
- Dos marcadores arrastrables: **A (Retiro, verde)** y **B (Entrega, ámbar)**, unidos por una polilínea punteada.
- Selector de "punto activo" (A o B): un click en el mapa mueve el marcador del punto activo.
- Botón "Mi GPS para Destino": `navigator.geolocation.getCurrentPosition` (`enableHighAccuracy: true`,
  `timeout: 6000`) y mueve B a esa posición.
- Mostrar coordenadas legibles (4 decimales) y la distancia estimada.
- Cada cambio de A o B recalcula la cotización.

---

## 5. Cotización

1. Al iniciar, leer `Datos_cotiz` (primera fila). Si falla o no hay fila, usar
   `bajada_band = 1200`, `tarifa_km = 1000`, `porc_tarif_dinamica = 30`.
2. Distancia: fórmula de Haversine entre A y B (radio 6371 km, en línea recta, no por calles),
   redondeada a 0,1 km, con **mínimo de 0,6 km**.
3. Cálculo:
   ```
   costoKm   = round(distKm * tarifa_km)
   subtotal  = bajada_band + costoKm
   nocturno  = hora local entre 00:00 y 05:59
   factor    = porc_tarif_dinamica > 1 ? porc_tarif_dinamica / 100 : porc_tarif_dinamica
   recargo   = nocturno ? round(subtotal * factor) : 0
   total     = subtotal + recargo        → se guarda en Pedidos.coste_pedido
   ```
4. Mostrar el desglose: bajada de bandera, costo por distancia (con los km), recargo nocturno y total en
   formato `es-AR`. Indicar "Tarifa Nocturna" o "Tarifa Estándar". Se paga en efectivo al cadete.

El toggle "Simular horario nocturno" del prototipo es solo para pruebas (como mucho, un flag de desarrollo).

---

## 6. Creación del pedido

Al confirmar:
1. Validar sesión.
2. Si ya hay una búsqueda de cadete activa para otro pedido, pedir confirmación
   ("El pedido #N todavía está buscando cadete. ¿Cancelarlo y crear uno nuevo?"). Si acepta, ejecutar
   `cancelarBusquedaPorCliente` (sección 7.6); si no, abortar.
3. Asegurar la fila en `Clientes` (sección 3).
4. Insertar y leer la fila creada (`insert(...).select().single()`):
   ```js
   {
     id_cliente, coste_pedido: total, inform_pedido, tipo_paquete,
     estado_pedido: 'pendiente',   // SIEMPRE nace sin cadete
     id_cadete: null,
     latitud_org, longitud_org, latitud_dest, longitud_dest,
     fecha_pedido: new Date().toISOString()
   }
   ```
5. Abrir el panel de seguimiento con ese pedido y conectar su canal (sección 8).
6. Iniciar el motor de asignación: `iniciarBusquedaCadete(id_pedido)` (sección 7).

Tipos de paquete del prototipo: "Bolsa de Comida", "Caja de Pizza", "Paquete Chico", "Bebidas", "Farmacia".

---

## 7. Motor de asignación de cadetes (CRÍTICO)

### 7.1 Reglas

- El pedido se ofrece a **UN SOLO cadete por vez**, en orden de `id_cad` ascendente.
- **Rechaza** → se anota y se pasa al siguiente. Nunca se le vuelve a ofrecer el mismo pedido en esa búsqueda.
- **No responde a tiempo** → el cliente retira la oferta, le avisa al cadete y pasa al siguiente.
- **Ocupado** (`estado_cad` distinto de `disponible`) → se saltea. Si no hay nadie libre pero sí cadetes
  ocupados que todavía no vieron el pedido, se espera un tiempo máximo a que alguno se libere.
- **Nadie conectado / todos rechazaron / nadie se liberó a tiempo** → se cancela el pedido con un motivo
  visible y la búsqueda termina limpia. Un pedido nuevo arranca de cero.
- **Ningún evento suelto decide.** Broadcasts, `postgres_changes` y un latido periódico solo *piden una revisión*.
  La revisión relee el pedido de la BD y actúa según lo que encuentra.
- **Todas las escrituras sobre `Pedidos` son condicionales** (bloqueo optimista). Así, si un cadete acepta
  o rechaza en el mismo instante en que el cliente retira la oferta, solo una de las dos escrituras gana.

Este motor corre hoy en el cliente. Está previsto moverlo a una Supabase Edge Function cuando se haga la
UI de cadetes, así que conviene implementarlo como **un módulo aislado** (sin dependencias de UI, con la UI
suscrita a sus cambios) para que la migración sea directa.

### 7.2 Configuración

```js
const CONFIG_ASIGNACION = {
  TIMEOUT_OFERTA_MS: 20000,       // el modal del cadete dura 15s; el resto es margen de red
  INTERVALO_REVISION_MS: 3000,    // latido de respaldo por si se pierde un evento realtime
  ESPERA_MAX_OCUPADOS_MS: 60000   // espera máxima a que se libere un cadete ocupado antes de cancelar
};
```
`TIMEOUT_OFERTA_MS` debe ser siempre MAYOR que el timer del modal del cadete (15s).

### 7.3 Estado de una búsqueda (una sola activa a la vez)

```js
{
  idPedido,
  intentados: Set<id_cad>,        // rechazaron o no respondieron: no se les vuelve a ofrecer
  rechazosRecibidos: Set<id_cad>, // rechazos avisados por broadcast (por si la BD aún no los refleja)
  idCadeteOfertado: null,         // cadete con la oferta vigente según este motor
  nombreCadeteOfertado: '',
  ofertaExpiraEn: 0,              // timestamp ms
  esperandoDesde: null,           // timestamp ms del inicio de la espera por cadetes ocupados
  ui: { titulo, detalle },        // texto para el panel
  latido,                         // setInterval(revisar, INTERVALO_REVISION_MS)
  ejecutando: false, repetir: false, finalizada: false
}
```

- `iniciarBusquedaCadete(idPedido)`: detiene la búsqueda anterior si existe, crea el estado, arranca el
  latido y pide una revisión inmediata.
- `detenerBusqueda(b, motivo)`: `finalizada = true` y `clearInterval(latido)`. Idempotente.

### 7.4 Serialización de revisiones

Nunca pueden correr dos revisiones en paralelo sobre la misma búsqueda:
```
solicitarRevision(b):
  si b.finalizada → salir
  si b.ejecutando → b.repetir = true; salir
  b.ejecutando = true
  hacer { b.repetir = false; await revisarAsignacion(b) } mientras (b.repetir && !b.finalizada && vueltas < 5)
  ante error: loguear (el próximo latido reintenta)
  b.ejecutando = false
```
Después de cada `await` de red, si `b.finalizada` pasó a true, salir sin hacer nada más.

### 7.5 Algoritmo de revisión

```
revisarAsignacion(b):
  pedido = SELECT * FROM Pedidos WHERE id_pedido = b.idPedido
  si no existe → detener("el pedido ya no existe")

  1) si pedido.estado_pedido NO está en ESTADOS_BUSQUEDA (asignado, cancelado, etc.):
       detener; actualizar UI con ese estado (y datos del cadete si corresponde); salir

  hayOferta = estado IN ('libre','en_confirmacion') AND id_cadete != null

  2) si hayOferta:
       si id_cadete != b.idCadeteOfertado:          // oferta no registrada (ej: se recargó la app)
         si b.idCadeteOfertado != null → agregarlo a intentados
         adoptarla: idCadeteOfertado = id_cadete; ofertaExpiraEn = ahora + TIMEOUT_OFERTA_MS
       si NO (id_cadete ∈ rechazosRecibidos) y ahora < ofertaExpiraEn:
         UI "Ofreciendo a {nombre}" / "{Enviando oferta|Viendo la oferta} • Intento N • {seg}s"
         salir                                        // seguir esperando respuesta
       // rechazó (aviso por broadcast) o venció el tiempo → RETIRAR OFERTA (condicional):
       UPDATE Pedidos SET id_cadete = null, estado_pedido = 'pendiente'
         WHERE id_pedido = X AND id_cadete = idOfertado AND estado_pedido IN ('libre','en_confirmacion')
         RETURNING id_pedido
       si no actualizó filas → b.repetir = true; salir   // el cadete respondió justo ahora
       si fue por timeout → broadcast 'pedido_retirado' al cadete (7.7)
       intentados += idOfertado; idCadeteOfertado = null

  3) si NO hayOferta y b.idCadeteOfertado != null:     // el cadete devolvió la oferta (rechazo / fin de su timer)
       intentados += idCadeteOfertado; idCadeteOfertado = null

  4) ofrecerAlSiguienteCadete(b)
```

```
ofrecerAlSiguienteCadete(b):
  cadetes   = SELECT id_cad, nombre_cad, alias_cad, estado_cad FROM Cadetes
              WHERE estado_cad IN ('disponible','en_confirmacion','ocupado') ORDER BY id_cad ASC
  sinIntentar = cadetes que no están en b.intentados
  libres      = sinIntentar con estado_cad = 'disponible'
  ocupados    = sinIntentar con otro estado

  A) si hay libres → cadete = libres[0]
       UPDATE Pedidos SET id_cadete = cadete, estado_pedido = 'libre'
         WHERE id_pedido = X
           AND estado_pedido IN ('pendiente','libre','en_confirmacion')
           AND (id_cadete IS NULL OR estado_pedido = 'pendiente')        // sin oferta vigente
         RETURNING *
       si no actualizó filas → b.repetir = true; salir
       idCadeteOfertado = cadete; ofertaExpiraEn = ahora + TIMEOUT_OFERTA_MS; esperandoDesde = null
       UI "Ofreciendo a {nombre}" / "Enviando oferta • Intento N"
       broadcast 'nuevo_pedido' al cadete con la fila completa devuelta (7.7)
       salir

  B) si hay ocupados:
       si esperandoDesde es null → esperandoDesde = ahora
       restante = ESPERA_MAX_OCUPADOS_MS - (ahora - esperandoDesde)
       si restante > 0 → UI "Todos los cadetes están ocupados" / "Esperando que se libere uno • {seg}s"; salir

  C) cancelar:
       motivo = ocupados.length > 0      ? 'Ningún cadete se liberó a tiempo'
              : intentados.size > 0      ? 'Todos los cadetes rechazaron el pedido'
              :                            'No hay cadetes conectados'
       UPDATE Pedidos SET id_cadete = null, estado_pedido = 'cancelado'
         WHERE id_pedido = X AND estado_pedido IN (ESTADOS_BUSQUEDA)
           AND (id_cadete IS NULL OR estado_pedido = 'pendiente')
         RETURNING id_pedido
       si no actualizó filas → b.repetir = true; salir
       guardar motivo; detener(b, motivo); UI cancelado con el motivo
```

Con supabase-js, el filtro "sin oferta vigente" se arma así:
```js
.eq('id_pedido', id)
.in('estado_pedido', ['pendiente', 'libre', 'en_confirmacion'])
.or('id_cadete.is.null,estado_pedido.eq.pendiente')
.select()
.maybeSingle()   // data === null ⇒ no se actualizó ninguna fila
```

### 7.6 Qué dispara una revisión

| Disparador                                                        | Acción                                             |
|-------------------------------------------------------------------|----------------------------------------------------|
| Latido cada `INTERVALO_REVISION_MS`                               | revisar                                            |
| `postgres_changes` UPDATE de `Pedidos` con `id_pedido=eq.X`       | actualizar UI + revisar                            |
| Broadcast `pedido_rechazado` en `pedido-en-curso-X`               | `rechazosRecibidos += id_cadete_rechazo` + revisar |
| Broadcast `cambio_estado_pedido` en `pedido-en-curso-X`           | actualizar UI + revisar                            |
| Abrir desde el historial un pedido en `ESTADOS_BUSQUEDA` sin búsqueda activa | `iniciarBusquedaCadete` (reanuda)       |

**Cancelación por el cliente** (`cancelarBusquedaPorCliente(b)`), usada al reemplazar un pedido en búsqueda:
1. `detenerBusqueda(b)` y guardar el motivo "Cancelado por el cliente".
2. `UPDATE Pedidos SET estado_pedido = 'cancelado' WHERE id_pedido = X AND estado_pedido IN (ESTADOS_BUSQUEDA)
   RETURNING id_pedido, id_cadete`. **No** se pone `id_cadete` en null: así el cadete con la oferta abierta recibe
   la cancelación por su suscripción `postgres_changes` (filtrada por `id_cadete`).
3. Si `id_cadete` no es null, además mandar broadcast `pedido_retirado` a ese cadete.

### 7.7 Canales hacia el cadete y envío de broadcasts puntuales

| Canal                    | Evento            | Dirección        | Payload                                   |
|--------------------------|-------------------|------------------|-------------------------------------------|
| `pedidos-cadete-{id_cad}`| `nuevo_pedido`    | Cliente → Cadete | fila completa de `Pedidos` (estado `libre`, `id_cadete` = ese cadete) |
| `pedidos-cadete-{id_cad}`| `pedido_retirado` | Cliente → Cadete | `{ id_pedido, id_cadete }`                |
| `pedido-en-curso-{id}`   | `pedido_rechazado`| Cadete → Cliente | `{ id_pedido, id_cadete_rechazo }`        |

Todos los canales se crean con `{ config: { broadcast: { ack: true } } }`.

Para mandar a un canal que el cliente no escucha (`pedidos-cadete-*`), usar un helper "broadcast efímero":
1. Si ya existe un canal con ese topic (`supabase.getChannels()` con `topic === 'realtime:' + nombre`),
   hacer `await supabase.removeChannel(canal)`. `supabase.channel(nombre)` DEVUELVE el canal existente, y un
   canal ya suscrito no vuelve a emitir `SUBSCRIBED`, así que el envío nunca saldría.
2. Crear el canal, `subscribe`, y al recibir `SUBSCRIBED` hacer `send({ type: 'broadcast', event, payload })`.
3. Resolver ante `CHANNEL_ERROR` / `TIMED_OUT` o a los 8s como máximo.
4. Quitar el canal ~1s después del envío.

El broadcast es solo para bajar la latencia. El cadete también detecta la oferta por `postgres_changes` y por
su propio verificador periódico, y el cliente siempre decide según la BD.

### 7.8 Contrato con la app de cadetes (ya implementado en `Templates/dashboard.html`)

La app de clientes asume que el cadete hace exactamente esto:
- Solo muestra ofertas con `estado_pedido IN ('libre','en_confirmacion')` e `id_cadete` = su id.
- Al abrir el modal: `UPDATE ... SET estado_pedido='en_confirmacion' WHERE id_pedido=X AND id_cadete=yo AND
  estado_pedido IN ('libre','en_confirmacion')`. Si no actualiza filas, cierra el modal.
  Además pone su `estado_cad` en `en_confirmacion`. El modal dura 15s y al vencer rechaza.
- **Aceptar**: `UPDATE ... SET estado_pedido='asignado'` con la misma condición. Si no actualiza filas, avisa
  "ya no disponible" y no toma el viaje. Si actualiza, pone `estado_cad='ocupado'` y manda
  `cambio_estado_pedido` (`asignado`) por `pedido-en-curso-X`.
- **Rechazar**: pone `estado_cad='disponible'` y hace `UPDATE ... SET id_cadete=null, estado_pedido='pendiente'`
  con la misma condición. Solo si actualizó filas manda `pedido_rechazado`.
- Si ya está ocupado (otra oferta abierta o viaje en curso) y le llega una oferta, la devuelve con el mismo
  UPDATE condicional y el mismo broadcast del rechazo, pero sin cambiar su `estado_cad`.
- Escucha `pedido_retirado` en `pedidos-cadete-{id}` y cierra el modal sin tocar la BD.
- NUNCA toma pedidos sin cadete de una "cola" ni se asigna pedidos ajenos.

### 7.9 Errores del prototipo anterior que NO hay que reintroducir

- Broadcast al canal global `cadetes-disponibles`: le abría el pedido a todos los cadetes.
- Cadetes que "reclaman" pedidos `pendiente` sin cadete: varios tomaban el mismo pedido.
- `UPDATE` sin condición sobre `id_cadete`/`estado_pedido`: un rechazo tardío pisaba la oferta de otro cadete.
- Decidir con el estado en memoria o con un único evento en vez de releer la BD.
- No tener timeout del lado del cliente: si el cadete no contestaba (pestaña cerrada), la búsqueda quedaba colgada.
- Reutilizar un canal ya suscrito para enviar (el envío no salía, o `subscribe` lanzaba error).
- Dejar pedidos en `pendiente` para siempre y búsquedas sin terminar: el siguiente pedido no se enviaba.

---

## 8. Seguimiento en vivo

Al mostrar un pedido se conecta UN canal `pedido-en-curso-{id_pedido}` (`broadcast.ack: true`). Si ya se está
conectado a ese mismo topic, reutilizarlo. Si era otro, `removeChannel` del anterior antes de crear el nuevo.

| Evento / fuente                                            | Payload                                                                 | Acción en la UI |
|------------------------------------------------------------|-------------------------------------------------------------------------|-----------------|
| `postgres_changes` UPDATE `Pedidos` (`id_pedido=eq.X`)     | `payload.new` (fila)                                                    | fusionar en el pedido local, actualizar estado, cargar cadete si `asignado`/`en_camino_entrega`, pedir revisión al motor |
| broadcast `cambio_estado_pedido`                           | `{ id_pedido, id_cadete, patente, vehiculo, nombre_cad?, estado_pedido, timestamp }` | actualizar estado y patente; si `asignado`, cargar cadete; pedir revisión al motor |
| broadcast `pedido_rechazado`                               | `{ id_pedido, id_cadete_rechazo }`                                      | ver 7.6         |
| broadcast `cadete_conectado`                               | `{ id_pedido, id_cadete, patente, vehiculo, timestamp }`                | mostrar patente y "Vehículo: …" |
| broadcast `ubicacion_cadete`                               | `{ id_pedido, id_cadete, patente, vehiculo, coords: { lat, lng, accuracy, heading, speed, timestamp } }` | coordenadas (5 decimales), velocidad `speed * 3.6` km/h (si es 0: "En movimiento"), "GPS en Vivo • {vehiculo}", patente |
| broadcast `mensaje_chat`                                   | ver sección 9                                                           | burbuja si `remitente === 'cadete'` |

Datos del cadete asignado: `SELECT id_cad, nombre_cad, alias_cad, telef_cad, vehiculo_cad, patente FROM Cadetes
WHERE id_cad = ?`. Nombre = `nombre_cad || alias_cad || 'Cadete #id'`, iniciales para el avatar.
Patente estilo chapa argentina; si viene vacía, mostrar "NO CARGADA".

Textos por estado (prototipo):
| Estado                                      | Badge                                  | Tarjeta del cadete |
|---------------------------------------------|----------------------------------------|--------------------|
| `pendiente` / `libre` / `en_confirmacion`   | "Buscando cadete..." (animado)         | `ui.titulo` / `ui.detalle` del motor; si no hay: "Buscando cadete..." / "Esperando confirmación del cadete" |
| `asignado`                                  | "Cadete Asignado • Retirando pedido"   | datos del cadete   |
| `en_camino_entrega`                         | "En camino a tu destino"               | datos del cadete   |
| `entregado` / `rendido`                     | "¡Entregado con Éxito!"                | —                  |
| `cancelado`                                 | "Pedido Cancelado"                     | título = motivo guardado (o "Ningún cadete disponible"), detalle "Puedes volver a solicitar el envío" |

Cuando el pedido está cancelado o entregado, se oculta el indicador de actividad de la pestaña Seguimiento.
Cuando no hay pedido activo, se muestra el estado vacío con un botón a "Solicitar Envío".

---

## 9. Chat con el cadete

- Va por broadcast en el canal `pedido-en-curso-{id_pedido}`, evento `mensaje_chat`. **No se persiste**
  (se pierde al recargar).
- Payload que envía el cliente:
  ```js
  { id_pedido, id_emisor: id_cliente, id_receptor: id_cadete, remitente: 'cliente',
    texto, hora: 'HH:MM', timestamp: ISO }
  ```
  El cadete envía lo mismo con `remitente: 'cadete'` y además `id_mensaje`.
- Pintar el propio mensaje al enviarlo (a la derecha) y los del cadete al recibirlos (a la izquierda), con la hora.
- **Renderizar el texto como texto plano** (`textContent` o el escape del framework). El prototipo lo inserta
  con `innerHTML`, lo que permite inyectar HTML desde el otro lado: no copiar eso.

---

## 10. Historial ("Mis Pedidos")

- Consulta: `SELECT * FROM Pedidos WHERE id_cliente = ? ORDER BY fecha_pedido DESC LIMIT 25`.
- Se refresca al abrir la pestaña, al iniciar sesión y con un botón manual.
- Cada tarjeta muestra: `#id`, fecha y hora (`es-AR`), estado, `inform_pedido`, `tipo_paquete`, total, "Efectivo".
- Etiquetas: `entregado` "Entregado", `rendido` "Entregado & Rendido", `en_camino_entrega` "En Camino",
  `asignado` "Cadete Asignado", `en_confirmacion` "Confirmando Cadete", `libre` y `pendiente` "Buscando Cadete",
  `cancelado` "Cancelado".
- Para `asignado`, `en_camino_entrega` y los de `ESTADOS_BUSQUEDA`: botón "Ver Seguimiento en Vivo" que
  relee el pedido, lo abre en Seguimiento y, si está en búsqueda y no hay otra búsqueda activa, la reanuda (7.6).

---

## 11. Limpieza de recursos

- Una sola búsqueda activa y un solo canal `pedido-en-curso-*` a la vez.
- Al terminar la búsqueda (asignado / cancelado) detener el latido.
- Al cambiar de pedido en Seguimiento, quitar el canal anterior. Al cerrar sesión o desmontar la app,
  detener la búsqueda y quitar los canales.
- Los canales efímeros de envío se quitan solos (7.7).
- Si la UI muestra otro pedido mientras corre una búsqueda, el motor sigue funcionando pero solo actualiza
  la UI del pedido que está en pantalla.

---

## 12. Pruebas de aceptación

Con 2 o 3 sesiones de cadete (`Templates/dashboard.html?id_cad=N`) en turno:

1. Cadetes 1 y 2 rechazan, 3 acepta → se ofrece en orden 1 → 2 → 3, nunca a dos a la vez; queda `asignado` al 3.
2. Todos rechazan → `cancelado` con "Todos los cadetes rechazaron el pedido"; el que rechazó NO vuelve a
   recibir la oferta. Crear otro pedido → se vuelve a ofrecer desde el cadete 1.
3. Un cadete `ocupado` → nunca recibe la oferta.
4. Ningún cadete en turno → `cancelado` al instante con "No hay cadetes conectados".
5. El cadete deja vencer el modal o cierra la pestaña → a los ≤20s pasa al siguiente y al primero se le cierra el modal.
6. Todos ocupados → el panel muestra la cuenta regresiva; si uno se libera, se le ofrece; si no, a los 60s
   `cancelado` con "Ningún cadete se liberó a tiempo".
7. El cadete acepta justo cuando vence el timeout → solo UNO queda con el pedido; el otro ve "ya no disponible".
8. Cambiar de pestaña en el cadete con el modal abierto → el modal y su timer siguen, sin reabrirse en loop.
9. Recargar la app de clientes durante una búsqueda y abrir el pedido desde el historial → la búsqueda se reanuda.
10. Crear un pedido mientras otro busca cadete → pide confirmación, cancela el anterior (el cadete con la oferta
    abierta ve la cancelación) y arranca el nuevo.
11. Aceptado → el panel pasa a "Cadete Asignado", muestra nombre, vehículo y patente, GPS en vivo y chat funcionando.

---

## 13. Fuera de alcance / pendiente

- Login 1-Click de demo y toggle de "simular nocturno": solo pruebas, no portear.
- Mover el motor de asignación (sección 7) a una Edge Function: previsto para cuando se haga la UI de cadetes.
- El total se calcula en el cliente. Cuando exista backend (Edge Function), recalcularlo del lado del servidor.
- Persistencia del chat: hoy no existe.
