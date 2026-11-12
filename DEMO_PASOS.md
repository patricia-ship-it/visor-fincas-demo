# Visor de Fincas · DEMO — puesta en marcha

Copia del visor real apuntando al proyecto de Supabase **Demo** (`xciuhtoolbhuvoeawmkh`).
Datos: expedientes de ejemplo **11111111A (Mar)** y **22222222B (Albert)**, campaña 2025, 311 líneas, 270 recintos, 160,59 ha.

## Cómo funciona el acceso
- **Sin login.** Al abrir cualquier página, entra sola con el usuario de demostración `demo@example.com`, que es administrador y autoriza borrados (como el administrador en el visor real).
- Todo se ve y todo se puede usar: agregar actividades, cambiar cultivos, quitar/agregar fincas de la campaña, Libro de Trabajo, Mi Expediente, documentos, Agregar Fincas y Mis Alertas.
- La cabecera dice «Modo demostración» y no hay botón de cerrar sesión.
- El usuario de demostración solo existe en el proyecto Demo: no sirve para el visor real.

## Qué cambia respecto al visor real
- Todas las páginas usan la URL y la llave pública de Demo.
- `gastos-ingresos.html`: sin el informe de Looker del visor real (tenía datos reales) y sin el botón «Actualizar ahora» (no hay Google Sheet de finanzas en la Demo).
- Sin workflows de GitHub ni scripts de Python.
- Marca «DEMO» en la cabecera.

## Pasos
1. **SQL pendiente**: en Supabase > Demo > SQL Editor, ejecutar `demo_05_funciones_borrado_y_limpieza.sql` (eliminar actividades y aprobar borrados).
2. **Repositorio y Netlify**: subir el contenido de esta carpeta al repositorio `visor-fincas-demo` y crear un sitio en Netlify desde ese repositorio (sin build; carpeta de publicación `.`).
3. *(Opcional)* Búsqueda dentro de PDFs: en Netlify > Site configuration > Environment variables, añadir `SUPABASE_URL` (`https://xciuhtoolbhuvoeawmkh.supabase.co`) y `SUPABASE_SERVICE_KEY` (Demo > Project Settings > API keys > service_role). No subir esa clave al repositorio.

## Maquinaria (control de horas y mantenimiento)
1. **SQL**: en Supabase > Demo > SQL Editor, ejecutar `demo_06_maquinaria.sql` (después de `demo_05`). Al final muestra 4 tareas: JD 7600 aceite «proxima» (faltan 50 h), filtro «al_dia», Fendt 828 aceite «al_dia», ITV «proxima».
2. **Página nueva** `maquinaria.html` (enlace «🚜 Maquinaria» en la cabecera del visor) y `index.html` actualizado.
3. **Cómo se usa**
   - El administrador da de alta cada máquina con las horas con las que inicia (lo que marca hoy el contador) y le añade tareas: por horas (p. ej. aceite cada 500 h, aviso 50 h antes), por fecha (p. ej. ITV cada 12 meses, aviso 30 días antes) o ambas.
   - En «Agregar actividad» hay un campo «Tractor / máquina». Si se elige uno, se piden las horas trabajadas y se suman a su contador.
   - Contador de la máquina = horas con las que inició + horas de sus actividades en el Libro. En Maquinaria se ven las líneas de cada tractor (con el contador después de cada actividad) y el total global de horas de todas las máquinas.
   - Cualquier persona dada de alta (también el agricultor) puede pulsar «Revisión hecha»: guarda fecha, horas y notas, y el contador de esa tarea vuelve a empezar.
   - Aviso en el visor: franja amarilla (próximo) o roja (vencido) bajo la cabecera y número junto a «Maquinaria». Al guardar una actividad que acerca el tractor a una revisión, el aviso sale en la misma ventana.
   - Aviso por correo (Brevo), al administrador y al correo del titular de la máquina: uno cuando la tarea pasa a «próxima» y otro cuando pasa a «vencida». Se comprueba al guardar cada actividad con tractor y cada día a las 05:00 UTC (pg_cron), para las tareas por fecha.
4. **Correo en la Demo**: no hay clave de Brevo, así que no se envía nada (el aviso en el visor sí funciona). Para activarlo: `SELECT vault.create_secret('<clave de Brevo>', 'brevo_api_key_avisos');` y, para el botón del correo, `SELECT vault.create_secret('<URL del sitio Demo>', 'visor_url');`. Ojo: el administrador de la Demo es `demo@example.com`, que no es un buzón real; el correo útil sería el del titular de la máquina.

## Después de cada presentación
Ejecutar `demo_reset.sql` en el SQL Editor de Demo: borra lo que hayan registrado los visitantes y deja los datos de origen. Luego `demo_reset_maquinaria.sql`: deja solo las dos máquinas de ejemplo en su estado inicial. Los archivos subidos se borran a mano en Storage > documentos-fincas.

## Notas
- 90 de los 270 recintos no tienen polígono (SIGPAC les cambió el número entre 2025 y 2026); están en los datos pero no en el mapa.
- Las imágenes de satélite y NDVI se leen de las carpetas públicas de Monitoreodecultivos (misma zona). NDVI por recinto: 99 recintos, noviembre 2025 – junio 2026.
- El aviso por correo al administrador no envía nada en la Demo (no hay clave de Brevo), y como el usuario demo autoriza, «Quitar este año» se aplica directo.
