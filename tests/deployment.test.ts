import assert from 'node:assert/strict';
import test from 'node:test';
import { apiRewrites, backendOrigin } from '../src/deployment/config';

test('local and persistent-backend deployment keeps API routes local', () => {
  assert.deepEqual(apiRewrites({}), { beforeFiles: [], afterFiles: [], fallback: [] });
  assert.equal(backendOrigin({ COUNTERSHOT_BACKEND_ORIGIN: '' }), null);
});

test('a Vercel deployment cannot silently fall back to local filesystem API handlers', () => {
  assert.throws(() => apiRewrites({ VERCEL: '1' }), /requires COUNTERSHOT_BACKEND_ORIGIN/);
});

test('hybrid frontend overrides local API handlers before filesystem routing', () => {
  assert.deepEqual(apiRewrites({ COUNTERSHOT_BACKEND_ORIGIN: 'https://api.example.com/', APP_PUBLIC_ORIGIN: 'https://countershot.example.com' }), {
    beforeFiles: [{ source: '/api/:path*', destination: 'https://api.example.com/api/:path*' }], afterFiles: [], fallback: [],
  });
});

test('backend routing rejects HTTP, credentials and ambiguous non-origin destinations', () => {
  for (const value of ['http://api.example.com', 'https://user:password@api.example.com', 'https://@api.example.com', 'https://api.example.com/api', 'https://api.example.com/a/..', 'https://api.example.com/.', 'https://api.example.com/%2e', 'https:////api.example.com', 'https://api.example.com//', 'https://api.example.com?token=x', 'https://api.example.com#fragment', 'https://api.example.com?', ' https://api.example.com', 'https://api.example.com ', 'https://api.\nexample.com', 'https://api.example.com\\'])
    assert.throws(() => backendOrigin({ COUNTERSHOT_BACKEND_ORIGIN: value }), /bare HTTPS origin/);
});

test('hybrid routing rejects self-proxy loops for public and Vercel deployment origins', () => {
  for (const frontend of [
    { APP_PUBLIC_ORIGIN: 'https://countershot.example.com/' },
    { VERCEL_URL: 'countershot.example.com' },
    { VERCEL_PROJECT_PRODUCTION_URL: 'countershot.example.com' },
  ]) assert.throws(() => backendOrigin({ COUNTERSHOT_BACKEND_ORIGIN: 'https://countershot.example.com', ...frontend }), /proxy loop/);
  assert.equal(backendOrigin({ COUNTERSHOT_BACKEND_ORIGIN: 'https://api.example.com', VERCEL_URL: 'countershot-preview.vercel.app' }), 'https://api.example.com');
});
