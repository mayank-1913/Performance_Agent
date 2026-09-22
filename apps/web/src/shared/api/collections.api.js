import { apiClient } from './client.js';

export const collectionsApi = {
  list: () => apiClient.get('/collections'),
  get: (id) => apiClient.get(`/collections/${id}`),
  authCheck: (id, environmentId) => {
    const q = environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : '';
    return apiClient.get(`/collections/${id}/auth-check${q}`);
  },
  tree: (id) => apiClient.get(`/collections/${id}/tree`),
  upload: (file) => {
    const form = new FormData();
    form.append('collection', file);
    return apiClient.post('/collections', form);
  },
  remove: (id) => apiClient.delete(`/collections/${id}`),
};
