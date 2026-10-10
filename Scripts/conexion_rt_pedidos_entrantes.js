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
// Hora (ms) del último fix GPS real; null mientras currentCoords es el fallback.
// La app de clientes solo usa coords con coords_ts para asignar el pedido al cadete más cercano.
let currentCoordsTs = null;

// Reconexión: si el canal se cae (red, pantalla bloqueada, pestaña en segundo plano) el cadete tiene que
// volver a anunciarse solo; si no, sigue "conectado" en su pantalla pero invisible para el admin y el motor.
let quiereConexion = false;      // true entre iniciar y desconectar a propósito
let generacion = 0;              // invalida los estados de canales viejos (ej: el CLOSED de uno que se está reemplazando)
let ultimoCadete = null;
let ultimoCallback = null;
let temporizadorReconexion = null;
let intentosReconexion = 0;
let temporizadorLatido = null;
const LATIDO_PRESENCIA_MS = 15000;
const REINTENTO_RECONEXION_MS = 200; // espera fija entre reintentos de presencia (sin backoff)
const MIN_TRACK_GPS_MS = 4000;       // separación mínima entre publicaciones de presencia causadas por el GPS
let ultimoTrackGpsMs = 0;
let wakeLock = null;                 // mantiene la pantalla encendida mientras el cadete está en turno

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
  const miGeneracion = ++generacion;
  await limpiarSuscripciones();
  if (miGeneracion !== generacion) return; // otra llamada más nueva tomó el control mientras se limpiaba

  quiereConexion = true;
  pedirPantallaEncendida();
  ultimoCadete = cadete;
  ultimoCallback = onNuevoPedido;
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
    // Escuchar Broadcasts emitidos globalmente al canal de cadetes.
    // Solo se atienden los dirigidos a este cadete: un pedido sin id_cadete NO se abre en todos a la vez
    .on('broadcast', { event: 'nuevo_pedido' }, ({ payload }) => {
      console.log('[Realtime Presence Broadcast] Evento recibido:', payload, 'Mi ID:', idCadete);
      if (payload && Number(payload.id_cadete) === idCadete) {
        console.log('[Realtime Presence Broadcast] ¡Pedido recibido para atender! Abriendo modal:', payload);
        procesarNuevoPedido(payload, onNuevoPedido);
      }
    })
    .subscribe(async (status, err) => {
      console.log(`[Realtime Presence] Estado suscripción "cadetes-disponibles": ${status}`);
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime Presence] Cadete #${idCadete} conectado exitosamente a "cadetes-disponibles"`);

        if (miGeneracion !== generacion) return;
        intentosReconexion = 0;
        iniciarLatidoPresencia();

        // Transmisión inicial de presencia, estado, patente y ubicación
        await channelPresence.track({
          id_cad: idCadete,
          nombre: nombreCadete,
          coords: currentCoords,
          coords_ts: currentCoordsTs,
          estado_cad: currentCadetState,
          patente: cadeteSession.patente || '',
          vehiculo_cad: cadeteSession.vehiculo_cad || ''
        });

        // Seguimiento GPS en tiempo real si el navegador lo soporta
        if ('geolocation' in navigator && geoWatchId === null) {
          geoWatchId = navigator.geolocation.watchPosition(
            async (position) => {
              currentCoords = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
              };
              currentCoordsTs = position.timestamp || Date.now();
              // El GPS puede disparar varias lecturas por segundo: publicar todas satura el límite de mensajes
              // del canal y el servidor lo cierra. Las coords quedan en memoria y el latido publica la última.
              if (Date.now() - ultimoTrackGpsMs < MIN_TRACK_GPS_MS) return;
              ultimoTrackGpsMs = Date.now();
              if (channelPresence && cadeteSession) {
                await channelPresence.track({
                  id_cad: idCadete,
                  nombre: nombreCadete,
                  coords: currentCoords,
                  coords_ts: currentCoordsTs,
                  estado_cad: currentCadetState,
                  patente: cadeteSession.patente || '',
                  vehiculo_cad: cadeteSession.vehiculo_cad || ''
                });
              }
            },
            (err) => console.warn('[GPS] Advertencia de ubicación:', err.message),
            { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
          );
        }
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[Realtime Presence] Canal de presencia en estado ${status}:`, err);
        if (miGeneracion === generacion) programarReconexion();
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
    // D) El cliente retiró la oferta (no respondió a tiempo, se pasó al siguiente cadete o se canceló)
    .on('broadcast', { event: 'pedido_retirado' }, ({ payload }) => {
      console.log('[Realtime Broadcast Canal Privado] Oferta retirada:', payload);
      if (!payload || Number(payload.id_cadete) !== idCadete) return;
      if (typeof window !== 'undefined' && typeof window.handlePedidoRetiradoRealtime === 'function') {
        window.handlePedidoRetiradoRealtime(payload);
      }
    })
    .subscribe((status, err) => {
      console.log(`[Realtime Pedidos] Estado suscripción "pedidos-cadete-${idCadete}": ${status}`);
      if (status === 'SUBSCRIBED') {
        console.log(`[Realtime Pedidos] Escuchando asignaciones para cadete #${idCadete}`);
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[Realtime Pedidos] Canal de pedidos en estado ${status}:`, err);
        if (miGeneracion === generacion) programarReconexion();
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

    await channelPresence.track({
      id_cad: idCadete,
      nombre: nombreCadete,
      coords: currentCoords,
      coords_ts: currentCoordsTs,
      estado_cad: nuevoEstado,
      patente: cadeteSession.patente || '',
      vehiculo_cad: cadeteSession.vehiculo_cad || ''
    });
    console.log(`[Realtime Presence] Estado del cadete #${idCadete} actualizado a: ${nuevoEstado} (Patente: ${cadeteSession.patente || 'S/D'})`);
  }
}

/**
 * Actualiza los datos en memoria de la sesión del cadete (ej. tras recargar perfil o patente desde BD)
 * @param {Object} nuevosDatos 
 */
export function actualizarDatosCadeteSession(nuevosDatos) {
  if (nuevosDatos && typeof nuevosDatos === 'object') {
    cadeteSession = { ...cadeteSession, ...nuevosDatos };
    if (channelPresence && cadeteSession) {
      actualizarEstadoPresencia(currentCadetState);
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
  quiereConexion = false;
  generacion++;
  soltarPantallaEncendida();
  await limpiarSuscripciones();
}

function programarReconexion() {
  if (!quiereConexion || temporizadorReconexion || !ultimoCadete) return;
  const espera = REINTENTO_RECONEXION_MS;
  intentosReconexion++;
  console.warn(`[Realtime] Reconectando presencia en ${espera} ms (intento ${intentosReconexion})...`);
  temporizadorReconexion = setTimeout(() => {
    temporizadorReconexion = null;
    if (!quiereConexion || !ultimoCadete) return;
    // Ante una caída de red el cliente de Supabase reintenta unirse solo: si ya lo logró no se rehace nada
    // (rehacerlo cortaba esa reconexión y dejaba al cadete invisible un rato más)
    if (canalesUnidos()) {
      intentosReconexion = 0;
      return;
    }
    iniciarSuscripcionesDashboard(ultimoCadete, ultimoCallback);
  }, espera);
}

function canalesUnidos() {
  return Boolean(channelPresence && channelPedidos
    && channelPresence.state === 'joined' && channelPedidos.state === 'joined');
}

// En el celular, con la pantalla apagada el sistema congela la página y el socket se cae: se pide mantenerla
// encendida mientras hay turno. El permiso se pierde al ocultar la pestaña, por eso se vuelve a pedir al volver.
async function pedirPantallaEncendida() {
  if (!quiereConexion || wakeLock || typeof navigator === 'undefined' || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { /* sin permiso o sin soporte: no es crítico */ }
}

function soltarPantallaEncendida() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// Cada pocos segundos se vuelve a publicar la presencia: si el servidor la perdió (reconexión del socket,
// pestaña dormida) se recupera sola, y si el canal ya no está unido se rehace entero.
function iniciarLatidoPresencia() {
  if (temporizadorLatido) clearInterval(temporizadorLatido);
  temporizadorLatido = setInterval(verificarPresencia, LATIDO_PRESENCIA_MS);
}

async function verificarPresencia() {
  if (!quiereConexion || !ultimoCadete) return;
  // También el canal de pedidos: si solo ese se cae, el cadete figura conectado pero no recibe ofertas
  if (!canalesUnidos()) {
    programarReconexion();
    return;
  }
  try {
    await actualizarEstadoPresencia(currentCadetState);
  } catch (e) {
    programarReconexion();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      pedirPantallaEncendida();
      verificarPresencia();
    }
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', verificarPresencia);
  window.addEventListener('pageshow', verificarPresencia);
}

async function limpiarSuscripciones() {
  if (temporizadorLatido) { clearInterval(temporizadorLatido); temporizadorLatido = null; }
  if (temporizadorReconexion) { clearTimeout(temporizadorReconexion); temporizadorReconexion = null; }

  if (geoWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }

  if (channelPresence) {
    try {
      await channelPresence.untrack();
    } catch (e) { }
    try {
      await supabase.removeChannel(channelPresence);
    } catch (e) { }
    channelPresence = null;
  }

  if (channelPedidos) {
    try {
      await supabase.removeChannel(channelPedidos);
    } catch (e) { }
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
  window.actualizarDatosCadeteSession = actualizarDatosCadeteSession;
  window.desconectarSuscripcionesDashboard = desconectarSuscripcionesDashboard;
}

export default {
  iniciarSuscripcionesDashboard,
  actualizarEstadoPresencia,
  actualizarDatosCadeteSession,
  desconectarSuscripcionesDashboard
};
