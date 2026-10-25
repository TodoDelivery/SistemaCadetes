// =========================================================================
// AVISOS PUSH: notificaciones con la app cerrada o la pantalla apagada
// =========================================================================
// Funcionan en Chrome para Android sin instalar la app: alcanza con el service worker (sw.js en la raíz,
// lo registra este módulo) y el permiso del cadete. En iPhone solo con la app agregada al inicio.
// El celular queda registrado en Push_suscripciones a través de la Edge Function suscribir-push
// (la tabla está cerrada a la clave pública). Los avisos los manda enviar-push cuando cambia el pedido.
//
// La app de clientes tiene una versión de este módulo (scripts/avisos_push.js): cambiarlas juntas.
// Diferencias: acá se registra el service worker y el celular queda a nombre del cadete (id_cad).
import { supabase } from './conexion_supabase.js';

/** El navegador puede recibir avisos push (Chrome/Android sí; iPhone sin instalar no) */
export function avisosDisponibles() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** 'granted' | 'denied' | 'default' | 'no-disponible' */
export function permisoAvisos() {
  return avisosDisponibles() ? Notification.permission : 'no-disponible';
}

function base64UrlABytes(texto) {
  const base64 = (texto + '='.repeat((4 - texto.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

// Sin caché ni interceptar pedidos: registrarlo no cambia nada más de la app
function registrarServiceWorker() {
  return navigator.serviceWorker.register(new URL('../sw.js', import.meta.url).href)
    .then(() => navigator.serviceWorker.ready);
}

async function llamar(cuerpo) {
  const { data, error } = await supabase.functions.invoke('suscribir-push', { body: cuerpo });
  if (error) throw error;
  return data;
}

/**
 * Pide el permiso y registra este celular a nombre del cadete.
 * Llamarla desde un toque del cadete (Chrome no muestra el permiso si no).
 * @returns {Promise<boolean>} true si los avisos quedaron activos
 */
export async function activarAvisos(idCad) {
  if (!avisosDisponibles() || !idCad) return false;
  if (await Notification.requestPermission() !== 'granted') return false;

  const registro = await registrarServiceWorker();
  let suscripcion = await registro.pushManager.getSubscription();
  if (!suscripcion) {
    const { clave } = await llamar({ accion: 'clave' });
    suscripcion = await registro.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlABytes(clave)
    });
  }
  await llamar({ accion: 'alta', id_cad: Number(idCad), suscripcion: suscripcion.toJSON() });
  return true;
}

/** Con el permiso ya dado, vuelve a registrar el celular (por si cambió la suscripción o la persona) */
export async function sincronizarAvisos(idCad) {
  if (permisoAvisos() !== 'granted') return;
  try {
    await activarAvisos(idCad);
  } catch (err) {
    console.warn('[Avisos] No se pudo registrar el celular:', err);
  }
}

/** Al cerrar sesión: este celular deja de recibir los avisos de este cadete */
export async function desactivarAvisos() {
  if (!avisosDisponibles()) return;
  try {
    const registro = await navigator.serviceWorker.getRegistration();
    const suscripcion = await registro?.pushManager.getSubscription();
    if (!suscripcion) return;
    await llamar({ accion: 'baja', suscripcion: { endpoint: suscripcion.endpoint } });
    await suscripcion.unsubscribe();
  } catch (err) {
    console.warn('[Avisos] No se pudo dar de baja el celular:', err);
  }
}
