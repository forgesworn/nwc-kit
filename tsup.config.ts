import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/extensions/05.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: 'es2022',
})
