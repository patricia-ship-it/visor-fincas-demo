-- ============================================================================
-- DEMO · Reiniciar la maquinaria después de una presentación
-- Pegar en Supabase > Demo > SQL Editor > Run (después de demo_reset.sql, si se usa).
-- Borra las máquinas, tareas y revisiones que hayan creado los visitantes y deja solo
-- las dos de ejemplo (JD 7600 y Fendt 828) en su estado inicial.
-- Las actividades del Libro no se borran aquí: al borrar la máquina quedan «sin tractor».
-- ============================================================================

DELETE FROM public.maquinas;   -- borra también sus tareas y revisiones

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
