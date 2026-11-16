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
import { mostrarDireccion } from './mapa_td.js';

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
      .select('id_pedido, estado_pedido, inform_pedido, tipo_paquete, coste_pedido, oferta_vence_en, latitud_org, longitud_org, latitud_dest, longitud_dest')
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
// Misma estética que la oferta del dashboard (tarjeta flotante, mapa 3D, anillo de tiempo), en amarillo
// porque es para después. Los estilos van en una hoja propia que se inyecta una sola vez.
const ESTILOS_COLA = `
#colaCadeteHoja { position: fixed; inset: 0; z-index: 99999; display: flex; align-items: flex-end; justify-content: center;
  background: rgba(0, 0, 0, .7); font-family: inherit; animation: colaVelo .3s ease-out both; }
#colaCadeteHoja.saliendo, .cola-hoja-saliendo { animation: colaVeloFuera .25s ease-in both; pointer-events: none; }
.cola-card { width: calc(100% - 24px); max-width: 456px; margin: 0 12px max(12px, env(safe-area-inset-bottom));
  max-height: calc(100dvh - 24px); display: flex; flex-direction: column; overflow: hidden; color: #fff;
  background: #13161D; border: 1px solid rgba(255, 255, 255, .09); border-radius: 28px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, .7), inset 0 1px 0 rgba(255, 255, 255, .04);
  animation: colaSube .5s cubic-bezier(.16, 1, .3, 1) both; }
.cola-hoja-saliendo .cola-card { animation: colaBaja .25s ease-in both; }
.cola-mapa { position: relative; height: 150px; flex-shrink: 0; background: #0B0E14; }
@media (max-height: 680px) { .cola-mapa { height: 116px; } }
.cola-mapa::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 44px; pointer-events: none;
  background: linear-gradient(to bottom, rgba(19, 22, 29, 0), #13161D); }
.cola-mapa--sin { height: 64px; }
.cola-mapa > .cola-lienzo { position: absolute; inset: 0; }
.cola-chip { position: absolute; top: 12px; left: 12px; z-index: 2; display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 11px; border-radius: 999px; background: rgba(17, 19, 24, .92); border: 1px solid rgba(255, 200, 0, .4);
  color: #FFC800; font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.cola-chip i { width: 7px; height: 7px; border-radius: 999px; background: currentColor; position: relative; }
.cola-chip i::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: currentColor; animation: colaLatido 1.4s ease-out infinite; }
.cola-anillo { position: absolute; top: 10px; right: 10px; z-index: 2; width: 46px; height: 46px; }
.cola-anillo svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.cola-anillo circle { fill: rgba(17, 19, 24, .92); stroke-width: 3.5; }
.cola-anillo .pista { stroke: #262C3A; }
.cola-anillo .avance { fill: none; stroke: #FFC800; stroke-linecap: round; stroke-dasharray: 100.53; stroke-dashoffset: 0;
  animation: colaAnillo var(--cola-s, 15s) linear forwards; transition: stroke .3s; }
.cola-anillo.urgente .avance { stroke: #FF3B30; }
.cola-anillo span { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 900; color: #fff; }
.cola-anillo.urgente span { color: #FF6B60; }
.cola-cuerpo { padding: 2px 18px 0; overflow-y: auto; min-height: 0; flex: 1; }
.cola-cuerpo > * + * { margin-top: 14px; }
.cola-titulo { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.cola-titulo h2 { margin: 0; font-size: 20px; font-weight: 900; line-height: 1.2; word-break: break-word; }
.cola-titulo p { margin: 4px 0 0; font-size: 12px; font-weight: 700; color: #9CA3AF; }
.cola-ganancia { text-align: right; flex-shrink: 0; }
.cola-ganancia b { display: block; font-size: 26px; line-height: 1; font-weight: 900; color: #00E58F; white-space: nowrap; }
.cola-ganancia small { display: block; margin-top: 4px; font-size: 10px; font-weight: 800; color: #8E9AA8; text-transform: uppercase; }
.cola-datos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.cola-dato { background: #1C2029; border: 1px solid rgba(255, 255, 255, .05); border-radius: 16px; padding: 9px 12px; }
.cola-dato small { display: block; font-size: 10px; font-weight: 800; color: #8E9AA8; text-transform: uppercase; letter-spacing: .05em; }
.cola-dato b { display: block; margin-top: 2px; font-size: 15px; font-weight: 900; white-space: nowrap; }
.cola-recorrido { position: relative; padding-left: 22px; }
.cola-recorrido::before { content: ''; position: absolute; left: 5px; top: 8px; bottom: 8px; width: 2px; background: linear-gradient(#00E58F, #FFC800); opacity: .45; border-radius: 2px; }
.cola-parada { position: relative; }
.cola-parada + .cola-parada { margin-top: 10px; }
.cola-parada::before { content: ''; position: absolute; left: -22px; top: 4px; width: 12px; height: 12px; border-radius: 999px; border: 3px solid #13161D; background: #00E58F; box-shadow: 0 0 0 1.5px #00E58F; }
.cola-parada--entrega::before { background: #FFC800; box-shadow: 0 0 0 1.5px #FFC800; }
.cola-parada small { display: block; font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #00E58F; }
.cola-parada--entrega small { color: #FFC800; }
.cola-parada p { margin: 1px 0 0; font-size: 13px; font-weight: 700; color: #fff; word-break: break-word; }
.cola-nota { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 16px;
  background: rgba(255, 200, 0, .07); border: 1px solid rgba(255, 200, 0, .18); color: #D1D5DB; font-size: 12px; line-height: 1.45; font-weight: 600; }
.cola-nota span { color: #FFC800; font-size: 15px; line-height: 1.1; }
.cola-botones { display: grid; grid-template-columns: 1fr 1.6fr; gap: 10px; padding: 16px 18px 18px; flex-shrink: 0; }
.cola-boton { position: relative; overflow: hidden; height: 56px; border-radius: 999px; font-family: inherit; font-size: 13px; font-weight: 900;
  letter-spacing: .05em; text-transform: uppercase; cursor: pointer; transition: transform .15s, opacity .2s; }
.cola-boton:active { transform: scale(.96); }
.cola-boton:disabled { opacity: .6; }
.cola-boton--no { background: #1C2029; border: 1px solid rgba(255, 255, 255, .08); color: #9CA3AF; }
.cola-boton--si { background: #00E58F; border: 0; color: #04140D; box-shadow: 0 10px 26px rgba(0, 229, 143, .25); }
.cola-boton--si > span { position: relative; }
.cola-boton--si > i { position: absolute; inset: 0; background: rgba(255, 255, 255, .28); transform-origin: left;
  animation: colaTiempo var(--cola-s, 15s) linear forwards; }
.cola-paso { animation: colaPaso .5s cubic-bezier(.16, 1, .3, 1) both; animation-delay: calc(var(--i, 0) * 70ms + 120ms); }

#colaCadeteCartel { position: fixed; left: 50%; z-index: 99990; max-width: calc(100% - 24px);
  display: flex; align-items: center; gap: 8px; padding: 7px 14px 7px 7px; border-radius: 999px;
  background: rgba(17, 19, 24, .97); border: 1px solid rgba(255, 200, 0, .45); color: #fff;
  font-size: 12px; font-weight: 800; box-shadow: 0 10px 26px rgba(0, 0, 0, .5); white-space: nowrap; pointer-events: none;
  transform: translateX(-50%); animation: colaCartel .45s cubic-bezier(.34, 1.4, .64, 1) both; }
#colaCadeteCartel i { width: 24px; height: 24px; border-radius: 999px; background: #FFC800; color: #000; font-style: normal;
  display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; }
#colaCadeteCartel span { overflow: hidden; text-overflow: ellipsis; }
#colaCadeteCartel b { color: #FFC800; }

#colaCadeteAviso { position: fixed; left: 12px; right: 12px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 99995;
  margin: 0 auto; max-width: 456px; padding: 14px 16px; border-radius: 20px; background: #1C2029; border: 1px solid rgba(255, 255, 255, .09);
  color: #fff; font-size: 14px; font-weight: 600; line-height: 1.35; box-shadow: 0 14px 34px rgba(0, 0, 0, .6);
  animation: colaAviso .4s cubic-bezier(.16, 1, .3, 1) both; }
#colaCadeteAviso.saliendo { animation: colaAvisoFuera .25s ease-in both; }

@keyframes colaVelo { from { opacity: 0; } to { opacity: 1; } }
@keyframes colaVeloFuera { from { opacity: 1; } to { opacity: 0; } }
@keyframes colaSube { from { transform: translateY(calc(100% + 24px)); } to { transform: none; } }
@keyframes colaBaja { to { transform: translateY(40px); } }
@keyframes colaPaso { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes colaAnillo { from { stroke-dashoffset: 0; } to { stroke-dashoffset: 100.53; } }
@keyframes colaTiempo { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@keyframes colaLatido { 0% { transform: scale(1); opacity: .8; } 100% { transform: scale(3); opacity: 0; } }
@keyframes colaCartel { from { opacity: 0; transform: translate(-50%, -14px) scale(.9); } to { opacity: 1; transform: translateX(-50%); } }
@keyframes colaAviso { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@keyframes colaAvisoFuera { to { opacity: 0; transform: translateY(16px); } }
@media (prefers-reduced-motion: reduce) {
  #colaCadeteHoja, .cola-card, .cola-paso, .cola-chip i::after, #colaCadeteCartel, #colaCadeteAviso { animation: none !important; }
}`;

function asegurarEstilos() {
  if (document.getElementById('colaCadeteEstilos')) return;
  const estilos = document.createElement('style');
  estilos.id = 'colaCadeteEstilos';
  estilos.textContent = ESTILOS_COLA;
  document.head.append(estilos);
}

let mapaHoja = null;      // mapa 3D de la hoja (se destruye al cerrarla: libera la memoria de WebGL)
let cuentaHoja = null;

function abrirHoja(pedido) {
  const vence = pedido.oferta_vence_en ? new Date(pedido.oferta_vence_en).getTime() : NaN;
  const restante = Number.isFinite(vence) ? Math.floor((vence - Date.now()) / 1000) - MARGEN_VENCIMIENTO_S : SEGUNDOS_MODAL;
  const segundos = Math.min(SEGUNDOS_MODAL, restante);
  if (segundos < 3) return; // ya casi vence: no vale la pena mostrarla

  asegurarEstilos();
  ofertaAbierta = pedido;
  const total = Number(pedido.coste_pedido) || 0;
  const ganancia = repartir(total, comision).cadete;
  const titulo = (pedido.inform_pedido || 'Pedido').split('-')[0].trim() || 'Pedido';
  const conMapa = typeof maplibregl !== 'undefined';

  const fondo = document.createElement('div');
  fondo.id = 'colaCadeteHoja';
  fondo.setAttribute('role', 'dialog');
  fondo.setAttribute('aria-modal', 'true');
  fondo.setAttribute('aria-label', 'Siguiente pedido');
  fondo.style.setProperty('--cola-s', `${segundos}s`);
  // Todo lo que viene del pedido se pone como texto (textContent), nunca como HTML
  fondo.innerHTML = `
    <div class="cola-card">
      <div class="cola-mapa${conMapa ? '' : ' cola-mapa--sin'}">
        ${conMapa ? '<div class="cola-lienzo"></div>' : ''}
        <span class="cola-chip"><i></i>Siguiente pedido</span>
        <div class="cola-anillo" aria-label="Segundos para responder">
          <svg viewBox="0 0 36 36" aria-hidden="true"><circle class="pista" cx="18" cy="18" r="16"></circle><circle class="avance" cx="18" cy="18" r="16"></circle></svg>
          <span data-segundos>${segundos}</span>
        </div>
      </div>
      <div class="cola-cuerpo">
        <div class="cola-titulo cola-paso" style="--i:0">
          <div><h2 data-titulo></h2><p data-resumen></p></div>
          <div class="cola-ganancia"><b data-ganancia>$0</b><small>Ganás</small></div>
        </div>
        <div class="cola-datos cola-paso" style="--i:1">
          <div class="cola-dato"><small>Cobrar en efectivo</small><b data-total></b></div>
          <div class="cola-dato"><small>Empieza</small><b>Al terminar este</b></div>
        </div>
        <div class="cola-recorrido cola-paso" style="--i:2">
          <div class="cola-parada"><small>Retiro en local</small><p data-origen></p></div>
          <div class="cola-parada cola-parada--entrega"><small>Entrega al cliente</small><p data-destino></p></div>
        </div>
        <p class="cola-nota cola-paso" style="--i:3"><span>↪</span>Es el pedido que te queda más cerca de donde vas a entregar. Si aceptás, queda en tu cola y arranca apenas termines.</p>
      </div>
      <div class="cola-botones cola-paso" style="--i:4">
        <button type="button" class="cola-boton cola-boton--no" data-rechazar>Rechazar</button>
        <button type="button" class="cola-boton cola-boton--si" data-aceptar><i aria-hidden="true"></i><span>Aceptar</span></button>
      </div>
    </div>`;
  fondo.querySelector('[data-titulo]').textContent = titulo;
  fondo.querySelector('[data-resumen]').textContent = [`Orden #${pedido.id_pedido}`, pedido.tipo_paquete].filter(Boolean).join(' • ');
  fondo.querySelector('[data-total]').textContent = `$${total.toLocaleString('es-AR')}`;
  mostrarDireccion(fondo.querySelector('[data-origen]'), pedido.latitud_org, pedido.longitud_org);
  mostrarDireccion(fondo.querySelector('[data-destino]'), pedido.latitud_dest, pedido.longitud_dest);
  fondo.querySelector('[data-rechazar]').addEventListener('click', () => responder(false));
  fondo.querySelector('[data-aceptar]').addEventListener('click', () => responder(true));
  document.body.append(fondo);

  contarHasta(fondo.querySelector('[data-ganancia]'), ganancia);
  iniciarCuentaHoja(fondo.querySelector('.cola-anillo'), segundos);
  if (conMapa) mostrarMapaHoja(fondo.querySelector('.cola-lienzo'), pedido, titulo);

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

// El mapa compartido se carga recién acá: si la página no tiene MapLibre, la hoja funciona igual sin mapa
async function mostrarMapaHoja(lienzo, pedido, titulo) {
  try {
    const { crearMapaOferta, mostrarOfertaEnMapa } = await import('./mapa_td.js');
    const map = await crearMapaOferta(lienzo);
    if (!map) return;
    // La hoja se cerró (o cambió de oferta) mientras se armaba el mapa
    if (!lienzo.isConnected || !ofertaAbierta || Number(ofertaAbierta.id_pedido) !== Number(pedido.id_pedido)) {
      map.remove();
      return;
    }
    mapaHoja = map;
    mostrarOfertaEnMapa(map, pedido, { color: '#FFC800', nombreLocal: titulo });
  } catch (err) {
    console.warn('[Cola] Sin mapa para la oferta:', err);
  }
}

function iniciarCuentaHoja(anillo, segundos) {
  clearInterval(cuentaHoja);
  const numero = anillo.querySelector('[data-segundos]');
  const fin = Date.now() + segundos * 1000;
  const pintar = () => {
    const quedan = Math.max(0, Math.ceil((fin - Date.now()) / 1000));
    numero.textContent = quedan;
    anillo.classList.toggle('urgente', quedan <= 5);
    if (!quedan) clearInterval(cuentaHoja);
  };
  pintar();
  cuentaHoja = setInterval(pintar, 250);
}

// La ganancia "sube" hasta su valor al aparecer (menos de un segundo)
function contarHasta(el, valor) {
  const inicio = performance.now();
  const paso = (ahora) => {
    const t = Math.min(1, (ahora - inicio) / 700);
    el.textContent = `$${Math.round(valor * (1 - Math.pow(1 - t, 3))).toLocaleString('es-AR')}`;
    if (t < 1 && el.isConnected) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

function cerrarHoja() {
  clearTimeout(temporizadorOferta);
  temporizadorOferta = null;
  clearInterval(cuentaHoja);
  cuentaHoja = null;
  ofertaAbierta = null;
  respondiendo = false;
  if (mapaHoja) {
    mapaHoja.remove();
    mapaHoja = null;
  }
  const hoja = document.getElementById('colaCadeteHoja');
  if (!hoja) return;
  // Sale con animación; el id se libera ya, por si enseguida se abre otra
  hoja.removeAttribute('id');
  hoja.classList.add('cola-hoja-saliendo');
  setTimeout(() => hoja.remove(), 260);
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
  document.getElementById('colaCadeteHoja')?.querySelectorAll('button').forEach(b => { b.disabled = true; });

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
// En la pantalla del viaje el cartel va justo debajo del banner de navegación (no lo tapa)
function ubicarCartel(cartel) {
  const banner = document.getElementById('navBanner');
  const abajoDelBanner = banner && banner.offsetParent !== null ? banner.getBoundingClientRect().bottom + 10 : null;
  cartel.style.top = abajoDelBanner != null ? `${Math.round(abajoDelBanner)}px` : 'calc(10px + env(safe-area-inset-top))';
}

function pintarCartel(pedido) {
  let cartel = document.getElementById('colaCadeteCartel');
  if (!pedido) {
    cartel?.remove();
    return;
  }
  asegurarEstilos();
  if (!cartel) {
    cartel = document.createElement('div');
    cartel.id = 'colaCadeteCartel';
    cartel.setAttribute('role', 'status');
    cartel.innerHTML = '<i aria-hidden="true">⏭</i><span>Siguiente en tu cola: <b></b></span>';
    document.body.append(cartel);
  }
  ubicarCartel(cartel);
  const texto = `pedido #${pedido.id_pedido}`;
  const numero = cartel.querySelector('b');
  if (numero.textContent !== texto) numero.textContent = texto;
}

function avisar(texto) {
  asegurarEstilos();
  document.getElementById('colaCadeteAviso')?.remove();
  const aviso = document.createElement('div');
  aviso.id = 'colaCadeteAviso';
  aviso.setAttribute('role', 'status');
  aviso.textContent = texto;
  document.body.append(aviso);
  setTimeout(() => aviso.classList.add('saliendo'), 5700);
  setTimeout(() => aviso.remove(), 6000);
}
