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
              bg: '#0E1118',
              surface: '#161B26',
              surfaceLight: '#1F2635',
              accent: '#00E58F',
              accentHover: '#00C77B',
              accentGlow: 'rgba(0, 229, 143, 0.25)',
              danger: '#FF4D4D',
              dangerGlow: 'rgba(255, 77, 77, 0.25)',
              warning: '#FFB800',
              textMuted: '#8E9AA8',
              border: '#283044'
            }
          }
        }
      }
    };

module.exports = { content: ["./Templates/dashboard.html", "./Scripts/*.js"], ...tema };
