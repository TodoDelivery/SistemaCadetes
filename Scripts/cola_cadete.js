// =========================================================================
// COLA DEL CADETE: OFERTA DE "SIGUIENTE PEDIDO" DURANTE UN VIAJE
// =========================================================================
// Cuando no hay cadetes libres, el asignador del servidor le ofrece el pedido nuevo a un cadete que está en
// viaje, para que lo haga apenas termine (elige al que va a entregar más cerca del retiro nuevo). Si acepta,
// el pedido queda 'en_cola' a su nombre y pasa solo a 'asignado' cuando entrega el viaje actual.
//
// Este módulo funciona igual en el dashboard y en la pantalla del viaje: consulta la BD cada 3 s y
//   * si el cadete tiene un viaje Y una oferta abierta, muestra la hoja "Siguiente pedido" (15 s);
//   * si tiene un pedido en cola, muestra un cartel fijo con el número.
// Sin viaje no hace nada: ahí la oferta es normal y la muestra el modal del dashboard.
// La hoja y el cartel se dibujan con estilos propios para no depender del HTML de cada página.
import { supabase } from './conexion_supabase.js';
import { COMISION_POR_DEFECTO, obtenerComision, repartir } from './comision.js';

const INTERVALO_MS = 3000;
const SEGUNDOS_MODAL = 15;         // igual que el modal de ofertas del dashboard
const MARGEN_VENCIMIENTO_S = 2;    // se cierra un poco antes de que el servidor venza la oferta
const TTL_RECHAZO_MS = 60000;
const ESTADOS_VIAJE = ['asignado', 'en_camino_entrega'];
const ESTADOS_OFERTA = ['libre', 'en_confirmacion'];

let idCadete = null;
let temporizador = null;
let consultando = false;
let ofertaAbierta = null;          // pedido que se está mostrando en la hoja
let temporizadorOferta = null;
let respondiendo = false;
let comision = COMISION_POR_DEFECTO;
let idEnCola = null;               // pedido que este cadete tiene en cola (para avisar cuando sale)
const rechazadas = new Map();      // id_pedido -> momento (no reabrir una oferta ya respondida)

export function iniciarColaCadete(idCad) {
  const id = Number(idCad);
  if (!id) return;
  idCadete = id;
  obtenerComision().then(c => { if (Number.isFinite(c)) comision = c; }).catch(() => {});
  if (temporizador) clearInterval(temporizador);
  temporizador = setInterval(revisar, INTERVALO_MS);
  revisar();
}

export function detenerColaCadete() {
  if (temporizador) clearInterval(temporizador);
  temporizador = null;
  idCadete = null;
  idEnCola = null;
  cerrarHoja();
  pintarCartel(null);
}

async function revisar() {
  if (!idCadete || consultando) return;
  consultando = true;
  try {
    const { data, error } = await supabase
      .from('Pedidos')
      .select('id_pedido, estado_pedido, inform_pedido, tipo_paquete, coste_pedido, oferta_vence_en')
      .eq('id_cadete', idCadete)
      .in('estado_pedido', [...ESTADOS_VIAJE, ...ESTADOS_OFERTA, 'en_cola']);
    if (error || !idCadete) return;

    const filas = data || [];
    const viaje = filas.find(p => ESTADOS_VIAJE.includes(p.estado_pedido));
    const oferta = filas.find(p => ESTADOS_OFERTA.includes(p.estado_pedido));
    const enCola = filas.find(p => p.estado_pedido === 'en_cola');

    pintarCartel(enCola || null);
    // El pedido salió de la cola: o ya es su viaje (terminó el anterior) o se canceló / pasó a otro cadete
    const idAhora = enCola ? Number(enCola.id_pedido) : null;
    if (idEnCola && idEnCola !== idAhora) {
      const yaEsSuViaje = viaje && Number(viaje.id_pedido) === idEnCola;
      avisar(yaEsSuViaje
        ? `El pedido #${idEnCola} que tenías en cola ya es tu viaje.`
        : `El pedido #${idEnCola} salió de tu cola (se canceló o pasó a otro cadete).`);
    }
    idEnCola = idAhora;

    if (ofertaAbierta) {
      // La oferta dejó de ser para este cadete (venció, la canceló el cliente): cerrar sin responder
      if (!respondiendo && (!oferta || Number(oferta.id_pedido) !== Number(ofertaAbierta.id_pedido))) cerrarHoja();
      return;
    }
    if (viaje && oferta && !fueRespondida(oferta.id_pedido)) abrirHoja(oferta);
  } catch (err) {
    console.warn('[Cola] No se pudo consultar la cola, se reintenta:', err);
  } finally {
    consultando = false;
  }
}

function fueRespondida(idPedido) {
  const momento = rechazadas.get(Number(idPedido));
  if (momento === undefined) return false;
  if (Date.now() - momento > TTL_RECHAZO_MS) {
    rechazadas.delete(Number(idPedido));
    return false;
  }
  return true;
}

// -------------------------------------------------------------------------
// HOJA "SIGUIENTE PEDIDO"
// -------------------------------------------------------------------------
function abrirHoja(pedido) {
  const vence = pedido.oferta_vence_en ? new Date(pedido.oferta_vence_en).getTime() : NaN;
  const restante = Number.isFinite(vence) ? Math.floor((vence - Date.now()) / 1000) - MARGEN_VENCIMIENTO_S : SEGUNDOS_MODAL;
  const segundos = Math.min(SEGUNDOS_MODAL, restante);
  if (segundos < 3) return; // ya casi vence: no vale la pena mostrarla

  ofertaAbierta = pedido;
  const total = Number(pedido.coste_pedido) || 0;
  const ganancia = repartir(total, comision).cadete;
  const titulo = (pedido.inform_pedido || 'Pedido').split('-')[0].trim() || 'Pedido';

  const fondo = document.createElement('div');
  fondo.id = 'colaCadeteHoja';
  fondo.setAttribute('role', 'dialog');
  fondo.setAttribute('aria-modal', 'true');
  fondo.setAttribute('aria-label', 'Siguiente pedido');
  fondo.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.72);font-family:inherit;';

  const hoja = document.createElement('div');
  hoja.style.cssText = 'width:100%;max-width:480px;background:#111318;border:1px solid #262C3A;border-bottom:0;border-radius:24px 24px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom));color:#fff;box-shadow:0 -12px 40px rgba(0,0,0,.6);';

  const barra = document.createElement('div');
  barra.style.cssText = 'height:6px;border-radius:999px;background:#262C3A;overflow:hidden;margin-bottom:16px;';
  const avance = document.createElement('div');
  avance.style.cssText = `height:100%;width:100%;background:#FFC800;transition:width ${segundos}s linear;`;
  barra.append(avance);

  const etiqueta = document.createElement('p');
  etiqueta.textContent = 'SIGUIENTE PEDIDO · PARA CUANDO TERMINES ESTE VIAJE';
  etiqueta.style.cssText = 'margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:.06em;color:#FFC800;';

  const nombre = document.createElement('h2');
  nombre.textContent = titulo;
  nombre.style.cssText = 'margin:0;font-size:22px;font-weight:800;line-height:1.2;';

  const resumen = document.createElement('p');
  resumen.textContent = [`Orden #${pedido.id_pedido}`, pedido.tipo_paquete].filter(Boolean).join(' • ');
  resumen.style.cssText = 'margin:4px 0 14px;font-size:14px;color:#9CA3AF;';

  const montos = document.createElement('div');
  montos.style.cssText = 'display:flex;gap:10px;margin-bottom:8px;';
  montos.append(
    crearDato('Ganás', `$${ganancia.toLocaleString('es-AR')}`, '#00E58F'),
    crearDato('Cobrar en efectivo', `$${total.toLocaleString('es-AR')}`, '#fff')
  );

  const nota = document.createElement('p');
  nota.textContent = 'Es el pedido que te queda más cerca de donde vas a entregar. Si aceptás, queda en tu cola y empieza apenas termines.';
  nota.style.cssText = 'margin:0 0 16px;font-size:13px;line-height:1.4;color:#9CA3AF;';

  const botones = document.createElement('div');
  botones.style.cssText = 'display:flex;gap:10px;';
  const btnRechazar = crearBoton('Rechazar', 'flex:1;background:#1C2029;border:1px solid #262C3A;color:#fff;');
  const btnAceptar = crearBoton('Aceptar', 'flex:2;background:#00E58F;border:0;color:#000;');
  btnRechazar.addEventListener('click', () => responder(false));
  btnAceptar.addEventListener('click', () => responder(true));
  botones.append(btnRechazar, btnAceptar);

  hoja.append(barra, etiqueta, nombre, resumen, montos, nota, botones);
  fondo.append(hoja);
  document.body.append(fondo);
  requestAnimationFrame(() => requestAnimationFrame(() => { avance.style.width = '0%'; }));

  if ('vibrate' in navigator) navigator.vibrate([200, 100, 200, 100, 400]);
  clearTimeout(temporizadorOferta);
  temporizadorOferta = setTimeout(() => responder(false), segundos * 1000);

  // Marcar la oferta como vista; si ya no es de este cadete, cerrar
  supabase.rpc('cadete_ver_oferta', { p_id_pedido: Number(pedido.id_pedido), p_id_cad: idCadete })
    .then(({ data: vigente, error }) => {
      if (!error && !vigente && ofertaAbierta && Number(ofertaAbierta.id_pedido) === Number(pedido.id_pedido) && !respondiendo) {
        cerrarHoja();
      }
    });
}

function crearDato(etiqueta, valor, color) {
  const caja = document.createElement('div');
  caja.style.cssText = 'flex:1;background:#1C2029;border:1px solid #262C3A;border-radius:14px;padding:10px 12px;';
  const e = document.createElement('p');
  e.textContent = etiqueta;
  e.style.cssText = 'margin:0;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.04em;';
  const v = document.createElement('p');
  v.textContent = valor;
  v.style.cssText = `margin:2px 0 0;font-size:20px;font-weight:800;color:${color};`;
  caja.append(e, v);
  return caja;
}

function crearBoton(texto, estilo) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = texto;
  btn.style.cssText = `${estilo}min-height:56px;border-radius:999px;font-size:15px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;cursor:pointer;font-family:inherit;`;
  return btn;
}

function cerrarHoja() {
  clearTimeout(temporizadorOferta);
  temporizadorOferta = null;
  ofertaAbierta = null;
  respondiendo = false;
  document.getElementById('colaCadeteHoja')?.remove();
}

async function responder(acepta) {
  if (!ofertaAbierta || respondiendo) return;
  respondiendo = true;
  clearTimeout(temporizadorOferta);
  const idPedido = Number(ofertaAbierta.id_pedido);
  const idCad = idCadete;
  // Se anota antes de esperar al servidor: mientras responde, el pedido sigue a nombre de este cadete
  // y la próxima consulta volvería a abrir la hoja
  rechazadas.set(idPedido, Date.now());
  document.getElementById('colaCadeteHoja')?.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '.6'; });

  try {
    if (!acepta) {
      const { error } = await supabase.rpc('cadete_rechazar_pedido', { p_id_pedido: idPedido, p_id_cad: idCad });
      if (error) throw error;
      cerrarHoja();
      return;
    }

    const { data: respuesta, error } = await supabase.rpc('cadete_aceptar_pedido', { p_id_pedido: idPedido, p_id_cad: idCad });
    if (error) throw error;
    cerrarHoja();

    if (respuesta?.ok && respuesta.en_cola) {
      pintarCartel(respuesta.pedido);
      avisar(`Pedido #${idPedido} en tu cola: empieza apenas termines este viaje.`);
    } else if (respuesta?.ok) {
      // El viaje anterior terminó justo antes de aceptar: este pedido ya es el viaje actual
      avisar(`Pedido #${idPedido} aceptado. Abrilo desde el inicio.`);
      if (!window.location.pathname.toLowerCase().includes('dashboard')) {
        window.location.href = `dashboard.html?id_cad=${idCad}`;
      } else {
        window.location.reload();
      }
    } else {
      avisar(`El pedido #${idPedido} ya no estaba disponible.`);
    }
  } catch (err) {
    console.error('[Cola] Error respondiendo la oferta:', err);
    cerrarHoja();
    avisar('No pudimos registrar tu respuesta. Si la oferta sigue vigente, va a volver a aparecer.');
    rechazadas.delete(idPedido);
  }
}

// -------------------------------------------------------------------------
// CARTEL "TENÉS UN PEDIDO EN COLA" Y AVISOS
// -------------------------------------------------------------------------
function pintarCartel(pedido) {
  let cartel = document.getElementById('colaCadeteCartel');
  if (!pedido) {
    cartel?.remove();
    return;
  }
  if (!cartel) {
    cartel = document.createElement('div');
    cartel.id = 'colaCadeteCartel';
    cartel.setAttribute('role', 'status');
    cartel.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(8px + env(safe-area-inset-top));z-index:99990;max-width:calc(100% - 24px);padding:8px 14px;border-radius:999px;background:#FFC800;color:#000;font-size:13px;font-weight:800;box-shadow:0 6px 20px rgba(0,0,0,.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;';
    document.body.append(cartel);
  }
  const texto = `Siguiente en tu cola: pedido #${pedido.id_pedido}`;
  if (cartel.textContent !== texto) cartel.textContent = texto;
}

function avisar(texto) {
  document.getElementById('colaCadeteAviso')?.remove();
  const aviso = document.createElement('div');
  aviso.id = 'colaCadeteAviso';
  aviso.setAttribute('role', 'status');
  aviso.textContent = texto;
  aviso.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:99995;margin:0 auto;max-width:456px;padding:14px 16px;border-radius:16px;background:#1C2029;border:1px solid #262C3A;color:#fff;font-size:14px;font-weight:600;line-height:1.35;box-shadow:0 10px 30px rgba(0,0,0,.55);';
  document.body.append(aviso);
  setTimeout(() => aviso.remove(), 6000);
}
