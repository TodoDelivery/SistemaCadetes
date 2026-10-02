// =========================================================================
// CONEXIÓN REALTIME: PEDIDO EN CURSO (CANAL PRIVADO CADETE <-> CLIENTE)
// =========================================================================
import { supabase } from './conexion_supabase.js';
import { crearHistorialChat } from './chat_pedido.js';

let channelPedidoActivo = null;
let historialChat = null; // chat del pedido: en vivo + guardado en Pedidos.Chat_pedido
let geoWatchId = null;
let pedidoActual = null;

// Desde qué estados se puede avanzar a cada uno. Una pestaña vieja del mismo viaje no puede volver atrás
// un pedido ya entregado (ni pisar uno 'rendido'): su UPDATE no encuentra la fila.
const ESTADOS_PREVIOS = {
  en_camino_entrega: ['asignado'],
  entregado: ['asignado', 'en_camino_entrega']
};

/**
 * Inicia la suscripción al canal privado del pedido en curso.
 * Sincroniza:
 * 1. Transmisión de ubicación GPS del cadete en vivo (Cadete -> Cliente).
 * 2. Chat en tiempo real (Cadete <-> Cliente), guardado además en Pedidos.Chat_pedido.
 * 3. Actualización y escucha de estados del pedido (postgres_changes y broadcast).
 * 
 * @param {Object} pedido - Objeto con los datos del pedido (id_pedido, id_cadete, id_cliente, etc.)
 * @param {Object} callbacks - Callbacks para eventos:
 *   onChat(lista): cambió el chat (historial, mensaje propio o del cliente); la lista viene completa y ordenada
 *   onMensaje(mensaje): llegó un mensaje nuevo del cliente (para avisar)
 *   onCambioEstado(estado)
 */
export async function iniciarSuscripcionPedidoActivo(pedido, callbacks = {}) {
  if (!pedido || !pedido.id_pedido) {
    console.error('[RT Pedido Activo] Se requiere id_pedido para iniciar el canal.');
    return null;
  }

  pedidoActual = pedido;
  const idPedido = pedido.id_pedido;
  const idCadete = pedido.id_cadete;
  const idCliente = pedido.id_cliente;

  console.log(`[RT Pedido Activo] Conectando canal privado para Pedido #${idPedido} (Cadete: ${idCadete} <-> Cliente: ${idCliente})`);

  // Historial del chat: arranca con lo que ya estaba guardado en el pedido
  if (historialChat) historialChat.cerrar();
  historialChat = crearHistorialChat({
    idPedido,
    remitente: 'cadete',
    idEmisor: idCadete,
    filtro: idCadete != null ? { id_cadete: idCadete } : {},
    inicial: pedido.Chat_pedido,
    alCambiar: (lista) => {
      if (typeof callbacks.onChat === 'function') callbacks.onChat(lista);
    },
    alRecibir: (nuevos) => {
      nuevos.forEach((mensaje) => {
        if (typeof callbacks.onMensaje === 'function') callbacks.onMensaje(mensaje);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('nuevoMensajeChat', { detail: mensaje }));
        }
      });
    }
  });
  if (typeof callbacks.onChat === 'function') callbacks.onChat(historialChat.lista());

  // Canal privado único por pedido
  channelPedidoActivo = supabase.channel(`pedido-en-curso-${idPedido}`, {
    config: { broadcast: { ack: true } }
  });

  channelPedidoActivo
    // ---------------------------------------------------------------------
    // A) MENSAJES DE CHAT EN TIEMPO REAL
    // ---------------------------------------------------------------------
    .on('broadcast', { event: 'mensaje_chat' }, ({ payload }) => {
      console.log('[RT Chat] Mensaje recibido:', payload);
      // El historial descarta repetidos y avisa por onChat / onMensaje
      historialChat?.registrar(payload);
    })

    // ---------------------------------------------------------------------
    // B) ACTUALIZACIÓN DE ESTADOS DEL VIAJE (BROADCAST Y DB)
    // ---------------------------------------------------------------------
    .on('broadcast', { event: 'cambio_estado_pedido' }, ({ payload }) => {
      console.log('[RT Estado] Cambio de estado recibido por broadcast:', payload);
      if (typeof callbacks.onCambioEstado === 'function') {
        callbacks.onCambioEstado(payload);
      }
    })
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'Pedidos',
        filter: `id_pedido=eq.${idPedido}`
      },
      (payload) => {
        console.log('[RT DB Pedido] Actualización en tabla Pedidos:', payload.new);
        // Mensajes guardados por el cliente que no llegaron en vivo
        if (payload.new) historialChat?.fusionar(payload.new.Chat_pedido);
        if (typeof callbacks.onCambioEstado === 'function') {
          callbacks.onCambioEstado(payload.new);
        }
      }
    )

    // ---------------------------------------------------------------------
    // C) SUSCRIPCIÓN Y TRANSMISIÓN GPS EN VIVO
    // ---------------------------------------------------------------------
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`[RT Pedido Activo] Canal pedido-en-curso-${idPedido} conectado.`);

        // Al conectar o reconectar: traer lo que se guardó mientras no había canal
        historialChat?.sincronizar();

        // Notificar presencia y patente inicial del cadete al cliente
        const patente = pedidoActual?.patente_cadete || pedidoActual?.patente || '';
        const vehiculo = pedidoActual?.vehiculo_cadete || pedidoActual?.vehiculo_cad || '';
        try {
          await channelPedidoActivo.send({
            type: 'broadcast',
            event: 'cadete_conectado',
            payload: {
              id_pedido: idPedido,
              id_cadete: idCadete,
              patente,
              vehiculo,
              timestamp: new Date().toISOString()
            }
          });
        } catch (e) {}

        // Iniciar rastreo continuo de GPS y transmisión al cliente
        iniciarTransmisionGPS(idPedido, idCadete);
      }
    });

  return channelPedidoActivo;
}

/**
 * Inicia el seguimiento del GPS del cadete y transmite su posición y patente al cliente
 */
function iniciarTransmisionGPS(idPedido, idCadete) {
  if (!('geolocation' in navigator)) return;

  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
  }

  geoWatchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const coords = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        heading: pos.coords.heading || 0,
        speed: pos.coords.speed || 0,
        timestamp: new Date().toISOString()
      };

      const patente = pedidoActual?.patente_cadete || pedidoActual?.patente || '';
      const vehiculo = pedidoActual?.vehiculo_cadete || pedidoActual?.vehiculo_cad || '';

      // Transmitir al canal del pedido
      if (channelPedidoActivo) {
        await channelPedidoActivo.send({
          type: 'broadcast',
          event: 'ubicacion_cadete',
          payload: {
            id_pedido: idPedido,
            id_cadete: idCadete,
            patente,
            vehiculo,
            coords
          }
        });
      }
    },
    (err) => console.warn('[GPS Pedido] Error de ubicación:', err.message),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 6000 }
  );
}

/**
 * Envía un mensaje de chat al cliente: primero en vivo por el canal Realtime y después lo guarda en
 * Pedidos.Chat_pedido. Si el cliente no está conectado, lo lee al volver a abrir el pedido.
 *
 * @param {string} texto - Contenido del mensaje
 * @returns {Promise<Object|null>} El mensaje, con `enviado: false` si no salió ni en vivo ni a la BD
 */
export async function enviarMensajeChat(texto) {
  if (!channelPedidoActivo || !pedidoActual || !historialChat) {
    console.error('[RT Chat] No hay un canal de pedido activo para enviar el mensaje.');
    return null;
  }
  if (!texto || !texto.trim()) return null;

  const mensaje = historialChat.crearMensaje(texto, pedidoActual.id_cliente); // se pinta por onChat

  let enVivo = false;
  try {
    enVivo = (await channelPedidoActivo.send({
      type: 'broadcast',
      event: 'mensaje_chat',
      payload: mensaje
    })) === 'ok';
  } catch (err) {
    console.warn('[RT Chat] No se pudo enviar el mensaje en vivo:', err);
  }
  const guardado = await historialChat?.sincronizar();

  return { ...mensaje, enviado: Boolean(enVivo || guardado) };
}

/**
 * true si el mensaje ya está guardado en Pedidos.Chat_pedido
 * @param {string} idMensaje
 */
export function mensajeChatGuardado(idMensaje) {
  return Boolean(historialChat?.estaGuardado(idMensaje));
}

/**
 * Actualiza el estado del pedido tanto en la Base de Datos como por Broadcast
 * 
 * @param {string} nuevoEstado - Ej: 'en_camino_retiro', 'en_camino_entrega', 'entregado'
 * @param {Object} [datosExtra] - Datos opcionales a persistir o transmitir
 */
export async function actualizarEstadoPedidoEnCurso(nuevoEstado, datosExtra = {}) {
  if (!pedidoActual) return;

  const idPedido = pedidoActual.id_pedido;

  try {
    // 1. Actualizar en Supabase (Postgres)
    const updateData = {
      estado_pedido: nuevoEstado,
      ...datosExtra
    };

    let consulta = supabase
      .from('Pedidos')
      .update(updateData)
      .eq('id_pedido', idPedido);
    if (pedidoActual.id_cadete != null) consulta = consulta.eq('id_cadete', pedidoActual.id_cadete);
    if (ESTADOS_PREVIOS[nuevoEstado]) consulta = consulta.in('estado_pedido', ESTADOS_PREVIOS[nuevoEstado]);

    const { data, error } = await consulta.select().maybeSingle();

    if (error) {
      console.warn('[RT Estado] Advertencia al actualizar en DB:', error.message);
    } else if (!data) {
      // El pedido ya avanzó (ej: se entregó desde otra pestaña): no se lo vuelve atrás ni se avisa al cliente
      console.warn(`[RT Estado] Pedido #${idPedido}: no se pasa a '${nuevoEstado}', ya no está en ${(ESTADOS_PREVIOS[nuevoEstado] || []).join('/')}.`);
      return null;
    }

    // 2. Notificar inmediatamente por broadcast al cliente
    if (channelPedidoActivo) {
      const patente = pedidoActual?.patente_cadete || pedidoActual?.patente || '';
      const vehiculo = pedidoActual?.vehiculo_cadete || pedidoActual?.vehiculo_cad || '';
      await channelPedidoActivo.send({
        type: 'broadcast',
        event: 'cambio_estado_pedido',
        payload: {
          id_pedido: idPedido,
          id_cadete: pedidoActual.id_cadete,
          patente,
          vehiculo,
          estado_pedido: nuevoEstado,
          timestamp: new Date().toISOString()
        }
      });
    }

    return data;
  } catch (err) {
    console.error('[RT Estado] Error al actualizar estado del pedido:', err);
  }
}

/**
 * Permite actualizar los metadatos del cadete (como patente o vehículo) en el pedido activo
 * @param {Object} datos - { patente_cadete, vehiculo_cadete, etc. }
 */
export function actualizarDatosCadetePedidoActivo(datos) {
  if (pedidoActual && datos) {
    pedidoActual = { ...pedidoActual, ...datos };
  }
}

/**
 * Desconecta el canal del pedido activo y detiene el GPS
 */
export async function desconectarPedidoActivo() {
  if (geoWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }

  if (historialChat) {
    historialChat.cerrar();
    historialChat = null;
  }

  if (channelPedidoActivo) {
    await supabase.removeChannel(channelPedidoActivo);
    channelPedidoActivo = null;
  }

  pedidoActual = null;
  console.log('[RT Pedido Activo] Canal y GPS desconectados con éxito.');
}

// Exponer globalmente en window
if (typeof window !== 'undefined') {
  window.iniciarSuscripcionPedidoActivo = iniciarSuscripcionPedidoActivo;
  window.enviarMensajeChat = enviarMensajeChat;
  window.mensajeChatGuardado = mensajeChatGuardado;
  window.actualizarEstadoPedidoEnCurso = actualizarEstadoPedidoEnCurso;
  window.actualizarDatosCadetePedidoActivo = actualizarDatosCadetePedidoActivo;
  window.desconectarPedidoActivo = desconectarPedidoActivo;
}

export default {
  iniciarSuscripcionPedidoActivo,
  enviarMensajeChat,
  mensajeChatGuardado,
  actualizarEstadoPedidoEnCurso,
  actualizarDatosCadetePedidoActivo,
  desconectarPedidoActivo
};
