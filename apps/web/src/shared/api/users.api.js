import { apiClient } from './client.js';

export const usersApi = {
  list: () => apiClient.get('/auth/users'),
  create: ({ username, password, role }) =>
    apiClient.post('/auth/users', { username, password, role }),
  update: (id, { password, role }) =>
    apiClient.put(`/auth/users/${id}`, { password, role }),
  remove: (id) => apiClient.delete(`/auth/users/${id}`),
};
