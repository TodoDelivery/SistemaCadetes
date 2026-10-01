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

const formatoPorcentaje = (n) => `${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })}%`;

/**
 * Escribe los porcentajes en los textos de la página:
 * [data-comision-empresa] -> "40%" y [data-comision-cadete] -> "60%"
 */
export function pintarComision(comision) {
  document.querySelectorAll('[data-comision-empresa]').forEach(el => { el.textContent = formatoPorcentaje(comision); });
  document.querySelectorAll('[data-comision-cadete]').forEach(el => { el.textContent = formatoPorcentaje(100 - comision); });
}
