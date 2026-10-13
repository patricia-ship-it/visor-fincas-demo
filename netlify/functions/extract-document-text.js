// netlify/functions/extract-document-text.js
//
// Se llama justo después de subir un documento. Descarga el archivo desde
// Supabase Storage, extrae el texto (solo PDFs "de texto" por ahora — un
// PDF escaneado sin capa de texto no producirá contenido; eso requeriría
// OCR aparte, no incluido en esta versión) y lo guarda en `contenido_extraido`
// para que quede indexado en la búsqueda full-text.
//
// Requiere en variables de entorno de Netlify:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// Requiere en netlify/functions/package.json la dependencia "pdf-parse".

const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse');

const BUCKET = 'documentos-fincas';
const LIMITE_CARACTERES = 100000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, body: 'Falta token de sesión' };
  }
  const token = authHeader.replace('Bearer ', '');

  let documentoId;
  try {
    ({ documento_id: documentoId } = JSON.parse(event.body || '{}'));
  } catch (e) {
    return { statusCode: 400, body: 'JSON inválido' };
  }
  if (!documentoId) {
    return { statusCode: 400, body: 'Falta documento_id' };
  }

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Verificar que el token corresponde a un usuario real con sesión válida
  const { data: userData, error: errorUser } = await supabaseAdmin.auth.getUser(token);
  if (errorUser || !userData?.user) {
    return { statusCode: 401, body: 'Sesión inválida' };
  }

  const { data: doc, error: errorDoc } = await supabaseAdmin
    .from('documentos')
    .select('id, storage_path, mime_type')
    .eq('id', documentoId)
    .single();

  if (errorDoc || !doc) {
    return { statusCode: 404, body: 'Documento no encontrado' };
  }

  // Solo sabemos extraer texto de PDFs por ahora
  if (doc.mime_type !== 'application/pdf') {
    await supabaseAdmin.from('documentos').update({ texto_indexado: true }).eq('id', documentoId);
    return { statusCode: 200, body: JSON.stringify({ ok: true, procesado: false, razon: 'tipo no soportado' }) };
  }

  try {
    const { data: archivo, error: errorDescarga } = await supabaseAdmin
      .storage.from(BUCKET)
      .download(doc.storage_path);
    if (errorDescarga) throw errorDescarga;

    const buffer = Buffer.from(await archivo.arrayBuffer());
    const resultado = await pdfParse(buffer);
    const texto = (resultado.text || '').trim().slice(0, LIMITE_CARACTERES);

    await supabaseAdmin
      .from('documentos')
      .update({ contenido_extraido: texto || null, texto_indexado: true })
      .eq('id', documentoId);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, procesado: true, caracteres: texto.length }),
    };
  } catch (e) {
    console.error('extract-document-text error:', e);
    // Marcamos como intentado igualmente para no reintentar en bucle
    await supabaseAdmin.from('documentos').update({ texto_indexado: true }).eq('id', documentoId);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
