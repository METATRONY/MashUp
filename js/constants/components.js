/**
 * Nine exclusive music components (IDs stable for API + backend).
 */
export const COMPONENTS = [
  { id: 'melody', label: 'Melody' },
  { id: 'harmony', label: 'Harmony' },
  { id: 'bass', label: 'Bass' },
  { id: 'drums', label: 'Drums' },
  { id: 'vocals', label: 'Vocals' },
  { id: 'pads', label: 'Pads' },
  { id: 'percussion', label: 'Percussion' },
  { id: 'fx', label: 'FX' },
  { id: 'other', label: 'Other' }
];

export const COMPONENT_IDS = COMPONENTS.map((c) => c.id);

const VALID = new Set(COMPONENT_IDS);

/** @param {string} id */
export function isValidComponentId(id) {
  return VALID.has(id);
}

/**
 * Returns duplicate component IDs if any track claims the same component twice globally.
 * @param {Array<{ trackId: string, components: string[] }>} selections
 * @returns {string[]} duplicate component ids (empty if valid)
 */
export function findExclusiveViolations(selections) {
  const seen = new Map();
  const dupes = new Set();
  for (const { trackId, components } of selections) {
    for (const c of components) {
      if (!VALID.has(c)) continue;
      if (seen.has(c)) dupes.add(c);
      else seen.set(c, trackId);
    }
  }
  return [...dupes];
}

/**
 * @param {Array<{ id: string, claimedComponents?: string[] }>} tracks
 * @returns {{ ok: boolean, duplicates: string[] }}
 */
export function validateExclusiveClaims(tracks) {
  const selections = tracks.map((t) => ({
    trackId: t.id,
    components: [...new Set(t.claimedComponents || [])].filter(isValidComponentId)
  }));
  const duplicates = findExclusiveViolations(selections);
  return { ok: duplicates.length === 0, duplicates };
}

/**
 * Components claimed by any track other than `excludeTrackId`.
 * @param {Array<{ id: string, claimedComponents?: string[] }>} tracks
 * @param {string} excludeTrackId
 */
export function componentsClaimedByOthers(tracks, excludeTrackId) {
  const set = new Set();
  for (const t of tracks) {
    if (t.id === excludeTrackId) continue;
    for (const c of t.claimedComponents || []) {
      if (VALID.has(c)) set.add(c);
    }
  }
  return set;
}

/**
 * Ready to call generate API: ≥2 tracks, each has ≥1 component, global exclusivity, ≥1 component total.
 * @param {Array<{ claimedComponents?: string[] }>} tracks
 */
export function canGenerateMashup(tracks) {
  if (!tracks || tracks.length < 2) return false;
  const { ok } = validateExclusiveClaims(tracks);
  if (!ok) return false;
  const all = tracks.every((t) => (t.claimedComponents || []).length > 0);
  if (!all) return false;
  const total = tracks.reduce((n, t) => n + (t.claimedComponents || []).length, 0);
  return total >= 1;
}
