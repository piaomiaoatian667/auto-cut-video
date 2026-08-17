export const DENO_WRAPPER_FILENAME = 'deno-isolated';
export const DENO_EXECUTABLE_ENVIRONMENT_KEY =
  'AUTO_CUT_VIDEO_DENO_EXECUTABLE';

const denoExecutableReference = `$${DENO_EXECUTABLE_ENVIRONMENT_KEY}`;
const requiredDenoExecutable = '${'
  + DENO_EXECUTABLE_ENVIRONMENT_KEY
  + ':?'
  + DENO_EXECUTABLE_ENVIRONMENT_KEY
  + ' must be set}';

export const DENO_WRAPPER_SOURCE = [
  '#!/bin/sh',
  'set -eu',
  `: "${requiredDenoExecutable}"`,
  `case "${denoExecutableReference}" in`,
  '  /*) ;;',
  '  *) exit 126 ;;',
  'esac',
  `if [ "${denoExecutableReference}" = "$0" ]; then`,
  '  exit 126',
  'fi',
  ': "${XDG_CACHE_HOME:?XDG_CACHE_HOME must be set}"',
  'export HOME="$XDG_CACHE_HOME"',
  'export TMPDIR="$XDG_CACHE_HOME"',
  'export NPM_CONFIG_REGISTRY="https://registry.npmjs.org/"',
  'export NPM_CONFIG_USERCONFIG="/dev/null"',
  'export NPM_CONFIG_GLOBALCONFIG="/dev/null"',
  `exec "${denoExecutableReference}" "$@"`,
  '',
].join('\n');
