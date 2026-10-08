// Detecta pedidos entrantes en páginas que no tienen el modal de oferta (Rendición, Historial).
// Mantiene al cadete visible en la red local y, si le llega una oferta, lo lleva al dashboard, que
// la muestra (allí un verificador consulta la BD cada 3 s, así que la oferta aparece aunque el aviso
// en tiempo real ya haya pasado).
import { supabase } from './conexion_supabase.js';
import { iniciarSuscripcionesDashboard, desconectarSuscripcionesDashboard } from './conexion_rt_pedidos_entrantes.js';

const ESTADOS_OFERTA = ['libre', 'en_confirmacion'];
let redirigiendo = false;
let temporizadorBusqueda = null;

// Para cuando el cadete cierra sesión desde la página: deja de escuchar y de redirigir
export async function detenerAvisoPedidoEntrante() {
  redirigiendo = true;
  if (temporizadorBusqueda) clearInterval(temporizadorBusqueda);
  await desconectarSuscripcionesDashboard();
}

export async function iniciarAvisoPedidoEntrante(cadete) {
  const idCad = Number(cadete?.id_cad);
  if (!idCad) return;

  // Si el cadete finalizó su turno no debe recibir ofertas ni figurar conectado
  try {
    const { data } = await supabase.from('Cadetes').select('*').eq('id_cad', idCad).maybeSingle();
    if (!data || data.estado_cad === 'desconectado') return;
    cadete = { ...cadete, ...data };
  } catch (e) { /* sin red: se intenta igual */ }

  const irAlDashboard = () => {
    if (redirigiendo) return;
    redirigiendo = true;
    window.location.href = `dashboard.html?id_cad=${idCad}`;
  };

  await iniciarSuscripcionesDashboard(cadete, (pedido) => {
    if (pedido && ESTADOS_OFERTA.includes(String(pedido.estado_pedido)) && Number(pedido.id_cadete) === idCad) {
      irAlDashboard();
    }
  });

  // Respaldo: oferta que ya existía al abrir la página, o que no llegó por tiempo real
  const buscarOfertaPendiente = async () => {
    if (redirigiendo) return;
    try {
      const { data } = await supabase
        .from('Pedidos')
        .select('id_pedido')
        .eq('id_cadete', idCad)
        .in('estado_pedido', ESTADOS_OFERTA)
        .limit(1);
      if (data && data.length > 0) irAlDashboard();
    } catch (e) { /* se reintenta en el próximo ciclo */ }
  };
  buscarOfertaPendiente();
  temporizadorBusqueda = setInterval(buscarOfertaPendiente, 3000);
}
