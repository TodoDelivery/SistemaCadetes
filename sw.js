// Service worker de la app de cadetes. Solo recibe las notificaciones push: no guarda nada en caché
// ni intercepta pedidos, así que la app funciona igual que sin él. Vive en la raíz para cubrir todo el sitio.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// ---- Notificaciones push ---------------------------------------------------
// Las manda la Edge Function enviar-push (ver supabase/functions). Con { titulo, texto, url, tag, ocultarSiAbierta }.
// Si la pantalla del aviso ya está visible, no se muestra nada: la app ya lo está mostrando.
// La app de clientes tiene una copia de esta parte (su sw.js): cambiarlas juntas.
const ICONO_AVISO = 'images/icons/icon-192.png';

function mismaPantalla(urlVentana, destino) {
  return new URL(urlVentana).pathname === destino.pathname;
}

// Misma pantalla y mismos parámetros (id_pedido, id_cad), sin contar 'chat'
function mismoPedido(urlVentana, destino) {
  const ventana = new URL(urlVentana);
  if (ventana.pathname !== destino.pathname) return false;
  return [...destino.searchParams].every(([clave, valor]) => clave === 'chat' || ventana.searchParams.get(clave) === valor);
}

self.addEventListener('push', (event) => {
  let aviso = {};
  try {
    aviso = event.data ? event.data.json() : {};
  } catch {
    aviso = { texto: event.data ? event.data.text() : '' };
  }

  event.waitUntil((async () => {
    const destino = new URL(aviso.url || '/', self.location.origin);
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visibles = ventanas.filter(v => v.visibilityState === 'visible');
    const yaEnPantalla = aviso.ocultarSiAbierta
      ? visibles.length > 0
      : visibles.some(v => mismaPantalla(v.url, destino));
    if (yaEnPantalla) return;

    await self.registration.showNotification(aviso.titulo || 'Todo Delivery', {
      body: aviso.texto || '',
      tag: aviso.tag || undefined,
      renotify: Boolean(aviso.tag), // con la misma etiqueta reemplaza al anterior, pero vuelve a sonar
      icon: new URL(ICONO_AVISO, self.registration.scope).href,
      data: { url: destino.href }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = new URL(event.notification.data?.url || self.registration.scope);

  event.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Si esa pantalla ya está abierta con el mismo pedido, se trae al frente; si no, se abre
    const abierta = ventanas.find(v => mismoPedido(v.url, destino));
    if (abierta) return abierta.focus();
    return self.clients.openWindow(destino.href);
  })());
});
