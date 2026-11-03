import { httpsOrigin } from '../deployment/config';

export type UploadOrigins = { apiOrigin: string; appOrigin: string };
export class UploadConfigError extends Error {}

/** No configuration means local uploads. A partial or invalid hybrid setup fails closed. */
export function uploadOrigins(): UploadOrigins | null {
  const api = process.env.PUBLIC_API_ORIGIN;
  const app = process.env.APP_PUBLIC_ORIGIN;
  if (!api && !app) return null;
  if (!api || !app) throw new UploadConfigError('Configure both PUBLIC_API_ORIGIN and APP_PUBLIC_ORIGIN for direct uploads.');
  let apiOrigin: string, appOrigin: string;
  try {
    apiOrigin = httpsOrigin(api, 'PUBLIC_API_ORIGIN');
    appOrigin = httpsOrigin(app, 'APP_PUBLIC_ORIGIN');
  } catch (error) {
    throw new UploadConfigError(error instanceof Error ? error.message : 'Invalid direct upload origins.');
  }
  if (apiOrigin === appOrigin) throw new UploadConfigError('The application and persistent API must use different origins for direct uploads.');
  return { apiOrigin, appOrigin };
}
