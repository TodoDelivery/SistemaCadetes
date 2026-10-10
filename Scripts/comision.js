// =========================================================================
// COMISIÓN DE LA EMPRESA (Datos_cotiz.Porc_Comision)
// =========================================================================
// El porcentaje lo edita el administrador desde Dashboard-Admin (Ajustes). Es el % de cada pedido
// que el cadete rinde a la empresa; el resto es su ganancia. Se lee de la primera fila de Datos_cotiz.
import { supabase } from './conexion_supabase.js';

export const COMISION_POR_DEFECTO = 40;

/** Número entre 0 y 100; si el valor no sirve se usa el porcentaje por defecto */
export function normalizarComision(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : COMISION_POR_DEFECTO;
}

/** Porcentaje de comisión vigente. Si falla la consulta, devuelve el porcentaje por defecto. */
export async function obtenerComision() {
  try {
    const { data, error } = await supabase
      .from('Datos_cotiz')
      .select('Porc_Comision')
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return normalizarComision(data?.Porc_Comision);
  } catch (err) {
    console.warn('[Comisión] No se pudo leer Porc_Comision, se usa', COMISION_POR_DEFECTO + '%:', err);
    return COMISION_POR_DEFECTO;
  }
}

/** Reparto de un monto: { empresa } es lo que se rinde y { cadete } lo que se queda el cadete */
export function repartir(monto, comision) {
  const total = Number(monto) || 0;
  return {
    empresa: Math.round(total * comision / 100),
    cadete: Math.round(total * (100 - comision) / 100)
  };
}

/**
 * Mantiene la comisión al día mientras la página está abierta: la lee, la pinta en los textos y avisa
 * por onCambio(comision) cada vez que el admin la modifica en Ajustes.
 * Se entera por Realtime y, de respaldo (por si la tabla no emite cambios), al volver a la pestaña y cada minuto.
 */
export function seguirComision(onCambio) {
  let actual = null;
  const refrescar = async () => {
    const comision = await obtenerComision();
    pintarComision(comision);
    if (comision !== actual) {
      actual = comision;
      if (typeof onCambio === 'function') onCambio(comision);
    }
  };

  refrescar();
  supabase
    .channel('comision-datos-cotiz')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'Datos_cotiz' }, refrescar)
    .subscribe();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refrescar();
  });
  setInterval(refrescar, 60000);
}

const formatoPorcentaje = (n) => `${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })}%`;

/**
 * Escribe los porcentajes en los textos de la página:
 * [data-comision-empresa] -> "40%" y [data-comision-cadete] -> "60%"
 */
export function pintarComision(comision) {
  document.querySelectorAll('[data-comision-empresa]').forEach(el => { el.textContent = formatoPorcentaje(comision); });
  document.querySelectorAll('[data-comision-cadete]').forEach(el => { el.textContent = formatoPorcentaje(100 - comision); });
}
