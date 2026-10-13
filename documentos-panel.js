/**
 * documentos-panel.js
 * Panel lateral de Gestión Documental — Visor de Fincas
 *
 * Integración:
 *   1. Cargar después de que supabase-js y tu cliente estén listos.
 *   2. Llamar una vez, tras resolver la sesión de Auth:
 *
 *        initDocumentosPanel(supabaseClient, {
 *          id: personaActual.id,
 *          esAdmin: personaActual.esAdmin
 *        });
 *
 *   3. Abrir el panel desde donde quieras:
 *
 *        // Sin filtro (botón "Documentos" del navbar) -> navegación por carpetas
 *        abrirPanelDocumentos();
 *
 *        // Filtrado a una parcela (desde el click handler del mapa)
 *        abrirPanelDocumentos({ poligono: '12', parcela: '34', recinte: '1' });
 *
 * Vistas:
 *   - "Carpetas": Tipo de documento → Titular (+ "General") → Documentos
 *   - "Lista": lista plana con filtros de titular y tipo
 *   - Al escribir en el buscador, ambas vistas muestran resultados aplanados
 *     dentro del alcance actual (nombre, descripción, tipo, expediente y
 *     — una vez indexado — el contenido del PDF).
 *
 * Requiere la tabla "documentos" y el bucket "documentos-fincas"
 * (ver gestion_documental_schema.sql, gestion_documental_busqueda_texto.sql
 * y gestion_documental_general_y_tipos.sql).
 */

(function () {
  let _supabase = null;
  let _persona = null; // { id, esAdmin }

  // Estado de navegación
  let _modoFiltroParcela = false;
  let _filtroParcela = null; // { poligono, parcela, recinte }
  let _vista = 'carpetas'; // 'carpetas' | 'lista'
  let _tipoSeleccionado = null; // 'contrato' | 'escritura' | ...
  let _titularSeleccionado = null; // { id, nombre } — id === null significa "General"
  let _titularesCache = null;

  const BUCKET = 'documentos-fincas';

  const TIPOS = [
    { value: 'escritura', label: 'Escriptures' },
    { value: 'contrato', label: 'Contractes' },
    { value: 'referencia_catastral', label: 'Referencies Cadastrals' },
    { value: 'factura', label: 'Facturas' },
    { value: 'certificado', label: 'Certificados' },
    { value: 'otro', label: 'Otros' },
  ];

  function etiquetaTipo(valor) {
    return TIPOS.find((t) => t.value === valor)?.label || valor;
  }

  function inyectarEstilos() {
    if (document.getElementById('documentos-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'documentos-panel-styles';
    style.textContent = `
      #documentos-panel-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.3);
        z-index: 9998; display: none;
      }
      #documentos-panel {
        position: fixed; top: 0; right: -420px; width: 400px; height: 100%;
        background: #fff; box-shadow: -2px 0 12px rgba(0,0,0,0.15);
        z-index: 9999; transition: right 0.25s ease; display: flex;
        flex-direction: column; font-family: Arial, sans-serif;
      }
      #documentos-panel.abierto { right: 0; }
      .dp-header {
        padding: 16px; border-bottom: 1px solid #e5e5e5;
        display: flex; justify-content: space-between; align-items: center;
      }
      .dp-header h3 { margin: 0; font-size: 16px; color: #1F4E79; }
      .dp-header small { display: block; color: #888; font-size: 12px; margin-top: 2px; }
      .dp-close { cursor: pointer; border: none; background: none; font-size: 20px; color: #888; }
      .dp-body { flex: 1; overflow-y: auto; padding: 12px 16px; }

      .dp-toggle-vista { display: flex; gap: 6px; margin-bottom: 10px; }
      .dp-toggle-vista button {
        flex: 1; padding: 6px 8px; font-size: 12px; border: 1px solid #ccc;
        background: #f7fafc; color: #555; border-radius: 6px; cursor: pointer;
      }
      .dp-toggle-vista button.activo { background: #1F4E79; color: #fff; border-color: #1F4E79; }

      .dp-breadcrumb { font-size: 12px; color: #888; margin-bottom: 8px; min-height: 16px; }
      .dp-crumb { cursor: pointer; text-decoration: underline; color: #1F4E79; }
      .dp-crumb.activo { color: #888; text-decoration: none; cursor: default; }
      .dp-crumb-sep { color: #ccc; }

      .dp-search {
        width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px;
        margin-bottom: 10px; box-sizing: border-box; font-size: 13px;
      }

      .dp-filtros-lista { display: none; gap: 8px; margin-bottom: 12px; }
      .dp-filtros-lista select, .dp-filtros-lista > div {
        flex: 1; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 12px;
      }
      #dp-filtro-titular-wrap { padding: 0; }
      #dp-filtro-titular-wrap select { width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 12px; }

      .dp-carpeta {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 12px; border: 1px solid #eee; border-radius: 8px;
        margin-bottom: 6px; cursor: pointer; font-size: 13px; color: #333;
      }
      .dp-carpeta:hover { background: #f7fafc; border-color: #b0c4d8; }
      .dp-carpeta-flecha { color: #aaa; }
      .dp-carpeta-count {
        font-size: 11px; color: #888; background: #eee; border-radius: 10px;
        padding: 1px 8px;
      }

      .dp-upload {
        border: 2px dashed #b0c4d8; border-radius: 8px; padding: 14px;
        text-align: center; font-size: 13px; color: #555; margin-bottom: 14px;
        cursor: pointer; background: #f7fafc;
      }
      .dp-upload.dragover { background: #eaf2fa; border-color: #1F4E79; }
      .dp-upload input[type=file] { display: none; }
      .dp-upload-form { display: none; margin-top: 10px; text-align: left; }
      .dp-upload-form.activo { display: block; }
      .dp-upload-form label { display: block; font-size: 12px; margin: 8px 0 3px; color: #333; }
      .dp-upload-form select, .dp-upload-form textarea, .dp-upload-form input[type=text], .dp-upload-form input[type=date] {
        width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #ccc;
        border-radius: 5px; font-size: 13px;
      }
      .dp-upload-form button {
        margin-top: 10px; width: 100%; padding: 8px; background: #1F4E79; color: #fff;
        border: none; border-radius: 6px; cursor: pointer; font-size: 13px;
      }
      .dp-upload-form button:disabled { opacity: 0.6; cursor: default; }

      .dp-item {
        border: 1px solid #eee; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;
      }
      .dp-item-top { display: flex; justify-content: space-between; align-items: start; gap: 8px; }
      .dp-item-nombre { font-size: 13px; font-weight: bold; color: #222; word-break: break-word; }
      .dp-item-meta { font-size: 11px; color: #888; margin-top: 3px; }
      .dp-badge {
        font-size: 10px; text-transform: uppercase; background: #eaf2fa; color: #1F4E79;
        padding: 2px 6px; border-radius: 4px; white-space: nowrap;
      }
      .dp-item-desc { font-size: 12px; color: #555; margin-top: 6px; }
      .dp-item-actions { margin-top: 8px; display: flex; gap: 10px; }
      .dp-item-actions a, .dp-item-actions button {
        font-size: 12px; color: #1F4E79; background: none; border: none; cursor: pointer;
        text-decoration: underline; padding: 0;
      }
      .dp-empty { color: #999; font-size: 13px; text-align: center; margin-top: 30px; }
    `;
    document.head.appendChild(style);
  }

  function construirPanel() {
    if (document.getElementById('documentos-panel')) return;

    const overlay = document.createElement('div');
    overlay.id = 'documentos-panel-overlay';
    overlay.onclick = cerrarPanelDocumentos;

    const panel = document.createElement('div');
    panel.id = 'documentos-panel';
    panel.innerHTML = `
      <div class="dp-header">
        <div>
          <h3>Documentos</h3>
          <small id="dp-subtitulo"></small>
        </div>
        <button class="dp-close" onclick="cerrarPanelDocumentos()">&times;</button>
      </div>
      <div class="dp-body">
        <div class="dp-toggle-vista" id="dp-toggle-vista">
          <button id="dp-btn-carpetas" class="activo">🗂 Carpetas</button>
          <button id="dp-btn-lista">📋 Lista</button>
        </div>

        <div class="dp-breadcrumb" id="dp-breadcrumb"></div>

        <input type="text" class="dp-search" id="dp-search" placeholder="Buscar por nombre, descripción o contenido del PDF..." />

        <div class="dp-filtros-lista" id="dp-filtros-lista">
          <div id="dp-filtro-titular-wrap">
            <select id="dp-filtro-titular">
              <option value="">Todos los titulares</option>
              <option value="__general__">General</option>
            </select>
          </div>
          <select id="dp-filtro-tipo">
            <option value="">Todos los tipos</option>
            ${TIPOS.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}
          </select>
        </div>

        <div class="dp-upload" id="dp-upload-zone">
          <div id="dp-upload-label">📎 Arrastra un archivo aquí o haz click para subir</div>
          <input type="file" id="dp-file-input" />
          <div class="dp-upload-form" id="dp-upload-form">
            ${_persona.esAdmin ? `
            <label>Subir en nombre de</label>
            <select id="dp-titular">
              <option value="__general__">General (sin titular)</option>
            </select>
            ` : ''}
            <label>Tipo de documento</label>
            <select id="dp-tipo">
              ${TIPOS.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}
            </select>
            <label>Descripción (opcional)</label>
            <textarea id="dp-descripcion" rows="2"></textarea>
            <label>Fecha del documento (opcional)</label>
            <input type="date" id="dp-fecha" />
            <button id="dp-submit-btn">Subir documento</button>
          </div>
        </div>

        <div id="dp-lista"></div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    if (_persona.esAdmin) {
      poblarSelectorTitularSubida();
    }

    document.getElementById('dp-search').addEventListener('input', debounce(actualizarPanel, 300));

    document.getElementById('dp-btn-carpetas').addEventListener('click', () => {
      if (_vista === 'carpetas') return;
      _vista = 'carpetas';
      actualizarBotonesVista();
      actualizarPanel();
    });
    document.getElementById('dp-btn-lista').addEventListener('click', () => {
      if (_vista === 'lista') return;
      _vista = 'lista';
      actualizarBotonesVista();
      actualizarPanel();
    });

    document.getElementById('dp-filtro-titular').addEventListener('change', actualizarPanel);
    document.getElementById('dp-filtro-tipo').addEventListener('change', actualizarPanel);

    // ---- Subida de archivos ----
    const zone = document.getElementById('dp-upload-zone');
    const fileInput = document.getElementById('dp-file-input');
    let archivoSeleccionado = null;

    zone.addEventListener('click', (e) => {
      if (e.target.closest('.dp-upload-form')) return;
      fileInput.click();
    });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        archivoSeleccionado = e.dataTransfer.files[0];
        mostrarFormularioSubida(archivoSeleccionado);
      }
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) {
        archivoSeleccionado = fileInput.files[0];
        mostrarFormularioSubida(archivoSeleccionado);
      }
    });

    function mostrarFormularioSubida(archivo) {
      document.getElementById('dp-upload-label').textContent = `📄 ${archivo.name}`;
      document.getElementById('dp-upload-form').classList.add('activo');
    }

    document.getElementById('dp-submit-btn').addEventListener('click', async () => {
      if (!archivoSeleccionado) return;
      await subirDocumento(archivoSeleccionado);
      archivoSeleccionado = null;
      document.getElementById('dp-upload-form').classList.remove('activo');
      document.getElementById('dp-upload-label').textContent = '📎 Arrastra un archivo aquí o haz click para subir';
      fileInput.value = '';
    });
  }

  function actualizarBotonesVista() {
    document.getElementById('dp-btn-carpetas').classList.toggle('activo', _vista === 'carpetas');
    document.getElementById('dp-btn-lista').classList.toggle('activo', _vista === 'lista');
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ---- Titulares (para selectores y agrupación) ----
  async function obtenerTitulares() {
    if (_titularesCache) return _titularesCache;
    // NOTA: ajusta 'nombre' si la columna en tu tabla "personas" se llama distinto
    const { data, error } = await _supabase.from('personas').select('id, nombre').order('nombre');
    if (error || !data) {
      console.error('obtenerTitulares:', error);
      return [];
    }
    _titularesCache = data;
    return data;
  }

  async function poblarSelectorTitularSubida() {
    const select = document.getElementById('dp-titular');
    if (!select) return;
    const titulares = await obtenerTitulares();
    select.innerHTML = '<option value="__general__">General (sin titular)</option>' +
      titulares.map((p) => `<option value="${p.id}" ${p.id === _persona.id ? 'selected' : ''}>${escapeHtml(p.nombre || p.id)}</option>`).join('');
  }

  // ---- Subida ----
  function obtenerContextoSubida() {
    if (_modoFiltroParcela) return { extra: { ..._filtroParcela } };
    if (_vista === 'carpetas' && _tipoSeleccionado && _titularSeleccionado) {
      return { tipo: _tipoSeleccionado, personaId: _titularSeleccionado.id };
    }
    return {};
  }

  async function subirDocumento(archivo) {
    const btn = document.getElementById('dp-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Subiendo...';

    try {
      const contexto = obtenerContextoSubida();
      const tipo = document.getElementById('dp-tipo').value;
      const descripcion = document.getElementById('dp-descripcion').value.trim() || null;
      const fecha = document.getElementById('dp-fecha').value || null;

      // Si es admin, el documento se asigna al titular elegido en el selector
      // ("__general__" = sin titular); si no, siempre es el propio usuario logueado.
      const selectorTitular = document.getElementById('dp-titular');
      let personaId;
      if (_persona.esAdmin && selectorTitular) {
        personaId = selectorTitular.value === '__general__' ? null : selectorTitular.value;
      } else {
        personaId = _persona.id;
      }

      const carpetaStorage = personaId || 'general';
      const rutaStorage = `${carpetaStorage}/${crypto.randomUUID()}-${archivo.name}`;

      const { error: errorStorage } = await _supabase
        .storage.from(BUCKET)
        .upload(rutaStorage, archivo);
      if (errorStorage) throw errorStorage;

      const { data: nuevoDoc, error: errorInsert } = await _supabase
        .from('documentos')
        .insert({
          persona_id: personaId,
          subido_por: _persona.id,
          tipo_documento: tipo,
          nombre_archivo: archivo.name,
          descripcion,
          fecha_documento: fecha,
          poligono: contexto.extra?.poligono || null,
          parcela: contexto.extra?.parcela || null,
          recinte: contexto.extra?.recinte || null,
          expediente: contexto.extra?.expediente || null,
          storage_provider: 'supabase',
          storage_path: rutaStorage,
          mime_type: archivo.type,
          tamano_bytes: archivo.size,
        })
        .select()
        .single();
      if (errorInsert) throw errorInsert;

      // Lanzar la extracción de texto en segundo plano (no bloquea la subida)
      lanzarExtraccionTexto(nuevoDoc.id);

      await actualizarPanel();
    } catch (e) {
      alert('Error al subir el documento: ' + (e.message || e));
      console.error(e);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Subir documento';
    }
  }

  async function lanzarExtraccionTexto(documentoId) {
    try {
      const { data: sessionData } = await _supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) return;
      fetch('/.netlify/functions/extract-document-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ documento_id: documentoId }),
      }).catch((e) => console.warn('No se pudo lanzar la extracción de texto:', e));
    } catch (e) {
      console.warn('lanzarExtraccionTexto:', e);
    }
  }

  // ---- Construcción de consultas ----
  function queryDocumentos(f = {}) {
    let query = _supabase.from('documentos').select('*').order('created_at', { ascending: false });

    if (f.persona_id !== undefined) {
      query = f.persona_id === null ? query.is('persona_id', null) : query.eq('persona_id', f.persona_id);
    } else if (!_persona.esAdmin) {
      query = query.eq('persona_id', _persona.id);
    }

    if (f.tipo_documento) query = query.eq('tipo_documento', f.tipo_documento);

    if (f.poligono !== undefined) {
      query = f.poligono === null ? query.is('poligono', null) : query.eq('poligono', f.poligono);
    }
    if (f.parcela !== undefined) {
      query = f.parcela === null ? query.is('parcela', null) : query.eq('parcela', f.parcela);
    }
    if (f.recinte !== undefined) {
      query = f.recinte === null ? query.is('recinte', null) : query.eq('recinte', f.recinte);
    }
    if (f.expediente !== undefined) {
      query = f.expediente === null ? query.is('expediente', null) : query.eq('expediente', f.expediente);
    }
    if (f.texto) {
      query = query.textSearch('busqueda', f.texto, { type: 'websearch', config: 'spanish' });
    }
    return query;
  }

  async function renderizarListaDocumentos(filtros) {
    const lista = document.getElementById('dp-lista');
    lista.innerHTML = '<div class="dp-empty">Cargando...</div>';

    const { data, error } = await queryDocumentos(filtros);
    if (error) {
      lista.innerHTML = `<div class="dp-empty">Error al cargar: ${error.message}</div>`;
      return;
    }
    if (!data || data.length === 0) {
      lista.innerHTML = '<div class="dp-empty">No hay documentos.</div>';
      return;
    }

    lista.innerHTML = data.map(renderItem).join('');
    data.forEach((doc) => {
      const btn = document.getElementById(`dp-descargar-${doc.id}`);
      if (btn) btn.addEventListener('click', () => descargarDocumento(doc));
    });
  }

  function renderItem(doc) {
    const fecha = doc.fecha_documento || doc.created_at?.slice(0, 10) || '';
    const ubicacion = [doc.poligono, doc.parcela, doc.recinte].filter(Boolean).join('-');
    const indexando = doc.mime_type === 'application/pdf' && doc.texto_indexado === false;
    return `
      <div class="dp-item">
        <div class="dp-item-top">
          <div class="dp-item-nombre">${escapeHtml(doc.nombre_archivo)}</div>
          <span class="dp-badge">${etiquetaTipo(doc.tipo_documento)}</span>
        </div>
        <div class="dp-item-meta">
          ${fecha}${ubicacion ? ' · Parcela ' + escapeHtml(ubicacion) : ''}${doc.expediente ? ' · Exp. ' + escapeHtml(doc.expediente) : ''}${indexando ? ' · <em>indexando texto…</em>' : ''}
        </div>
        ${doc.descripcion ? `<div class="dp-item-desc">${escapeHtml(doc.descripcion)}</div>` : ''}
        <div class="dp-item-actions">
          <button id="dp-descargar-${doc.id}">Descargar</button>
        </div>
      </div>
    `;
  }

  async function descargarDocumento(doc) {
    const { data, error } = await _supabase.storage.from(BUCKET).createSignedUrl(doc.storage_path, 60);
    if (error) {
      alert('No se pudo generar el enlace de descarga: ' + error.message);
      return;
    }
    window.open(data.signedUrl, '_blank');
  }

  // ---- Vista "Lista con filtros" ----
  async function mostrarListaConFiltros(texto) {
    const wrapTitular = document.getElementById('dp-filtro-titular-wrap');

    if (_persona.esAdmin) {
      wrapTitular.style.display = 'block';
      const contenedor = document.getElementById('dp-filtros-lista');
      if (!contenedor.dataset.cargado) {
        const titulares = await obtenerTitulares();
        const select = document.getElementById('dp-filtro-titular');
        select.innerHTML = '<option value="">Todos los titulares</option><option value="__general__">General</option>' +
          titulares.map((t) => `<option value="${t.id}">${escapeHtml(t.nombre || t.id)}</option>`).join('');
        contenedor.dataset.cargado = '1';
      }
    } else {
      wrapTitular.style.display = 'none';
    }

    const filtros = {};
    const titularVal = document.getElementById('dp-filtro-titular')?.value;
    if (titularVal === '__general__') filtros.persona_id = null;
    else if (titularVal) filtros.persona_id = titularVal;
    const tipoVal = document.getElementById('dp-filtro-tipo')?.value;
    if (tipoVal) filtros.tipo_documento = tipoVal;
    if (texto) filtros.texto = texto;

    await renderizarListaDocumentos(filtros);
  }

  // ---- Vista "Carpetas": Tipo → Titular/General → Documentos ----
  function construirBreadcrumb(items) {
    document.getElementById('dp-breadcrumb').innerHTML = items
      .map((it) => (it.activo
        ? `<span class="dp-crumb activo">${escapeHtml(it.label)}</span>`
        : `<span class="dp-crumb" onclick="${it.onClick}()">${escapeHtml(it.label)}</span>`))
      .join(' <span class="dp-crumb-sep">/</span> ');
  }

  async function mostrarRaizTipos() {
    construirBreadcrumb([{ label: 'Documentos', activo: true }]);
    const lista = document.getElementById('dp-lista');
    lista.innerHTML = TIPOS.map((t) => `
      <div class="dp-carpeta" data-tipo="${t.value}">
        <span>📁 ${t.label}</span>
        <span class="dp-carpeta-flecha">›</span>
      </div>
    `).join('');
    lista.querySelectorAll('.dp-carpeta').forEach((elCarpeta) => {
      elCarpeta.addEventListener('click', () => {
        _tipoSeleccionado = elCarpeta.dataset.tipo;
        _titularSeleccionado = null;
        actualizarPanel();
      });
    });
  }

  async function obtenerCarpetasPorTipo(tipo) {
    const { data: carpetas, error: errorCarpetas } = await _supabase
      .from('documentos_carpetas')
      .select('persona_id, expediente, nombre_carpeta')
      .eq('tipo_documento', tipo);
    if (errorCarpetas || !carpetas) return [];

    const { data: docs, error: errorDocs } = await _supabase
      .from('documentos')
      .select('persona_id, expediente')
      .eq('tipo_documento', tipo);
    const conteo = new Map();
    (docs || []).forEach((d) => {
      const clave = `${d.persona_id || ''}|${d.expediente || ''}`;
      conteo.set(clave, (conteo.get(clave) || 0) + 1);
    });

    let resultado = carpetas.map((c) => ({
      id: c.persona_id,
      nombre: c.nombre_carpeta,
      expediente: c.expediente || null,
      count: conteo.get(`${c.persona_id || ''}|${c.expediente || ''}`) || 0,
    }));

    // Los titulares normales solo ven su propia carpeta + General/expedientes
    // (las de otros titulares no se muestran, aunque estén registradas).
    if (!_persona.esAdmin) {
      resultado = resultado.filter((c) => c.id === _persona.id || c.id === null);
    }

    resultado.sort((a, b) => {
      if (a.nombre === 'General') return 1;
      if (b.nombre === 'General') return -1;
      return (a.nombre || '').localeCompare(b.nombre || '');
    });
    return resultado;
  }

  async function mostrarTitularesDeTipo() {
    construirBreadcrumb([
      { label: 'Documentos', onClick: 'dpVolverRaizTipos' },
      { label: etiquetaTipo(_tipoSeleccionado), activo: true },
    ]);

    const lista = document.getElementById('dp-lista');
    lista.innerHTML = '<div class="dp-empty">Cargando...</div>';
    const titulares = await obtenerCarpetasPorTipo(_tipoSeleccionado);
    if (!titulares.length) {
      lista.innerHTML = '<div class="dp-empty">No hay carpetas registradas para este tipo todavía.</div>';
      return;
    }
    lista.innerHTML = titulares.map((t, i) => `
      <div class="dp-carpeta" data-idx="${i}">
        <span>${t.id === null && !t.expediente ? '🗒' : '📂'} ${escapeHtml(t.nombre)}</span>
        <span class="dp-carpeta-count">${t.count}</span>
      </div>
    `).join('');
    lista.querySelectorAll('.dp-carpeta').forEach((elCarpeta) => {
      elCarpeta.addEventListener('click', () => {
        _titularSeleccionado = titulares[Number(elCarpeta.dataset.idx)];
        actualizarPanel();
      });
    });
  }

  async function mostrarDocumentosDeTitular() {
    construirBreadcrumb([
      { label: 'Documentos', onClick: 'dpVolverRaizTipos' },
      { label: etiquetaTipo(_tipoSeleccionado), onClick: 'dpVolverTitularesDeTipo' },
      { label: _titularSeleccionado.nombre, activo: true },
    ]);

    const filtros = { tipo_documento: _tipoSeleccionado, persona_id: _titularSeleccionado.id };
    if (_titularSeleccionado.expediente) {
      filtros.expediente = _titularSeleccionado.expediente;
    }
    await renderizarListaDocumentos(filtros);

    // Preseleccionar tipo y titular en el formulario de subida, por comodidad
    // (solo tiene sentido si la carpeta es de un titular o "General", no una categoría libre)
    const selTipo = document.getElementById('dp-tipo');
    if (selTipo) selTipo.value = _tipoSeleccionado;
    if (!_titularSeleccionado.expediente) {
      const selTitular = document.getElementById('dp-titular');
      if (selTitular && _persona.esAdmin) {
        selTitular.value = _titularSeleccionado.id === null ? '__general__' : _titularSeleccionado.id;
      }
    }
  }

  window.dpVolverRaizTipos = function () {
    _tipoSeleccionado = null;
    _titularSeleccionado = null;
    actualizarPanel();
  };
  window.dpVolverTitularesDeTipo = function () {
    _titularSeleccionado = null;
    actualizarPanel();
  };

  // ---- Dispatcher central ----
  async function actualizarPanel() {
    const texto = document.getElementById('dp-search').value.trim();
    const filtrosLista = document.getElementById('dp-filtros-lista');

    if (_modoFiltroParcela) {
      filtrosLista.style.display = 'none';
      document.getElementById('dp-breadcrumb').innerHTML = '';
      const filtros = { ..._filtroParcela };
      if (texto) filtros.texto = texto;
      await renderizarListaDocumentos(filtros);
      return;
    }

    if (_vista === 'lista') {
      filtrosLista.style.display = 'flex';
      document.getElementById('dp-breadcrumb').innerHTML = '';
      await mostrarListaConFiltros(texto);
      return;
    }

    filtrosLista.style.display = 'none';

    if (texto) {
      const filtros = { texto };
      if (_tipoSeleccionado) filtros.tipo_documento = _tipoSeleccionado;
      if (_titularSeleccionado) filtros.persona_id = _titularSeleccionado.id;
      document.getElementById('dp-breadcrumb').innerHTML = '<span class="dp-crumb activo">Resultados de búsqueda</span>';
      await renderizarListaDocumentos(filtros);
      return;
    }

    if (!_tipoSeleccionado) {
      await mostrarRaizTipos();
    } else if (!_titularSeleccionado) {
      await mostrarTitularesDeTipo();
    } else {
      await mostrarDocumentosDeTitular();
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  // ---- API pública ----
  window.initDocumentosPanel = function (supabaseClient, persona) {
    _supabase = supabaseClient;
    _persona = persona; // { id, esAdmin, soloLectura }
    inyectarEstilos();
    construirPanel();
    // DEMO: visitante sin sesión → ve todo pero no puede subir documentos
    if (persona.soloLectura) {
      const zona = document.getElementById('dp-upload-zone');
      if (zona) zona.style.display = 'none';
    }
  };

  window.abrirPanelDocumentos = function (filtro) {
    if (!_supabase || !_persona) {
      console.error('documentos-panel: llama a initDocumentosPanel() antes de abrir el panel.');
      return;
    }

    _modoFiltroParcela = !!(filtro && (filtro.poligono || filtro.parcela || filtro.recinte));
    _filtroParcela = _modoFiltroParcela ? filtro : null;
    _vista = 'carpetas';
    _tipoSeleccionado = null;
    _titularSeleccionado = null;

    actualizarBotonesVista();
    document.getElementById('dp-toggle-vista').style.display = _modoFiltroParcela ? 'none' : 'flex';

    const subtitulo = document.getElementById('dp-subtitulo');
    subtitulo.textContent = _modoFiltroParcela
      ? `Parcela ${[filtro.poligono, filtro.parcela, filtro.recinte].filter(Boolean).join('-')}`
      : 'Explora por tipo de documento';

    document.getElementById('documentos-panel-overlay').style.display = 'block';
    document.getElementById('documentos-panel').classList.add('abierto');
    document.getElementById('dp-search').value = '';

    actualizarPanel();
  };

  window.cerrarPanelDocumentos = function () {
    document.getElementById('documentos-panel-overlay').style.display = 'none';
    document.getElementById('documentos-panel').classList.remove('abierto');
  };
})();
