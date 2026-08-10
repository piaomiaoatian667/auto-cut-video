export type CompatibilityDecision =
  | {compatibility: 'direct'}
  | {compatibility: 'transcoded'; reasons: string[]}
  | {
    compatibility: 'rejected';
    errorCode: 'ASSET_HDR_UNSUPPORTED' | 'ASSET_DECODE_FAILED';
    reasons: string[];
  };

export interface FrameRateRational {
  numerator: number;
  denominator: number;
  value: number;
}

export interface VideoStreamProbe {
  index: number;
  codec: string;
  profile?: string;
  codecTag?: string;
  pixelFormat: string;
  width: number;
  height: number;
  averageFrameRate: FrameRateRational;
  realFrameRate: FrameRateRational;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  colorRange?: string;
  rotation: number;
  durationMs?: number;
  frameCount?: number;
  bitsPerRawSample?: number;
  bitsPerCodedSample?: number;
  sideDataTypes: string[];
}

export interface AudioStreamProbe {
  index: number;
  codec: string;
  profile?: string;
  sampleFormat?: string;
  sampleRate?: number;
  channels?: number;
  channelLayout?: string;
  durationMs?: number;
}

export interface MediaProbe {
  durationMs: number;
  formatName?: string;
  videoStreams: VideoStreamProbe[];
  audioStreams: AudioStreamProbe[];
}

export class FfprobeParseError extends Error {
  readonly code = 'ASSET_DECODE_FAILED';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FfprobeParseError';
  }
}

type JsonRecord = Record<string, unknown>;

const fail = (message: string, cause?: unknown): never => {
  throw new FfprobeParseError(
    message,
    cause === undefined ? undefined : {cause},
  );
};

const asRecord = (value: unknown, field: string): JsonRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${field} must be an object`);
  }
  return value as JsonRecord;
};

const requiredString = (record: JsonRecord, field: string, path: string): string => {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${path}.${field} must be a non-empty string`);
  }
  return value;
};

const optionalString = (
  record: JsonRecord,
  field: string,
  path: string,
): string | undefined => {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${path}.${field} must be a non-empty string when present`);
  }
  return value;
};

const parseNumber = (
  value: unknown,
  field: string,
  minimum: number,
): number => {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return fail(`${field} must be numeric`);
  }
  if (typeof value === 'string' && value.trim() === '') {
    return fail(`${field} must be numeric`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fail(`${field} must be finite and at least ${minimum}`);
  }
  return parsed;
};

const parseInteger = (
  value: unknown,
  field: string,
  minimum: number,
): number => {
  const parsed = parseNumber(value, field, minimum);
  if (!Number.isInteger(parsed)) return fail(`${field} must be an integer`);
  return parsed;
};

const optionalInteger = (
  record: JsonRecord,
  field: string,
  path: string,
  minimum: number,
): number | undefined => record[field] === undefined
  ? undefined
  : parseInteger(record[field], `${path}.${field}`, minimum);

const durationMs = (value: unknown, field: string): number =>
  Math.round(parseNumber(value, field, 0) * 1000);

const greatestCommonDivisor = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
};

const parseFrameRate = (value: unknown, field: string): FrameRateRational => {
  if (typeof value !== 'string') return fail(`${field} must be a rational string`);
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) return fail(`${field} must be a rational string`);
  const rawNumerator = Number(match[1]);
  const rawDenominator = Number(match[2]);
  if (
    !Number.isSafeInteger(rawNumerator)
    || !Number.isSafeInteger(rawDenominator)
    || rawNumerator <= 0
    || rawDenominator <= 0
  ) {
    return fail(`${field} must contain positive safe integers`);
  }
  const divisor = greatestCommonDivisor(rawNumerator, rawDenominator);
  const numerator = rawNumerator / divisor;
  const denominator = rawDenominator / divisor;
  const result = numerator / denominator;
  if (!Number.isFinite(result) || result <= 0) {
    return fail(`${field} must resolve to a positive finite rate`);
  }
  return {numerator, denominator, value: result};
};

const normalizeRotation = (value: number): number => {
  const normalized = ((value % 360) + 360) % 360;
  if (Math.abs(normalized) < 0.000001 || Math.abs(normalized - 360) < 0.000001) {
    return 0;
  }
  return Number(normalized.toFixed(6));
};

const rotationFromDisplayMatrix = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const firstRow = value.split('\n')[0];
  if (firstRow === undefined) return undefined;
  const payload = firstRow.includes(':')
    ? firstRow.slice(firstRow.indexOf(':') + 1)
    : firstRow;
  const values = payload.trim().split(/\s+/).slice(0, 2).map(Number);
  const first = values[0];
  const second = values[1];
  if (!Number.isFinite(first) || !Number.isFinite(second)) return undefined;
  return normalizeRotation(-Math.atan2(second!, first!) * 180 / Math.PI);
};

const parseRotation = (
  stream: JsonRecord,
  sideData: JsonRecord[],
  path: string,
): number => {
  for (const [index, entry] of sideData.entries()) {
    if (entry.rotation !== undefined) {
      return normalizeRotation(parseNumber(
        entry.rotation,
        `${path}.side_data_list[${index}].rotation`,
        -Number.MAX_VALUE,
      ));
    }
    const matrixRotation = rotationFromDisplayMatrix(entry.displaymatrix);
    if (matrixRotation !== undefined) return matrixRotation;
  }

  if (stream.tags === undefined) return 0;
  const tags = asRecord(stream.tags, `${path}.tags`);
  if (tags.rotate === undefined) return 0;
  return normalizeRotation(parseNumber(
    tags.rotate,
    `${path}.tags.rotate`,
    -Number.MAX_VALUE,
  ));
};

const parseSideData = (stream: JsonRecord, path: string): JsonRecord[] => {
  if (stream.side_data_list === undefined) return [];
  if (!Array.isArray(stream.side_data_list)) {
    return fail(`${path}.side_data_list must be an array`);
  }
  return stream.side_data_list.map((entry, index) =>
    asRecord(entry, `${path}.side_data_list[${index}]`));
};

const parseVideoStream = (stream: JsonRecord, path: string): VideoStreamProbe => {
  const sideData = parseSideData(stream, path);
  const profile = optionalString(stream, 'profile', path);
  const codecTag = optionalString(stream, 'codec_tag_string', path);
  const colorPrimaries = optionalString(stream, 'color_primaries', path);
  const colorTransfer = optionalString(stream, 'color_transfer', path);
  const colorSpace = optionalString(stream, 'color_space', path);
  const colorRange = optionalString(stream, 'color_range', path);
  const streamDuration = stream.duration === undefined
    ? undefined
    : durationMs(stream.duration, `${path}.duration`);
  const frameCount = optionalInteger(stream, 'nb_frames', path, 0);
  const bitsPerRawSample = optionalInteger(stream, 'bits_per_raw_sample', path, 0);
  const bitsPerCodedSample = optionalInteger(stream, 'bits_per_coded_sample', path, 0);

  return {
    index: parseInteger(stream.index, `${path}.index`, 0),
    codec: requiredString(stream, 'codec_name', path),
    ...(profile === undefined ? {} : {profile}),
    ...(codecTag === undefined ? {} : {codecTag}),
    pixelFormat: requiredString(stream, 'pix_fmt', path),
    width: parseInteger(stream.width, `${path}.width`, 1),
    height: parseInteger(stream.height, `${path}.height`, 1),
    averageFrameRate: parseFrameRate(
      stream.avg_frame_rate,
      `${path}.avg_frame_rate`,
    ),
    realFrameRate: parseFrameRate(
      stream.r_frame_rate,
      `${path}.r_frame_rate`,
    ),
    ...(colorPrimaries === undefined ? {} : {colorPrimaries}),
    ...(colorTransfer === undefined ? {} : {colorTransfer}),
    ...(colorSpace === undefined ? {} : {colorSpace}),
    ...(colorRange === undefined ? {} : {colorRange}),
    rotation: parseRotation(stream, sideData, path),
    ...(streamDuration === undefined ? {} : {durationMs: streamDuration}),
    ...(frameCount === undefined ? {} : {frameCount}),
    ...(bitsPerRawSample === undefined ? {} : {bitsPerRawSample}),
    ...(bitsPerCodedSample === undefined ? {} : {bitsPerCodedSample}),
    sideDataTypes: sideData.flatMap((entry, index) => {
      const sideDataType = optionalString(
        entry,
        'side_data_type',
        `${path}.side_data_list[${index}]`,
      );
      return sideDataType === undefined ? [] : [sideDataType];
    }),
  };
};

const parseAudioStream = (stream: JsonRecord, path: string): AudioStreamProbe => {
  const profile = optionalString(stream, 'profile', path);
  const sampleFormat = optionalString(stream, 'sample_fmt', path);
  const sampleRate = optionalInteger(stream, 'sample_rate', path, 1);
  const channels = optionalInteger(stream, 'channels', path, 1);
  const channelLayout = optionalString(stream, 'channel_layout', path);
  const streamDuration = stream.duration === undefined
    ? undefined
    : durationMs(stream.duration, `${path}.duration`);

  return {
    index: parseInteger(stream.index, `${path}.index`, 0),
    codec: requiredString(stream, 'codec_name', path),
    ...(profile === undefined ? {} : {profile}),
    ...(sampleFormat === undefined ? {} : {sampleFormat}),
    ...(sampleRate === undefined ? {} : {sampleRate}),
    ...(channels === undefined ? {} : {channels}),
    ...(channelLayout === undefined ? {} : {channelLayout}),
    ...(streamDuration === undefined ? {} : {durationMs: streamDuration}),
  };
};

const STILL_IMAGE_FORMATS = new Set([
  'apng',
  'bmp_pipe',
  'gif',
  'jpeg_pipe',
  'jpegls_pipe',
  'png_pipe',
  'tiff_pipe',
  'webp_pipe',
]);

const resolveDuration = (
  format: JsonRecord,
  formatName: string,
  videoStreams: VideoStreamProbe[],
  audioStreams: AudioStreamProbe[],
): number => {
  if (format.duration !== undefined) {
    const parsed = durationMs(format.duration, 'format.duration');
    if (parsed === 0 && !STILL_IMAGE_FORMATS.has(formatName)) {
      return fail('format.duration must be positive for timed media');
    }
    return parsed;
  }

  const streamDurations = [...videoStreams, ...audioStreams]
    .flatMap((stream) => stream.durationMs === undefined ? [] : [stream.durationMs]);
  if (streamDurations.length > 0) {
    const parsed = Math.max(...streamDurations);
    if (parsed === 0 && !STILL_IMAGE_FORMATS.has(formatName)) {
      return fail('stream duration must be positive for timed media');
    }
    return parsed;
  }
  if (STILL_IMAGE_FORMATS.has(formatName) && videoStreams.length === 1) return 0;
  return fail('ffprobe output is missing a valid duration');
};

export const parseFfprobeJson = (source: string): MediaProbe => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return fail('ffprobe output is not valid JSON', error);
  }

  const root = asRecord(parsed, 'ffprobe output');
  if (!Array.isArray(root.streams)) return fail('ffprobe output.streams must be an array');
  const format = asRecord(root.format, 'ffprobe output.format');
  const formatName = requiredString(format, 'format_name', 'format');
  const videoStreams: VideoStreamProbe[] = [];
  const audioStreams: AudioStreamProbe[] = [];

  for (const [index, rawStream] of root.streams.entries()) {
    const path = `streams[${index}]`;
    const stream = asRecord(rawStream, path);
    const codecType = requiredString(stream, 'codec_type', path);
    if (codecType === 'video') videoStreams.push(parseVideoStream(stream, path));
    if (codecType === 'audio') audioStreams.push(parseAudioStream(stream, path));
  }
  if (videoStreams.length === 0 && audioStreams.length === 0) {
    return fail('ffprobe output contains no audio or video streams');
  }

  return {
    durationMs: resolveDuration(format, formatName, videoStreams, audioStreams),
    formatName,
    videoStreams,
    audioStreams,
  };
};

const relativeDifference = (left: number, right: number): number =>
  Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right));

const validRate = (rate: FrameRateRational): boolean =>
  Number.isSafeInteger(rate.numerator)
  && Number.isSafeInteger(rate.denominator)
  && rate.numerator > 0
  && rate.denominator > 0
  && Number.isFinite(rate.value)
  && rate.value > 0;

export const isVariableFrameRate = (stream: VideoStreamProbe): boolean => {
  if (!validRate(stream.averageFrameRate) || !validRate(stream.realFrameRate)) {
    return true;
  }

  if (relativeDifference(
    stream.averageFrameRate.value,
    stream.realFrameRate.value,
  ) > 0.002) {
    return true;
  }

  if (
    stream.frameCount !== undefined
    && stream.frameCount > 0
    && stream.durationMs !== undefined
    && stream.durationMs > 0
  ) {
    const expectedFrames = stream.averageFrameRate.value * stream.durationMs / 1000;
    const tolerance = Math.max(1, stream.frameCount * 0.005);
    if (Math.abs(expectedFrames - stream.frameCount) > tolerance) return true;
  }
  return false;
};

const HDR_TRANSFERS = new Set([
  'arib-std-b67',
  'hlg',
  'pq',
  'smpte2084',
]);

const SDR_PRIMARIES = new Set([
  'bt2020',
  'bt470bg',
  'bt470m',
  'bt709',
  'ebu3213',
  'film',
  'jedec-p22',
  'smpte170m',
  'smpte240m',
  'smpte431',
  'smpte432',
]);

const SDR_TRANSFERS = new Set([
  'bt1361e',
  'bt2020-10',
  'bt2020-12',
  'bt709',
  'gamma22',
  'gamma28',
  'iec61966-2-1',
  'iec61966-2-4',
  'linear',
  'log',
  'log_sqrt',
  'smpte170m',
  'smpte240m',
]);

const SDR_SPACES = new Set([
  'bt2020c',
  'bt2020nc',
  'bt470bg',
  'bt709',
  'chroma-derived-c',
  'chroma-derived-nc',
  'fcc',
  'gbr',
  'rgb',
  'smpte170m',
  'smpte2085',
  'smpte240m',
  'ycgco',
]);

const hasDolbyVision = (stream: VideoStreamProbe): boolean => {
  const fields = [
    stream.codec,
    stream.profile ?? '',
    stream.codecTag ?? '',
    ...stream.sideDataTypes,
  ].map((value) => value.toLowerCase());
  return fields.some((value) =>
    value.includes('dolby vision')
    || value.includes('dovi')
    || /^(dva1|dvav|dvhe|dvh1)/.test(value));
};

const explicitPixelBitDepth = (pixelFormat: string): number | undefined => {
  const normalized = pixelFormat.toLowerCase();
  const planar = /(?:^|p)(9|10|12|14|16)(?:le|be)?$/.exec(normalized);
  if (planar) return Number(planar[1]);
  const packedYuv = /^p0?(10|12|16)(?:le|be)$/.exec(normalized);
  if (packedYuv) return Number(packedYuv[1]);
  const gray = /^gray(9|10|12|14|16)(?:le|be)$/.exec(normalized);
  if (gray) return Number(gray[1]);
  const rgb = /^(?:rgb|bgr)(30|36|48)(?:le|be)?$/.exec(normalized);
  if (rgb) return Number(rgb[1]) / 3;
  const rgba = /^(?:rgba|bgra|argb|abgr)(40|48|64)(?:le|be)?$/.exec(normalized);
  if (rgba) return Number(rgba[1]) / 4;
  return undefined;
};

const hasHighBitDepth = (stream: VideoStreamProbe): boolean =>
  (stream.bitsPerRawSample ?? 0) > 8
  || (stream.bitsPerCodedSample ?? 0) > 8
  || (explicitPixelBitDepth(stream.pixelFormat) ?? 8) > 8;

const normalizedColor = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (
    normalized === 'unknown'
    || normalized === 'unspecified'
    || normalized === 'reserved'
  ) {
    return undefined;
  }
  return normalized;
};

const hasSupportedSdrMetadata = (stream: VideoStreamProbe): boolean => {
  const primaries = normalizedColor(stream.colorPrimaries);
  const transfer = normalizedColor(stream.colorTransfer);
  const space = normalizedColor(stream.colorSpace);
  const range = normalizedColor(stream.colorRange);
  return primaries !== undefined
    && transfer !== undefined
    && space !== undefined
    && range !== undefined
    && SDR_PRIMARIES.has(primaries)
    && SDR_TRANSFERS.has(transfer)
    && SDR_SPACES.has(space)
    && (range === 'tv' || range === 'pc');
};

const isDirectBt709 = (stream: VideoStreamProbe): boolean =>
  normalizedColor(stream.colorPrimaries) === 'bt709'
  && normalizedColor(stream.colorTransfer) === 'bt709'
  && normalizedColor(stream.colorSpace) === 'bt709';

export const decideVideoCompatibility = (
  probe: MediaProbe,
  options: {decodable: boolean},
): CompatibilityDecision => {
  if (!options.decodable) {
    return {
      compatibility: 'rejected',
      errorCode: 'ASSET_DECODE_FAILED',
      reasons: ['video sample decode failed'],
    };
  }

  const stream = probe.videoStreams[0];
  if (stream === undefined) {
    return {
      compatibility: 'rejected',
      errorCode: 'ASSET_DECODE_FAILED',
      reasons: ['video stream is missing'],
    };
  }

  const rejectionReasons: string[] = [];
  if (hasDolbyVision(stream)) rejectionReasons.push('Dolby Vision is unsupported');
  if (hasHighBitDepth(stream)) {
    rejectionReasons.push(`high bit-depth video is unsupported (${stream.pixelFormat})`);
  }
  const transfer = normalizedColor(stream.colorTransfer);
  if (transfer !== undefined && HDR_TRANSFERS.has(transfer)) {
    rejectionReasons.push(`HDR transfer is unsupported (${transfer})`);
  }
  if (
    (transfer === undefined || !HDR_TRANSFERS.has(transfer))
    && !hasSupportedSdrMetadata(stream)
  ) {
    rejectionReasons.push('color metadata is missing or unsupported');
  }
  if (rejectionReasons.length > 0) {
    return {
      compatibility: 'rejected',
      errorCode: 'ASSET_HDR_UNSUPPORTED',
      reasons: rejectionReasons,
    };
  }

  const reasons: string[] = [];
  if (stream.codec.toLowerCase() !== 'h264') {
    reasons.push(`video codec must be h264 (received ${stream.codec})`);
  }
  if (stream.pixelFormat.toLowerCase() !== 'yuv420p') {
    reasons.push(`pixel format must be yuv420p (received ${stream.pixelFormat})`);
  }
  if (!isDirectBt709(stream)) {
    reasons.push('color metadata must be BT.709 for direct use');
  }
  if (isVariableFrameRate(stream)) {
    reasons.push('variable frame rate requires normalization');
  }

  return reasons.length === 0
    ? {compatibility: 'direct'}
    : {compatibility: 'transcoded', reasons};
};
