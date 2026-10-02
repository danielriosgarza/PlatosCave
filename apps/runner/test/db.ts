// The integration project's global setup (which provides `itestPrefix`) belongs to apps/server;
// its `ProvidedContext` augmentation must be in this program for `inject` to typecheck.
/// <reference path="../../server/test/integration/global-setup.ts" />
export { createTestDatabase, type TestDatabase } from '../../server/test/integration/db';
