import {describe, expect, it} from 'vitest';
import {validateAuthoringInputs} from '../../../src/domain/validate-authoring';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
} from '../../helpers/temp-project';

describe('validateAuthoringInputs', () => {
  it('uses a project limit lower than the default 28', () => {
    const project = createProjectFixture('demo', 8);
    const script = createScriptFixture('123456789');

    try {
      validateAuthoringInputs({project, script, edit: createEditFixture()});
      expect.unreachable('expected overlong segment text to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'SCRIPT_SEGMENT_TEXT_TOO_LONG',
        segmentId: 'intro',
        graphemeCount: 9,
        maximumGraphemes: 8,
      });
    }
  });

  it('permits text above 28 when the project limit allows it', () => {
    const project = createProjectFixture('demo', 29);
    const script = createScriptFixture('A'.repeat(29));

    expect(() => validateAuthoringInputs({
      project,
      script,
      edit: createEditFixture(),
    })).not.toThrow();
  });

  it('counts mixed CJK, ASCII, combining marks, and Emoji as graphemes', () => {
    const project = createProjectFixture('demo', 8);
    const eightGraphemes = '中Ae\u0301👨‍👩‍👧‍👦文本12';

    expect(() => validateAuthoringInputs({
      project,
      script: createScriptFixture(eightGraphemes),
      edit: createEditFixture(),
    })).not.toThrow();

    try {
      validateAuthoringInputs({
        project,
        script: createScriptFixture(`${eightGraphemes}!`),
        edit: createEditFixture(),
      });
      expect.unreachable('expected the ninth grapheme to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'SCRIPT_SEGMENT_TEXT_TOO_LONG',
        graphemeCount: 9,
        maximumGraphemes: 8,
      });
    }
  });
});
