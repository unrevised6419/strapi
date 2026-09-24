#!/usr/bin/env node

/**
 * Type-checks the published declaration files of a workspace package the way an external
 * consumer sees them: the package is imported by name (through its `exports` map), library
 * checking is on, and the check runs under every module resolution mode a consumer may use.
 *
 * It reports two kinds of problems:
 *   - type errors inside first-party declaration files (errors in third-party `.d.ts` files are
 *     only counted, since they are outside our control)
 *   - imports in the package's own declaration files that a consumer cannot resolve, because the
 *     module (or its `@types/*` package) is not listed in `dependencies` or `peerDependencies`
 *
 * The package must be built first.
 *
 * Usage (from a package directory or with an explicit path):
 *   node scripts/check-public-types.mjs [packageDir] [--verbose]
 */

import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const pkgDir = fs.realpathSync(path.resolve(args.find((arg) => !arg.startsWith('--')) ?? '.'));
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

const MODES = [
  {
    name: 'bundler',
    ext: '.ts',
    baselineExt: '.ts',
    options: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
  },
  {
    name: 'node16 (cjs)',
    ext: '.cts',
    baselineExt: '.cts',
    options: { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 },
  },
  {
    name: 'node16 (esm)',
    ext: '.mts',
    baselineExt: '.cts',
    options: { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 },
  },
];

const BASE_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  strict: true,
  skipLibCheck: false,
  noEmit: true,
  esModuleInterop: true,
  types: ['node'],
};

const isInside = (dir, file) => !path.relative(dir, file).startsWith('..');
const isFirstParty = (file) =>
  isInside(repoRoot, file) && !file.split(path.sep).includes('node_modules');

/**
 * Collects the public entry points: `.` plus every subpath in `exports` that declares types.
 * Wildcard subpaths cannot be imported without a concrete name, so they are skipped.
 */
const getEntrySpecifiers = () => {
  if (!pkg.exports) {
    return pkg.types || pkg.typings ? [pkg.name] : [];
  }

  const hasTypes = (target) =>
    typeof target === 'object' &&
    target !== null &&
    ('types' in target || Object.values(target).some(hasTypes));

  return Object.entries(pkg.exports)
    .filter(([subpath, target]) => !subpath.includes('*') && hasTypes(target))
    .map(([subpath]) => path.posix.join(pkg.name, subpath));
};

/**
 * Maps a bare specifier to the package name that has to be declared as a dependency
 * (`lodash/fp` -> `lodash`, `@strapi/types/dist/x` -> `@strapi/types`).
 */
const getPackageName = (specifier) => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

/**
 * Walks up from a resolved file to the `node_modules/<name>` directory that owns it.
 */
const getOwningPackageName = (file) => {
  const segments = file.split(path.sep);
  const index = segments.lastIndexOf('node_modules');

  if (index === -1) {
    return null;
  }

  const name = segments[index + 1];
  return name.startsWith('@') ? `${name}/${segments[index + 2]}` : name;
};

const declaredDependencies = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);

const createConsumerProgram = (consumerFile, consumerSource, options) => {
  const host = ts.createCompilerHost(options, true);

  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (file) => file === consumerFile || fileExists.call(host, file);
  host.readFile = (file) => (file === consumerFile ? consumerSource : readFile.call(host, file));
  host.getSourceFile = (file, languageVersion, ...rest) =>
    file === consumerFile
      ? ts.createSourceFile(file, consumerSource, languageVersion, true)
      : getSourceFile.call(host, file, languageVersion, ...rest);

  return { program: ts.createProgram({ rootNames: [consumerFile], options, host }), host };
};

/**
 * Bare specifiers that first-party declaration files import (or augment) and that resolve to
 * third-party code.
 */
const getThirdPartySpecifiers = (program, options, host) => {
  const specifiers = new Set();

  for (const sourceFile of program.getSourceFiles()) {
    if (!isFirstParty(sourceFile.fileName)) {
      continue;
    }

    for (const literal of [...sourceFile.imports, ...sourceFile.moduleAugmentations]) {
      const text = literal.text;

      if (!text || text.startsWith('.') || path.isAbsolute(text)) {
        continue;
      }

      const resolved = ts.resolveModuleName(
        text,
        sourceFile.fileName,
        options,
        host
      ).resolvedModule;

      if (resolved && !isFirstParty(resolved.resolvedFileName)) {
        specifiers.add(text);
      }
    }
  }

  return [...specifiers];
};

const checkMode = (mode, entries) => {
  const options = { ...BASE_OPTIONS, ...mode.options };

  const consumerFile = path.join(pkgDir, `__public-types-consumer__${mode.ext}`);
  const { program, host } = createConsumerProgram(
    consumerFile,
    entries.map((entry, i) => `import type * as entry${i} from '${entry}';\n`).join(''),
    options
  );

  const problems = [];
  let thirdPartyErrorCount = 0;

  // Errors located in third-party files can still be caused by first-party code, e.g. a
  // `declare module 'koa'` augmentation that conflicts with @types/koa. A consumer importing the
  // same third-party modules, without any first-party code, tells the two apart. Emitted
  // declarations are CommonJS, so that is the format they import third-party modules in.
  const baselineFile = path.join(pkgDir, `__public-types-baseline__${mode.baselineExt}`);
  const baseline = new Set(
    ts
      .getPreEmitDiagnostics(
        createConsumerProgram(
          baselineFile,
          getThirdPartySpecifiers(program, options, host)
            .map((specifier, i) => `import type * as dep${i} from '${specifier}';\n`)
            .join(''),
          options
        ).program
      )
      .filter((diagnostic) => diagnostic.file && diagnostic.file.fileName !== baselineFile)
      .map(formatDiagnostic)
  );

  // Type errors
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const file = diagnostic.file?.fileName;
    const message = formatDiagnostic(diagnostic);

    if (file && !isFirstParty(file) && baseline.has(message)) {
      thirdPartyErrorCount += 1;

      if (verbose) {
        problems.push(`[third-party] ${message}`);
      }

      continue;
    }

    problems.push(
      file && !isFirstParty(file) ? `[caused by first-party code] ${message}` : message
    );
  }

  // Files resolved outside the repository mean the check ran against something other than this
  // checkout (e.g. a parent directory's node_modules), so its result cannot be trusted.
  const foreignFiles = program
    .getSourceFiles()
    .map((sourceFile) => sourceFile.fileName)
    .filter(
      (file) =>
        file !== consumerFile &&
        !isInside(repoRoot, file) &&
        !isInside(path.dirname(ts.getDefaultLibFilePath(options)), file)
    );

  for (const file of foreignFiles) {
    problems.push(`resolved outside of the repository: ${file}`);
  }

  // Undeclared dependencies of the package's own declaration files
  const ownFiles = program
    .getSourceFiles()
    .filter((sourceFile) => sourceFile.isDeclarationFile && isInside(pkgDir, sourceFile.fileName));

  for (const sourceFile of ownFiles) {
    const specifiers = [
      ...sourceFile.imports.map((literal) => ({
        text: literal.text,
        mode: program.getModeForUsageLocation(sourceFile, literal),
        pos: literal.getStart(),
      })),
      ...sourceFile.typeReferenceDirectives.map((ref) => ({
        text: ref.fileName,
        mode: undefined,
        pos: ref.pos,
        isTypeReference: true,
      })),
    ];

    for (const specifier of specifiers) {
      if (specifier.text.startsWith('.') || path.isAbsolute(specifier.text)) {
        continue;
      }

      const location = formatLocation(sourceFile, specifier.pos);
      const name = specifier.isTypeReference ? specifier.text : getPackageName(specifier.text);

      if (name.startsWith('node:') || builtinModules.includes(name)) {
        continue;
      }

      const resolved = specifier.isTypeReference
        ? ts.resolveTypeReferenceDirective(specifier.text, sourceFile.fileName, options, host)
            .resolvedTypeReferenceDirective?.resolvedFileName
        : ts.resolveModuleName(
            specifier.text,
            sourceFile.fileName,
            options,
            host,
            undefined,
            undefined,
            specifier.mode
          ).resolvedModule?.resolvedFileName;

      if (!resolved) {
        problems.push(`${location} cannot resolve '${specifier.text}'`);
        continue;
      }

      if (name === pkg.name) {
        continue;
      }

      // Types may come from the package itself or from DefinitelyTyped
      const typesProvider = getOwningPackageName(resolved) ?? name;

      if (!declaredDependencies.has(name) && !declaredDependencies.has(typesProvider)) {
        problems.push(`${location} imports '${specifier.text}', but '${name}' is not a dependency`);
      } else if (typesProvider !== name && !declaredDependencies.has(typesProvider)) {
        problems.push(
          `${location} imports '${specifier.text}', whose types come from '${typesProvider}', which is not a dependency`
        );
      }
    }
  }

  return {
    problems: [...new Set(problems)],
    thirdPartyErrorCount,
    fileCount: program.getSourceFiles().length,
  };
};

const formatLocation = (sourceFile, pos) => {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
  return `${path.relative(repoRoot, sourceFile.fileName)}:${line + 1}:${character + 1}`;
};

const formatDiagnostic = (diagnostic) => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');

  if (!diagnostic.file) {
    return `TS${diagnostic.code}: ${message}`;
  }

  return `${formatLocation(diagnostic.file, diagnostic.start ?? 0)} TS${diagnostic.code}: ${message}`;
};

const main = () => {
  const entries = getEntrySpecifiers();

  if (entries.length === 0) {
    console.log(`${pkg.name}: no typed entry points, skipping`);
    return;
  }

  let failed = false;

  for (const mode of MODES) {
    const { problems, thirdPartyErrorCount, fileCount } = checkMode(mode, entries);
    const status = problems.length === 0 ? 'ok' : `${problems.length} problem(s)`;

    console.log(
      `${pkg.name} [${mode.name}]: ${status} — ${fileCount} files, ${thirdPartyErrorCount} third-party error(s) ignored`
    );

    for (const problem of problems) {
      console.log(`  ${problem}`);
    }

    failed ||= problems.some((problem) => !problem.startsWith('[third-party]'));
  }

  if (failed) {
    process.exitCode = 1;
  }
};

main();
