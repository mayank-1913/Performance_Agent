'use strict';

/**
 * Phase 7 realistic collection builder.
 *
 * Produces a Postman v2.1 collection that exercises the full feature
 * matrix Phase 7 has to certify. Every URL uses {{baseUrl}} so the same
 * collection can run against the local audit server on any port.
 *
 * Features exercised:
 *   - nested folders (2 levels deep)
 *   - GET / POST / PUT / PATCH / DELETE
 *   - path variables via url.variable[]
 *   - query parameters via url.query[]
 *   - headers (including a static Cookie header case elsewhere)
 *   - JSON body
 *   - raw body
 *   - x-www-form-urlencoded
 *   - GraphQL body
 *   - login → captured token flow via pm.environment.set + response_token_body
 *   - {{jwt_token}} + {{access_token}} + custom-name {{myApiToken}} placeholders
 *   - collection variables (baseUrl)
 *   - custom auth header (X-Auth-Token)
 */

function collection({ name, baseUrl }) {
  return {
    info: { name, schema: 'v2.1' },
    variable: [{ key: 'baseUrl', value: baseUrl }],
    item: [
      // Root-level GET
      {
        name: 'Health',
        request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/health' } },
      },

      // Nested folder: auth
      {
        name: 'Auth',
        item: [
          {
            name: 'Login',
            request: {
              method: 'POST',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              url: { raw: '{{baseUrl}}/login' },
              body: { mode: 'raw', raw: '{"u":"a","p":"b"}', options: { raw: { language: 'json' } } },
            },
            event: [
              {
                listen: 'test',
                script: {
                  exec: [
                    'const j = pm.response.json();',
                    'pm.environment.set("access_token", j.access_token);',
                    'pm.collectionVariables.set("captured_token", j.access_token);',
                  ],
                },
              },
            ],
          },
          {
            name: 'Get Profile',
            request: {
              method: 'GET',
              header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
              url: { raw: '{{baseUrl}}/me' },
            },
          },
        ],
      },

      // Nested folder: users
      {
        name: 'Users',
        item: [
          {
            name: 'Get User by ID',
            request: {
              method: 'GET',
              header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
              url: {
                raw: '{{baseUrl}}/users/:id',
                host: ['{{baseUrl}}'],
                path: ['users', ':id'],
                variable: [{ key: 'id', value: '42' }],
              },
            },
          },
          {
            name: 'Update User',
            request: {
              method: 'PUT',
              header: [
                { key: 'Authorization', value: 'Bearer {{access_token}}' },
                { key: 'Content-Type', value: 'application/json' },
              ],
              url: {
                raw: '{{baseUrl}}/users/:id',
                path: ['users', ':id'],
                variable: [{ key: 'id', value: '42' }],
              },
              body: { mode: 'raw', raw: '{"name":"phase7"}', options: { raw: { language: 'json' } } },
            },
          },
          {
            name: 'Patch User',
            request: {
              method: 'PATCH',
              header: [
                { key: 'Authorization', value: 'Bearer {{access_token}}' },
                { key: 'Content-Type', value: 'application/json' },
              ],
              url: {
                raw: '{{baseUrl}}/users/:id',
                path: ['users', ':id'],
                variable: [{ key: 'id', value: '42' }],
              },
              body: { mode: 'raw', raw: '{"nickname":"p7"}', options: { raw: { language: 'json' } } },
            },
          },
          {
            name: 'Delete User',
            request: {
              method: 'DELETE',
              header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
              url: {
                raw: '{{baseUrl}}/users/:id',
                path: ['users', ':id'],
                variable: [{ key: 'id', value: '42' }],
              },
            },
          },
        ],
      },

      // Nested folder: search + form + graphql
      {
        name: 'API Features',
        item: [
          {
            name: 'Search',
            request: {
              method: 'GET',
              header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
              url: {
                raw: '{{baseUrl}}/search?q=hello&limit=5&tenant={{tenant}}',
                host: ['{{baseUrl}}'],
                path: ['search'],
                query: [
                  { key: 'q', value: 'hello' },
                  { key: 'limit', value: '5' },
                  { key: 'tenant', value: '{{tenant}}' },
                ],
              },
            },
          },
          {
            name: 'Echo JSON',
            request: {
              method: 'POST',
              header: [
                { key: 'Authorization', value: 'Bearer {{access_token}}' },
                { key: 'Content-Type', value: 'application/json' },
              ],
              url: { raw: '{{baseUrl}}/echo' },
              body: {
                mode: 'raw',
                raw: '{"tenant":"{{tenant}}","userId":42}',
                options: { raw: { language: 'json' } },
              },
            },
          },
          {
            name: 'Form Submit',
            request: {
              method: 'POST',
              header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
              url: { raw: '{{baseUrl}}/form' },
              body: {
                mode: 'urlencoded',
                urlencoded: [
                  { key: 'name', value: 'phase7-user' },
                  { key: 'tenant', value: '{{tenant}}' },
                ],
              },
            },
          },
          {
            name: 'GraphQL Ping',
            request: {
              method: 'POST',
              header: [
                { key: 'Authorization', value: 'Bearer {{access_token}}' },
                { key: 'Content-Type', value: 'application/json' },
              ],
              url: { raw: '{{baseUrl}}/graphql' },
              body: {
                mode: 'graphql',
                graphql: { query: '{ me { id } }', variables: '{}' },
              },
            },
          },
        ],
      },

      // Root-level custom auth header (X-Auth-Token). Exercises the
      // Phase 2 name-agnostic resolver — {{myApiToken}} is a non-standard
      // placeholder name.
      {
        name: 'CustomAuthEndpoint',
        request: {
          method: 'GET',
          header: [{ key: 'X-Auth-Token', value: '{{myApiToken}}' }],
          url: { raw: '{{baseUrl}}/custom-auth' },
        },
      },

      // Cookie flow: /session/set responds with Set-Cookie; K6's per-VU
      // cookie jar automatically replays it on the /session/read call
      // in the same iteration. Proves the runtime cookie-propagation
      // path end to end without needing pm.* cookie helpers.
      {
        name: 'SessionSet',
        request: {
          method: 'GET',
          header: [],
          url: { raw: '{{baseUrl}}/session/set' },
        },
      },
      {
        name: 'SessionRead',
        request: {
          method: 'GET',
          header: [],
          url: { raw: '{{baseUrl}}/session/read' },
        },
      },
    ],
  };
}

module.exports = { collection };
