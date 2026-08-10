import {describe, expect, it} from 'vitest';
import {
  FfprobeParseError,
  parseFfprobeJson,
} from '../../../src/media/ffprobe';

const videoStream = {
  index: 0,
  codec_name: 'h264',
  profile: 'High',
  codec_type: 'video',
  codec_tag_string: 'avc1',
  width: 1920,
  height: 1080,
  pix_fmt: 'yuv420p',
  color_range: 'tv',
  color_space: 'bt709',
  color_transfer: 'bt709',
  color_primaries: 'bt709',
  r_frame_rate: '30000/1001',
  avg_frame_rate: '60000/2002',
  duration: '2.002000',
  nb_frames: '60',
  bits_per_raw_sample: '8',
};

const audioStream = {
  index: 1,
  codec_name: 'aac',
  profile: 'LC',
  codec_type: 'audio',
  sample_fmt: 'fltp',
  sample_rate: '48000',
  channels: 2,
  channel_layout: 'stereo',
  duration: '2.002000',
};

const ffprobeDocument = (overrides: Record<string, unknown> = {}) => ({
  streams: [videoStream, audioStream],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '2.002000',
  },
  ...overrides,
});

describe('parseFfprobeJson', () => {
  it('parses video, audio, duration, and reduced rational frame rates', () => {
    const result = parseFfprobeJson(JSON.stringify(ffprobeDocument()));

    expect(result).toMatchObject({
      durationMs: 2002,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      videoStreams: [{
        index: 0,
        codec: 'h264',
        profile: 'High',
        codecTag: 'avc1',
        pixelFormat: 'yuv420p',
        width: 1920,
        height: 1080,
        colorRange: 'tv',
        colorSpace: 'bt709',
        colorTransfer: 'bt709',
        colorPrimaries: 'bt709',
        rotation: 0,
        frameCount: 60,
        durationMs: 2002,
        bitsPerRawSample: 8,
        averageFrameRate: {
          numerator: 30000,
          denominator: 1001,
          value: 30000 / 1001,
        },
        realFrameRate: {
          numerator: 30000,
          denominator: 1001,
          value: 30000 / 1001,
        },
      }],
      audioStreams: [{
        index: 1,
        codec: 'aac',
        profile: 'LC',
        sampleFormat: 'fltp',
        sampleRate: 48000,
        channels: 2,
        channelLayout: 'stereo',
        durationMs: 2002,
      }],
    });
  });

  it.each([
    {
      name: 'display matrix side data',
      stream: {
        ...videoStream,
        side_data_list: [{
          side_data_type: 'Display Matrix',
          displaymatrix: [
            '00000000:            0       65536           0',
            '00000001:       -65536           0           0',
            '00000002:            0           0  1073741824',
          ].join('\n'),
          rotation: -90,
        }],
      },
      expected: 270,
    },
    {
      name: 'rotate tag',
      stream: {...videoStream, tags: {rotate: '450'}},
      expected: 90,
    },
    {
      name: 'display matrix text',
      stream: {
        ...videoStream,
        side_data_list: [{
          side_data_type: 'Display Matrix',
          displaymatrix: [
            '00000000:            0      -65536           0',
            '00000001:        65536           0           0',
            '00000002:            0           0  1073741824',
          ].join('\n'),
        }],
      },
      expected: 90,
    },
  ])('parses rotation from $name', ({stream, expected}) => {
    const result = parseFfprobeJson(JSON.stringify(ffprobeDocument({
      streams: [stream],
    })));

    expect(result.videoStreams[0]?.rotation).toBe(expected);
  });

  it('accepts a still image without a duration', () => {
    const result = parseFfprobeJson(JSON.stringify({
      streams: [{
        index: 0,
        codec_name: 'png',
        codec_type: 'video',
        width: 64,
        height: 48,
        pix_fmt: 'rgb24',
        color_range: 'pc',
        color_space: 'gbr',
        r_frame_rate: '25/1',
        avg_frame_rate: '25/1',
      }],
      format: {format_name: 'png_pipe'},
    }));

    expect(result.durationMs).toBe(0);
    expect(result.videoStreams[0]).toMatchObject({codec: 'png', width: 64, height: 48});
  });

  it('uses primary video duration_ts/time_base instead of longer format audio duration', () => {
    const result = parseFfprobeJson(JSON.stringify({
      streams: [{
        ...videoStream,
        duration: undefined,
        duration_ts: 90_000,
        time_base: '1/90000',
        nb_frames: '30',
      }, {
        ...audioStream,
        duration: '3.000000',
      }],
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '3.000000',
      },
    }));

    expect(result.durationMs).toBe(1000);
    expect(result.videoStreams[0]?.durationMs).toBe(1000);
    expect(result.audioStreams[0]?.durationMs).toBe(3000);
  });

  it.each([
    {name: 'malformed JSON', input: '{'},
    {name: 'missing streams', input: JSON.stringify({format: {duration: '1'}})},
    {name: 'no audio or video streams', input: JSON.stringify({
      streams: [{index: 0, codec_type: 'subtitle', codec_name: 'mov_text'}],
      format: {duration: '1'},
    })},
    {name: 'NaN duration', input: JSON.stringify(ffprobeDocument({
      format: {format_name: 'mp4', duration: 'NaN'},
    }))},
    {name: 'negative duration', input: JSON.stringify(ffprobeDocument({
      format: {format_name: 'mp4', duration: '-1'},
    }))},
    {name: 'missing duration', input: JSON.stringify({
      streams: [{...videoStream, duration: undefined, nb_frames: undefined}],
      format: {format_name: 'mp4'},
    })},
    {name: 'invalid frame rate', input: JSON.stringify(ffprobeDocument({
      streams: [{...videoStream, avg_frame_rate: '0/0'}, audioStream],
    }))},
    {name: 'missing pixel format', input: JSON.stringify(ffprobeDocument({
      streams: [{...videoStream, pix_fmt: undefined}, audioStream],
    }))},
    {name: 'malformed display matrix', input: JSON.stringify(ffprobeDocument({
      streams: [{
        ...videoStream,
        side_data_list: [{
          side_data_type: 'Display Matrix',
          displaymatrix: 'not a matrix',
        }],
      }],
    }))},
    {name: 'structurally inconsistent display matrix', input: JSON.stringify(ffprobeDocument({
      streams: [{
        ...videoStream,
        side_data_list: [{
          side_data_type: 'Display Matrix',
          displaymatrix: [
            '00000000:            0      -65536           0',
            '00000001:            0           0           0',
            '00000002:            0           0  1073741824',
          ].join('\n'),
        }],
      }],
    }))},
    {name: 'malformed rotation field', input: JSON.stringify(ffprobeDocument({
      streams: [{
        ...videoStream,
        side_data_list: [{side_data_type: 'Display Matrix', rotation: 'clockwise'}],
      }],
    }))},
    {name: 'conflicting rotation fields', input: JSON.stringify(ffprobeDocument({
      streams: [{
        ...videoStream,
        tags: {rotate: '90'},
        side_data_list: [{side_data_type: 'Display Matrix', rotation: -90}],
      }],
    }))},
    {name: 'non-quarter-turn rotation', input: JSON.stringify(ffprobeDocument({
      streams: [{...videoStream, tags: {rotate: '45'}}],
    }))},
  ])('rejects $name', ({input}) => {
    expect(() => parseFfprobeJson(input)).toThrow(FfprobeParseError);
  });
});
