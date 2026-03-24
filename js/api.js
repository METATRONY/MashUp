/**
 * Simulated API for "extracting" audio components.
 * Uses the audio.js module to generate real AudioBuffers.
 */

import { generateComponentAudio, initAudio } from './audio.js';

const jobs = new Map();

/**
 * Simulate extracting components from a video.
 * Returns a job ID; poll with getJobStatus().
 */
export function extractComponents(songId, componentIds, bpm = 120) {
  initAudio();

  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id: jobId,
    songId,
    componentIds: [...componentIds],
    status: 'processing',
    progress: 0,
    results: new Map(), // componentId -> AudioBuffer
    error: null
  };

  jobs.set(jobId, job);

  // Simulate progressive extraction
  const totalSteps = componentIds.length;
  let currentStep = 0;

  const processNext = () => {
    if (currentStep >= totalSteps) {
      job.status = 'complete';
      job.progress = 100;
      return;
    }

    const compId = componentIds[currentStep];
    try {
      const buffer = generateComponentAudio(compId, bpm);
      job.results.set(compId, buffer);
    } catch (e) {
      console.error(`Failed to generate audio for ${compId}:`, e);
    }

    currentStep++;
    job.progress = Math.round((currentStep / totalSteps) * 100);

    if (currentStep < totalSteps) {
      setTimeout(processNext, 400 + Math.random() * 600);
    } else {
      job.status = 'complete';
    }
  };

  // Start after a brief initial delay
  setTimeout(processNext, 300);

  return jobId;
}

/**
 * Get current status of an extraction job.
 */
export function getJobStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { status: 'not_found' };
  return {
    id: job.id,
    songId: job.songId,
    status: job.status,
    progress: job.progress,
    completedComponents: [...job.results.keys()],
    error: job.error
  };
}

/**
 * Get the generated AudioBuffer for a component once extraction is complete.
 */
export function getExtractedBuffer(jobId, componentId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return job.results.get(componentId) || null;
}

/**
 * Wait for a job to complete, returning a promise.
 */
export function waitForJob(jobId) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const status = getJobStatus(jobId);
      if (status.status === 'complete') {
        resolve(status);
      } else if (status.status === 'error') {
        reject(new Error(status.error));
      } else if (status.status === 'not_found') {
        reject(new Error('Job not found'));
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}
