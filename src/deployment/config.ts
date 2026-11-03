type DeploymentEnvironment = {
  [key: string]: string | undefined;
  COUNTERSHOT_BACKEND_ORIGIN?: string;
  APP_PUBLIC_ORIGIN?: string;
  VERCEL_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  VERCEL?: string;
};

/** Build-time configuration, never a destination supplied by a browser request. */
export function httpsOrigin(value: string, key: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${key} must be a bare HTTPS origin, for example https://api.example.com.`); }
  if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(value) || /[\s\\@]/.test(value) || parsed.protocol !== 'https:' || !parsed.hostname ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || /[?#]/.test(value))
    throw new Error(`${key} must be a bare HTTPS origin without credentials, a path, query or fragment.`);
  return parsed.origin;
}

export function backendOrigin(environment: DeploymentEnvironment): string | null {
  const configured = environment.COUNTERSHOT_BACKEND_ORIGIN;
  if (configured === undefined || configured === '') {
    if (environment.VERCEL === '1') throw new Error('A Vercel frontend requires COUNTERSHOT_BACKEND_ORIGIN for its separate persistent backend. Local SQLite, media files and the worker cannot be deployed as frontend-only functions.');
    return null;
  }
  const origin = httpsOrigin(configured, 'COUNTERSHOT_BACKEND_ORIGIN');
  const frontendOrigins: string[] = [];
  if (environment.APP_PUBLIC_ORIGIN) frontendOrigins.push(httpsOrigin(environment.APP_PUBLIC_ORIGIN, 'APP_PUBLIC_ORIGIN'));
  for (const key of ['VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL'] as const) {
    const host = environment[key];
    if (host) frontendOrigins.push(httpsOrigin(`https://${host}`, key));
  }
  if (frontendOrigins.includes(origin))
    throw new Error('COUNTERSHOT_BACKEND_ORIGIN points to this frontend. Use the separate persistent backend origin to avoid an API proxy loop.');
  return origin;
}

export function apiRewrites(environment: DeploymentEnvironment) {
  const origin = backendOrigin(environment);
  return {
    beforeFiles: origin ? [{ source: '/api/:path*', destination: `${origin}/api/:path*` }] : [],
    afterFiles: [],
    fallback: [],
  };
}
