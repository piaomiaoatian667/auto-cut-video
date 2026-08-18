import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const EXIT_CODES = Object.freeze({
  ok: 0,
  invalid: 2,
  blocked: 3,
  io: 4,
});

export class PublishStateError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options);
    this.name = 'PublishStateError';
    this.kind = kind;
  }
}

const isPlainObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value);

const assertObject = (value, label) => {
  if (!isPlainObject(value)) {
    throw new PublishStateError('invalid', `${label} must be an object`);
  }
  return value;
};

const assertAllowedKeys = (value, allowedKeys, label) => {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new PublishStateError('invalid', `${label} has unknown field: ${key}`);
    }
  }
};

const normalizeString = (value, label) => {
  if (typeof value !== 'string') {
    throw new PublishStateError('invalid', `${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PublishStateError('invalid', `${label} must not be empty`);
  }
  return normalized;
};

const normalizeRelativePath = (value, label) => {
  const normalized = normalizeString(value, label);
  if (path.isAbsolute(normalized)) {
    throw new PublishStateError('invalid', `${label} must be a project-relative path`);
  }
  return normalized;
};

const normalizeConfig = (rawConfig) => {
  const config = assertObject(rawConfig, 'config');
  assertAllowedKeys(
    config,
    new Set([
      'version',
      'account',
      'video',
      'cover',
      'title',
      'topics',
      'visibility',
      'allowDownload',
      'publish',
    ]),
    'config',
  );

  if (config.version !== 1) {
    throw new PublishStateError('invalid', 'version must equal 1');
  }

  const account = assertObject(config.account, 'account');
  assertAllowedKeys(account, new Set(['expectedName']), 'account');

  const publish = assertObject(config.publish, 'publish');
  assertAllowedKeys(publish, new Set(['mode', 'allowDuplicate']), 'publish');
  if (publish.mode !== 'immediate') {
    throw new PublishStateError('invalid', 'publish.mode must equal immediate');
  }
  if (
    publish.allowDuplicate !== undefined
    && typeof publish.allowDuplicate !== 'boolean'
  ) {
    throw new PublishStateError('invalid', 'publish.allowDuplicate must be a boolean');
  }

  if (!Array.isArray(config.topics)) {
    throw new PublishStateError('invalid', 'topics must be an array');
  }
  const topics = config.topics.map((topic, index) => {
    const normalized = normalizeString(topic, `topics[${index}]`);
    if (normalized.startsWith('#')) {
      throw new PublishStateError('invalid', 'topics must not start with #');
    }
    return normalized;
  });
  if (new Set(topics).size !== topics.length) {
    throw new PublishStateError('invalid', 'topics must be unique');
  }

  const allowedVisibility = new Set(['public', 'friends', 'private']);
  if (!allowedVisibility.has(config.visibility)) {
    throw new PublishStateError(
      'invalid',
      'visibility must be public, friends, or private',
    );
  }
  if (typeof config.allowDownload !== 'boolean') {
    throw new PublishStateError('invalid', 'allowDownload must be a boolean');
  }

  return {
    version: 1,
    account: {
      expectedName: normalizeString(account.expectedName, 'account.expectedName'),
    },
    video: normalizeRelativePath(config.video, 'video'),
    cover: normalizeRelativePath(config.cover, 'cover'),
    title: normalizeString(config.title, 'title'),
    topics,
    visibility: config.visibility,
    allowDownload: config.allowDownload,
    publish: {
      mode: 'immediate',
      allowDuplicate: publish.allowDuplicate ?? false,
    },
  };
};

const isOutsideRoot = (rootPath, targetPath) => {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
};

const resolveExistingProjectFile = async ({
  projectRoot,
  configuredPath,
  label,
  extensions,
}) => {
  if (path.isAbsolute(configuredPath)) {
    throw new PublishStateError('invalid', `${label} must be a project-relative path`);
  }

  const candidatePath = path.resolve(projectRoot, configuredPath);
  let resolvedPath;
  try {
    resolvedPath = await realpath(candidatePath);
  } catch (cause) {
    throw new PublishStateError(
      'invalid',
      `${label} file does not exist: ${configuredPath}`,
      {cause},
    );
  }

  if (isOutsideRoot(projectRoot, resolvedPath)) {
    throw new PublishStateError(
      'invalid',
      `${label} resolves outside project root`,
    );
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  if (extensions !== undefined && !extensions.has(extension)) {
    const supported = [...extensions].join(', ');
    throw new PublishStateError(
      'invalid',
      `${label} extension must be one of: ${supported}`,
    );
  }

  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch (cause) {
    throw new PublishStateError('io', `failed to inspect ${label}`, {cause});
  }
  if (!fileStat.isFile()) {
    throw new PublishStateError('invalid', `${label} must be a regular file`);
  }
  if (fileStat.size === 0) {
    throw new PublishStateError('invalid', `${label} file is empty`);
  }

  return {path: resolvedPath, size: fileStat.size};
};

const hashFile = async (filePath) => {
  const hash = createHash('sha256');
  try {
    await new Promise((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
  } catch (cause) {
    throw new PublishStateError('io', 'failed to hash video', {cause});
  }
  return `sha256:${hash.digest('hex')}`;
};

const RECEIPT_STATUSES = new Set(['published', 'unknown', 'failed']);

export const scanReceipts = async ({receiptDirectory, allowDuplicate}) => {
  let entries;
  try {
    entries = await readdir(receiptDirectory, {withFileTypes: true});
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      return {
        directory: receiptDirectory,
        statuses: [],
        blocked: false,
        reason: null,
        allowDuplicate,
      };
    }
    throw new PublishStateError('io', 'failed to read receipt directory', {cause});
  }

  const statuses = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') {
      continue;
    }
    const receiptPath = path.join(receiptDirectory, entry.name);
    let receipt;
    try {
      receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    } catch (cause) {
      throw new PublishStateError(
        'io',
        `failed to read receipt: ${entry.name}`,
        {cause},
      );
    }
    if (!isPlainObject(receipt) || !RECEIPT_STATUSES.has(receipt.status)) {
      throw new PublishStateError('io', `invalid receipt status: ${entry.name}`);
    }
    statuses.push(receipt.status);
  }

  const reason = statuses.includes('unknown')
    ? 'unknown'
    : !allowDuplicate && statuses.includes('published')
      ? 'published'
      : null;

  return {
    directory: receiptDirectory,
    statuses,
    blocked: reason !== null,
    reason,
    allowDuplicate,
  };
};

const normalizeNullableString = (value, label) => {
  if (value === null) {
    return null;
  }
  return normalizeString(value, label);
};

const assertResultMatchesPreflight = (preflight, result) => {
  if (result.videoSha256 !== preflight.video.sha256) {
    throw new PublishStateError('invalid', 'result videoSha256 does not match preflight');
  }
  if (result.title !== preflight.config.title) {
    throw new PublishStateError('invalid', 'result title does not match preflight');
  }
  if (
    result.accountName !== null
    && result.accountName !== preflight.config.account.expectedName
  ) {
    throw new PublishStateError('invalid', 'result accountName does not match preflight');
  }
};

const normalizeDate = (now) => {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PublishStateError('invalid', 'result timestamp is invalid');
  }
  return date;
};

const normalizePublishedResult = (preflight, result, timestamp) => {
  assertAllowedKeys(
    result,
    new Set([
      'status',
      'accountName',
      'videoSha256',
      'title',
      'topics',
      'visibility',
      'allowDownload',
      'workId',
      'workUrl',
    ]),
    'result',
  );
  if (result.accountName !== preflight.config.account.expectedName) {
    throw new PublishStateError('invalid', 'published accountName must match preflight');
  }
  if (
    !Array.isArray(result.topics)
    || JSON.stringify(result.topics) !== JSON.stringify(preflight.config.topics)
  ) {
    throw new PublishStateError('invalid', 'published topics must match preflight');
  }
  if (result.visibility !== preflight.config.visibility) {
    throw new PublishStateError('invalid', 'published visibility must match preflight');
  }
  if (result.allowDownload !== preflight.config.allowDownload) {
    throw new PublishStateError('invalid', 'published allowDownload must match preflight');
  }

  return {
    version: 1,
    platform: 'douyin',
    status: 'published',
    publishedAt: timestamp,
    accountName: result.accountName,
    videoSha256: result.videoSha256,
    title: result.title,
    topics: [...result.topics],
    visibility: result.visibility,
    allowDownload: result.allowDownload,
    workId: normalizeNullableString(result.workId, 'workId'),
    workUrl: normalizeNullableString(result.workUrl, 'workUrl'),
  };
};

const normalizeAttemptResult = (preflight, result, timestamp) => {
  const isFailed = result.status === 'failed';
  assertAllowedKeys(
    result,
    new Set([
      'status',
      'accountName',
      'videoSha256',
      'title',
      'stage',
      'lastKnownUrl',
      'message',
    ]),
    'result',
  );
  if (!isFailed && result.accountName !== preflight.config.account.expectedName) {
    throw new PublishStateError('invalid', 'unknown accountName must match preflight');
  }
  if (isFailed && result.accountName !== null) {
    normalizeString(result.accountName, 'accountName');
  }

  const receipt = {
    version: 1,
    platform: 'douyin',
    status: result.status,
    [isFailed ? 'failedAt' : 'attemptedAt']: timestamp,
    accountName: result.accountName,
    videoSha256: result.videoSha256,
    title: result.title,
    stage: normalizeString(result.stage, 'stage'),
    lastKnownUrl: normalizeString(result.lastKnownUrl, 'lastKnownUrl'),
  };
  if (isFailed) {
    receipt.message = normalizeString(result.message, 'message');
  }
  return receipt;
};

const chooseReceiptPath = async ({directory, date, status}) => {
  for (let offset = 0; offset < 1000; offset += 1) {
    const candidateDate = new Date(date.getTime() + offset);
    const timestamp = candidateDate.toISOString().replaceAll(':', '-');
    const candidatePath = path.join(directory, `${timestamp}-${status}.json`);
    try {
      await access(candidatePath);
    } catch (cause) {
      if (cause?.code === 'ENOENT') {
        return candidatePath;
      }
      throw new PublishStateError('io', 'failed to inspect receipt path', {cause});
    }
  }
  throw new PublishStateError('io', 'could not allocate a unique receipt path');
};

export const recordPublishResult = async ({
  preflight,
  result: rawResult,
  now = () => new Date(),
}) => {
  const result = assertObject(rawResult, 'result');
  if (!RECEIPT_STATUSES.has(result.status)) {
    throw new PublishStateError('invalid', 'result status is invalid');
  }
  assertResultMatchesPreflight(preflight, result);

  const date = normalizeDate(now);
  const timestamp = date.toISOString();
  const receipt = result.status === 'published'
    ? normalizePublishedResult(preflight, result, timestamp)
    : normalizeAttemptResult(preflight, result, timestamp);

  const receiptDirectory = preflight.receipt.directory;
  try {
    await mkdir(receiptDirectory, {recursive: true});
  } catch (cause) {
    throw new PublishStateError('io', 'failed to create receipt directory', {cause});
  }

  const finalPath = await chooseReceiptPath({
    directory: receiptDirectory,
    date,
    status: result.status,
  });
  const temporaryPath = path.join(
    receiptDirectory,
    `.${path.basename(finalPath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {flag: 'wx'});
    await rename(temporaryPath, finalPath);
  } catch (cause) {
    await rm(temporaryPath, {force: true}).catch(() => undefined);
    throw new PublishStateError('io', 'failed to write receipt', {cause});
  }

  return {
    path: finalPath,
    relativePath: path.relative(preflight.paths.projectRoot, finalPath),
    receipt,
  };
};

export const validatePublishConfig = async ({projectRoot, configPath}) => {
  let resolvedProjectRoot;
  try {
    resolvedProjectRoot = await realpath(projectRoot);
  } catch (cause) {
    throw new PublishStateError('io', 'project root is not accessible', {cause});
  }

  const configFile = await resolveExistingProjectFile({
    projectRoot: resolvedProjectRoot,
    configuredPath: normalizeRelativePath(configPath, 'config path'),
    label: 'config',
    extensions: new Set(['.json']),
  });

  let rawConfig;
  try {
    rawConfig = JSON.parse(await readFile(configFile.path, 'utf8'));
  } catch (cause) {
    throw new PublishStateError('invalid', 'config must contain valid JSON', {cause});
  }
  const config = normalizeConfig(rawConfig);

  const videoFile = await resolveExistingProjectFile({
    projectRoot: resolvedProjectRoot,
    configuredPath: config.video,
    label: 'video',
    extensions: new Set(['.mp4']),
  });
  const coverFile = await resolveExistingProjectFile({
    projectRoot: resolvedProjectRoot,
    configuredPath: config.cover,
    label: 'cover',
    extensions: new Set(['.jpg', '.jpeg', '.png']),
  });
  const sha256 = await hashFile(videoFile.path);
  const receiptDirectory = path.join(
    resolvedProjectRoot,
    'publish',
    'receipts',
    'douyin',
    sha256.slice('sha256:'.length),
  );
  const receipt = await scanReceipts({
    receiptDirectory,
    allowDuplicate: config.publish.allowDuplicate,
  });

  return {
    config,
    paths: {
      projectRoot: resolvedProjectRoot,
      config: configFile.path,
      video: videoFile.path,
      cover: coverFile.path,
    },
    video: {
      size: videoFile.size,
      sha256,
    },
    receipt,
  };
};
