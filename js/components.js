/**
 * Audio component categories and their individual components.
 */

export const CATEGORIES = [
  {
    id: 'rhythm',
    name: 'Rhythm & Time',
    color: '#f59e0b',
    colorName: 'amber',
    components: [
      { id: 'tempo',  label: 'Tempo',  description: 'Speed/BPM of the track' },
      { id: 'rhythm', label: 'Rhythm', description: 'Pattern of long and short sounds' },
      { id: 'beat',   label: 'Beat',   description: 'Drum and percussion elements' },
      { id: 'meter',  label: 'Meter',  description: 'Time signature and grouping' }
    ]
  },
  {
    id: 'pitch',
    name: 'Pitch & Tone',
    color: '#06b6d4',
    colorName: 'cyan',
    components: [
      { id: 'melody',    label: 'Melody',      description: 'Main singable line' },
      { id: 'harmony',   label: 'Harmony',     description: 'Chords and supporting notes' },
      { id: 'key_scale', label: 'Key & Scale', description: 'Tonal center and mode' },
      { id: 'pitch',     label: 'Pitch',       description: 'Frequency and register' }
    ]
  },
  {
    id: 'color',
    name: 'Color & Expression',
    color: '#10b981',
    colorName: 'green',
    components: [
      { id: 'timbre',       label: 'Timbre',       description: 'Instrument/voice character' },
      { id: 'dynamics',     label: 'Dynamics',     description: 'Volume shape and intensity' },
      { id: 'articulation', label: 'Articulation', description: 'Note attack and release' }
    ]
  },
  {
    id: 'architecture',
    name: 'Architecture',
    color: '#7c3aed',
    colorName: 'purple',
    components: [
      { id: 'texture', label: 'Texture', description: 'Layer density and arrangement' },
      { id: 'form',    label: 'Form',    description: 'Song structure and sections' }
    ]
  }
];

/**
 * Flat lookup: componentId -> { ...component, categoryId, categoryColor, categoryColorName }
 */
const componentLookup = new Map();
CATEGORIES.forEach(cat => {
  cat.components.forEach(comp => {
    componentLookup.set(comp.id, {
      ...comp,
      categoryId: cat.id,
      categoryName: cat.name,
      categoryColor: cat.color,
      categoryColorName: cat.colorName
    });
  });
});

export function getComponentInfo(componentId) {
  return componentLookup.get(componentId) || null;
}

/**
 * Render the full component selector UI for a song.
 */
export function renderComponentSelector(song, store) {
  const wrapper = document.createElement('div');
  wrapper.className = 'component-selector';
  wrapper.id = `selector-${song.id}`;

  const selectedIds = new Set(song.selectedComponents || []);

  for (const category of CATEGORIES) {
    const group = document.createElement('div');
    group.className = 'category-group';
    group.style.setProperty('--category-color', category.color);

    const selectedInCategory = category.components.filter(c => selectedIds.has(c.id)).length;

    group.innerHTML = `
      <div class="category-header">
        <span class="category-name">${category.name}</span>
        <span class="category-count">${selectedInCategory}/${category.components.length}</span>
      </div>
      <div class="component-chips"></div>
    `;

    const chipsContainer = group.querySelector('.component-chips');

    for (const comp of category.components) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'component-chip' + (selectedIds.has(comp.id) ? ' selected' : '');
      chip.draggable = true;
      chip.dataset.componentId = comp.id;
      chip.dataset.categoryId = category.id;
      chip.dataset.songId = song.id;
      chip.style.setProperty('--chip-color', category.color);
      chip.style.setProperty('--chip-bg', category.color + '20');
      chip.style.setProperty('--chip-glow', category.color + '66');

      chip.innerHTML = `
        <span class="chip-dot"></span>
        <span class="chip-label">${comp.label}</span>
      `;
      chip.title = comp.description;

      // Toggle on click
      chip.addEventListener('click', () => {
        toggleComponent(store, song.id, comp.id);
      });

      // Drag support
      chip.addEventListener('dragstart', (e) => {
        if (!selectedIds.has(comp.id)) {
          toggleComponent(store, song.id, comp.id);
        }
        e.dataTransfer.setData('application/json', JSON.stringify({
          songId: song.id,
          componentId: comp.id,
          categoryId: category.id,
          categoryColorName: category.colorName,
          label: comp.label,
          songTitle: song.title
        }));
        e.dataTransfer.effectAllowed = 'copy';
        chip.classList.add('dragging');
      });

      chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging');
      });

      chipsContainer.appendChild(chip);
    }

    wrapper.appendChild(group);
  }

  // "Add selected to mixer" button
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'add-to-mixer-btn';
  addBtn.innerHTML = `
    <svg width="16" height="16"><use href="#icon-plus"/></svg>
    Add Selected to Mixer
  `;
  addBtn.addEventListener('click', () => {
    addSelectedToMixer(song, store);
  });
  wrapper.appendChild(addBtn);

  return wrapper;
}

/**
 * Toggle a component selection on a song.
 */
export function toggleComponent(store, songId, componentId) {
  const state = store.getState();
  const song = state.songs.find(s => s.id === songId);
  if (!song) return;

  const selected = new Set(song.selectedComponents || []);
  if (selected.has(componentId)) {
    selected.delete(componentId);
  } else {
    selected.add(componentId);
  }

  store.updateSong(songId, { selectedComponents: [...selected] });
}

/**
 * Add all selected components of a song to the mixer as tracks.
 */
function addSelectedToMixer(song, store) {
  const state = store.getState();
  const existingTrackKeys = new Set(
    state.mashup.tracks.map(t => `${t.songId}:${t.componentId}`)
  );

  const selected = song.selectedComponents || [];
  let added = 0;

  for (const compId of selected) {
    const key = `${song.id}:${compId}`;
    if (existingTrackKeys.has(key)) continue;

    const info = getComponentInfo(compId);
    if (!info) continue;

    store.addTrack({
      id: `track-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      songId: song.id,
      componentId: compId,
      categoryColorName: info.categoryColorName,
      label: info.label,
      songTitle: song.title,
      volume: 75,
      pan: 0,
      muted: false,
      soloed: false
    });
    added++;
  }

  if (added > 0) {
    window.dispatchEvent(new CustomEvent('mashup:toast', {
      detail: { message: `Added ${added} component${added > 1 ? 's' : ''} to mixer`, type: 'success' }
    }));
  } else if (selected.length > 0) {
    window.dispatchEvent(new CustomEvent('mashup:toast', {
      detail: { message: 'All selected components are already in the mixer', type: 'info' }
    }));
  } else {
    window.dispatchEvent(new CustomEvent('mashup:toast', {
      detail: { message: 'Select some components first', type: 'info' }
    }));
  }
}
