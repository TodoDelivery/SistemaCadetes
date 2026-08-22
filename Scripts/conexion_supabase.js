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
    },
});

// Exponer globalmente en window para compatibilidad directa en scripts de vistas
if (typeof window !== 'undefined') {
    window.supabaseClient = supabase;
}

export default supabase;
