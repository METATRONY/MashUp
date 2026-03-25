/**
 * Essence pipeline: analyze → compose → render (see FastAPI /docs).
 * Shapes mirror backend/essence_schema.py (schema_version 1.0.0).
 */

function apiBase() {
  return window.MASHUP_API_BASE || 'http://127.0.0.1:8000';
}

/**
 * @param {Array<{ track_ref: string, source_type: string, source_id: string }>} tracks
 * @param {Partial<{ clip_start_sec: number|null, clip_duration_sec: number|null, include_embeddings: boolean }>} [options]
 */
export async function analyzeTracks(tracks, options = {}) {
  const res = await fetch(`${apiBase()}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: '1.0.0',
      tracks,
      options: {
        include_embeddings: true,
        ...options
      }
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `analyze failed (${res.status})`);
  }
  return res.json();
}

/**
 * @param {{
 *   analyses: unknown[],
 *   assignments: Array<{ track_ref: string, components: string[] }>,
 *   target_bpm?: number|null,
 *   key_policy?: string|null
 * }} body
 */
export async function composeFromAnalyses(body) {
  const res = await fetch(`${apiBase()}/api/compose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: '1.0.0',
      ...body
    })
  });
  if (!res.ok) {
    let detail = await res.text();
    try {
      const j = JSON.parse(detail);
      detail = j.detail ?? detail;
    } catch {
      /* use raw */
    }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return res.json();
}

/**
 * @param {{
 *   recipe_id?: string|null,
 *   compose?: unknown|null,
 *   output_format?: 'wav'|'mp3',
 *   engine?: string
 * }} body
 */
export async function renderEssenceRecipe(body) {
  const res = await fetch(`${apiBase()}/api/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: '1.0.0',
      ...body
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `render failed (${res.status})`);
  }
  return res.json();
}
