import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {
  FingerprintInputError,
  fingerprintValue,
} from '../../../src/pipeline/fingerprint';

describe('fingerprintValue', () => {
  it('is independent of object key insertion order', () => {
    expect(fingerprintValue({a: 1, b: 2})).toBe(
      fingerprintValue({b: 2, a: 1}),
    );
  });

  it('canonicalizes nested plain objects but preserves array order', () => {
    expect(fingerprintValue({nested: [{b: 2, a: 1}]})).toBe(
      fingerprintValue({nested: [{a: 1, b: 2}]}),
    );
    expect(fingerprintValue(['a', 'b'])).not.toBe(
      fingerprintValue(['b', 'a']),
    );
  });

  it('uses canonical JSON bytes in the stable sha256 format', () => {
    const canonicalJson = '{"a":1,"b":2}';
    const expected = createHash('sha256')
      .update(canonicalJson)
      .digest('hex');

    expect(fingerprintValue({b: 2, a: 1})).toBe(`sha256:${expected}`);
  });

  it.each([
    ['root undefined', undefined],
    ['object undefined', {value: undefined}],
    ['array undefined', [undefined]],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['negative zero', -0],
    ['date', new Date('2026-08-09T00:00:00.000Z')],
    ['map', new Map([['a', 1]])],
    ['bigint', 1n],
    ['function', () => undefined],
    ['symbol', Symbol('value')],
  ])('rejects unsupported %s inputs', (_label, value) => {
    expect(() => fingerprintValue(value)).toThrow(FingerprintInputError);
  });

  it('rejects cycles rather than silently changing their meaning', () => {
    const value: {self?: unknown} = {};
    value.self = value;

    expect(() => fingerprintValue(value)).toThrowError(
      expect.objectContaining({code: 'FINGERPRINT_INPUT_INVALID'}),
    );
  });

  it('rejects sparse arrays and hidden or accessor properties', () => {
    const sparse: unknown[] = new Array(2);
    sparse[1] = 'value';

    const hidden = {visible: true};
    Object.defineProperty(hidden, 'hidden', {value: true});

    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => 'dynamic',
    });

    expect(() => fingerprintValue(sparse)).toThrow(FingerprintInputError);
    expect(() => fingerprintValue(hidden)).toThrow(FingerprintInputError);
    expect(() => fingerprintValue(accessor)).toThrow(FingerprintInputError);
  });

  it('rejects symbol keys that JSON would otherwise ignore', () => {
    const symbolKey = Symbol('hidden');
    const value = {[symbolKey]: 'ignored'};

    expect(() => fingerprintValue(value)).toThrow(FingerprintInputError);
  });
});
