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
 * 2. Canal 'pedidos-asignados' (Postgres Changes & Broadcast): Escucha pedidos asignados a id_cadete.
 * 
 * @param {Object} cadete - Objeto con datos del cadete (id_cad, nombre_cad, etc.)
 * @param {Function} [onNuevoPedido] - Callback ejecutado al recibir un nuevo pedido
 */
export async function iniciarSuscripcionesDashboard(cadete, onNuevoPedido) {
  if (!cadete || !cadete.id_cad) {
    console.error('[Realtime] No se proporcionó un cadete válido con id_cad.');
    return;
  }

  cadeteSession = cadete;
  currentCadetState = cadete.estado_cad || 'disponible';
  const idCadete = cadete.id_cad;
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
      if (payload && Number(payload.id_cadete) === Number(idCadete)) {
        console.log('[Realtime Presence Broadcast] ¡Pedido destinado a mí! Abriendo modal:', payload);
        procesarNuevoPedido(payload, onNuevoPedido);
      }
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime Presence] Cadete #${idCadete} conectado a "cadetes-disponibles"`);
        
        // Transmisión inicial de presencia, estado y ubicación
        await channelPresence.track({
          id_cad: idCadete,
          nombre: nombreCadete,
          coords: currentCoords,
          estado_cad: currentCadetState
        });

        // Seguimiento GPS en tiempo real si el navegador lo soporta
        if ('geolocation' in navigator) {
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
                });
              }
            },
            (err) => console.warn('[GPS] Error de ubicación:', err.message),
            { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
          );
        }
      }
    });

  // -----------------------------------------------------------------------
  // 2. CANAL DE PEDIDOS ENTRANTES: Escucha en tabla 'Pedidos' y Broadcast
  // -----------------------------------------------------------------------
  channelPedidos = supabase.channel(`pedidos-cadete-${idCadete}`);

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
        if (payload.new && Number(payload.new.id_cadete) === Number(idCadete) && payload.new.estado_pedido === 'en_confirmacion') {
          procesarNuevoPedido(payload.new, onNuevoPedido);
        }
      }
    )
    // B) Escuchar actualizaciones en la tabla 'Pedidos' (oferta de asignación)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'Pedidos',
        filter: `id_cadete=eq.${idCadete}`
      },
      (payload) => {
        console.log('[Realtime Pedidos] Pedido UPDATE asignado:', payload.new);
        // El modal SOLO debe abrirse ante una nueva oferta 'en_confirmacion'.
        // NUNCA cuando pasa a 'asignado' (ya que significa que el cadete acaba de aceptarlo y va a viajar).
        if (
          payload.new &&
          Number(payload.new.id_cadete) === Number(idCadete) &&
          payload.new.estado_pedido === 'en_confirmacion'
        ) {
          procesarNuevoPedido(payload.new, onNuevoPedido);
        }
      }
    )
    // C) Escuchar mensajes directos por Broadcast emitidos al canal privado
    .on('broadcast', { event: 'nuevo_pedido' }, ({ payload }) => {
      console.log('[Realtime Broadcast Canal Privado] Pedido recibido:', payload);
      if (payload && Number(payload.id_cadete) === Number(idCadete)) {
        procesarNuevoPedido(payload, onNuevoPedido);
      }
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime Pedidos] Escuchando asignaciones para cadete #${idCadete}`);
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
    const idCadete = cadeteSession.id_cad;
    const nombreCadete = cadeteSession.nombre_cad || cadeteSession.alias_cad || `Cadete #${idCadete}`;
    
    await channelPresence.track({
      id_cad: idCadete,
      nombre: nombreCadete,
      coords: currentCoords,
      estado_cad: nuevoEstado
    });
    console.log(`[Realtime Presence] Estado del cadete actualizado a: ${nuevoEstado}`);
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
 * Desconecta los canales y detiene el rastreo de GPS
 */
export async function desconectarSuscripcionesDashboard() {
  if (geoWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }

  if (channelPresence) {
    await channelPresence.untrack();
    await supabase.removeChannel(channelPresence);
    channelPresence = null;
  }

  if (channelPedidos) {
    await supabase.removeChannel(channelPedidos);
    channelPedidos = null;
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
