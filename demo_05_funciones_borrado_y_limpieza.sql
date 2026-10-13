-- ============================================================================
-- DEMO · paso pendiente (pegar en Supabase > proyecto Demo > SQL Editor > Run)
-- 1) Crea las dos funciones con DELETE que faltan (copia exacta de Monitoreodecultivos):
--    eliminar_actividad (botón 🗑 del Libro) y aprobar_borrado_finca («Quitar este año» / borrado).
-- 2) Borra las 3 funciones temporales que se usaron para cargar los datos.
-- Solo afecta al proyecto Demo (xciuhtoolbhuvoeawmkh).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.eliminar_actividad(p_id bigint, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_copia jsonb; v_quien text; v_bid bigint;
BEGIN
  IF NOT public.es_admin() THEN
    RAISE EXCEPTION 'Solo los administradores pueden eliminar actividades';
  END IF;
  SELECT to_jsonb(l) INTO v_copia FROM public.libro_trabajo l WHERE l.id = p_id FOR UPDATE;
  IF v_copia IS NULL THEN RAISE EXCEPTION 'La actividad no existe o ya fue eliminada'; END IF;
  SELECT nombre INTO v_quien FROM public.personas WHERE user_id = auth.uid() LIMIT 1;
  INSERT INTO public.libro_trabajo_borrados (actividad_id, copia, motivo, borrado_por, borrado_por_nombre)
  VALUES (p_id, v_copia, NULLIF(btrim(p_motivo), ''), auth.uid(), v_quien)
  RETURNING id INTO v_bid;
  DELETE FROM public.libro_trabajo WHERE id = p_id;
  RETURN jsonb_build_object('borrado_id', v_bid, 'actividad_id', p_id);
END $function$;

CREATE OR REPLACE FUNCTION public.aprobar_borrado_finca(p_solicitud_id bigint, p_comentario text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  s public.solicitudes_borrado%ROWTYPE;
  d public.declaraciones%ROWTYPE;
  v_copia jsonb;
  v_camp jsonb;
  v_quien text;
  v_persona uuid;
BEGIN
  IF NOT public.soy_autorizador_borrado() THEN
    RAISE EXCEPTION 'Solo quien autoriza los borrados puede aprobar';
  END IF;

  SELECT * INTO s FROM public.solicitudes_borrado WHERE id = p_solicitud_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La solicitud % no existe', p_solicitud_id; END IF;
  IF s.estado <> 'pendiente' THEN RAISE EXCEPTION 'La solicitud ya está %', s.estado; END IF;

  SELECT nombre, id INTO v_quien, v_persona FROM public.personas WHERE user_id = auth.uid() LIMIT 1;

  IF s.accion = 'quitar_campana' THEN
    INSERT INTO public.fincas_estado_campana (parcela_id, nif, activa, actualizado_por)
    VALUES (s.parcela_id, s.nif, false, v_persona)
    ON CONFLICT (parcela_id, nif) DO UPDATE SET activa = false, actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now();
    UPDATE public.solicitudes_borrado
       SET estado = 'aprobada', resuelto_por = auth.uid(), resuelto_por_nombre = v_quien,
           resuelto_en = now(), comentario = NULLIF(btrim(p_comentario), '')
     WHERE id = s.id;
    RETURN;
  END IF;

  SELECT * INTO d FROM public.declaraciones WHERE id = s.declaracion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La línea ya no existe (¿se borró por otra vía?)'; END IF;

  v_copia := jsonb_build_object(
    'declaracion', to_jsonb(d) - 'geom_linea',
    'geom_linea_ewkt', (SELECT ST_AsEWKT(x.geom_linea) FROM public.declaraciones x WHERE x.id = d.id));

  SELECT coalesce(jsonb_agg(to_jsonb(fe)), '[]'::jsonb) INTO v_camp
    FROM public.fincas_estado_campana fe WHERE fe.parcela_id = d.parcela_id AND upper(trim(fe.nif)) = upper(trim(d.nif));
  v_copia := v_copia || jsonb_build_object('campana', v_camp);

  DELETE FROM public.declaraciones WHERE id = d.id;

  IF NOT EXISTS (SELECT 1 FROM public.declaraciones x
                  WHERE x.parcela_id = d.parcela_id AND upper(trim(x.nif)) = upper(trim(d.nif))) THEN
    DELETE FROM public.fincas_estado_campana fe
     WHERE fe.parcela_id = d.parcela_id AND upper(trim(fe.nif)) = upper(trim(d.nif));
  END IF;

  UPDATE public.solicitudes_borrado
     SET estado = 'aprobada', resuelto_por = auth.uid(), resuelto_por_nombre = v_quien,
         resuelto_en = now(), comentario = NULLIF(btrim(p_comentario), ''), copia = v_copia
   WHERE id = s.id;
END $function$;

REVOKE EXECUTE ON FUNCTION public.eliminar_actividad(bigint, text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.aprobar_borrado_finca(bigint, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.eliminar_actividad(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_borrado_finca(bigint, text) TO authenticated;

DROP FUNCTION IF EXISTS public.tmp_demo_cargar_parcelas(jsonb);
DROP FUNCTION IF EXISTS public.tmp_demo_cargar_lineas(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.tmp_demo_anillo(text);

-- Comprobación: debe devolver 2 filas (eliminar_actividad y aprobar_borrado_finca) y 0 funciones tmp_demo
SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('eliminar_actividad','aprobar_borrado_finca') OR proname LIKE 'tmp_demo%';
