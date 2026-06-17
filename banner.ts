import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageJson = { name: string; version: string; license?: string };

/**
 * Builds a multi-line dist banner for a publishable package.
 *
 * Pass `import.meta.url` from the calling `tsdown.config.ts`. The helper
 * resolves the directory, reads `package.json`, and returns a legal
 * comment block. Example output:
 *
 * ```text
 * /*!
 *  * @responsivevoice/core v2.0.0-alpha.16
 *  * https://responsivevoice.org
 *  * Copyright (c) 2026 ResponsiveVoice, Inc.
 *  * @license MIT
 *  *\/
 * ```
 *
 * Format notes:
 *   - `/*!` prefix is the "legal comment" marker preserved by terser, uglify,
 *     esbuild, and rollup by default, so the banner survives downstream
 *     re-bundling.
 *   - `@license MIT` is the machine-readable JSDoc tag that SBOM generators
 *     and license-audit tools (license-checker, GitHub dep graph) parse.
 *   - The copyright line satisfies MIT's redistribution clause for CDN/IIFE
 *     consumers who receive only the bundle with no sidecar LICENSE. For
 *     npm consumers the sidecar LICENSE ships in the tarball regardless.
 */
export function bannerFor(importMetaUrl: string): string {
  const packageDir = dirname(fileURLToPath(importMetaUrl));
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageJson;
  const license = pkg.license ?? 'MIT';
  const year = new Date().getFullYear();
  const licenseBanner = [
    '/*!',
    ` * ${pkg.name} v${pkg.version}`,
    ' * https://responsivevoice.org',
    ` * Copyright (c) ${year} ResponsiveVoice, Inc.`,
    ` * @license ${license}`,
    ' */',
  ].join('\n');

  // Preserve the source's `@packageDocumentation` block in the bundled .d.mts.
  // Rolldown's d.ts bundler strips floating top-of-file TSDoc blocks during
  // tree-shaking, which erases the package-level description. Re-injecting it
  // via the banner keeps source as the single source of truth while ensuring
  // API Extractor finds the block in dist output.
  const packageDocBlock = extractPackageDocumentationBlock(join(packageDir, 'src', 'index.ts'));
  return packageDocBlock ? `${licenseBanner}\n${packageDocBlock}` : licenseBanner;
}

function extractPackageDocumentationBlock(indexPath: string): string | null {
  try {
    const src = readFileSync(indexPath, 'utf8');
    const match = src.match(/\/\*\*[\s\S]*?@packageDocumentation[\s\S]*?\*\//);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}
