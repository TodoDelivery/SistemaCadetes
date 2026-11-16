// Tema de Tailwind de esta app (antes estaba dentro de cada página, para el CDN).
// Después de cambiarlo, o de agregar clases nuevas en el HTML o el JS: npm run css
const tema = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Plus Jakarta Sans"', 'sans-serif'],
          },
          colors: {
            brand: {
              black: '#000000',
              surface: '#111318',
              surfaceLight: '#1C2029',
              accent: '#00E58F',
              accentDark: '#00B36B',
              warning: '#FFC800',
              danger: '#FF3B30',
              textMuted: '#9CA3AF',
              border: '#262C3A'
            }
          }
        }
      }
    };

module.exports = { content: ["./Templates/pedido_activo.html", "./Scripts/*.js"], ...tema };
