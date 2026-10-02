import type { SkysApi } from './client';
import { createHttpApi } from './http';
import { createMockApi } from './mock';

export type { SkysApi } from './client';
export * from './types';

/**
 * VITE_SKYS_API_URL selects the real back end, e.g. "http://localhost:8787"
 * or "" for same-origin. Leave it unset to run on the in-memory mock.
 */
const url = import.meta.env.VITE_SKYS_API_URL as string | undefined;
export const api: SkysApi = url === undefined ? createMockApi() : createHttpApi(url);
export const usingMock = url === undefined;
