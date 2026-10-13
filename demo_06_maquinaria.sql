-- ============================================================================
-- DEMO · Control de maquinaria (horas de tractor y avisos de mantenimiento)
-- Pegar en Supabase > proyecto Demo (xciuhtoolbhuvoeawmkh) > SQL Editor > Run.
-- Se puede ejecutar más de una vez sin romper nada.
--
-- Qué crea:
--   · maquinas               catálogo de tractores/máquinas, con las horas con las que inician
--   · maquinas_tareas        tareas de mantenimiento por máquina (cada X horas y/o cada X meses,
--                            con su aviso previo)
--   · maquinas_revisiones    historial de «Revisión hecha» (reinicia el contador de esa tarea)
--   · libro_trabajo.maquina_id   el tractor con el que se hizo cada actividad
--   · v_maquinas_estado          contador actual de cada máquina (inicial + horas del Libro)
--   · v_maquinas_tareas_estado   estado de cada tarea: al_dia / proxima / vencida
--   · v_maquinas_actividades     las líneas de cada tractor, con el contador acumulado
--   · registrar_revision()       botón «Revisión hecha» (cualquier persona dada de alta)
--   · avisar_mantenimiento()     correo por Brevo al administrador y al titular de la máquina
--   · aviso inmediato al guardar una actividad + revisión diaria (pg_cron) para las fechas
--   · máquinas de ejemplo para la demostración (JD 7600 y Fendt 828)
--
-- Regla del contador: horas actuales = horas con las que se dio de alta la máquina
--                     + suma de las horas de las actividades del Libro hechas con ella.
-- Cada actividad del Libro es de una sola finca, así que sus horas se suman tal cual.
-- ============================================================================

-- 0) Extensiones para enviar correo y programar la revisión diaria
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 1) Tablas -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.maquinas (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre           text NOT NULL,
  tipo             text NOT NULL DEFAULT 'Tractor',
  titular_nif      text,                       -- dueño de la máquina (opcional)
  email_aviso      text,                       -- correo del titular para los avisos
  horas_iniciales  numeric(10,1) NOT NULL DEFAULT 0 CHECK (horas_iniciales >= 0),
  fecha_alta       date NOT NULL DEFAULT current_date,
  activa           boolean NOT NULL DEFAULT true,
  notas            text,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maquinas_nombre_unico UNIQUE (nombre)
);

CREATE TABLE IF NOT EXISTS public.maquinas_tareas (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  maquina_id          bigint NOT NULL REFERENCES public.maquinas(id) ON DELETE CASCADE,
  nombre              text NOT NULL,             -- p. ej. «Cambio de aceite»
  cada_horas          numeric(10,1) CHECK (cada_horas > 0),
  avisar_horas_antes  numeric(10,1) NOT NULL DEFAULT 0 CHECK (avisar_horas_antes >= 0),
  cada_meses          integer CHECK (cada_meses > 0),
  avisar_dias_antes   integer NOT NULL DEFAULT 0 CHECK (avisar_dias_antes >= 0),
  horas_ultima        numeric(10,1),             -- contador en la última revisión
  fecha_ultima        date,                      -- fecha de la última revisión
  activa              boolean NOT NULL DEFAULT true,
  aviso_enviado       text,                      -- último estado avisado por correo (proxima / vencida)
  aviso_enviado_en    timestamptz,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maquinas_tareas_algun_intervalo CHECK (cada_horas IS NOT NULL OR cada_meses IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS maquinas_tareas_maquina_idx ON public.maquinas_tareas (maquina_id);

CREATE TABLE IF NOT EXISTS public.maquinas_revisiones (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tarea_id         bigint NOT NULL REFERENCES public.maquinas_tareas(id) ON DELETE CASCADE,
  maquina_id       bigint NOT NULL REFERENCES public.maquinas(id) ON DELETE CASCADE,
  fecha            date NOT NULL DEFAULT current_date,
  horas_contador   numeric(10,1),
  hecha_por        uuid,
  hecha_por_nombre text,
  notas            text,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maquinas_revisiones_tarea_idx ON public.maquinas_revisiones (tarea_id);

ALTER TABLE public.libro_trabajo
  ADD COLUMN IF NOT EXISTS maquina_id bigint REFERENCES public.maquinas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS libro_trabajo_maquina_idx ON public.libro_trabajo (maquina_id);

-- 2) Contador de horas de una máquina -------------------------------------------
CREATE OR REPLACE FUNCTION public.horas_maquina(p_maquina_id bigint)
 RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT m.horas_iniciales + coalesce((SELECT sum(l.horas) FROM public.libro_trabajo l
                                        WHERE l.maquina_id = m.id), 0)
    FROM public.maquinas m WHERE m.id = p_maquina_id;
$$;

-- Al crear una tarea sin «última revisión», se cuenta desde hoy y desde el contador actual
CREATE OR REPLACE FUNCTION public.maquinas_tareas_valores_iniciales()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.cada_horas IS NOT NULL AND NEW.horas_ultima IS NULL THEN
    NEW.horas_ultima := public.horas_maquina(NEW.maquina_id);
  END IF;
  IF NEW.cada_meses IS NOT NULL AND NEW.fecha_ultima IS NULL THEN
    NEW.fecha_ultima := current_date;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_maquinas_tareas_valores_iniciales ON public.maquinas_tareas;
CREATE TRIGGER trg_maquinas_tareas_valores_iniciales
  BEFORE INSERT ON public.maquinas_tareas
  FOR EACH ROW EXECUTE FUNCTION public.maquinas_tareas_valores_iniciales();

-- 3) Vistas ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_maquinas_estado WITH (security_invoker = true) AS
SELECT m.id, m.nombre, m.tipo, m.titular_nif,
       (SELECT p.nombre FROM public.personas p WHERE upper(trim(p.nif)) = upper(trim(m.titular_nif)) LIMIT 1) AS titular_nombre,
       m.email_aviso, m.horas_iniciales, m.fecha_alta, m.activa, m.notas,
       coalesce(a.horas_libro, 0)                        AS horas_libro,
       m.horas_iniciales + coalesce(a.horas_libro, 0)    AS horas_totales,
       coalesce(a.n_actividades, 0)                      AS n_actividades,
       a.ultima_actividad
  FROM public.maquinas m
  LEFT JOIN (SELECT l.maquina_id, sum(l.horas) AS horas_libro, count(*) AS n_actividades,
                    max(l.fecha_actividad) AS ultima_actividad
               FROM public.libro_trabajo l WHERE l.maquina_id IS NOT NULL
              GROUP BY l.maquina_id) a ON a.maquina_id = m.id;

CREATE OR REPLACE VIEW public.v_maquinas_tareas_estado WITH (security_invoker = true) AS
WITH base AS (
  SELECT t.*, e.nombre AS maquina, e.titular_nif, e.titular_nombre, e.email_aviso,
         e.horas_totales, e.activa AS maquina_activa,
         CASE WHEN t.cada_horas IS NOT NULL THEN e.horas_totales - t.horas_ultima END            AS horas_desde_revision,
         CASE WHEN t.cada_horas IS NOT NULL THEN t.horas_ultima + t.cada_horas END               AS horas_proxima,
         CASE WHEN t.cada_horas IS NOT NULL THEN t.horas_ultima + t.cada_horas - e.horas_totales END AS faltan_horas,
         CASE WHEN t.cada_meses IS NOT NULL THEN (t.fecha_ultima + make_interval(months => t.cada_meses))::date END AS fecha_proxima
    FROM public.maquinas_tareas t
    JOIN public.v_maquinas_estado e ON e.id = t.maquina_id
)
SELECT b.*,
       CASE WHEN b.fecha_proxima IS NOT NULL THEN b.fecha_proxima - current_date END AS faltan_dias,
       CASE
         WHEN NOT b.activa OR NOT b.maquina_activa THEN 'inactiva'
         WHEN (b.faltan_horas IS NOT NULL AND b.faltan_horas <= 0)
           OR (b.fecha_proxima IS NOT NULL AND b.fecha_proxima <= current_date) THEN 'vencida'
         WHEN (b.faltan_horas IS NOT NULL AND b.faltan_horas <= b.avisar_horas_antes)
           OR (b.fecha_proxima IS NOT NULL AND b.fecha_proxima - current_date <= b.avisar_dias_antes) THEN 'proxima'
         ELSE 'al_dia'
       END AS estado
  FROM base b;

-- Las líneas de cada tractor, con el contador después de cada actividad
CREATE OR REPLACE VIEW public.v_maquinas_actividades WITH (security_invoker = true) AS
SELECT l.id, l.maquina_id, m.nombre AS maquina, l.fecha_actividad, l.actividad, l.finca,
       l.codigo_sigpac, l.titular, l.expediente, l.cultivo, l.horas, l.superficie_ha, l.notas,
       m.horas_iniciales + sum(coalesce(l.horas, 0)) OVER (PARTITION BY l.maquina_id
                                    ORDER BY l.fecha_actividad, l.id) AS contador_despues
  FROM public.libro_trabajo l
  JOIN public.maquinas m ON m.id = l.maquina_id;

-- 4) Permisos (RLS) --------------------------------------------------------------
ALTER TABLE public.maquinas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maquinas_tareas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maquinas_revisiones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maquinas_leer ON public.maquinas;
DROP POLICY IF EXISTS maquinas_admin ON public.maquinas;
DROP POLICY IF EXISTS demo_anon_lee_maquinas ON public.maquinas;
CREATE POLICY maquinas_leer  ON public.maquinas FOR SELECT TO authenticated USING (public.es_persona_autorizada());
CREATE POLICY maquinas_admin ON public.maquinas FOR ALL    TO authenticated USING (public.es_admin()) WITH CHECK (public.es_admin());
CREATE POLICY demo_anon_lee_maquinas ON public.maquinas FOR SELECT TO anon USING (true);   -- solo Demo

DROP POLICY IF EXISTS maquinas_tareas_leer ON public.maquinas_tareas;
DROP POLICY IF EXISTS maquinas_tareas_admin ON public.maquinas_tareas;
DROP POLICY IF EXISTS demo_anon_lee_maquinas_tareas ON public.maquinas_tareas;
CREATE POLICY maquinas_tareas_leer  ON public.maquinas_tareas FOR SELECT TO authenticated USING (public.es_persona_autorizada());
CREATE POLICY maquinas_tareas_admin ON public.maquinas_tareas FOR ALL    TO authenticated USING (public.es_admin()) WITH CHECK (public.es_admin());
CREATE POLICY demo_anon_lee_maquinas_tareas ON public.maquinas_tareas FOR SELECT TO anon USING (true);   -- solo Demo

-- Las revisiones se registran solo con registrar_revision(); los administradores pueden corregirlas
DROP POLICY IF EXISTS maquinas_revisiones_leer ON public.maquinas_revisiones;
DROP POLICY IF EXISTS maquinas_revisiones_admin ON public.maquinas_revisiones;
DROP POLICY IF EXISTS demo_anon_lee_maquinas_revisiones ON public.maquinas_revisiones;
CREATE POLICY maquinas_revisiones_leer  ON public.maquinas_revisiones FOR SELECT TO authenticated USING (public.es_persona_autorizada());
CREATE POLICY maquinas_revisiones_admin ON public.maquinas_revisiones FOR ALL    TO authenticated USING (public.es_admin()) WITH CHECK (public.es_admin());
CREATE POLICY demo_anon_lee_maquinas_revisiones ON public.maquinas_revisiones FOR SELECT TO anon USING (true);   -- solo Demo

GRANT SELECT ON public.v_maquinas_estado, public.v_maquinas_tareas_estado, public.v_maquinas_actividades TO authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.horas_maquina(bigint) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.horas_maquina(bigint) TO authenticated;

-- 5) «Revisión hecha» (lo puede marcar el agricultor) ------------------------------
CREATE OR REPLACE FUNCTION public.registrar_revision(
  p_tarea_id bigint, p_fecha date DEFAULT current_date,
  p_horas numeric DEFAULT NULL, p_notas text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  t public.maquinas_tareas%ROWTYPE;
  v_horas numeric; v_quien text; v_id bigint;
BEGIN
  IF NOT public.es_persona_autorizada() THEN
    RAISE EXCEPTION 'Tu cuenta no está autorizada para registrar revisiones';
  END IF;
  SELECT * INTO t FROM public.maquinas_tareas WHERE id = p_tarea_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La tarea de mantenimiento no existe'; END IF;
  IF p_fecha IS NULL OR p_fecha > current_date THEN
    RAISE EXCEPTION 'La fecha de la revisión no puede ser futura';
  END IF;
  v_horas := coalesce(p_horas, public.horas_maquina(t.maquina_id));
  IF v_horas < 0 THEN RAISE EXCEPTION 'Las horas no pueden ser negativas'; END IF;
  SELECT nombre INTO v_quien FROM public.personas WHERE user_id = auth.uid() LIMIT 1;

  INSERT INTO public.maquinas_revisiones (tarea_id, maquina_id, fecha, horas_contador, hecha_por, hecha_por_nombre, notas)
  VALUES (t.id, t.maquina_id, p_fecha, v_horas, auth.uid(), v_quien, NULLIF(btrim(p_notas), ''))
  RETURNING id INTO v_id;

  UPDATE public.maquinas_tareas
     SET horas_ultima = CASE WHEN cada_horas IS NOT NULL THEN v_horas ELSE horas_ultima END,
         fecha_ultima = p_fecha,
         aviso_enviado = NULL, aviso_enviado_en = NULL
   WHERE id = t.id;
  RETURN jsonb_build_object('revision_id', v_id, 'horas_contador', v_horas, 'fecha', p_fecha);
END $$;
REVOKE EXECUTE ON FUNCTION public.registrar_revision(bigint, date, numeric, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.registrar_revision(bigint, date, numeric, text) TO authenticated;

-- 6) Aviso por correo (Brevo) al administrador y al titular de la máquina -----------
-- Envía un correo por máquina cuando una tarea pasa a «próxima» y otro cuando pasa a
-- «vencida» (no repite). Necesita la clave de Brevo en Vault con el nombre
-- 'brevo_api_key_avisos' (la misma que usa el aviso a Mar en el visor real):
--   SELECT vault.create_secret('xkeysib-…', 'brevo_api_key_avisos');
-- Sin clave, no envía nada y deja un aviso (WARNING) en el log; el visor sigue avisando.
CREATE OR REPLACE FUNCTION public.avisar_mantenimiento(p_maquina_id bigint DEFAULT NULL)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'net', 'vault'
AS $$
DECLARE
  v_key text; v_url text; v_dest jsonb; v_html text; v_filas text; v_enviados int := 0;
  r record;
BEGIN
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'brevo_api_key_avisos' LIMIT 1;
  IF v_key IS NULL THEN
    RAISE WARNING 'Aviso de mantenimiento no enviado: falta la clave brevo_api_key_avisos en Vault';
    RETURN 0;
  END IF;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'visor_url' LIMIT 1;

  FOR r IN
    SELECT e.maquina_id, max(e.maquina) AS maquina, max(e.email_aviso) AS email_aviso,
           max(e.titular_nombre) AS titular_nombre, bool_or(e.estado = 'vencida') AS hay_vencida,
           array_agg(e.id) AS tareas
      FROM public.v_maquinas_tareas_estado e
     WHERE e.estado IN ('proxima', 'vencida')
       AND coalesce(e.aviso_enviado, '') <> e.estado
       AND (p_maquina_id IS NULL OR e.maquina_id = p_maquina_id)
     GROUP BY e.maquina_id
  LOOP
    -- Destinatarios: administradores con correo + correo del titular de la máquina (sin repetir)
    SELECT jsonb_agg(jsonb_build_object('email', d.email)) INTO v_dest
      FROM (SELECT DISTINCT lower(btrim(x.email)) AS email
              FROM (SELECT p.email FROM public.personas p
                     WHERE p.rol = 'admin' AND coalesce(p.activo, true)
                    UNION ALL SELECT r.email_aviso) x
             WHERE x.email IS NOT NULL AND btrim(x.email) <> '' AND x.email LIKE '%@%') d;
    CONTINUE WHEN v_dest IS NULL;

    SELECT string_agg(
             '<li><strong>' || public._html_escapar(e.nombre) || '</strong>: '
             || CASE WHEN e.estado = 'vencida' THEN '<span style="color:#c0392b">vencida</span>' ELSE 'próxima' END
             || CASE WHEN e.faltan_horas IS NOT NULL THEN
                  ' · ' || CASE WHEN e.faltan_horas > 0 THEN 'faltan ' || replace(round(e.faltan_horas, 1)::text, '.', ',') || ' h'
                                ELSE 'pasada en ' || replace(round(-e.faltan_horas, 1)::text, '.', ',') || ' h' END
                  || ' (toca a las ' || replace(round(e.horas_proxima, 1)::text, '.', ',') || ' h; contador actual '
                  || replace(round(e.horas_totales, 1)::text, '.', ',') || ' h)'
                ELSE '' END
             || CASE WHEN e.fecha_proxima IS NOT NULL THEN ' · fecha: ' || to_char(e.fecha_proxima, 'DD/MM/YYYY') ELSE '' END
             || '</li>', '' ORDER BY e.estado DESC, e.nombre)
      INTO v_filas
      FROM public.v_maquinas_tareas_estado e WHERE e.id = ANY (r.tareas);

    v_html := '<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:560px">'
      || '<p>Hola:</p>'
      || '<p>La máquina <strong>' || public._html_escapar(r.maquina) || '</strong>'
      || CASE WHEN r.titular_nombre IS NOT NULL THEN ' (titular: ' || public._html_escapar(r.titular_nombre) || ')' ELSE '' END
      || ' tiene mantenimiento ' || CASE WHEN r.hay_vencida THEN 'pendiente' ELSE 'próximo' END || ':</p>'
      || '<ul>' || v_filas || '</ul>'
      || '<p>Cuando esté hecho, márcalo con «Revisión hecha» en la sección Maquinaria del visor: el contador vuelve a empezar.</p>'
      || CASE WHEN v_url IS NOT NULL THEN '<p><a href="' || public._html_escapar(rtrim(v_url, '/') || '/maquinaria.html')
           || '" style="background:#1f7a4d;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir Maquinaria</a></p>' ELSE '' END
      || '<p style="color:#777;font-size:12px">Aviso automático del Visor de Fincas.</p></div>';

    PERFORM net.http_post(
      url     := 'https://api.brevo.com/v3/smtp/email',
      headers := jsonb_build_object('api-key', v_key, 'content-type', 'application/json', 'accept', 'application/json'),
      body    := jsonb_build_object(
                   'sender',      jsonb_build_object('name', 'Visor de Fincas', 'email', 'patricia@einadata.com'),
                   'to',          v_dest,
                   'subject',     CASE WHEN r.hay_vencida THEN 'Mantenimiento pendiente: ' ELSE 'Mantenimiento próximo: ' END || r.maquina,
                   'htmlContent', v_html),
      timeout_milliseconds := 5000);

    UPDATE public.maquinas_tareas t
       SET aviso_enviado = e.estado, aviso_enviado_en = now()
      FROM public.v_maquinas_tareas_estado e
     WHERE e.id = t.id AND t.id = ANY (r.tareas);
    v_enviados := v_enviados + 1;
  END LOOP;
  RETURN v_enviados;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Aviso de mantenimiento no enviado: %', SQLERRM;
  RETURN v_enviados;
END $$;
REVOKE EXECUTE ON FUNCTION public.avisar_mantenimiento(bigint) FROM public, anon, authenticated;

-- Aviso inmediato al guardar una actividad con tractor
CREATE OR REPLACE FUNCTION public.trg_libro_avisar_mantenimiento()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.maquina_id IS NOT NULL THEN
    PERFORM public.avisar_mantenimiento(NEW.maquina_id);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Aviso de mantenimiento no enviado: %', SQLERRM;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_libro_avisar_mantenimiento ON public.libro_trabajo;
CREATE TRIGGER trg_libro_avisar_mantenimiento
  AFTER INSERT OR UPDATE OF horas, maquina_id ON public.libro_trabajo
  FOR EACH ROW EXECUTE FUNCTION public.trg_libro_avisar_mantenimiento();

-- Revisión diaria (07:00 en España ≈ 05:00 UTC) para las tareas por fecha
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'avisos-mantenimiento';
SELECT cron.schedule('avisos-mantenimiento', '0 5 * * *', 'SELECT public.avisar_mantenimiento()');

-- 7) Máquinas de ejemplo para la demostración --------------------------------------
-- JD 7600 (de Mar): cambio de aceite a 50 h → aparece como «próximo».
-- Fendt 828 (de Albert): aceite al día; ITV en menos de 30 días → «próxima».
INSERT INTO public.maquinas (nombre, tipo, titular_nif, horas_iniciales, fecha_alta, notas)
VALUES ('JD 7600',   'Tractor', '11111111A', 3150, DATE '2026-09-01', 'Máquina de ejemplo'),
       ('Fendt 828', 'Tractor', '22222222B', 1180, DATE '2026-09-01', 'Máquina de ejemplo')
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO public.maquinas_tareas (maquina_id, nombre, cada_horas, avisar_horas_antes, horas_ultima, fecha_ultima)
SELECT m.id, x.nombre, x.cada, x.antes, x.ultima, DATE '2026-06-15'
  FROM (VALUES ('JD 7600',   'Cambio de aceite', 500, 50, 2700),
               ('JD 7600',   'Filtro de aire',   250, 25, 3000),
               ('Fendt 828', 'Cambio de aceite', 500, 50, 1000)) AS x(maquina, nombre, cada, antes, ultima)
  JOIN public.maquinas m ON m.nombre = x.maquina
 WHERE NOT EXISTS (SELECT 1 FROM public.maquinas_tareas t WHERE t.maquina_id = m.id AND t.nombre = x.nombre);

INSERT INTO public.maquinas_tareas (maquina_id, nombre, cada_meses, avisar_dias_antes, fecha_ultima)
SELECT m.id, 'ITV', 12, 30, DATE '2025-11-05'
  FROM public.maquinas m
 WHERE m.nombre = 'Fendt 828'
   AND NOT EXISTS (SELECT 1 FROM public.maquinas_tareas t WHERE t.maquina_id = m.id AND t.nombre = 'ITV');

-- 8) Comprobación: 4 tareas; JD 7600 aceite = proxima (faltan 50 h), filtro = al_dia,
--    Fendt 828 aceite = al_dia (faltan 320 h), ITV = proxima.
SELECT maquina, nombre, horas_totales, faltan_horas, fecha_proxima, faltan_dias, estado
  FROM public.v_maquinas_tareas_estado ORDER BY maquina, nombre;
