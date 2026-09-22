import { apiClient, config } from './_index.js';

export const reportsApi = {
  list: () => apiClient.get('/reports'),
  get: (id) => apiClient.get(`/reports/${id}`),
  metrics: (id) => apiClient.get(`/reports/${id}/metrics`),
  logs: (id) => apiClient.get(`/reports/${id}/logs`),
  remove: (id) => apiClient.delete(`/reports/${id}`),
  reportUrl: (id) =>
    apiClient.withToken(`${config.apiBaseUrl}/reports/${id}/report`),
  reportDownloadUrl: (id) =>
    apiClient.withToken(`${config.apiBaseUrl}/reports/${id}/report?download=1`),
};
