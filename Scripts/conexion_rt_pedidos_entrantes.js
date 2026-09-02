// =========================================================================
// CONEXIÓN REALTIME: PRESENCIA DE CADETES & RECEPCIÓN DE PEDIDOS ENTRANTES
// =========================================================================
import { supabase } from './conexion_supabase.js';

let channelPresence = null;
let channelPedidos = null;
let geoWatchId = null;
let cadeteSession = null;
let currentCadetState = 'disponible';
let currentCoords = { lat: -31.5375, lng: -68.5364 }; // San Juan (Fallback)

/**
 * Inicia la doble suscripción en Supabase Realtime:
 * 1. Canal 'cadetes-disponibles' (Presence): Transmite conexión, estado y ubicación GPS al backend.
 * 2. Canal 'pedidos-cadete-${idCadete}' (Postgres Changes & Broadcast): Escucha pedidos asignados a id_cadete.
 * 
 * @param {Object} cadete - Objeto con datos del cadete (id_cad, nombre_cad, etc.)
 * @param {Function} [onNuevoPedido] - Callback ejecutado al recibir un nuevo pedido
 */
export async function iniciarSuscripcionesDashboard(cadete, onNuevoPedido) {
  if (!cadete || !cadete.id_cad) {
    console.error('[Realtime] No se proporcionó un cadete válido con id_cad.');
    return;
  }

  // 1. Limpiar suscripciones previas si ya existían para garantizar reconexión limpia
  await desconectarSuscripcionesDashboard();

  cadeteSession = cadete;
  currentCadetState = cadete.estado_cad || 'disponible';
  const idCadete = Number(cadete.id_cad);
  const nombreCadete = cadete.nombre_cad || cadete.alias_cad || `Cadete #${idCadete}`;

  console.log(`[Realtime] Inicializando suscripciones para cadete ID: ${idCadete} (${nombreCadete}) - Estado: ${currentCadetState}`);

  // -----------------------------------------------------------------------
  // 1. CANAL DE PRESENCIA: 'cadetes-disponibles'
  // -----------------------------------------------------------------------
  channelPresence = supabase.channel('cadetes-disponibles', {
    config: {
      presence: {
        key: `cad_${idCadete}`
      }
    }
  });

  channelPresence
    .on('presence', { event: 'sync' }, () => {
      const state = channelPresence.presenceState();
      console.log('[Realtime Presence] Estado sincronizado:', state);
    })
    // Escuchar Broadcasts emitidos globalmente al canal de cadetes
    .on('broadcast', { event: 'nuevo_pedido' }, ({ payload }) => {
      console.log('[Realtime Presence Broadcast] Evento recibido:', payload, 'Mi ID:', idCadete);
      if (payload && Number(payload.id_cadete) === idCadete) {
        console.log('[Realtime Presence Broadcast] ¡Pedido destinado a mí! Abriendo modal:', payload);
        procesarNuevoPedido(payload, onNuevoPedido);
      }
    })
    .subscribe(async (status, err) => {
      console.log(`[Realtime Presence] Estado suscripción "cadetes-disponibles": ${status}`);
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime Presence] Cadete #${idCadete} conectado exitosamente a "cadetes-disponibles"`);
        
        // Transmisión inicial de presencia, estado y ubicación
        try {
          await channelPresence.track({
            id_cad: idCadete,
            nombre: nombreCadete,
            coords: currentCoords,
            estado_cad: currentCadetState
          });
        } catch (e) {
          console.warn('[Realtime Presence] Error al trackear presencia:', e);
        }

        // Seguimiento GPS en tiempo real si el navegador lo soporta
        if ('geolocation' in navigator && geoWatchId === null) {
          geoWatchId = navigator.geolocation.watchPosition(
            async (position) => {
              currentCoords = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
              };
              if (channelPresence) {
                await channelPresence.track({
                  id_cad: idCadete,
                  nombre: nombreCadete,
                  coords: currentCoords,
                  estado_cad: currentCadetState
                }).catch(e => console.warn('[GPS] Error trackeando coordenadas:', e));
              }
            },
            (err) => console.warn('[GPS] Advertencia de ubicación:', err.message),
            { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
          );
        }
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[Realtime Presence] Canal de presencia en estado ${status}:`, err);
      }
    });

  // -----------------------------------------------------------------------
  // 2. CANAL DE PEDIDOS ENTRANTES: Escucha en tabla 'Pedidos' y Broadcast
  // -----------------------------------------------------------------------
  channelPedidos = supabase.channel(`pedidos-cadete-${idCadete}`, {
    config: {
      broadcast: { ack: true }
    }
  });

  channelPedidos
    // A) Escuchar inserciones en la tabla 'Pedidos' cuando id_cadete coincide
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'Pedidos',
        filter: `id_cadete=eq.${idCadete}`
      },
      (payload) => {
        console.log('[Realtime Pedidos] Nuevo pedido INSERT recibido:', payload.new);
        if (!payload.new) return;
        
        const destId = Number(payload.new.id_cadete);
        if (destId !== idCadete) {
          console.error(`[FUEGO P2P] INTENTO DE INVASIÓN INSERT! Destinado a ${destId}, pero yo soy ${idCadete}! Bloqueando.`);
          return;
        }

        if (payload.new.estado_pedido === 'libre' || payload.new.estado_pedido === 'en_confirmacion') {
          procesarNuevoPedido(payload.new, onNuevoPedido);
        }
      }
    )
    // B) Escuchar actualizaciones en la tabla 'Pedidos' (oferta de asignación o cancelación)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'Pedidos',
        filter: `id_cadete=eq.${idCadete}`
      },
      (payload) => {
        console.log('[Realtime Pedidos] Pedido UPDATE recibido:', payload.new);
        if (!payload.new) return;

        const destId = Number(payload.new.id_cadete);

        if (payload.new.estado_pedido === 'cancelado') {
          if (typeof window !== 'undefined' && typeof window.handlePedidoCanceladoRealtime === 'function') {
            window.handlePedidoCanceladoRealtime(payload.new);
          }
          return;
        }

        if (destId !== idCadete) {
          console.error(`[FUEGO P2P] INTENTO DE INVASIÓN UPDATE! Destinado a ${destId}, pero yo soy ${idCadete}! Bloqueando.`);
          return;
        }

        // Permitir tanto 'libre' (reasignación de cliente) como 'en_confirmacion'
        if (payload.new.estado_pedido === 'libre' || payload.new.estado_pedido === 'en_confirmacion') {
          procesarNuevoPedido(payload.new, onNuevoPedido);
        }
      }
    )
    // C) Escuchar mensajes directos por Broadcast emitidos al canal privado
    .on('broadcast', { event: 'nuevo_pedido' }, ({ payload }) => {
      console.log('[Realtime Broadcast Canal Privado] Pedido recibido:', payload);
      if (!payload) return;

      const destId = Number(payload.id_cadete);
      if (destId !== idCadete) {
        console.error(`[FUEGO P2P] INTENTO DE INVASIÓN BROADCAST! Destinado a ${destId}, pero yo soy ${idCadete}! Bloqueando.`);
        return;
      }

      procesarNuevoPedido(payload, onNuevoPedido);
    })
    .subscribe((status, err) => {
      console.log(`[Realtime Pedidos] Estado suscripción "pedidos-cadete-${idCadete}": ${status}`);
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime Pedidos] Escuchando asignaciones para cadete #${idCadete}`);
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[Realtime Pedidos] Canal de pedidos en estado ${status}:`, err);
      }
    });

  return {
    channelPresence,
    channelPedidos
  };
}

/**
 * Actualiza el estado de presencia del cadete (ej. 'disponible', 'en_confirmacion', 'ocupado')
 * y lo retransmite inmediatamente en Realtime Presence
 * 
 * @param {string} nuevoEstado - 'disponible' | 'en_confirmacion' | 'ocupado' | 'desconectado'
 */
export async function actualizarEstadoPresencia(nuevoEstado) {
  currentCadetState = nuevoEstado;
  if (channelPresence && cadeteSession) {
    const idCadete = Number(cadeteSession.id_cad);
    const nombreCadete = cadeteSession.nombre_cad || cadeteSession.alias_cad || `Cadete #${idCadete}`;
    
    try {
      await channelPresence.track({
        id_cad: idCadete,
        nombre: nombreCadete,
        coords: currentCoords,
        estado_cad: nuevoEstado
      });
      console.log(`[Realtime Presence] Estado del cadete actualizado a: ${nuevoEstado}`);
    } catch (err) {
      console.warn('[Realtime Presence] Error actualizando estado de presencia:', err);
    }
  }
}

/**
 * Procesa los datos del pedido recibido y notifica a la interfaz del Dashboard
 */
function procesarNuevoPedido(pedido, callback) {
  if (!pedido || !pedido.id_pedido) return;

  if (typeof callback === 'function') {
    callback(pedido);
  } else if (typeof window !== 'undefined' && typeof window.triggerIncomingOrderModal === 'function') {
    window.triggerIncomingOrderModal(pedido);
  }
}

/**
 * Desconecta los canales y detiene el rastreo de GPS de forma limpia
 */
export async function desconectarSuscripcionesDashboard() {
  if (geoWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }

  if (channelPresence) {
    try {
      await channelPresence.untrack();
    } catch (e) {}
    try {
      await supabase.removeChannel(channelPresence);
    } catch (e) {}
    channelPresence = null;
  }

  if (channelPedidos) {
    try {
      await supabase.removeChannel(channelPedidos);
    } catch (e) {}
    channelPedidos = null;
  }

  // Purgar cualquier canal residual en el cliente para estos nombres
  try {
    const existingChannels = typeof supabase.getChannels === 'function' ? supabase.getChannels() : [];
    for (const ch of existingChannels) {
      if (ch.topic === 'realtime:cadetes-disponibles' || (cadeteSession && ch.topic === `realtime:pedidos-cadete-${cadeteSession.id_cad}`)) {
        await supabase.removeChannel(ch);
      }
    }
  } catch (e) {
    console.warn('[Realtime] Advertencia purgando canales:', e);
  }

  console.log('[Realtime] Suscripciones de dashboard desconectadas exitosamente.');
}

// Exponer globalmente en window para fácil uso desde cualquier script
if (typeof window !== 'undefined') {
  window.iniciarSuscripcionesDashboard = iniciarSuscripcionesDashboard;
  window.actualizarEstadoPresencia = actualizarEstadoPresencia;
  window.desconectarSuscripcionesDashboard = desconectarSuscripcionesDashboard;
}

export default {
  iniciarSuscripcionesDashboard,
  actualizarEstadoPresencia,
  desconectarSuscripcionesDashboard
};
