#!/usr/bin/env node

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  EXIT_CODES,
  PublishStateError,
  recordPublishResult,
} from './publish-state.mjs';

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--preflight' || argument === '--result') {
      if (value === undefined || value.startsWith('--')) {
        throw new PublishStateError('invalid', `${argument} requires a value`);
      }
      options[argument === '--preflight' ? 'preflightPath' : 'resultPath'] = value;
      index += 1;
      continue;
    }
    throw new PublishStateError('invalid', `unknown argument: ${argument}`);
  }
  if (options.preflightPath === undefined || options.resultPath === undefined) {
    throw new PublishStateError('invalid', '--preflight and --result are required');
  }
  return options;
};

const readJsonInput = async (filePath, label) => {
  let source;
  try {
    source = await readFile(path.resolve(filePath), 'utf8');
  } catch (cause) {
    throw new PublishStateError('io', `failed to read ${label} file`, {cause});
  }
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new PublishStateError('invalid', `${label} file must contain valid JSON`, {cause});
  }
};

const exitCodeFor = (kind) => kind === 'invalid'
  ? EXIT_CODES.invalid
  : EXIT_CODES.io;

const writeJson = (stream, value) => {
  stream.write(`${JSON.stringify(value)}\n`);
};

export const main = async (argv = process.argv.slice(2)) => {
  try {
    const options = parseArgs(argv);
    const preflightInput = await readJsonInput(options.preflightPath, 'preflight');
    const preflight = preflightInput?.ok === true && preflightInput.preflight !== undefined
      ? preflightInput.preflight
      : preflightInput;
    const result = await readJsonInput(options.resultPath, 'result');
    const recorded = await recordPublishResult({preflight, result});
    writeJson(process.stdout, {
      ok: true,
      receipt: {
        path: recorded.relativePath,
        status: recorded.receipt.status,
      },
    });
    return EXIT_CODES.ok;
  } catch (error) {
    const kind = error instanceof PublishStateError ? error.kind : 'io';
    writeJson(process.stderr, {
      ok: false,
      error: {
        kind,
        message: error instanceof Error ? error.message : 'unexpected receipt failure',
      },
    });
    return exitCodeFor(kind);
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
