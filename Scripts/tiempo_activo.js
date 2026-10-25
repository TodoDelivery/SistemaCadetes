// Tiempo activo del cadete: solo suma lo que registró al entregar (Pedidos.tiempo_pedido, en minutos).
// Si ningún pedido tiene tiempo cargado se muestra "—" en vez de estimar horas.

/** Minutos reales de una lista de pedidos */
export function minutosActivos(pedidos) {
  return (pedidos || []).reduce((acc, p) => acc + (Number(p.tiempo_pedido) || 0), 0);
}

/** "—", "25 min" o "1.5 hs" */
export function textoTiempoActivo(minutos) {
  const min = Math.round(Number(minutos) || 0);
  if (min <= 0) return '—';
  if (min < 60) return `${min} min`;
  return `${(min / 60).toFixed(1)} hs`;
}

/** Duración de un viaje, o "Sin registrar" si el cadete no la cargó */
export function textoDuracionViaje(pedido) {
  const min = Number(pedido?.tiempo_pedido) || 0;
  return min > 0 ? `${min} min` : 'Sin registrar';
}
