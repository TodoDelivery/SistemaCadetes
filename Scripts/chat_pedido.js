// =========================================================================
// HISTORIAL DEL CHAT DE UN PEDIDO (Pedidos.Chat_pedido)
// =========================================================================
// El chat viaja en vivo por broadcast ('mensaje_chat' en pedido-en-curso-{id}) y además queda guardado
// en la columna de texto Pedidos.Chat_pedido, como un array JSON de esos mismos mensajes. Así no se
// pierde al salir de la app y le llega al otro lado aunque no estuviera conectado.
//
// Cliente y cadete escriben la misma columna sin bloqueo: una escritura puede pisar a la otra. Por eso
// cada lado guarda la UNIÓN (por id_mensaje) de lo que conoce y lo que hay en la BD, y la vuelve a
// guardar cada vez que ve que a la BD le falta un mensaje. El historial converge solo.
//
// La app de clientes tiene una copia de este módulo (scripts/chat_pedido.js): cambiarlos juntos.
import { supabase } from './conexion_supabase.js';

export const COLUMNA_CHAT = 'Chat_pedido';
export const LARGO_MAX_MENSAJE = 500;

const REINTENTO_MS = 5000;     // espera antes de reintentar un guardado que falló
const REINTENTOS_MAX = 6;
const VERIFICACION_MS = 4000;  // margen para que el emisor guarde su mensaje antes de guardarlo uno

function horaDe(fecha) {
  return fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); // 'HH:MM'
}

/** Deja un mensaje (de broadcast o de la BD) con la forma que se guarda. null si no sirve */
function normalizarMensaje(m) {
  if (!m || typeof m !== 'object') return null;
  const texto = String(m.texto ?? '').trim().slice(0, LARGO_MAX_MENSAJE);
  if (!texto) return null;

  const remitente = m.remitente === 'cadete' ? 'cadete' : 'cliente';
  const ms = Date.parse(m.timestamp);
  const timestamp = Number.isNaN(ms) ? '' : new Date(ms).toISOString();
  const hora = String(m.hora || (timestamp ? horaDe(new Date(ms)) : ''));

  return {
    // Sin id (versiones viejas): uno que los dos lados calculen igual para el mismo mensaje
    id_mensaje: String(m.id_mensaje || `${remitente}_${timestamp || `${hora}_${texto}`}`),
    id_emisor: m.id_emisor ?? null,
    id_receptor: m.id_receptor ?? null,
    remitente,
    texto,
    hora,
    timestamp
  };
}

function ordenar(mensajes) {
  return [...mensajes].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp) || a.id_mensaje.localeCompare(b.id_mensaje));
}

/** Convierte lo que haya en Pedidos.Chat_pedido en una lista ordenada y sin repetidos */
export function leerChat(valor) {
  let lista = valor;
  if (typeof valor === 'string') {
    try {
      lista = JSON.parse(valor);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(lista)) return [];

  const porId = new Map();
  lista.map(normalizarMensaje).filter(Boolean).forEach(m => porId.set(m.id_mensaje, m));
  return ordenar(porId.values());
}

/**
 * Historial del chat de un pedido: lo que se ve en pantalla sale siempre de acá.
 *
 * @param {Object} opciones
 * @param {number} opciones.idPedido
 * @param {'cliente'|'cadete'} opciones.remitente - quién usa esta app
 * @param {*} opciones.idEmisor - id_cliente o id_cad de quien escribe
 * @param {Object} [opciones.filtro] - condición extra del UPDATE (ej: { id_cadete }): solo se escribe en pedidos propios
 * @param {*} [opciones.inicial] - valor de Chat_pedido ya leído con el pedido
 * @param {(lista: Array) => void} [opciones.alCambiar] - cambió la lista o lo que ya está guardado
 * @param {(nuevos: Array) => void} [opciones.alRecibir] - llegaron mensajes del otro lado
 */
export function crearHistorialChat({ idPedido, remitente, idEmisor, filtro = {}, inicial, alCambiar, alRecibir }) {
  const mensajes = new Map(); // id_mensaje -> mensaje: todo lo que este lado conoce
  const enBD = new Set();     // ids que ya están en Pedidos.Chat_pedido
  let cola = Promise.resolve(true);
  let temporizador = null;
  let reintentos = 0;
  let cerrado = false;

  const lista = () => ordenar(mensajes.values());
  const faltaGuardar = () => [...mensajes.keys()].some(id => !enBD.has(id));
  const avisarCambio = () => { if (!cerrado) alCambiar?.(lista()); };

  function avisarRecibidos(nuevos) {
    const ajenos = nuevos.filter(m => m.remitente !== remitente);
    if (ajenos.length && !cerrado) alRecibir?.(ajenos);
  }

  /** Suma a lo conocido lo que hay en la BD. Devuelve los mensajes que no se conocían */
  function aplicarBD(valor) {
    const guardados = leerChat(valor);
    const nuevos = guardados.filter(m => !mensajes.has(m.id_mensaje));
    nuevos.forEach(m => mensajes.set(m.id_mensaje, m));
    enBD.clear();
    guardados.forEach(m => enBD.add(m.id_mensaje));
    return nuevos;
  }

  function programar(ms) {
    clearTimeout(temporizador);
    temporizador = cerrado ? null : setTimeout(sincronizar, ms);
  }

  async function leerYGuardar() {
    const { data, error } = await supabase
      .from('Pedidos')
      .select(COLUMNA_CHAT)
      .eq('id_pedido', idPedido)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error(`No se pudo leer el pedido #${idPedido}`);

    const nuevos = aplicarBD(data[COLUMNA_CHAT]);
    if (nuevos.length) {
      avisarCambio();
      avisarRecibidos(nuevos);
    }
    if (!faltaGuardar()) return;

    const completa = lista();
    let consulta = supabase
      .from('Pedidos')
      .update({ [COLUMNA_CHAT]: JSON.stringify(completa) })
      .eq('id_pedido', idPedido);
    for (const [columna, valor] of Object.entries(filtro)) consulta = consulta.eq(columna, valor);

    const { data: fila, error: errorGuardar } = await consulta.select('id_pedido').maybeSingle();
    if (errorGuardar) throw errorGuardar;
    // Sin filas y sin error: RLS no permite el UPDATE sobre Pedidos
    if (!fila) throw new Error('No se actualizó Pedidos.Chat_pedido (revisar la política RLS de UPDATE)');

    completa.forEach(m => enBD.add(m.id_mensaje));
  }

  /**
   * Trae lo que haya en la BD y guarda lo que le falte. Las llamadas se encolan: nunca hay dos a la vez.
   * @returns {Promise<boolean>} true si todo lo conocido quedó guardado
   */
  function sincronizar() {
    clearTimeout(temporizador);
    temporizador = null;

    cola = cola.then(async () => {
      if (cerrado) return false;
      try {
        await leerYGuardar();
        reintentos = 0;
        avisarCambio();
        return true;
      } catch (err) {
        console.warn('[Chat] No se pudo guardar el historial:', err);
        if (reintentos < REINTENTOS_MAX) {
          reintentos++;
          programar(REINTENTO_MS);
        }
        return false;
      }
    });
    return cola;
  }

  /** Crea un mensaje propio y lo suma al historial. Después hay que enviarlo y llamar a sincronizar() */
  function crearMensaje(texto, idReceptor) {
    const ahora = new Date();
    // Siempre posterior a lo ya visto, aunque el reloj del otro teléfono esté adelantado
    const ultimo = Math.max(0, ...[...mensajes.values()].map(m => Date.parse(m.timestamp) || 0));
    const fecha = new Date(Math.max(ahora.getTime(), ultimo + 1));

    const mensaje = {
      id_mensaje: `msg_${fecha.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      id_pedido: idPedido,
      id_emisor: idEmisor,
      id_receptor: idReceptor ?? null,
      remitente,
      texto: String(texto).trim().slice(0, LARGO_MAX_MENSAJE),
      hora: horaDe(ahora),
      timestamp: fecha.toISOString()
    };
    mensajes.set(mensaje.id_mensaje, normalizarMensaje(mensaje));
    avisarCambio();
    return mensaje;
  }

  /** Mensaje que llegó por broadcast. Lo guarda el emisor; si no llega a hacerlo, lo guarda este lado */
  function registrar(payload) {
    const mensaje = normalizarMensaje(payload);
    if (!mensaje || mensajes.has(mensaje.id_mensaje)) return null;

    mensajes.set(mensaje.id_mensaje, mensaje);
    avisarCambio();
    avisarRecibidos([mensaje]);
    programar(VERIFICACION_MS);
    return mensaje;
  }

  /** Valor de Chat_pedido que llegó por postgres_changes (undefined si el evento no trae la columna) */
  function fusionar(valor) {
    if (valor === undefined || cerrado) return;

    const nuevos = aplicarBD(valor);
    avisarCambio();
    avisarRecibidos(nuevos);
    if (faltaGuardar()) {
      sincronizar();
    } else {
      clearTimeout(temporizador);
      temporizador = null;
    }
  }

  function cerrar() {
    cerrado = true;
    clearTimeout(temporizador);
    window.removeEventListener('online', sincronizar);
  }

  aplicarBD(inicial);
  // Al recuperar la conexión: traer lo que se perdió y guardar lo que quedó pendiente
  window.addEventListener('online', sincronizar);

  return {
    lista,
    crearMensaje,
    registrar,
    fusionar,
    sincronizar,
    cerrar,
    estaGuardado: (idMensaje) => enBD.has(idMensaje)
  };
}
