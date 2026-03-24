/**
 * Simple pub-sub store for application state.
 */
export function createStore() {
  let state = {
    songs: [],
    mashup: {
      tracks: [],
      bpm: 120,
      playing: false,
      currentTime: 0
    }
  };

  const listeners = new Set();

  function notify() {
    listeners.forEach(fn => fn(state));
  }

  return {
    getState() {
      return state;
    },

    setState(partial) {
      state = { ...state, ...partial };
      notify();
    },

    updateSong(id, updates) {
      state = {
        ...state,
        songs: state.songs.map(song =>
          song.id === id ? { ...song, ...updates } : song
        )
      };
      notify();
    },

    removeSong(id) {
      state = {
        ...state,
        songs: state.songs.filter(s => s.id !== id),
        mashup: {
          ...state.mashup,
          tracks: state.mashup.tracks.filter(t => t.songId !== id)
        }
      };
      notify();
    },

    addTrack(track) {
      state = {
        ...state,
        mashup: {
          ...state.mashup,
          tracks: [...state.mashup.tracks, track]
        }
      };
      notify();
    },

    updateTrack(trackId, updates) {
      state = {
        ...state,
        mashup: {
          ...state.mashup,
          tracks: state.mashup.tracks.map(t =>
            t.id === trackId ? { ...t, ...updates } : t
          )
        }
      };
      notify();
    },

    removeTrack(trackId) {
      state = {
        ...state,
        mashup: {
          ...state.mashup,
          tracks: state.mashup.tracks.filter(t => t.id !== trackId)
        }
      };
      notify();
    },

    updateMashup(updates) {
      state = {
        ...state,
        mashup: { ...state.mashup, ...updates }
      };
      notify();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}
