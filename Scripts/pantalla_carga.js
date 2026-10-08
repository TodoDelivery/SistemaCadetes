// Pantalla de carga a pantalla completa (estilos en línea: no depende de Tailwind ni de la página).
export function mostrarPantallaCarga(texto = 'Cargando...') {
  let overlay = document.getElementById('pantallaCargaCadete');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pantallaCargaCadete';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#090B10;color:#fff;font-family:system-ui,sans-serif;';
    overlay.innerHTML = `
      <style>@keyframes pcGiro{to{transform:rotate(360deg)}}</style>
      <div style="width:48px;height:48px;border-radius:50%;border:4px solid #1c2230;border-top-color:#00E58F;animation:pcGiro .8s linear infinite;"></div>
      <p id="pantallaCargaTexto" style="margin:0;font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;"></p>`;
    document.body.appendChild(overlay);
  }
  overlay.querySelector('#pantallaCargaTexto').textContent = texto;
  overlay.style.display = 'flex';
}

export function ocultarPantallaCarga() {
  const overlay = document.getElementById('pantallaCargaCadete');
  if (overlay) overlay.style.display = 'none';
}
