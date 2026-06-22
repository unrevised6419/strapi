import { baseConfig } from '../../../rollup.utils.mjs';

export default baseConfig({
  input: {
    index: './src/index.ts',
    cli: './src/cli/index.ts',
    admin: './src/admin.ts',
    'admin-test': './src/admin-test.ts',
    // Phase C (experimental): the prod `server` env build resolves these files as
    // its Rolldown `rollupOptions.input`, so they must ship as real dist files
    // (not be tree-shaken into another chunk). `-manifest` is the TS source-only
    // entry (Task C5); the other is the JS-disk entry.
    'node/server-prod-entry': './src/node/server-prod-entry.ts',
    'node/server-prod-entry-manifest': './src/node/server-prod-entry-manifest.ts',
  },
});
