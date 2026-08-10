import {describe, expect, it} from 'vitest';
import {formatSrt} from '../../../src/captions/srt';
import type {CaptionsManifest} from '../../../src/domain/manifest-schema';

const captions: CaptionsManifest = {
  version: 1,
  sourceNarrationHash: 'sha256:narration',
  cues: [
    {id: 'caption-intro', segmentId: 'intro', text: '第一句', startMs: 0, endMs: 1000},
    {id: 'caption-outro', segmentId: 'outro', text: '第二句', startMs: 1100, endMs: 2100},
  ],
};

describe('formatSrt', () => {
  it('serializes ordered cues with deterministic timing', () => {
    expect(formatSrt(captions)).toBe([
      '1',
      '00:00:00,000 --> 00:00:01,000',
      '第一句',
      '',
      '2',
      '00:00:01,100 --> 00:00:02,100',
      '第二句',
      '',
    ].join('\n'));
  });

  it('escapes CRLF differences in cue text', () => {
    expect(formatSrt({
      ...captions,
      cues: [{...captions.cues[0]!, text: '第一句\r\n第二行'}],
    })).toContain('第一句\n第二行');
  });
});
