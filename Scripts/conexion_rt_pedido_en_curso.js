// =========================================================================
// CONEXIÓN REALTIME: PEDIDO EN CURSO (CANAL PRIVADO CADETE <-> CLIENTE)
// =========================================================================
import { supabase } from './conexion_supabase.js';

let channelPedidoActivo = null;
let geoWatchId = null;
let pedidoActual = null;

/**
 * Inicia la suscripción al canal privado del pedido en curso.
 * Sincroniza:
 * 1. Transmisión de ubicación GPS del cadete en vivo (Cadete -> Cliente).
 * 2. Chat y mensajes en tiempo real (Cadete <-> Cliente).
 * 3. Actualización y escucha de estados del pedido (postgres_changes y broadcast).
 * 
 * @param {Object} pedido - Objeto con los datos del pedido (id_pedido, id_cadete, id_cliente, etc.)
 * @param {Object} callbacks - Callbacks para eventos: onMensaje, onCambioEstado, onUbicacion
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
      // Notificar si el mensaje proviene del cliente o del sistema
      if (typeof callbacks.onMensaje === 'function') {
        callbacks.onMensaje(payload);
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('nuevoMensajeChat', { detail: payload }));
      }
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

        // Iniciar rastreo continuo de GPS y transmisión al cliente
        iniciarTransmisionGPS(idPedido, idCadete);
      }
    });

  return channelPedidoActivo;
}

/**
 * Inicia el seguimiento del GPS del cadete y transmite su posición al cliente
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

      // Transmitir al canal del pedido
      if (channelPedidoActivo) {
        await channelPedidoActivo.send({
          type: 'broadcast',
          event: 'ubicacion_cadete',
          payload: {
            id_pedido: idPedido,
            id_cadete: idCadete,
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
 * Envía un mensaje de chat al cliente a través del canal Realtime
 * 
 * @param {string} texto - Contenido del mensaje
 * @returns {Promise<Object>} El objeto del mensaje enviado
 */
export async function enviarMensajeChat(texto) {
  if (!channelPedidoActivo || !pedidoActual) {
    console.error('[RT Chat] No hay un canal de pedido activo para enviar el mensaje.');
    return null;
  }

  const mensaje = {
    id_mensaje: `msg_${Date.now()}`,
    id_pedido: pedidoActual.id_pedido,
    id_emisor: pedidoActual.id_cadete,
    id_receptor: pedidoActual.id_cliente,
    remitente: 'cadete',
    texto: texto.trim(),
    hora: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    timestamp: new Date().toISOString()
  };

  await channelPedidoActivo.send({
    type: 'broadcast',
    event: 'mensaje_chat',
    payload: mensaje
  });

  return mensaje;
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

    const { data, error } = await supabase
      .from('Pedidos')
      .update(updateData)
      .eq('id_pedido', idPedido)
      .select()
      .maybeSingle();

    if (error) {
      console.warn('[RT Estado] Advertencia al actualizar en DB:', error.message);
    }

    // 2. Notificar inmediatamente por broadcast al cliente
    if (channelPedidoActivo) {
      await channelPedidoActivo.send({
        type: 'broadcast',
        event: 'cambio_estado_pedido',
        payload: {
          id_pedido: idPedido,
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
 * Desconecta el canal del pedido activo y detiene el GPS
 */
export async function desconectarPedidoActivo() {
  if (geoWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
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
  window.actualizarEstadoPedidoEnCurso = actualizarEstadoPedidoEnCurso;
  window.desconectarPedidoActivo = desconectarPedidoActivo;
}

export default {
  iniciarSuscripcionPedidoActivo,
  enviarMensajeChat,
  actualizarEstadoPedidoEnCurso,
  desconectarPedidoActivo
};
