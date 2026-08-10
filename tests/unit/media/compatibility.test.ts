import {describe, expect, it} from 'vitest';
import {
  decideVideoCompatibility,
  isVariableFrameRate,
  parseFfprobeJson,
  type MediaProbe,
} from '../../../src/media/ffprobe';
import {transcodeVideo} from '../../../src/media/transcode';
import type {ProcessResult} from '../../../src/process/run-process';

const createProbe = (
  videoOverrides: Record<string, unknown> = {},
): MediaProbe => parseFfprobeJson(JSON.stringify({
  streams: [{
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
    r_frame_rate: '30/1',
    avg_frame_rate: '30/1',
    duration: '2.000000',
    nb_frames: '60',
    bits_per_raw_sample: '8',
    ...videoOverrides,
  }],
  format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.000000'},
}));

describe('video compatibility', () => {
  it('accepts decodable H.264 yuv420p BT.709 CFR directly', () => {
    expect(decideVideoCompatibility(createProbe(), {decodable: true})).toEqual({
      compatibility: 'direct',
    });
  });

  it('ignores attached artwork when selecting the primary video stream', () => {
    const probe = createProbe();
    const primary = probe.videoStreams[0]!;
    probe.videoStreams = [{
      ...primary,
      index: 0,
      codec: 'mjpeg',
      attachedPicture: true,
      averageFrameRate: {numerator: 0, denominator: 0, value: 0},
    }, {
      ...primary,
      index: 1,
    }];

    expect(decideVideoCompatibility(probe, {decodable: true})).toEqual({
      compatibility: 'direct',
    });
  });

  it('does not mistake equivalent or near-nominal frame-rate rationals for VFR', () => {
    const equivalent = createProbe({
      avg_frame_rate: '60000/2002',
      r_frame_rate: '30000/1001',
      duration: '2.002000',
      nb_frames: '60',
    });
    const nearNominal = createProbe({
      avg_frame_rate: '30000/1001',
      r_frame_rate: '30/1',
      duration: '2.002000',
      nb_frames: '60',
    });

    expect(isVariableFrameRate(equivalent.videoStreams[0]!)).toBe(false);
    expect(isVariableFrameRate(nearNominal.videoStreams[0]!)).toBe(false);
  });

  it('fails closed when frame-count timing contradicts equal avg/r rates', () => {
    const inconsistentTiming = createProbe({
      avg_frame_rate: '30/1',
      r_frame_rate: '30/1',
      duration: '2.000000',
      nb_frames: '48',
    });

    expect(isVariableFrameRate(inconsistentTiming.videoStreams[0]!)).toBe(true);
    expect(decideVideoCompatibility(inconsistentTiming, {decodable: true})).toEqual({
      compatibility: 'transcoded',
      reasons: ['variable frame rate requires normalization'],
    });
  });

  it.each([
    {
      name: 'codec',
      overrides: {codec_name: 'hevc'},
      reasons: ['video codec must be h264 (received hevc)'],
    },
    {
      name: 'pixel format',
      overrides: {pix_fmt: 'yuv422p'},
      reasons: ['pixel format must be yuv420p (received yuv422p)'],
    },
    {
      name: 'frame rate',
      overrides: {avg_frame_rate: '24/1', r_frame_rate: '30/1', nb_frames: '48'},
      reasons: ['variable frame rate requires normalization'],
    },
    {
      name: 'SDR color space',
      overrides: {
        color_primaries: 'bt470bg',
        color_transfer: 'gamma28',
        color_space: 'bt470bg',
      },
      reasons: ['color metadata must be BT.709 for direct use'],
    },
    {
      name: 'multiple fields',
      overrides: {
        codec_name: 'hevc',
        pix_fmt: 'yuv422p',
        avg_frame_rate: '24/1',
        r_frame_rate: '30/1',
        nb_frames: '48',
        color_primaries: 'bt470bg',
        color_transfer: 'gamma28',
        color_space: 'bt470bg',
      },
      reasons: [
        'video codec must be h264 (received hevc)',
        'pixel format must be yuv420p (received yuv422p)',
        'color metadata must be BT.709 for direct use',
        'variable frame rate requires normalization',
      ],
    },
  ])('transcodes supported SDR video with incompatible $name', ({overrides, reasons}) => {
    expect(decideVideoCompatibility(createProbe(overrides), {decodable: true})).toEqual({
      compatibility: 'transcoded',
      reasons,
    });
  });

  it.each([
    {
      name: 'PQ transfer',
      overrides: {color_transfer: 'smpte2084'},
      reasons: ['HDR transfer is unsupported (smpte2084)'],
    },
    {
      name: 'HLG transfer',
      overrides: {color_transfer: 'arib-std-b67'},
      reasons: ['HDR transfer is unsupported (arib-std-b67)'],
    },
    {
      name: 'Dolby Vision profile',
      overrides: {profile: 'Dolby Vision Profile 8.1'},
      reasons: ['Dolby Vision is unsupported'],
    },
    {
      name: 'Dolby Vision side data',
      overrides: {side_data_list: [{side_data_type: 'DOVI configuration record'}]},
      reasons: ['Dolby Vision is unsupported'],
    },
    {
      name: 'HDR10+ dynamic metadata',
      overrides: {side_data_list: [{side_data_type: 'HDR10+ Dynamic Metadata'}]},
      reasons: ['HDR side data is unsupported (HDR10+ Dynamic Metadata)'],
    },
    {
      name: 'mastering display metadata',
      overrides: {side_data_list: [{side_data_type: 'Mastering display metadata'}]},
      reasons: ['HDR side data is unsupported (Mastering display metadata)'],
    },
    {
      name: 'content light level metadata',
      overrides: {side_data_list: [{side_data_type: 'Content light level metadata'}]},
      reasons: ['HDR side data is unsupported (Content light level metadata)'],
    },
    {
      name: 'unknown video side data',
      overrides: {side_data_list: [{side_data_type: 'Future Color Volume Metadata'}]},
      reasons: ['video side data is unsupported (Future Color Volume Metadata)'],
    },
    {
      name: 'missing color metadata',
      overrides: {color_primaries: undefined},
      reasons: ['color metadata is missing or unsupported'],
    },
    {
      name: 'unknown color metadata',
      overrides: {color_space: 'unknown'},
      reasons: ['color metadata is missing or unsupported'],
    },
  ])('rejects $name', ({overrides, reasons}) => {
    expect(decideVideoCompatibility(createProbe(overrides), {decodable: true})).toEqual({
      compatibility: 'rejected',
      errorCode: 'ASSET_HDR_UNSUPPORTED',
      reasons,
    });
  });

  it.each([
    'yuv420p10le',
    'p010le',
    'y210le',
    'gbrp10le',
    'gray10le',
    'vendor9le',
    'vendor_10bit',
    'vendor12be',
    'vendor_p14',
    'vendor14xyz',
    'vendor16_planar',
  ])('rejects inferred high-bit-depth pixel format %s without descriptor bits', (pixelFormat) => {
    expect(decideVideoCompatibility(createProbe({
      pix_fmt: pixelFormat,
      bits_per_raw_sample: undefined,
    }), {decodable: true})).toEqual({
      compatibility: 'rejected',
      errorCode: 'ASSET_HDR_UNSUPPORTED',
      reasons: [`high bit-depth video is unsupported (${pixelFormat})`],
    });
  });

  it('rejects an unknown pixel format when 8-bit depth cannot be proven', () => {
    expect(decideVideoCompatibility(createProbe({
      pix_fmt: 'mystery_fmt',
      bits_per_raw_sample: undefined,
    }), {decodable: true})).toEqual({
      compatibility: 'rejected',
      errorCode: 'ASSET_HDR_UNSUPPORTED',
      reasons: ['pixel format bit depth is unknown or unsupported (mystery_fmt)'],
    });
  });

  it('does not use an 8-bit descriptor to bless an unknown pixel format', () => {
    expect(decideVideoCompatibility(createProbe({
      pix_fmt: 'mystery_fmt',
      bits_per_raw_sample: '8',
      bits_per_coded_sample: '8',
    }), {decodable: true})).toEqual({
      compatibility: 'rejected',
      errorCode: 'ASSET_HDR_UNSUPPORTED',
      reasons: ['pixel format bit depth is unknown or unsupported (mystery_fmt)'],
    });
  });

  it('rejects a failed sample decode', () => {
    expect(decideVideoCompatibility(createProbe(), {decodable: false})).toEqual({
      compatibility: 'rejected',
      errorCode: 'ASSET_DECODE_FAILED',
      reasons: ['video sample decode failed'],
    });
  });

  it('rejects a missing video stream', () => {
    const probe: MediaProbe = {
      durationMs: 2000,
      formatName: 'wav',
      videoStreams: [],
      audioStreams: [{index: 0, codec: 'pcm_s16le', durationMs: 2000}],
    };

    expect(decideVideoCompatibility(probe, {decodable: true})).toEqual({
      compatibility: 'rejected',
      errorCode: 'ASSET_DECODE_FAILED',
      reasons: ['video stream is missing'],
    });
  });

  it('keeps transcoding reasons deterministic across calls', () => {
    const probe = createProbe({
      codec_name: 'hevc',
      pix_fmt: 'yuv422p',
      avg_frame_rate: '24/1',
      r_frame_rate: '30/1',
      nb_frames: '48',
    });

    const first = decideVideoCompatibility(probe, {decodable: true});
    const second = decideVideoCompatibility(probe, {decodable: true});
    expect(second).toEqual(first);
  });
});

describe('transcodeVideo', () => {
  it('uses only borrowed descriptors and the normalized MP4 command contract', async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      extraStdioFds: readonly number[] | undefined;
    }> = [];
    const result: ProcessResult = {
      command: '/tools/ffmpeg',
      args: [],
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 1,
    };

    await transcodeVideo({
      ffmpegExecutable: '/tools/ffmpeg',
      sourceFd: 41,
      outputFd: 42,
      sourceStreamIndex: 2,
      sourceColor: {
        primaries: 'bt470bg',
        transfer: 'bt470bg',
        space: 'bt470bg',
        range: 'tv',
      },
      runner: async (command, args, options) => {
        calls.push({
          command,
          args: [...args],
          extraStdioFds: options.extraStdioFds === undefined
            ? undefined
            : [...options.extraStdioFds],
        });
        return result;
      },
    });

    expect(calls).toEqual([{
      command: '/tools/ffmpeg',
      args: [
        '-y',
        '-v', 'error',
        '-i', '/dev/fd/3',
        '-map', '0:2',
        '-an',
        '-vf', [
          'colorspace=space=bt709:trc=bt709:primaries=bt709:range=tv:ispace=bt470bg:itrc=bt470bg:iprimaries=bt470bg:irange=tv:fast=0',
          'fps=30',
          'format=yuv420p',
        ].join(','),
        '-fps_mode', 'cfr',
        '-c:v', 'libx264',
        '-crf', '18',
        '-preset', 'medium',
        '-color_primaries', 'bt709',
        '-color_trc', 'bt709',
        '-colorspace', 'bt709',
        '-color_range', 'tv',
        '-f', 'mp4',
        '/dev/fd/4',
      ],
      extraStdioFds: [41, 42],
    }]);
  });
});
