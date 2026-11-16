// =========================================================================
// MAPA COMPARTIDO DE LA APP DE CADETES (MapLibre)
// =========================================================================
// Lo usan la pantalla del viaje (pedido_activo.html), la oferta de pedido nuevo (dashboard.html) y la oferta
// de "siguiente pedido" en cola (cola_cadete.js). Necesita maplibre-gl cargado en la página y
// Styles/mapa_td.css para los pines.
//   * cargarEstiloMapa(): estilo oscuro vectorial (OpenFreeMap, sin clave) con la paleta de la app;
//     si no carga, los mosaicos de OpenStreetMap oscurecidos.
//   * crearPin(): pin del local o del cliente (el texto va como texto, nunca como HTML).
//   * Ruta: rutaOSRM() pide el recorrido por calles; ponerRuta() la dibuja con brillo debajo de los nombres.
//   * Oferta: crearMapaOferta() + mostrarOfertaEnMapa() arman el mapa chico, inclinado y quieto de las ofertas.

const ESTILO_VECTORIAL = 'https://tiles.openfreemap.org/styles/dark';

// Respaldo si el estilo vectorial no carga: los mosaicos de OpenStreetMap de antes, oscurecidos
const ESTILO_RASTER = {
  version: 8,
  sources: {
    osm: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
    }
  },
  layers: [
    { id: 'fondo', type: 'background', paint: { 'background-color': '#0B0E14' } },
    {
      id: 'osm', type: 'raster', source: 'osm',
      paint: { 'raster-brightness-min': 0.85, 'raster-brightness-max': 0.08, 'raster-hue-rotate': 200, 'raster-saturation': -0.75, 'raster-contrast': 0.1 }
    }
  ]
};

// Lleva el estilo oscuro a la paleta de la app: calles más visibles y nombres en español
function adaptarEstilo(estilo) {
  const colores = {
    background: { 'background-color': '#0B0E14' },
    water: { 'fill-color': '#0E1A26' },
    waterway: { 'line-color': '#0E1A26' },
    landuse_residential: { 'fill-color': '#0E121A' },
    landcover_wood: { 'fill-color': '#0D1714' },
    landuse_park: { 'fill-color': '#0D1714' },
    building: { 'fill-color': '#151A24', 'fill-outline-color': '#1E2533' },
    highway_path: { 'line-color': '#1A202C' },
    highway_minor: { 'line-color': '#252C3A' },
    highway_major_casing: { 'line-color': '#3A4458' },
    highway_major_inner: { 'line-color': '#2C3444' },
    highway_major_subtle: { 'line-color': '#2C3444' },
    highway_motorway_casing: { 'line-color': '#46536B' },
    highway_motorway_inner: { 'line-color': '#36405A' },
    highway_motorway_subtle: { 'line-color': '#2C3444' },
    highway_name_other: { 'text-color': '#8E9AA8', 'text-halo-color': '#0B0E14', 'text-halo-width': 1.4 },
    highway_name_motorway: { 'text-color': '#A7B1BE', 'text-halo-color': '#0B0E14', 'text-halo-width': 1.4 }
  };
  const nombre = ['coalesce', ['get', 'name:es'], ['get', 'name'], ['get', 'name_en']];
  for (const capa of estilo.layers || []) {
    if (colores[capa.id]) capa.paint = { ...capa.paint, ...colores[capa.id] };
    if (capa.type !== 'symbol' || !capa.layout?.['text-field']) continue;
    if (/^(place_|highway_name|water_name)/.test(capa.id)) capa.layout['text-field'] = nombre;
    if (capa.id === 'highway_name_other') capa.layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 13];
    if (capa.id.startsWith('place_')) capa.paint = { ...capa.paint, 'text-color': '#9CA3AF', 'text-halo-color': '#0B0E14' };
  }
  return estilo;
}

// Se pide una sola vez por página; cada mapa recibe su propia copia (MapLibre no debe compartir el objeto)
let estiloPromesa = null;
export async function cargarEstiloMapa() {
  if (!estiloPromesa) {
    estiloPromesa = (async () => {
      try {
        const ctrl = new AbortController();
        const corte = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(ESTILO_VECTORIAL, { signal: ctrl.signal });
        clearTimeout(corte);
        if (res.ok) return adaptarEstilo(await res.json());
      } catch (e) {
        console.warn('[Mapa] Estilo vectorial no disponible, uso OSM raster:', e);
      }
      estiloPromesa = null; // el próximo mapa vuelve a intentar el vectorial
      return ESTILO_RASTER;
    })();
  }
  return structuredClone(await estiloPromesa);
}

// Pin del local ('local') o del cliente ('cliente'). Devuelve la raíz (para el Marker) y el pin (para estilos)
export function crearPin(tipo, emoji, texto) {
  const raiz = document.createElement('div');
  raiz.innerHTML = `
    <div class="td-pin td-pin--${tipo}">
      <span class="td-pin__etiqueta"></span>
      <div class="td-pin__cabeza"><span>${emoji}</span></div>
      <i class="td-pin__onda"></i>
    </div>`;
  const pin = raiz.firstElementChild;
  pin.querySelector('.td-pin__etiqueta').textContent = texto;
  return { raiz, pin };
}

// ---------------- Ruta ----------------
// Recorrido por calles entre dos puntos ({lat, lng}). Devuelve [[lng, lat], ...] o null si no hay servicio
export async function rutaOSRM(origen, destino) {
  const url = `https://router.project-osrm.org/route/v1/driving/${origen.lng},${origen.lat};${destino.lng},${destino.lat}?overview=full&geometries=geojson`;
  try {
    const ctrl = new AbortController();
    const corte = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(corte);
    if (!res.ok) return null;
    const data = await res.json();
    const ruta = data?.routes?.[0];
    return ruta ? { coordinates: ruta.geometry.coordinates, distance: ruta.distance, duration: ruta.duration } : null;
  } catch {
    return null;
  }
}

// Encima de todas las calles y debajo de los nombres, para que se sigan leyendo
function capaAntesDeEtiquetas(map) {
  const capas = map.getStyle().layers;
  const ultimaCalle = capas.findLastIndex(l => l.type !== 'symbol' && /transportation|building/.test(l['source-layer'] || ''));
  return capas.slice(ultimaCalle + 1).find(l => l.type === 'symbol')?.id;
}

// Dibuja (o reemplaza) la ruta [[lng, lat], ...] con borde oscuro y brillo del color indicado
export function ponerRuta(map, coordenadas, color = '#00E58F', id = 'ruta') {
  const datos = {
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: coordenadas || [] }
  };
  if (map.getSource(id)) {
    map.getSource(id).setData(datos);
  } else {
    const antes = capaAntesDeEtiquetas(map);
    const ancho = (a, b) => ['interpolate', ['linear'], ['zoom'], 12, a, 18, b];
    const layout = { 'line-join': 'round', 'line-cap': 'round' };
    map.addSource(id, { type: 'geojson', data: datos });
    map.addLayer({ id: `${id}-brillo`, type: 'line', source: id, layout, paint: { 'line-color': color, 'line-width': ancho(12, 26), 'line-blur': 10, 'line-opacity': 0.3 } }, antes);
    map.addLayer({ id: `${id}-borde`, type: 'line', source: id, layout, paint: { 'line-color': '#000000', 'line-width': ancho(7, 15), 'line-opacity': 0.7 } }, antes);
    map.addLayer({ id: `${id}-linea`, type: 'line', source: id, layout, paint: { 'line-color': color, 'line-width': ancho(4, 9) } }, antes);
  }
  [`${id}-linea`, `${id}-brillo`].forEach(capa => map.getLayer(capa) && map.setPaintProperty(capa, 'line-color', color));
}

// ---------------- Mapa chico de las ofertas ----------------
// Mapa para mostrar retiro → entrega: quieto en las ofertas, con gestos (mover, girar, inclinar) en el
// historial. Devuelve null si no hay MapLibre o WebGL
export async function crearMapaOferta(contenedor, { interactivo = false } = {}) {
  if (typeof maplibregl === 'undefined' || !contenedor) return null;
  const estilo = await cargarEstiloMapa();
  try {
    const map = new maplibregl.Map({
      container: contenedor,
      style: estilo,
      center: [-68.5364, -31.5375],
      zoom: 13,
      interactive: interactivo,
      maxPitch: 65,
      attributionControl: false,
      fadeDuration: 0
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    // Los créditos quedan plegados en la "i" (abiertos tapaban la parte de abajo del mapa chico)
    map.once('idle', () => contenedor.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show'));
    map._tdPines = [];
    if (!map.loaded()) await new Promise(r => map.once('load', r));
    return map;
  } catch (e) {
    console.warn('[Mapa] No se pudo crear el mapa de la oferta:', e);
    return null;
  }
}

// Encuadra retiro y entrega. Con 'bajada', la cámara arranca alta y girada y "aterriza" inclinada
export function encuadrarRecorrido(map, { pitch = 50, bajada = false, duracion = 900 } = {}) {
  const caja = map?._tdCaja;
  if (!caja) return;
  map.resize();
  const camara = map.cameraForBounds(caja, { padding: { top: 60, bottom: 30, left: 50, right: 50 } });
  const zoom = Math.min(16, (camara?.zoom ?? 15) - (pitch ? 0.5 : 0));
  const centro = camara?.center ?? caja.getCenter();
  map.stop();
  if (bajada) map.jumpTo({ center: centro, zoom: zoom - 1.3, pitch: 0, bearing: -25 });
  map.easeTo({ center: centro, zoom, pitch, bearing: 0, duration: bajada ? 1800 : duracion, easing: t => 1 - Math.pow(1 - t, 3) });
}

// Pone los pines, encuadra con la "bajada" de cámara y después dibuja la ruta por calles.
// Devuelve una promesa con la ruta por calles (o null si no hubo servicio / no hay retiro)
export function mostrarOfertaEnMapa(map, pedido, { color = '#00E58F', nombreLocal = 'Local', nombreCliente = 'Cliente', pitch = 50 } = {}) {
  if (!map || !pedido) return Promise.resolve(null);
  const dest = { lat: Number(pedido.latitud_dest) || -31.5390, lng: Number(pedido.longitud_dest) || -68.5320 };
  const orgLat = Number(pedido.latitud_org), orgLng = Number(pedido.longitud_org);
  const org = orgLat && orgLng ? { lat: orgLat, lng: orgLng } : null;

  map._tdPines.forEach(m => m.remove());
  map._tdPines = [];
  const local = org && crearPin('local', '🏪', nombreLocal);
  const cliente = crearPin('cliente', '🏠', nombreCliente);
  if (local) map._tdPines.push(new maplibregl.Marker({ element: local.raiz, anchor: 'bottom' }).setLngLat([org.lng, org.lat]).addTo(map));
  map._tdPines.push(new maplibregl.Marker({ element: cliente.raiz, anchor: 'bottom' }).setLngLat([dest.lng, dest.lat]).addTo(map));

  // Línea recta mientras llega la ruta real
  ponerRuta(map, org ? [[org.lng, org.lat], [dest.lng, dest.lat]] : [], color);

  // Cámara: arranca alta y girada, y "aterriza" inclinada sobre el recorrido
  map._tdCaja = new maplibregl.LngLatBounds([dest.lng, dest.lat], [dest.lng, dest.lat]);
  if (org) map._tdCaja.extend([org.lng, org.lat]);
  encuadrarRecorrido(map, { pitch, bajada: true });

  if (!org) return Promise.resolve(null);
  const pedidoId = pedido.id_pedido;
  map._tdPedido = pedidoId;
  return rutaOSRM(org, dest).then(ruta => {
    if (map._tdPedido !== pedidoId) return null; // ya se mostró otro pedido
    if (ruta && map.getStyle()) {
      ponerRuta(map, ruta.coordinates, color);
      ruta.coordinates.forEach(c => map._tdCaja.extend(c)); // la ruta real puede salirse de la caja
    }
    return ruta;
  });
}

// ---------------- Dirección de un punto (para no mostrar coordenadas) ----------------
// Los pedidos guardan solo latitud/longitud. Se traduce a "Calle 123" con Nominatim (OpenStreetMap), igual que
// la app de clientes: como mucho una consulta por segundo (lo pide Nominatim) y memoria por punto.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const direcciones = new Map();   // "lat,lng" -> promesa de { titulo, zona } | null
let proximaConsulta = 0;

export function direccionDePunto(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) || !Number(lat) || !Number(lng)) return Promise.resolve(null);
  const clave = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
  if (!direcciones.has(clave)) {
    const promesa = (async () => {
      const ahora = Date.now();
      const turno = Math.max(ahora, proximaConsulta);
      proximaConsulta = turno + 1100;
      if (turno > ahora) await new Promise(r => setTimeout(r, turno - ahora));
      try {
        const query = new URLSearchParams({ format: 'jsonv2', 'accept-language': 'es', lat, lon: lng, zoom: 18, addressdetails: 1 });
        const res = await fetch(`${NOMINATIM_URL}?${query}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Nominatim respondió ${res.status}`);
        const r = await res.json();
        const a = r?.address || {};
        const calle = [a.road || a.pedestrian || a.footway || a.path, a.house_number].filter(Boolean).join(' ');
        const lugar = r?.name && r.name !== a.road ? r.name : '';
        const titulo = lugar || calle || (r?.display_name || '').split(',')[0].trim();
        const zona = [lugar ? calle : '', a.suburb || a.neighbourhood || a.city_district, a.city || a.town || a.village]
          .filter(Boolean).filter((v, i, l) => l.indexOf(v) === i).join(', ');
        return titulo ? { titulo, zona } : null;
      } catch (e) {
        direcciones.delete(clave); // con la red caída, la próxima vez se reintenta
        return null;
      }
    })();
    direcciones.set(clave, promesa);
  }
  return direcciones.get(clave);
}

// Pone en el elemento la dirección del punto (nunca las coordenadas). Ignora respuestas viejas si el
// elemento ya muestra otro pedido (data-td-punto)
export function mostrarDireccion(el, lat, lng, { sinDatos = 'Sin ubicación guardada' } = {}) {
  if (!el) return;
  const punto = `${lat},${lng}`;
  el.dataset.tdPunto = punto;
  if (!Number(lat) || !Number(lng)) {
    el.textContent = sinDatos;
    return;
  }
  el.textContent = 'Buscando la dirección…';
  direccionDePunto(lat, lng).then(d => {
    if (el.dataset.tdPunto !== punto) return;
    el.textContent = d ? [d.titulo, d.zona].filter(Boolean).join(' · ') : 'Marcado en el mapa';
  });
}
