// netlify/functions/trigger-sync.js
//
// Endpoint que dispara manualmente el workflow de GitHub Actions
// "sync_gastos_ingresos.yml" desde un botón en el visor.
//
// Requiere estas variables de entorno configuradas en Netlify
// (Site settings > Environment variables) — NUNCA hardcodear aquí:
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY   (service role key de Supabase)
//   GH_OWNER               (usuario u organización de GitHub, ej. "epatricia")
//   GH_REPO                (nombre del repo, ej. "visor-fincas")
//   GH_PAT                 (GitHub fine-grained token, permiso Actions: write, solo sobre este repo)

const { createClient } = require('@supabase/supabase-js');

const COOLDOWN_MINUTES = 5;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const requiredEnv = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GH_OWNER', 'GH_REPO', 'GH_PAT'];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Faltan variables de entorno:', missing.join(', '));
    return { statusCode: 500, body: 'Configuración incompleta en el servidor' };
  }

  // 1. Verificar sesión de Supabase (token enviado desde el frontend logueado)
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  console.log('[debug] authHeader presente:', !!authHeader, '- longitud del token:', token.length);
  if (!token) {
    return { statusCode: 401, body: 'No autenticado' };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  console.log('[debug] userError:', JSON.stringify(userError), '- usuario encontrado:', !!userData?.user);
  if (userError || !userData?.user) {
    return { statusCode: 401, body: 'Sesión inválida' };
  }

  // 2. Verificar que quien pulsa el botón es admin (Mar, Patricia...), no un titular cualquiera
  const { data: persona, error: personaError } = await supabase
    .from('personas')
    .select('id, rol')
    .eq('user_id', userData.user.id)
    .single();

  if (personaError || !persona || persona.rol !== 'admin') {
    return { statusCode: 403, body: 'No autorizado' };
  }

  // 3. Cooldown: evitar que se dispare el workflow demasiado seguido
  //    (requiere una tabla `sync_estado` con una fila que guarde el último disparo)
  const { data: estado } = await supabase
    .from('sync_estado')
    .select('ultimo_disparo')
    .eq('id', 'gastos_ingresos')
    .maybeSingle();

  if (estado?.ultimo_disparo) {
    const minutosDesde = (Date.now() - new Date(estado.ultimo_disparo).getTime()) / 60000;
    if (minutosDesde < COOLDOWN_MINUTES) {
      const restante = Math.ceil(COOLDOWN_MINUTES - minutosDesde);
      return {
        statusCode: 429,
        body: JSON.stringify({
          error: `Ya se lanzó una actualización hace poco. Espera ${restante} minuto(s).`,
        }),
      };
    }
  }

  // 4. Disparar el workflow de GitHub Actions
  const ghResponse = await fetch(
    `https://api.github.com/repos/${process.env.GH_OWNER}/${process.env.GH_REPO}/actions/workflows/sync_gastos_ingresos.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GH_PAT}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );

  if (!ghResponse.ok) {
    const errText = await ghResponse.text();
    console.error('Error al llamar a la API de GitHub:', ghResponse.status, errText);
    return { statusCode: 502, body: 'No se pudo lanzar la actualización en GitHub' };
  }

  // 5. Guardar la fecha del disparo para el cooldown
  await supabase
    .from('sync_estado')
    .upsert({ id: 'gastos_ingresos', ultimo_disparo: new Date().toISOString(), disparado_por: persona.id });

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, mensaje: 'Actualización lanzada correctamente' }),
  };
};
