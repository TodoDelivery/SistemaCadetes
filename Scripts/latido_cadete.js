// =========================================================================
// LATIDO DEL CADETE: SEÑAL DE VIDA Y UBICACIÓN PARA EL ASIGNADOR DEL SERVIDOR
// =========================================================================
// El asignador de pedidos corre en la base (Postgres) y no ve Realtime Presence: sabe quién está en turno
// y dónde por esta señal, que se guarda con la función cadete_latido(). Si un cadete deja de mandarla
// (cerró la app, se quedó sin red) el asignador lo da por desconectado y no le ofrece pedidos.
// Se manda en el dashboard, en Rendición/Historial y también durante un viaje: un cadete en viaje cuenta
// como "ocupado" y los pedidos nuevos esperan a que se libere en vez de cancelarse.
import { supabase } from './conexion_supabase.js';

const INTERVALO_LATIDO_MS = 15000;

let idCadete = null;
let temporizador = null;
let ubicacion = null; // { lat, lng, ts } del último fix GPS real; null = todavía sin GPS

export function iniciarLatidoCadete(idCad) {
  const id = Number(idCad);
  if (!id) return;
  if (id !== idCadete) ubicacion = null; // no arrastrar la ubicación de otro cadete (cambio de sesión)
  idCadete = id;
  if (temporizador) clearInterval(temporizador);
  temporizador = setInterval(enviarLatido, INTERVALO_LATIDO_MS);
  enviarLatido();
}

export function detenerLatidoCadete() {
  if (temporizador) clearInterval(temporizador);
  temporizador = null;
  idCadete = null;
}

/** Última lectura real del GPS. La primera se manda enseguida para que el asignador ya pueda medir distancias. */
export function actualizarUbicacionLatido(lat, lng, ts) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const eraLaPrimera = ubicacion === null;
  ubicacion = { lat, lng, ts: Math.round(Number(ts) || Date.now()) };
  if (eraLaPrimera) enviarLatido();
}

async function enviarLatido() {
  if (!idCadete) return;
  try {
    const { error } = await supabase.rpc('cadete_latido', {
      p_id_cad: idCadete,
      p_lat: ubicacion ? ubicacion.lat : null,
      p_lng: ubicacion ? ubicacion.lng : null,
      p_gps_ms: ubicacion ? ubicacion.ts : null
    });
    if (error) console.warn('[Latido] No se pudo enviar la señal:', error.message);
  } catch (err) {
    console.warn('[Latido] No se pudo enviar la señal:', err);
  }
}

// Al volver a la app o recuperar la red no se espera al próximo ciclo
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') enviarLatido();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', enviarLatido);
  window.addEventListener('pageshow', enviarLatido);
}
