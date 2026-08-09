import {createHash} from 'node:crypto';

export class FingerprintInputError extends TypeError {
  readonly code = 'FINGERPRINT_INPUT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'FingerprintInputError';
  }
}

const invalid = (path: string, reason: string): never => {
  throw new FingerprintInputError(`cannot fingerprint ${path}: ${reason}`);
};

const serializeArray = (
  value: unknown[],
  path: string,
  ancestors: WeakSet<object>,
): string => {
  const allowedKeys = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${path}[${index}]`, 'sparse array entry');
    allowedKeys.add(String(index));
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return invalid(path, 'symbol-keyed property');
    if (!allowedKeys.has(key)) {
      invalid(path, `unexpected array property ${JSON.stringify(key)}`);
    }
  }

  const entries = value.map((entry, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      return invalid(`${path}[${index}]`, 'accessor or hidden array entry');
    }
    return canonicalJson(entry, `${path}[${index}]`, ancestors);
  });
  return `[${entries.join(',')}]`;
};

const serializeObject = (
  value: object,
  path: string,
  ancestors: WeakSet<object>,
): string => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, 'non-plain object');
  }

  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return invalid(path, 'symbol-keyed property');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
    ) {
      invalid(`${path}.${key}`, 'accessor or hidden property');
    }
    keys.push(key);
  }
  keys.sort();

  return `{${keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return `${JSON.stringify(key)}:${canonicalJson(
      descriptor.value,
      `${path}.${key}`,
      ancestors,
    )}`;
  }).join(',')}}`;
};

const canonicalJson = (
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): string => {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) return invalid(path, 'non-finite number');
      if (Object.is(value, -0)) return invalid(path, 'negative zero');
      return JSON.stringify(value);
    case 'object': {
      if (ancestors.has(value)) return invalid(path, 'cyclic reference');
      ancestors.add(value);
      try {
        return Array.isArray(value)
          ? serializeArray(value, path, ancestors)
          : serializeObject(value, path, ancestors);
      } finally {
        ancestors.delete(value);
      }
    }
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      return invalid(path, `unsupported ${typeof value}`);
  }
  return invalid(path, 'unsupported value');
};

export function fingerprintValue(value: unknown): string {
  const canonical = canonicalJson(value, '$', new WeakSet());
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
