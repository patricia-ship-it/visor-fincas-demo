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

## Después de cada presentación
Ejecutar `demo_reset.sql` en el SQL Editor de Demo: borra lo que hayan registrado los visitantes y deja los datos de origen. Los archivos subidos se borran a mano en Storage > documentos-fincas.

## Notas
- 90 de los 270 recintos no tienen polígono (SIGPAC les cambió el número entre 2025 y 2026); están en los datos pero no en el mapa.
- Las imágenes de satélite y NDVI se leen de las carpetas públicas de Monitoreodecultivos (misma zona). NDVI por recinto: 99 recintos, noviembre 2025 – junio 2026.
- El aviso por correo al administrador no envía nada en la Demo (no hay clave de Brevo), y como el usuario demo autoriza, «Quitar este año» se aplica directo.
