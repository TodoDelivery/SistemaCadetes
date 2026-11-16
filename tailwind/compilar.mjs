// Compila Tailwind a CSS estático (antes se cargaba desde el CDN en cada visita).
// Uso: npm run css   — hay que correrlo después de agregar o cambiar clases en el HTML o el JS,
// o de tocar un tema en tailwind/*.config.cjs, y commitear los .css que genera.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAILWIND = 'tailwindcss@3.4.17';

// [tema, archivo de salida]
const COMPILACIONES = [
  [
    "ingreso",
    "Styles/tailwind-ingreso.css"
  ],
  [
    "inicio",
    "Styles/tailwind-inicio.css"
  ],
  [
    "viaje",
    "Styles/tailwind-viaje.css"
  ],
  [
    "listas",
    "Styles/tailwind-listas.css"
  ]
];

for (const [tema, salida] of COMPILACIONES) {
  execSync(`npx --yes ${TAILWIND} -c tailwind/${tema}.config.cjs -i tailwind/entrada.css -o ${salida} --minify`,
    { cwd: raiz, stdio: 'inherit' });
  console.log(`✔ ${salida}`);
}
