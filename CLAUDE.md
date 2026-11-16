# Reglas de este repo

## Tailwind compilado (obligatorio)

Este repo usa Tailwind **compilado y commiteado**, no por CDN. Cada vez que se agregue, cambie o quite una clase de
Tailwind en un `.html` o `.js`, o se toque el tema en `tailwind/*.config.cjs`:

1. Correr `npm run css`.
2. Commitear `Styles/tailwind-*.css (ingreso, inicio, viaje y listas: una paleta por pantalla)` **en el mismo commit** que el cambio.

Si no se corre, la clase nueva queda sin estilo en producción. Escribir las clases completas (nunca `'bg-' + color`).
No editar a mano el CSS generado ni volver a agregar el `<script>` del CDN.

Más reglas del sistema en `../CLAUDE.md`.
