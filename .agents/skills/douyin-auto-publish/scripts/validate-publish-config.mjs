#!/usr/bin/env node

import {pathToFileURL} from 'node:url';
import {
  EXIT_CODES,
  PublishStateError,
  validatePublishConfig,
} from './publish-state.mjs';

const parseArgs = (argv) => {
  const options = {
    projectRoot: '.',
    configPath: 'publish/douyin.json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--project-root' || argument === '--config') {
      if (value === undefined || value.startsWith('--')) {
        throw new PublishStateError('invalid', `${argument} requires a value`);
      }
      if (argument === '--project-root') {
        options.projectRoot = value;
      } else {
        options.configPath = value;
      }
      index += 1;
      continue;
    }
    throw new PublishStateError('invalid', `unknown argument: ${argument}`);
  }
  return options;
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
    const preflight = await validatePublishConfig(options);
    if (preflight.receipt.blocked) {
      writeJson(process.stderr, {
        ok: false,
        error: {
          kind: 'blocked',
          message: `publishing blocked by ${preflight.receipt.reason} receipt`,
        },
        preflight,
      });
      return EXIT_CODES.blocked;
    }
    writeJson(process.stdout, {ok: true, preflight});
    return EXIT_CODES.ok;
  } catch (error) {
    const kind = error instanceof PublishStateError ? error.kind : 'io';
    writeJson(process.stderr, {
      ok: false,
      error: {
        kind,
        message: error instanceof Error ? error.message : 'unexpected validation failure',
      },
    });
    return exitCodeFor(kind);
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
