// =========================================================================
// CONEXIÓN Y CLIENTE DE SUPABASE (CON SOPORTE REALTIME)
// =========================================================================
// Importación del SDK oficial de Supabase para navegador mediante CDN (ES Modules)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Variables de Conexión (URL base del proyecto de Supabase)
const SUPABASE_URL = 'https://zngfzdcipqbddmyuqaht.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_4fmNtN1o4x20cXTNuGGPow_ZG01UHIB'; // Clave pública 'anon'

// Inicialización del Cliente Supabase
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: {
        params: {
            eventsPerSecond: 10,
        },
        // El latido del socket corre en un Web Worker: el navegador no lo frena con la pestaña en segundo plano
        // (los temporizadores normales se estrangulan y el servidor cierra el socket por falta de latido)
        worker: true,
        heartbeatIntervalMs: 15000,
        // Reintentos del socket más rápidos que el valor por defecto (1s, 2s, 5s, 10s)
        reconnectAfterMs: (intento) => [200, 500, 1000, 2000][intento - 1] || 3000,
    },
});

// Exponer globalmente en window para compatibilidad directa en scripts de vistas
if (typeof window !== 'undefined') {
    window.supabaseClient = supabase;
}

export default supabase;
