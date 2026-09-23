// Builds the GitHub Pages site into docs/.
//
// Deliberately dependency-free beyond the esbuild already present for
// check:browser-bundle. This package's whole claim is one runtime dependency
// and a small audited surface; a demo site is not a reason to add a frontend
// toolchain to it.
import { build } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const site = resolve(root, 'site')
const out = resolve(root, 'docs')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const result = await build({
  entryPoints: [resolve(site, 'demo.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  sourcemap: false,
  outfile: resolve(out, 'demo.js'),
  logLevel: 'error',
  metafile: true,
})

// The version shown on the page comes from package.json at build time, so a
// release cannot leave the site advertising the previous one.
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const VERSION_PLACEHOLDER = '__NWC_KIT_VERSION__'

for (const file of ['index.html', 'lnurlcash.html', 'styles.css', 'favicon.svg']) {
  if (file.endsWith('.html')) {
    const source = await readFile(resolve(site, file), 'utf8')
    await writeFile(resolve(out, file), source.replaceAll(VERSION_PLACEHOLDER, version))
  } else {
    await cp(resolve(site, file), resolve(out, file))
  }
}

// The three faces are served from this domain because the page's own CSP
// forbids a third-party request and the colophon says so out loud.
await cp(resolve(site, 'fonts'), resolve(out, 'fonts'), { recursive: true })

// The site is served as plain static files. This only matters if the output is
// ever handed to GitHub Pages as a fallback, which would otherwise run it
// through Jekyll and strip anything beginning with an underscore.
await writeFile(resolve(out, '.nojekyll'), '')

const bytes = Object.values(result.metafile.outputs)[0].bytes
const html = await readFile(resolve(out, 'index.html'), 'utf8')
if (!html.includes('demo.js')) throw new Error('index.html does not load the demo bundle')
if (html.includes(VERSION_PLACEHOLDER)) throw new Error('index.html still carries the version placeholder')
if (!html.includes(`v${version},`)) throw new Error('index.html does not show the package version')
console.log(`site → docs/ (demo.js ${(bytes / 1024).toFixed(1)} KB)`)
