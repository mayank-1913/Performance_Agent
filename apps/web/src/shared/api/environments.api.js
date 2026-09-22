import { apiClient } from './_index.js';

export const environmentsApi = {
  list: () => apiClient.get('/environments'),
  get: (id) => apiClient.get(`/environments/${id}`),
  upload: (file) => {
    const form = new FormData();
    form.append('environment', file);
    return apiClient.post('/environments', form);
  },
  remove: (id) => apiClient.delete(`/environments/${id}`),
};
