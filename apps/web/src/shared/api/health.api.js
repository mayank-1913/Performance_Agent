import { apiClient } from './client.js';

export const healthApi = {
  check: () => apiClient.get('/health'),
};
