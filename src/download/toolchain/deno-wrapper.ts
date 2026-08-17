export const DENO_WRAPPER_FILENAME = 'deno-isolated';

export const DENO_WRAPPER_SOURCE = [
  '#!/bin/sh',
  'set -eu',
  ': "${XDG_CACHE_HOME:?XDG_CACHE_HOME must be set}"',
  'export HOME="$XDG_CACHE_HOME"',
  'export TMPDIR="$XDG_CACHE_HOME"',
  'export NPM_CONFIG_REGISTRY="https://registry.npmjs.org/"',
  'export NPM_CONFIG_USERCONFIG="/dev/null"',
  'export NPM_CONFIG_GLOBALCONFIG="/dev/null"',
  'exec deno "$@"',
  '',
].join('\n');
