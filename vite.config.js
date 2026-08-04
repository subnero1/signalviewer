import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `--mode singlefile` (see the build:static script) folds everything into one
// self-contained index.html. The plugin sets the build config it needs, so the
// normal `build` is left as a plain multi-asset Vite build.
export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    ...(mode === 'singlefile'
      ? [viteSingleFile({ removeViteModuleLoader: true })] // nothing is fetched, so drop the chunk loader
      : [])
  ]
}));
