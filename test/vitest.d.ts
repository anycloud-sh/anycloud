import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseTemplatePath: string;
    testCatalogsPath: string;
    constrainedE2E: boolean;
  }
}
