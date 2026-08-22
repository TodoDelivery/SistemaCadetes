// =========================================================================
// CONEXIÓN REALTIME: PRESENCIA DE CADETES & RECEPCIÓN DE PEDIDOS ENTRANTES
// =========================================================================
import { supabase } from './conexion_supabase.js';

let channelPresence = null;
let channelPedidos = null;
let geoWatchId = null;

/**
 * Inicia la doble suscripción en Supabase Realtime:
 * 1. Canal 'cadetes-disponibles' (Presence): Transmite conexión y ubicación GPS al backend.
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

  const idCadete = cadete.id_cad;
  const nombreCadete = cadete.nombre_cad || cadete.alias_cad || `Cadete #${idCadete}`;

  console.log(`[Realtime] Inicializando suscripciones para cadete ID: ${idCadete} (${nombreCadete})`);

  // Coordenadas iniciales (por defecto centro o GPS)
  let currentCoords = { lat: -31.5375, lng: -68.5364 }; // San Juan (Fallback)

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
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[Realtime Presence] Conectado al canal "cadetes-disponibles"');
        
        // Transmisión inicial de presencia y ubicación
        await channelPresence.track({
          id_cad: idCadete,
          nombre: nombreCadete,
          coords: currentCoords
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
                  coords: currentCoords
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
        procesarNuevoPedido(payload.new, onNuevoPedido);
      }
    )
    // B) Escuchar actualizaciones en la tabla 'Pedidos' (por ejemplo cuando se asigna id_cadete)
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
        // Si el estado es pendiente o asignado para el cadete
        if (payload.new.estado_pedido === 'asignado' || payload.new.estado_pedido === 'pendiente') {
          procesarNuevoPedido(payload.new, onNuevoPedido);
        }
      }
    )
    // C) Escuchar mensajes directos por Broadcast emitidos por backend
    .on('broadcast', { event: 'nuevo_pedido' }, ({ payload }) => {
      console.log('[Realtime Broadcast] Pedido recibido por broadcast:', payload);
      procesarNuevoPedido(payload, onNuevoPedido);
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
 * Procesa los datos del pedido recibido y notifica a la interfaz del Dashboard
 */
function procesarNuevoPedido(pedido, callback) {
  if (!pedido) return;

  // Notificar mediante callback si fue provisto
  if (typeof callback === 'function') {
    callback(pedido);
  }

  // Notificar globalmente mediante CustomEvent para el DOM
  if (typeof window !== 'undefined') {
    const event = new CustomEvent('nuevoPedidoEntrante', { detail: pedido });
    window.dispatchEvent(event);

    // Si existe la función global en dashboard.html para abrir el modal
    if (typeof window.recibirPedidoRealtime === 'function') {
      window.recibirPedidoRealtime(pedido);
    }
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
  window.desconectarSuscripcionesDashboard = desconectarSuscripcionesDashboard;
}

export default {
  iniciarSuscripcionesDashboard,
  desconectarSuscripcionesDashboard
};
