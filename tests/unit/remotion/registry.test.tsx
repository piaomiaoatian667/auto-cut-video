import {describe, expect, it} from 'vitest';
import {componentRegistry, parseOverlayProps} from '../../../src/remotion/registry';

describe('componentRegistry', () => {
  it('registers basic-title with strict props', () => {
    expect(Object.keys(componentRegistry)).toEqual(['basic-title']);
    expect(parseOverlayProps('basic-title', {text: '标题'})).toEqual({text: '标题'});
    expect(() => parseOverlayProps('basic-title', {text: '标题', extra: true}))
      .toThrowError(/EDIT_COMPONENT_PROPS_INVALID/);
  });

  it('rejects unknown component ids', () => {
    expect(() => parseOverlayProps('arbitrary-code', {text: '标题'}))
      .toThrowError(/EDIT_COMPONENT_UNREGISTERED/);
  });
});
