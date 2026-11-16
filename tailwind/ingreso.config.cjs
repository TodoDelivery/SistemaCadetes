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
              bg: '#090B10',
              surface: '#121620',
              surfaceLight: '#1A202E',
              accent: '#00E58F',
              accentHover: '#00C77B',
              accentGlow: 'rgba(0, 229, 143, 0.25)',
              textMuted: '#8E9AA8',
              border: '#1F2636'
            }
          }
        }
      }
    };

module.exports = { content: ["./index.html", "./Scripts/*.js"], ...tema };
