import { apiClient, config } from './_index.js';

export const runsApi = {
  list: () => apiClient.get('/runs'),
  get: (runId) => apiClient.get(`/runs/${runId}`),
  logs: (runId) => apiClient.get(`/runs/${runId}/logs`),
  prepare: (payload) => apiClient.post('/runs/prepare', payload),
  start: (payload) => apiClient.post('/runs', payload),
  stop: (runId) => apiClient.post(`/runs/${runId}/stop`, {}),
  streamUrl: (runId) =>
    apiClient.withToken(`${config.apiBaseUrl}/runs/${runId}/stream`),
  summary: (runId) => apiClient.get(`/runs/${runId}/summary`),
  metrics: (runId) => apiClient.get(`/runs/${runId}/metrics`),
  reportUrl: (runId) =>
    apiClient.withToken(`${config.apiBaseUrl}/runs/${runId}/report`),
  reportDownloadUrl: (runId) =>
    apiClient.withToken(`${config.apiBaseUrl}/runs/${runId}/report?download=1`),
};
