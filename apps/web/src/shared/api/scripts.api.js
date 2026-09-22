import { apiClient, config } from './_index.js';

export const scriptsApi = {
  list: (collectionId) =>
    apiClient.get(`/scripts${collectionId ? `?collectionId=${encodeURIComponent(collectionId)}` : ''}`),
  get: (id) => apiClient.get(`/scripts/${id}`),
  generate: (payload) => apiClient.post('/scripts/generate', payload),
  downloadUrl: (id) => `${config.apiBaseUrl}/scripts/${id}/download`,
};
