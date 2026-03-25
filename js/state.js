/**
 * Simple pub-sub store for application state.
 */

import { isValidComponentId, validateExclusiveClaims } from './constants/components.js';

function normalizeComponents(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.filter(isValidComponentId))];
}

export function createStore() {
  let state = {
    songs: [],
    mashup: {
      tracks: [],
      bpm: 120,
      playing: false,
      currentTime: 0,
      masterVolume: 80,
      generation: {
        status: 'idle',
        jobId: null,
        resultUrl: null,
        error: null
      }
    }
  };

  const listeners = new Set();

  function notify() {
    listeners.forEach((fn) => fn(state));
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
        songs: state.songs.map((song) => (song.id === id ? { ...song, ...updates } : song))
      };
      notify();
    },

    removeSong(id) {
      state = {
        ...state,
        songs: state.songs.filter((s) => s.id !== id),
        mashup: {
          ...state.mashup,
          tracks: state.mashup.tracks.filter((t) => t.songId !== id)
        }
      };
      notify();
    },

    addTrack(track) {
      const withDefaults = {
        claimedComponents: [],
        ...track
      };
      state = {
        ...state,
        mashup: {
          ...state.mashup,
          tracks: [...state.mashup.tracks, withDefaults]
        }
      };
      notify();
    },

    updateTrack(trackId, updates) {
      state = {
        ...state,
        mashup: {
          ...state.mashup,
          tracks: state.mashup.tracks.map((t) => (t.id === trackId ? { ...t, ...updates } : t))
        }
      };
      notify();
    },

    /**
     * Toggle a component for a track; enforces global exclusivity.
     * @returns {{ ok: boolean, reason?: string }}
     */
    toggleTrackComponent(trackId, componentId) {
      if (!isValidComponentId(componentId)) return { ok: false, reason: 'invalid' };

      const tracks = state.mashup.tracks;
      const track = tracks.find((t) => t.id === trackId);
      if (!track) return { ok: false, reason: 'not_found' };

      const current = normalizeComponents(track.claimedComponents);
      const isOn = current.includes(componentId);

      if (isOn) {
        const next = current.filter((c) => c !== componentId);
        state = {
          ...state,
          mashup: {
            ...state.mashup,
            tracks: tracks.map((t) => (t.id === trackId ? { ...t, claimedComponents: next } : t))
          }
        };
        notify();
        return { ok: true };
      }

      const takenBy = tracks.find(
        (t) => t.id !== trackId && (t.claimedComponents || []).includes(componentId)
      );
      if (takenBy) return { ok: false, reason: 'taken' };

      const next = [...current, componentId];
      state = {
        ...state,
        mashup: {
          ...state.mashup,
          tracks: tracks.map((t) => (t.id === trackId ? { ...t, claimedComponents: next } : t))
        }
      };
      notify();
      return { ok: true };
    },

    updateTrackComponents(trackId, components) {
      const normalized = normalizeComponents(components);
      const tracks = state.mashup.tracks;
      const hypothetical = tracks.map((t) =>
        t.id === trackId ? { ...t, claimedComponents: normalized } : t
      );
      const { ok, duplicates } = validateExclusiveClaims(hypothetical);
      if (!ok) return { ok: false, duplicates };
      state = {
        ...state,
        mashup: {
          ...state.mashup,
          tracks: hypothetical
        }
      };
      notify();
      return { ok: true };
    },

    removeTrack(trackId) {
      state = {
        ...state,
        mashup: {
          ...state.mashup,
          tracks: state.mashup.tracks.filter((t) => t.id !== trackId)
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

    setGeneration(updates) {
      state = {
        ...state,
        mashup: {
          ...state.mashup,
          generation: { ...state.mashup.generation, ...updates }
        }
      };
      notify();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}
