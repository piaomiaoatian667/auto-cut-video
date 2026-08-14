import {randomUUID} from 'node:crypto';
import {
  constants as fsConstants,
  type BigIntStats,
} from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import {runProcess} from '../process/run-process';
import {DownloadError} from './errors';
import {
  assertExtractorMatches,
  DownloadPlatformSchema,
  parseDownloadUrl,
  type DownloadPlatform,
} from './platforms';
import {
  DownloadReceiptSchema,
  roleForArchiveFilename,
  type DownloadArchiveFile,
  type DownloadReceipt,
} from './receipt-schema';
import {parseYtDlpInfo, type DownloadToolVersions} from './yt-dlp';

const OUTPUT_INVALID_MESSAGE = 'The download output path is invalid.';
const ARCHIVE_INVALID_MESSAGE = 'The downloaded archive contents are invalid.';
const DESTINATION_CONFLICT_MESSAGE =
  'The download destination conflicts with an existing archive.';
const FINALIZE_FAILED_MESSAGE = 'The download archive could not be finalized.';

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;
const URI_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const VIDEO_ID = /^[A-Za-z0-9._-]+$/u;
const PUBLICATION_QUARANTINE_NAME =
  /^\.publish-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TEMPORARY_SUFFIXES = ['.part', '.tmp', '.ytdl'] as const;
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const STAGING_OWNERSHIP_MARKER_OPEN_FLAGS = (
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_WRONLY |
  DARWIN_O_NOFOLLOW_ANY
);
const STAGED_INSPECTION_WORKER_SCRIPT = [
  'const {createHash} = require("node:crypto");',
  'const {constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync} = require("node:fs");',
  'const O_NOFOLLOW_ANY = 0x20000000;',
  'const readBuffer = Buffer.allocUnsafe(64 * 1024);',
  'try {',
  '  const files = [];',
  '  let metadata;',
  '  for (const name of readdirSync(".")) {',
  '    const entry = lstatSync(name);',
  '    if (entry.isSymbolicLink() || !entry.isFile()) {',
  '      files.push({name, regular: false, bytes: entry.size});',
  '      continue;',
  '    }',
  '    const descriptor = openSync(name, constants.O_RDONLY | O_NOFOLLOW_ANY);',
  '    try {',
  '      const stats = fstatSync(descriptor);',
  '      if (!stats.isFile()) throw new Error();',
  '      const hash = createHash("sha256");',
  '      const metadataChunks = name === "video.info.json" ? [] : null;',
  '      let totalBytes = 0;',
  '      let remainingBytes = stats.size;',
  '      while (remainingBytes > 0) {',
  '        const bytesRead = readSync(',
  '          descriptor, readBuffer, 0,',
  '          Math.min(readBuffer.length, remainingBytes), null,',
  '        );',
  '        if (bytesRead === 0) throw new Error();',
  '        const chunk = Buffer.from(readBuffer.subarray(0, bytesRead));',
  '        hash.update(chunk);',
  '        metadataChunks?.push(chunk);',
  '        totalBytes += bytesRead;',
  '        remainingBytes -= bytesRead;',
  '      }',
  '      if (readSync(descriptor, readBuffer, 0, 1, null) !== 0) throw new Error();',
  '      const statsAfter = fstatSync(descriptor);',
  '      if (totalBytes !== stats.size || statsAfter.size !== stats.size ||',
  '          statsAfter.dev !== stats.dev || statsAfter.ino !== stats.ino ||',
  '          statsAfter.mtimeMs !== stats.mtimeMs ||',
  '          statsAfter.ctimeMs !== stats.ctimeMs) throw new Error();',
  '      files.push({',
  '        name,',
  '        regular: true,',
  '        bytes: stats.size,',
  '        sha256: `sha256:${hash.digest("hex")}`,',
  '      });',
  '      if (metadataChunks !== null) {',
  '        const parsed = JSON.parse(Buffer.concat(metadataChunks).toString("utf8"));',
  '        metadata = {',
  '          id: parsed.id,',
  '          title: parsed.title,',
  '          webpage_url: parsed.webpage_url,',
  '          extractor: parsed.extractor,',
  '          ...(parsed.extractor_key === undefined',
  '            ? {} : {extractor_key: parsed.extractor_key}),',
  '          ...(parsed._type === undefined ? {} : {_type: parsed._type}),',
  '          ...(parsed.is_live === undefined ? {} : {is_live: parsed.is_live}),',
  '          ...(parsed.live_status === undefined',
  '            ? {} : {live_status: parsed.live_status}),',
  '        };',
  '      }',
  '    } finally {',
  '      closeSync(descriptor);',
  '    }',
  '  }',
  '  process.stdout.write(JSON.stringify({files, metadata}));',
  '} catch {',
  '  process.exitCode = 1;',
  '}',
].join('\n');
const STAGED_SEAL_WORKER_SCRIPT = [
  'const {createHash, randomUUID} = require("node:crypto");',
  'const {',
  '  constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync,',
  '  openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync,',
  '  writeSync,',
  '} = require("node:fs");',
  'const O_NOFOLLOW_ANY = 0x20000000;',
  'const CONTENT_CONFLICT = Symbol("content-conflict");',
  'const readBuffer = Buffer.allocUnsafe(64 * 1024);',
  'const operation = process.argv[1];',
  'const receiptContents = Buffer.from(process.argv[2], "base64");',
  'const receipt = JSON.parse(receiptContents.toString("utf8"));',
  'const expectedFiles = receipt.files;',
  'const contentConflict = () => { throw CONTENT_CONFLICT; };',
  'const safeUnlink = (name) => {',
  '  try { unlinkSync(name); } catch {}',
  '};',
  'const sortedNames = () => readdirSync(".")',
  '  .sort((left, right) => left.localeCompare(right));',
  'const namesMatch = (actual, expected) =>',
  '  actual.length === expected.length &&',
  '  actual.every((name, index) => name === expected[index]);',
  'const expectedNames = () => expectedFiles.map((file) => file.path)',
  '  .sort((left, right) => left.localeCompare(right));',
  'const validateExpectedFiles = () => {',
  '  if (!Array.isArray(expectedFiles)) contentConflict();',
  '  for (const file of expectedFiles) {',
  '    if (!file || typeof file.path !== "string" ||',
  '        file.path.length === 0 || file.path === "." || file.path === ".." ||',
  '        file.path.includes("/") || file.path.includes("\\\\") ||',
  '        file.path.includes("\\0") || !Number.isSafeInteger(file.bytes) ||',
  '        file.bytes < 0 || typeof file.sha256 !== "string") {',
  '      contentConflict();',
  '    }',
  '  }',
  '};',
  'const hashDescriptor = (descriptor) => {',
  '  const hash = createHash("sha256");',
  '  let totalBytes = 0;',
  '  while (true) {',
  '    const bytesRead = readSync(',
  '      descriptor, readBuffer, 0, readBuffer.length, null,',
  '    );',
  '    if (bytesRead === 0) break;',
  '    hash.update(readBuffer.subarray(0, bytesRead));',
  '    totalBytes += bytesRead;',
  '    if (!Number.isSafeInteger(totalBytes)) contentConflict();',
  '  }',
  '  return {',
  '    bytes: totalBytes,',
  '    sha256: `sha256:${hash.digest("hex")}`,',
  '  };',
  '};',
  'const snapshotFile = (file) => {',
  '  const sourcePathStats = lstatSync(file.path);',
  '  if (sourcePathStats.isSymbolicLink() || !sourcePathStats.isFile() ||',
  '      sourcePathStats.size !== file.bytes) contentConflict();',
  '  const temporaryName = `.snapshot-${randomUUID()}.tmp`;',
  '  let sourceDescriptor;',
  '  let targetDescriptor;',
  '  try {',
  '    sourceDescriptor = openSync(',
  '      file.path, constants.O_RDONLY | O_NOFOLLOW_ANY,',
  '    );',
  '    const sourceStats = fstatSync(sourceDescriptor);',
  '    if (!sourceStats.isFile() || sourceStats.size !== file.bytes ||',
  '        sourceStats.dev !== sourcePathStats.dev ||',
  '        sourceStats.ino !== sourcePathStats.ino) contentConflict();',
  '    targetDescriptor = openSync(',
  '      temporaryName,',
  '      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |',
  '        O_NOFOLLOW_ANY,',
  '      0o600,',
  '    );',
  '    const hash = createHash("sha256");',
  '    let totalBytes = 0;',
  '    let remainingBytes = file.bytes;',
  '    while (remainingBytes > 0) {',
  '      const bytesRead = readSync(',
  '        sourceDescriptor, readBuffer, 0,',
  '        Math.min(readBuffer.length, remainingBytes), null,',
  '      );',
  '      if (bytesRead === 0) contentConflict();',
  '      hash.update(readBuffer.subarray(0, bytesRead));',
  '      let writtenBytes = 0;',
  '      while (writtenBytes < bytesRead) {',
  '        writtenBytes += writeSync(',
  '          targetDescriptor, readBuffer, writtenBytes,',
  '          bytesRead - writtenBytes,',
  '        );',
  '      }',
  '      totalBytes += bytesRead;',
  '      remainingBytes -= bytesRead;',
  '      if (!Number.isSafeInteger(totalBytes)) contentConflict();',
  '    }',
  '    if (readSync(sourceDescriptor, readBuffer, 0, 1, null) !== 0) {',
  '      contentConflict();',
  '    }',
  '    const digest = `sha256:${hash.digest("hex")}`;',
  '    const sourceAfter = fstatSync(sourceDescriptor);',
  '    if (totalBytes !== file.bytes || digest !== file.sha256 ||',
  '        sourceAfter.size !== file.bytes ||',
  '        sourceAfter.dev !== sourceStats.dev ||',
  '        sourceAfter.ino !== sourceStats.ino ||',
  '        sourceAfter.mtimeMs !== sourceStats.mtimeMs ||',
  '        sourceAfter.ctimeMs !== sourceStats.ctimeMs) contentConflict();',
  '    fchmodSync(targetDescriptor, 0o400);',
  '    fsyncSync(targetDescriptor);',
  '    closeSync(targetDescriptor);',
  '    targetDescriptor = undefined;',
  '    closeSync(sourceDescriptor);',
  '    sourceDescriptor = undefined;',
  '    renameSync(temporaryName, file.path);',
  '  } finally {',
  '    if (targetDescriptor !== undefined) closeSync(targetDescriptor);',
  '    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);',
  '    safeUnlink(temporaryName);',
  '  }',
  '};',
  'const writeReceipt = () => {',
  '  const temporaryName = `.receipt-${randomUUID()}.tmp`;',
  '  let descriptor;',
  '  try {',
  '    descriptor = openSync(',
  '      temporaryName,',
  '      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |',
  '        O_NOFOLLOW_ANY,',
  '      0o600,',
  '    );',
  '    let writtenBytes = 0;',
  '    while (writtenBytes < receiptContents.length) {',
  '      writtenBytes += writeSync(',
  '        descriptor, receiptContents, writtenBytes,',
  '        receiptContents.length - writtenBytes,',
  '      );',
  '    }',
  '    fchmodSync(descriptor, 0o600);',
  '    fsyncSync(descriptor);',
  '    closeSync(descriptor);',
  '    descriptor = undefined;',
  '    renameSync(temporaryName, "receipt.json");',
  '  } finally {',
  '    if (descriptor !== undefined) closeSync(descriptor);',
  '    safeUnlink(temporaryName);',
  '  }',
  '};',
  'const verifyExpectedFile = (file) => {',
  '  const pathStats = lstatSync(file.path);',
  '  if (pathStats.isSymbolicLink() || !pathStats.isFile() ||',
  '      (pathStats.mode & 0o777) !== 0o400) contentConflict();',
  '  const descriptor = openSync(',
  '    file.path, constants.O_RDONLY | O_NOFOLLOW_ANY,',
  '  );',
  '  try {',
  '    const stats = fstatSync(descriptor);',
  '    if (!stats.isFile() || stats.dev !== pathStats.dev ||',
  '        stats.ino !== pathStats.ino || stats.size !== file.bytes) {',
  '      contentConflict();',
  '    }',
  '    const actual = hashDescriptor(descriptor);',
  '    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {',
  '      contentConflict();',
  '    }',
  '  } finally {',
  '    closeSync(descriptor);',
  '  }',
  '};',
  'const verifyReceipt = () => {',
  '  const pathStats = lstatSync("receipt.json");',
  '  if (pathStats.isSymbolicLink() || !pathStats.isFile() ||',
  '      (pathStats.mode & 0o777) !== 0o600) contentConflict();',
  '  const descriptor = openSync(',
  '    "receipt.json", constants.O_RDONLY | O_NOFOLLOW_ANY,',
  '  );',
  '  try {',
  '    const stats = fstatSync(descriptor);',
  '    if (!stats.isFile() || stats.dev !== pathStats.dev ||',
  '        stats.ino !== pathStats.ino || stats.size !== receiptContents.length ||',
  '        !readFileSync(descriptor).equals(receiptContents)) contentConflict();',
  '  } finally {',
  '    closeSync(descriptor);',
  '  }',
  '};',
  'const prepare = () => {',
  '  validateExpectedFiles();',
  '  const files = expectedNames();',
  '  if (!namesMatch(sortedNames(), files)) contentConflict();',
  '  for (const file of expectedFiles) snapshotFile(file);',
  '  if (!namesMatch(sortedNames(), files)) contentConflict();',
  '  writeReceipt();',
  '  const directoryDescriptor = openSync(',
  '    ".", constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY,',
  '  );',
  '  try {',
  '    fchmodSync(directoryDescriptor, 0o500);',
  '    fsyncSync(directoryDescriptor);',
  '  } finally {',
  '    closeSync(directoryDescriptor);',
  '  }',
  '  process.stdout.write("prepared");',
  '};',
  'const verify = () => {',
  '  validateExpectedFiles();',
  '  const directoryDescriptor = openSync(',
  '    ".", constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY,',
  '  );',
  '  try {',
  '    const directoryStats = fstatSync(directoryDescriptor);',
  '    if (!directoryStats.isDirectory() ||',
  '        (directoryStats.mode & 0o777) !== 0o500) contentConflict();',
  '  } finally {',
  '    closeSync(directoryDescriptor);',
  '  }',
  '  const files = expectedNames();',
  '  const completeNames = ["receipt.json", ...files]',
  '    .sort((left, right) => left.localeCompare(right));',
  '  if (!namesMatch(sortedNames(), completeNames)) contentConflict();',
  '  for (const file of expectedFiles) verifyExpectedFile(file);',
  '  verifyReceipt();',
  '  process.stdout.write("sealed");',
  '};',
  'try {',
  '  if (operation === "prepare") prepare();',
  '  else if (operation === "verify") verify();',
  '  else process.exitCode = 1;',
  '} catch (error) {',
  '  if (error === CONTENT_CONFLICT) process.stdout.write("content-conflict");',
  '  else process.exitCode = 1;',
  '}',
].join('\n');
const EXISTING_ARCHIVE_WORKER_SCRIPT = [
  'const {createHash} = require("node:crypto");',
  'const {',
  '  constants, closeSync, fstatSync, openSync, readSync, readdirSync,',
  '} = require("node:fs");',
  'const O_NOFOLLOW_ANY = 0x20000000;',
  'const readBuffer = Buffer.allocUnsafe(64 * 1024);',
  'const sortedNames = () => readdirSync(".")',
  '  .sort((left, right) => left.localeCompare(right));',
  'const namesMatch = (actual, expected) =>',
  '  actual.length === expected.length &&',
  '  actual.every((name, index) => name === expected[index]);',
  'const stableStats = (before, after) =>',
  '  after.isFile() && after.dev === before.dev && after.ino === before.ino &&',
  '  after.size === before.size && after.mtimeMs === before.mtimeMs &&',
  '  after.ctimeMs === before.ctimeMs;',
  'const openRegularFile = (name) => {',
  '  const descriptor = openSync(name, constants.O_RDONLY | O_NOFOLLOW_ANY);',
  '  try {',
  '    const stats = fstatSync(descriptor);',
  '    if (!stats.isFile()) throw new Error();',
  '    return {descriptor, stats};',
  '  } catch (error) {',
  '    closeSync(descriptor);',
  '    throw error;',
  '  }',
  '};',
  'const entryStillMatches = (name, expectedStats) => {',
  '  const opened = openRegularFile(name);',
  '  try {',
  '    return stableStats(expectedStats, opened.stats);',
  '  } finally {',
  '    closeSync(opened.descriptor);',
  '  }',
  '};',
  'const readExact = (descriptor, expectedBytes, consume) => {',
  '  let remainingBytes = expectedBytes;',
  '  while (remainingBytes > 0) {',
  '    const bytesRead = readSync(',
  '      descriptor, readBuffer, 0,',
  '      Math.min(readBuffer.length, remainingBytes), null,',
  '    );',
  '    if (bytesRead === 0) throw new Error();',
  '    consume(Buffer.from(readBuffer.subarray(0, bytesRead)));',
  '    remainingBytes -= bytesRead;',
  '  }',
  '  if (readSync(descriptor, readBuffer, 0, 1, null) !== 0) throw new Error();',
  '};',
  'const hashExact = (descriptor, expectedBytes, chunks) => {',
  '  const hash = createHash("sha256");',
  '  readExact(descriptor, expectedBytes, (chunk) => {',
  '    hash.update(chunk);',
  '    chunks?.push(chunk);',
  '  });',
  '  return `sha256:${hash.digest("hex")}`;',
  '};',
  'try {',
  '  const directoryDescriptor = openSync(',
  '    ".", constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY,',
  '  );',
  '  try {',
  '    const directoryStats = fstatSync(directoryDescriptor);',
  '    if (!directoryStats.isDirectory()) throw new Error();',
  '  } finally {',
  '    closeSync(directoryDescriptor);',
  '  }',
  '  const entriesBefore = sortedNames();',
  '  const receiptFile = openRegularFile("receipt.json");',
  '  let receipt;',
  '  try {',
  '    if (!Number.isSafeInteger(receiptFile.stats.size) ||',
  '        receiptFile.stats.size < 0) throw new Error();',
  '    const chunks = [];',
  '    readExact(receiptFile.descriptor, receiptFile.stats.size,',
  '      (chunk) => chunks.push(chunk));',
  '    const receiptAfter = fstatSync(receiptFile.descriptor);',
  '    if (!stableStats(receiptFile.stats, receiptAfter) ||',
  '        !entryStillMatches("receipt.json", receiptFile.stats)) throw new Error();',
  '    receipt = JSON.parse(',
  '      Buffer.concat(chunks, receiptFile.stats.size).toString("utf8"),',
  '    );',
  '  } finally {',
  '    closeSync(receiptFile.descriptor);',
  '  }',
  '  if (!receipt || !Array.isArray(receipt.files)) throw new Error();',
  '  const expectedEntries = ["receipt.json"];',
  '  for (const file of receipt.files) {',
  '    if (!file || typeof file.path !== "string" ||',
  '        file.path.length === 0 || file.path === "." || file.path === ".." ||',
  '        file.path.includes("/") || file.path.includes("\\\\") ||',
  '        file.path.includes("\\0") || !Number.isSafeInteger(file.bytes) ||',
  '        file.bytes < 0 || typeof file.sha256 !== "string") throw new Error();',
  '    expectedEntries.push(file.path);',
  '  }',
  '  expectedEntries.sort((left, right) => left.localeCompare(right));',
  '  if (!namesMatch(entriesBefore, expectedEntries)) throw new Error();',
  '  let metadata;',
  '  for (const file of receipt.files) {',
  '    const opened = openRegularFile(file.path);',
  '    try {',
  '      const metadataChunks = file.path === "video.info.json" ? [] : null;',
  '      if (!Number.isSafeInteger(opened.stats.size) ||',
  '          opened.stats.size !== file.bytes ||',
  '          hashExact(opened.descriptor, file.bytes, metadataChunks) !== file.sha256 ||',
  '          !stableStats(opened.stats, fstatSync(opened.descriptor)) ||',
  '          !entryStillMatches(file.path, opened.stats)) {',
  '        throw new Error();',
  '      }',
  '      if (metadataChunks !== null) {',
  '        const parsed = JSON.parse(',
  '          Buffer.concat(metadataChunks, file.bytes).toString("utf8"),',
  '        );',
  '        metadata = {',
  '          id: parsed.id,',
  '          title: parsed.title,',
  '          webpage_url: parsed.webpage_url,',
  '          extractor: parsed.extractor,',
  '          ...(parsed.extractor_key === undefined',
  '            ? {} : {extractor_key: parsed.extractor_key}),',
  '          ...(parsed._type === undefined ? {} : {_type: parsed._type}),',
  '          ...(parsed.is_live === undefined ? {} : {is_live: parsed.is_live}),',
  '          ...(parsed.live_status === undefined',
  '            ? {} : {live_status: parsed.live_status}),',
  '        };',
  '      }',
  '    } finally {',
  '      closeSync(opened.descriptor);',
  '    }',
  '  }',
  '  if (metadata === undefined) throw new Error();',
  '  if (!namesMatch(sortedNames(), expectedEntries)) throw new Error();',
  '  process.stdout.write(JSON.stringify({receipt, metadata}));',
  '} catch {',
  '  process.exitCode = 1;',
  '}',
].join('\n');
const DARWIN_ARCHIVE_HELPER_SCRIPT = [
  'ObjC.import("Foundation");',
  'ObjC.bindFunction("open", ["int", ["char *", "int"]]);',
  'ObjC.bindFunction("openat", ["int", ["int", "char *", "int"]]);',
  'ObjC.bindFunction("close", ["int", ["int"]]);',
  'ObjC.bindFunction("fchflags", ["int", ["int", "uint32"]]);',
  'ObjC.bindFunction("fchmod", ["int", ["int", "uint32"]]);',
  'ObjC.bindFunction("renameatx_np", ["int", ["int", "char *", "int", "char *", "uint32"]]);',
  'ObjC.bindFunction("fchdir", ["int", ["int"]]);',
  'ObjC.bindFunction("unlinkat", ["int", ["int", "char *", "int"]]);',
  'ObjC.bindFunction("__error", ["void *", []]);',
  'const DIRECTORY_AUTHORITY_FLAGS = 0x20100000;',
  'const FILE_AUTHORITY_FLAGS = 0x20000000;',
  'const RENAME_EXCL_NOFOLLOW_ANY = 20;',
  'const AT_REMOVEDIR = 128;',
  'const UF_IMMUTABLE = 2;',
  'const ENOENT = 2;',
  'const EEXIST = 17;',
  'const ELOOP = 62;',
  'const manager = $.NSFileManager.defaultManager;',
  'let identityExecutable = "";',
  'function descriptorIdentity(descriptor) {',
  '  const task = $.NSTask.alloc.init;',
  '  task.launchPath = identityExecutable;',
  '  task.arguments = [',
  '    "-e",',
  '    "const s=require(\\"node:fs\\").fstatSync(0,{bigint:true});" +',
  '      "process.stdout.write(`${s.dev}:${s.ino}`);",',
  '  ];',
  '  task.standardInput = $.NSFileHandle.alloc',
  '    .initWithFileDescriptorCloseOnDealloc(descriptor, false);',
  '  const outputPipe = $.NSPipe.pipe;',
  '  task.standardOutput = outputPipe;',
  '  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;',
  '  task.launch;',
  '  const outputData = outputPipe.fileHandleForReading.readDataToEndOfFile;',
  '  task.waitUntilExit;',
  '  if (Number(task.terminationStatus) !== 0) return null;',
  '  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(outputData, 4)).trim();',
  '}',
  'function descriptorMatches(descriptor, device, inode) {',
  '  return descriptorIdentity(descriptor) === `${device}:${inode}`;',
  '}',
  'function descriptorFileBase64(descriptor) {',
  '  const task = $.NSTask.alloc.init;',
  '  task.launchPath = identityExecutable;',
  '  task.arguments = [',
  '    "-e",',
  '    "const fs=require(\\"node:fs\\");" +',
  '      "const s=fs.fstatSync(0);" +',
  '      "if(!s.isFile())process.exit(1);" +',
  '      "process.stdout.write(fs.readFileSync(0).toString(\\"base64\\"));",',
  '  ];',
  '  task.standardInput = $.NSFileHandle.alloc',
  '    .initWithFileDescriptorCloseOnDealloc(descriptor, false);',
  '  const outputPipe = $.NSPipe.pipe;',
  '  task.standardOutput = outputPipe;',
  '  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;',
  '  task.launch;',
  '  const outputData = outputPipe.fileHandleForReading.readDataToEndOfFile;',
  '  task.waitUntilExit;',
  '  if (Number(task.terminationStatus) !== 0) return null;',
  '  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(outputData, 4));',
  '}',
  'function matchesDirectory(filePath, device, inode) {',
  '  const descriptor = Number($.open(filePath, DIRECTORY_AUTHORITY_FLAGS));',
  '  if (descriptor < 0) return false;',
  '  const matches = descriptorMatches(descriptor, device, inode);',
  '  $.close(descriptor);',
  '  return matches;',
  '}',
  'function matchesDirectoryAt(directoryDescriptor, name, device, inode) {',
  '  const descriptor = Number($.openat(',
  '    directoryDescriptor, name, DIRECTORY_AUTHORITY_FLAGS,',
  '  ));',
  '  if (descriptor < 0) return false;',
  '  const matches = descriptorMatches(descriptor, device, inode);',
  '  $.close(descriptor);',
  '  return matches;',
  '}',
  'function markerMatches(directoryDescriptor, markerName, markerBase64) {',
  '  const descriptor = Number($.openat(',
  '    directoryDescriptor, markerName, FILE_AUTHORITY_FLAGS,',
  '  ));',
  '  if (descriptor < 0) return false;',
  '  const contents = descriptorFileBase64(descriptor);',
  '  $.close(descriptor);',
  '  return contents === markerBase64;',
  '}',
  'function directoryNames(descriptor) {',
  '  if (Number($.fchdir(descriptor)) !== 0) return null;',
  '  const listError = Ref();',
  '  const entries = manager.contentsOfDirectoryAtPathError(".", listError);',
  '  if (!entries) return null;',
  '  const names = [];',
  '  for (let index = 0; index < Number(entries.count); index += 1) {',
  '    names.push(ObjC.unwrap(entries.objectAtIndex(index)));',
  '  }',
  '  return names;',
  '}',
  'function taskOutput(executable, script, args) {',
  '  const task = $.NSTask.alloc.init;',
  '  task.launchPath = executable;',
  '  task.arguments = ["-e", script].concat(args);',
  '  const outputPipe = $.NSPipe.pipe;',
  '  task.standardOutput = outputPipe;',
  '  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;',
  '  task.launch;',
  '  const outputData = outputPipe.fileHandleForReading.readDataToEndOfFile;',
  '  task.waitUntilExit;',
  '  if (Number(task.terminationStatus) !== 0) return null;',
  '  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(outputData, 4));',
  '}',
  'function receiptNames(encodedReceipt) {',
  '  const data = $.NSData.alloc.initWithBase64EncodedStringOptions(',
  '    encodedReceipt, 0,',
  '  );',
  '  if (!data) return null;',
  '  const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, 4));',
  '  const receipt = JSON.parse(text);',
  '  if (!receipt || !Array.isArray(receipt.files)) return null;',
  '  return receipt.files.map((file) => file.path).concat(["receipt.json"]);',
  '}',
  'function setImmutableFiles(directoryDescriptor, encodedReceipt) {',
  '  const names = receiptNames(encodedReceipt);',
  '  if (!names) return false;',
  '  for (const name of names) {',
  '    const descriptor = Number($.openat(',
  '      directoryDescriptor, name, FILE_AUTHORITY_FLAGS,',
  '    ));',
  '    if (descriptor < 0) return false;',
  '    const result = Number($.fchflags(descriptor, UF_IMMUTABLE));',
  '    $.close(descriptor);',
  '    if (result !== 0) return false;',
  '  }',
  '  return true;',
  '}',
  'function clearImmutableEntry(directoryDescriptor, name) {',
  '  const descriptor = Number($.openat(',
  '    directoryDescriptor, name, FILE_AUTHORITY_FLAGS,',
  '  ));',
  '  if (descriptor < 0) return Number($.__error()[0]) === ELOOP;',
  '  const result = Number($.fchflags(descriptor, 0));',
  '  $.close(descriptor);',
  '  return result === 0;',
  '}',
  'function entryExistsAt(directoryDescriptor, name) {',
  '  const descriptor = Number($.openat(',
  '    directoryDescriptor, name, FILE_AUTHORITY_FLAGS,',
  '  ));',
  '  if (descriptor >= 0) {',
  '    $.close(descriptor);',
  '    return true;',
  '  }',
  '  const errorNumber = Number($.__error()[0]);',
  '  if (errorNumber === ENOENT) return false;',
  '  if (errorNumber === ELOOP) return true;',
  '  return null;',
  '}',
  'function moveNoReplace(sourceDescriptor, sourceName, targetDescriptor, targetName) {',
  '  return Number($.renameatx_np(',
  '    sourceDescriptor, sourceName, targetDescriptor, targetName,',
  '    RENAME_EXCL_NOFOLLOW_ANY,',
  '  )) === 0;',
  '}',
  'function restore(sourceName, quarantineName) {',
  '  return moveNoReplace(3, quarantineName, 3, sourceName);',
  '}',
  'function run(argv) {',
  '  const operation = argv[0];',
  '  identityExecutable = operation === "publish" || operation === "cleanup"',
  '    ? argv[argv.length - 1] : argv[1];',
  '  if (typeof identityExecutable !== "string" || identityExecutable.length === 0) {',
  '    return "error";',
  '  }',
  '  if (operation === "remove-staging-marker") {',
  '    if (!descriptorMatches(3, argv[5], argv[6]) ||',
  '        !matchesDirectory(argv[4], argv[5], argv[6])) {',
  '      return "ownership-conflict";',
  '    }',
  '    const entries = directoryNames(3);',
  '    if (!entries || entries.length !== 1 || entries[0] !== argv[2] ||',
  '        !markerMatches(3, argv[2], argv[3])) {',
  '      return "content-conflict";',
  '    }',
  '    return Number($.unlinkat(3, argv[2], 0)) === 0 ? "removed" : "error";',
  '  }',
  '  if (operation === "cleanup-staging-marker") {',
  '    if (!descriptorMatches(3, argv[6], argv[7]) ||',
  '        !matchesDirectory(argv[5], argv[6], argv[7])) {',
  '      return "ownership-conflict";',
  '    }',
  '    const entries = directoryNames(3);',
  '    if (!entries) return "error";',
  '    let ownedName = null;',
  '    for (const name of entries) {',
  '      if (typeof name !== "string" || !name.startsWith("download-")) continue;',
  '      const descriptor = Number($.openat(3, name, DIRECTORY_AUTHORITY_FLAGS));',
  '      if (descriptor < 0) continue;',
  '      let candidateEntries = null;',
  '      if (markerMatches(descriptor, argv[2], argv[3])) {',
  '        candidateEntries = directoryNames(descriptor);',
  '      }',
  '      const restored = Number($.fchdir(3)) === 0;',
  '      $.close(descriptor);',
  '      if (!restored) return "error";',
  '      if (candidateEntries === null || candidateEntries.length !== 1 ||',
  '          candidateEntries[0] !== argv[2]) continue;',
  '      if (ownedName !== null) return "ownership-conflict";',
  '      ownedName = name;',
  '    }',
  '    if (ownedName === null) return "not-found";',
  '    if (!moveNoReplace(3, ownedName, 3, argv[4])) return "error";',
  '    const ownedDescriptor = Number($.openat(',
  '      3, argv[4], DIRECTORY_AUTHORITY_FLAGS,',
  '    ));',
  '    if (ownedDescriptor < 0) {',
  '      moveNoReplace(3, argv[4], 3, ownedName);',
  '      return "error";',
  '    }',
  '    const ownedEntries = directoryNames(ownedDescriptor);',
  '    const restored = Number($.fchdir(3)) === 0;',
  '    const markerMatchesOwned = markerMatches(',
  '      ownedDescriptor, argv[2], argv[3],',
  '    );',
  '    if (!restored || !ownedEntries || ownedEntries.length !== 1 ||',
  '        ownedEntries[0] !== argv[2] || !markerMatchesOwned) {',
  '      $.close(ownedDescriptor);',
  '      moveNoReplace(3, argv[4], 3, ownedName);',
  '      return "ownership-conflict";',
  '    }',
  '    if (Number($.unlinkat(ownedDescriptor, argv[2], 0)) !== 0) {',
  '      $.close(ownedDescriptor);',
  '      moveNoReplace(3, argv[4], 3, ownedName);',
  '      return "error";',
  '    }',
  '    $.close(ownedDescriptor);',
  '    return Number($.unlinkat(3, argv[4], AT_REMOVEDIR)) === 0',
  '      ? "cleaned" : "error";',
  '  }',
  '  if (operation === "inspect-staging") {',
  '    if (!matchesDirectory(argv[3], argv[4], argv[5]) ||',
  '        !matchesDirectory(argv[6], argv[7], argv[8]) ||',
  '        !matchesDirectory(argv[9], argv[10], argv[11])) {',
  '      return "ownership-conflict";',
  '    }',
  '    if (Number($.fchdir(3)) !== 0) return "error";',
  '    const output = taskOutput(argv[1], argv[2], []);',
  '    return output === null ? "error" : output;',
  '  }',
  '  if (operation === "seal-staging") {',
  '    if (!matchesDirectory(argv[4], argv[5], argv[6]) ||',
  '        !matchesDirectory(argv[7], argv[8], argv[9]) ||',
  '        !matchesDirectory(argv[10], argv[11], argv[12])) {',
  '      return "ownership-conflict";',
  '    }',
  '    if (Number($.fchdir(3)) !== 0) return "error";',
  '    const prepared = taskOutput(argv[1], argv[2], ["prepare", argv[3]]);',
  '    if (prepared === "content-conflict") return "content-conflict";',
  '    if (prepared !== "prepared") return "error";',
  '    if (!setImmutableFiles(3, argv[3])) return "error";',
  '    const verified = taskOutput(argv[1], argv[2], ["verify", argv[3]]);',
  '    if (verified === "content-conflict") return "content-conflict";',
  '    return verified === "sealed" ? "sealed" : "error";',
  '  }',
  '  if (operation === "inspect-existing") {',
  '    if (!matchesDirectory(argv[4], argv[5], argv[6]) ||',
  '        !matchesDirectory(argv[7], argv[8], argv[9]) ||',
  '        !matchesDirectory(argv[10], argv[11], argv[12])) {',
  '      return "ownership-conflict";',
  '    }',
  '    if (Number($.fchdir(4)) !== 0 ||',
  '        !matchesDirectory(argv[3], argv[11], argv[12]) ||',
  '        Number($.fchdir(5)) !== 0) return "ownership-conflict";',
  '    const output = taskOutput(argv[1], argv[2], []);',
  '    if (output === null) return "error";',
  '    if (!matchesDirectory(argv[4], argv[5], argv[6]) ||',
  '        !matchesDirectory(argv[7], argv[8], argv[9]) ||',
  '        !matchesDirectory(argv[10], argv[11], argv[12]) ||',
  '        Number($.fchdir(4)) !== 0 ||',
  '        !matchesDirectory(argv[3], argv[11], argv[12])) {',
  '      return "ownership-conflict";',
  '    }',
  '    return output;',
  '  }',
  '  if (operation === "publish") {',
  '    if (!matchesDirectory(argv[4], argv[5], argv[6]) ||',
  '        !matchesDirectory(argv[7], argv[8], argv[9]) ||',
  '        !matchesDirectory(argv[10], argv[11], argv[12])) {',
  '      return "ownership-conflict";',
  '    }',
  '    if (Number($.fchmod(5, 448)) !== 0) return "error";',
  '    if (Number($.fchdir(3)) !== 0) return "error";',
  '    const result = Number($.renameatx_np(',
  '      3, argv[1], 3, argv[3], RENAME_EXCL_NOFOLLOW_ANY,',
  '    ));',
  '    if (result !== 0) return "source-conflict";',
  '    if (!matchesDirectoryAt(3, argv[3], argv[14], argv[15]) ||',
  '        !matchesDirectory(argv[4], argv[5], argv[6]) ||',
  '        !matchesDirectory(argv[7], argv[8], argv[9]) ||',
  '        !matchesDirectory(argv[10], argv[11], argv[12])) {',
  '      restore(argv[1], argv[3]);',
  '      return "source-conflict";',
  '    }',
  '    const published = Number($.renameatx_np(',
  '      3, argv[3], 4, argv[2], RENAME_EXCL_NOFOLLOW_ANY,',
  '    ));',
  '    if (published === 0) return "published";',
  '    const errorNumber = Number($.__error()[0]);',
  '    if (!restore(argv[1], argv[3])) return "error";',
  '    return errorNumber === EEXIST || errorNumber === ELOOP',
  '      ? "destination-conflict" : "error";',
  '  }',
  '  if (operation === "cleanup") {',
  '    if (!matchesDirectory(argv[3], argv[4], argv[5]) ||',
  '        !matchesDirectory(argv[6], argv[7], argv[8]) ||',
  '        !matchesDirectory(argv[9], argv[10], argv[11])) {',
  '      return "ownership-conflict";',
  '    }',
  '    if (Number($.fchmod(4, 448)) !== 0) return "error";',
  '    if (Number($.fchdir(3)) !== 0) return "error";',
  '    const renamed = Number($.renameatx_np(',
  '      3, argv[1], 3, argv[2], RENAME_EXCL_NOFOLLOW_ANY,',
  '    ));',
  '    if (renamed !== 0) return "error";',
  '    if (!matchesDirectory(argv[2], argv[10], argv[11])) {',
  '      restore(argv[1], argv[2]);',
  '      return "ownership-conflict";',
  '    }',
  '    if (!matchesDirectory(argv[3], argv[4], argv[5]) ||',
  '        !matchesDirectory(argv[6], argv[7], argv[8])) {',
  '      restore(argv[1], argv[2]);',
  '      return "ownership-conflict";',
  '    }',
  '    if (Number($.fchdir(4)) !== 0) {',
  '      restore(argv[1], argv[2]);',
  '      return "error";',
  '    }',
  '    if (Number($.fchmod(4, 448)) !== 0) {',
  '      $.fchdir(3);',
  '      restore(argv[1], argv[2]);',
  '      return "error";',
  '    }',
  '    const listError = Ref();',
  '    const entries = manager.contentsOfDirectoryAtPathError(".", listError);',
  '    if (!entries) {',
  '      $.fchdir(3);',
  '      restore(argv[1], argv[2]);',
  '      return "error";',
  '    }',
  '    for (let index = 0; index < Number(entries.count); index += 1) {',
  '      const name = ObjC.unwrap(entries.objectAtIndex(index));',
  '      if (!clearImmutableEntry(4, name)) {',
  '        $.fchdir(3);',
  '        restore(argv[1], argv[2]);',
  '        return "error";',
  '      }',
  '      const removeError = Ref();',
  '      if (!manager.removeItemAtPathError(name, removeError)) {',
  '        $.fchdir(3);',
  '        restore(argv[1], argv[2]);',
  '        return "error";',
  '      }',
  '    }',
  '    if (Number($.fchdir(3)) !== 0) return "error";',
  '    if (!matchesDirectory(argv[2], argv[10], argv[11]) ||',
  '        !matchesDirectory(argv[3], argv[4], argv[5]) ||',
  '        !matchesDirectory(argv[6], argv[7], argv[8])) {',
  '      restore(argv[1], argv[2]);',
  '      return "ownership-conflict";',
  '    }',
  '    if (Number($.unlinkat(3, argv[2], AT_REMOVEDIR)) !== 0) return "error";',
  '    return "cleaned";',
  '  }',
  '  return "error";',
  '}',
].join('\n');
const DIRECTORY_OPEN_FLAGS = (
  fsConstants.O_RDONLY |
  fsConstants.O_DIRECTORY |
  DARWIN_O_NOFOLLOW_ANY
);

export interface ValidatedArchiveRoot {
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
}

export interface StagedArchive {
  status: 'staging';
  root: ValidatedArchiveRoot;
  platform: DownloadPlatform;
  videoId: string;
  stagingDirectory: string;
  finalDirectory: string;
  relativeDirectory: string;
}

export interface StagingDownloadAuthority {
  readonly fd: number;
  close(): Promise<void>;
}

export interface ExistingArchive {
  status: 'already-present';
  platform: DownloadPlatform;
  videoId: string;
  directory: string;
  mediaPath: string;
  receiptPath: string;
  receipt: DownloadReceipt;
}

export type ArchivePreparation = StagedArchive | ExistingArchive;

export interface FinalizeArchiveInput {
  platform: DownloadPlatform;
  videoId: string;
  title: string;
  canonicalUrl: string;
  downloadedAt: Date;
  tools: DownloadToolVersions;
}

export interface DownloadedArchive {
  status: 'downloaded';
  platform: DownloadPlatform;
  videoId: string;
  directory: string;
  mediaPath: string;
  receiptPath: string;
  receipt: DownloadReceipt;
}

interface DirectoryIdentity {
  device: string;
  inode: string;
}

interface StagedArchiveOwnership {
  root: DirectoryIdentity;
  platformDirectory: DirectoryIdentity;
  stagingRoot: DirectoryIdentity;
  stagingDirectory: DirectoryIdentity;
  publicationQuarantineName?: string;
}

interface StagingOwnershipMarker {
  filename: string;
  contentsBase64: string;
}

const stagedArchiveOwnership = new WeakMap<StagedArchive, StagedArchiveOwnership>();

const createStagingOwnershipMarker = (): StagingOwnershipMarker => ({
  filename: `.ownership-${randomUUID()}`,
  contentsBase64: Buffer.from(
    `${randomUUID()}:${randomUUID()}`,
    'utf8',
  ).toString('base64'),
});

const writeStagingOwnershipMarker = async (
  stagingDirectory: string,
  marker: StagingOwnershipMarker,
): Promise<void> => {
  const markerContents = Buffer.from(marker.contentsBase64, 'base64');
  const handle = await open(
    path.join(stagingDirectory, marker.filename),
    STAGING_OWNERSHIP_MARKER_OPEN_FLAGS,
    0o600,
  );
  try {
    await handle.writeFile(markerContents);
    await handle.sync();
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== markerContents.byteLength) {
      throw new Error();
    }
  } finally {
    await handle.close();
  }
};

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;

const lstatIfExists = async (target: string) => {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
};

const directoryIdentity = (stats: BigIntStats): DirectoryIdentity => ({
  device: stats.dev.toString(),
  inode: stats.ino.toString(),
});

const readDirectoryIdentity = async (
  directory: string,
): Promise<DirectoryIdentity> => {
  const stats = await lstat(directory, {bigint: true});
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error();
  return directoryIdentity(stats);
};

const identitiesMatch = (
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean => left.device === right.device && left.inode === right.inode;

const openOwnedDirectory = async (
  directory: string,
  expectedIdentity: DirectoryIdentity,
): Promise<FileHandle> => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error();
  }
  const handle = await open(directory, DIRECTORY_OPEN_FLAGS);
  try {
    const stats = await handle.stat({bigint: true});
    if (
      !stats.isDirectory() ||
      !identitiesMatch(directoryIdentity(stats), expectedIdentity)
    ) {
      throw new Error();
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
};

const closeDirectories = async (
  handles: readonly FileHandle[],
): Promise<void> => {
  await Promise.allSettled(handles.map((handle) => handle.close()));
};

const identityArguments = (
  directory: string,
  identity: DirectoryIdentity,
): string[] => [directory, identity.device, identity.inode];

const ensureRealDirectory = async (directory: string): Promise<void> => {
  let stats = await lstatIfExists(directory);
  if (stats === null) {
    try {
      await mkdir(directory);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    stats = await lstat(directory);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error();
};

const isWithin = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const outputSegments = (outputRoot: string): string[] => {
  if (
    outputRoot.length === 0 ||
    path.posix.isAbsolute(outputRoot) ||
    WINDOWS_DRIVE_PREFIX.test(outputRoot) ||
    URI_PREFIX.test(outputRoot) ||
    outputRoot.includes('\\') ||
    outputRoot.includes('\0')
  ) {
    throw new Error();
  }
  const segments = outputRoot.split('/');
  if (segments.some((segment) =>
    segment === '' || segment === '.' || segment === '..')) {
    throw new Error();
  }
  return segments;
};

const validVideoId = (videoId: string): boolean =>
  videoId.length >= 1 &&
  videoId.length <= 512 &&
  videoId !== '.' &&
  videoId !== '..' &&
  VIDEO_ID.test(videoId);

const isStrictDescendant = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
};

const isOwnedStagingDirectory = (prepared: StagedArchive): boolean => {
  const stagingRoot = path.resolve(prepared.root.absolutePath, '.staging');
  const stagingDirectory = path.resolve(prepared.stagingDirectory);
  return isStrictDescendant(stagingRoot, stagingDirectory) &&
    path.basename(stagingDirectory).startsWith('download-');
};

interface StagedFile {
  name: string;
  role: DownloadArchiveFile['role'];
  bytes: number;
  sha256: string;
}

interface StagingInspectionFile {
  name: string;
  regular: boolean;
  bytes: number;
  sha256?: string;
}

interface StagingInspection {
  files: StagingInspectionFile[];
  metadata: unknown;
}

const validatePreparedPaths = (
  prepared: StagedArchive,
  input: FinalizeArchiveInput,
): void => {
  const expectedFinalDirectory = path.join(
    prepared.root.absolutePath,
    prepared.platform,
    prepared.videoId,
  );
  const expectedRelativeDirectory = path.posix.join(
    prepared.root.relativePath,
    prepared.platform,
    prepared.videoId,
  );
  if (
    prepared.platform !== input.platform ||
    prepared.videoId !== input.videoId ||
    prepared.finalDirectory !== expectedFinalDirectory ||
    prepared.relativeDirectory !== expectedRelativeDirectory ||
    !validVideoId(input.videoId) ||
    !DownloadPlatformSchema.safeParse(input.platform).success ||
    !isOwnedStagingDirectory(prepared) ||
    !stagedArchiveOwnership.has(prepared)
  ) {
    throw new Error();
  }
};

const parseStagingInspection = (source: string): StagingInspection => {
  const parsed: unknown = JSON.parse(source);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('files' in parsed) ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error();
  }
  const files = parsed.files.map((file): StagingInspectionFile => {
    if (
      typeof file !== 'object' ||
      file === null ||
      !('name' in file) ||
      typeof file.name !== 'string' ||
      !('regular' in file) ||
      typeof file.regular !== 'boolean' ||
      !('bytes' in file) ||
      typeof file.bytes !== 'number'
    ) {
      throw new Error();
    }
    if ('sha256' in file && typeof file.sha256 !== 'string') throw new Error();
    return {
      name: file.name,
      regular: file.regular,
      bytes: file.bytes,
      ...('sha256' in file && file.sha256 !== undefined
        ? {sha256: file.sha256}
        : {}),
    };
  });
  return {
    files,
    metadata: 'metadata' in parsed ? parsed.metadata : undefined,
  };
};

const buildReceipt = (
  prepared: StagedArchive,
  input: FinalizeArchiveInput,
  inspection: StagingInspection,
): {receipt: DownloadReceipt; mediaFilename: string} => {
  try {
    validatePreparedPaths(prepared, input);
    const stagedFiles: StagedFile[] = [];
    for (const file of inspection.files) {
      const lowerName = file.name.toLowerCase();
      const role = roleForArchiveFilename(file.name);
      if (
        !file.regular ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.sha256 === undefined ||
        role === null ||
        file.name === 'receipt.json' ||
        TEMPORARY_SUFFIXES.some((suffix) => lowerName.endsWith(suffix)) ||
        !file.name.startsWith('video.')
      ) {
        throw new Error();
      }
      stagedFiles.push({
        name: file.name,
        role,
        bytes: file.bytes,
        sha256: file.sha256,
      });
    }

    const metadataFiles = stagedFiles.filter((file) => file.role === 'metadata');
    const mediaFiles = stagedFiles.filter((file) => file.role === 'media');
    const thumbnailFiles = stagedFiles.filter((file) => file.role === 'thumbnail');
    if (
      metadataFiles.length !== 1 ||
      mediaFiles.length !== 1 ||
      thumbnailFiles.length > 1
    ) {
      throw new Error();
    }

    const info = parseYtDlpInfo(inspection.metadata);
    if (info.id !== input.videoId) throw new Error();
    assertExtractorMatches(input.platform, info.extractor);
    const metadataCanonical = parseDownloadUrl(info.canonicalUrl);
    const inputCanonical = parseDownloadUrl(input.canonicalUrl);
    if (
      metadataCanonical.platform !== input.platform ||
      inputCanonical.platform !== input.platform ||
      metadataCanonical.url !== inputCanonical.url
    ) {
      throw new Error();
    }

    const files: DownloadArchiveFile[] = [...stagedFiles]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((file) => ({
        role: file.role,
        path: file.name,
        bytes: file.bytes,
        sha256: file.sha256,
      }));

    const receipt = DownloadReceiptSchema.parse({
      version: 1,
      status: 'downloaded',
      platform: input.platform,
      videoId: input.videoId,
      title: input.title,
      canonicalUrl: inputCanonical.url,
      downloadedAt: input.downloadedAt.toISOString(),
      purpose: 'learning-analysis',
      rightsConfirmed: true,
      transcoded: false,
      tools: input.tools,
      files,
    });
    return {receipt, mediaFilename: mediaFiles[0]?.name ?? ''};
  } catch {
    throw new DownloadError('DOWNLOAD_ARCHIVE_INVALID', ARCHIVE_INVALID_MESSAGE);
  }
};

const readExistingArchive = async (
  root: ValidatedArchiveRoot,
  platformDirectory: string,
  finalDirectory: string,
  relativeDirectory: string,
  platform: DownloadPlatform,
  videoId: string,
): Promise<ExistingArchive | null> => {
  const handles: FileHandle[] = [];
  try {
    const rootIdentity = await readDirectoryIdentity(root.absolutePath);
    const rootHandle = await openOwnedDirectory(root.absolutePath, rootIdentity);
    handles.push(rootHandle);
    const platformIdentity = await readDirectoryIdentity(platformDirectory);
    const platformHandle = await openOwnedDirectory(
      platformDirectory,
      platformIdentity,
    );
    handles.push(platformHandle);

    let finalHandle: FileHandle;
    try {
      finalHandle = await open(finalDirectory, DIRECTORY_OPEN_FLAGS);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
    handles.push(finalHandle);
    const finalStats = await finalHandle.stat({bigint: true});
    if (!finalStats.isDirectory()) throw new Error();
    const finalIdentity = directoryIdentity(finalStats);

    const inspectionResult = await runDarwinArchiveHelper([
      'inspect-existing',
      process.execPath,
      EXISTING_ARCHIVE_WORKER_SCRIPT,
      videoId,
      ...identityArguments(root.absolutePath, rootIdentity),
      ...identityArguments(platformDirectory, platformIdentity),
      ...identityArguments(finalDirectory, finalIdentity),
    ], [rootHandle, platformHandle, finalHandle]);
    if (
      inspectionResult === 'ownership-conflict' ||
      inspectionResult === 'error'
    ) {
      throw new Error();
    }

    const parsedInspection: unknown = JSON.parse(inspectionResult);
    if (
      typeof parsedInspection !== 'object' ||
      parsedInspection === null ||
      !('receipt' in parsedInspection) ||
      !('metadata' in parsedInspection)
    ) {
      throw new Error();
    }
    const receipt = DownloadReceiptSchema.parse(parsedInspection.receipt);
    if (receipt.platform !== platform || receipt.videoId !== videoId) {
      throw new Error();
    }
    const metadata = parseYtDlpInfo(parsedInspection.metadata);
    if (metadata.id !== receipt.videoId) throw new Error();
    assertExtractorMatches(receipt.platform, metadata.extractor);
    const metadataCanonical = parseDownloadUrl(metadata.canonicalUrl);
    const receiptCanonical = parseDownloadUrl(receipt.canonicalUrl);
    if (
      metadataCanonical.platform !== receipt.platform ||
      receiptCanonical.platform !== receipt.platform ||
      metadataCanonical.url !== receiptCanonical.url
    ) {
      throw new Error();
    }

    const media = receipt.files.find((file) => file.role === 'media');
    if (media === undefined) throw new Error();
    return {
      status: 'already-present',
      platform,
      videoId,
      directory: relativeDirectory,
      mediaPath: path.posix.join(relativeDirectory, media.path),
      receiptPath: path.posix.join(relativeDirectory, 'receipt.json'),
      receipt,
    };
  } catch {
    throw new DownloadError(
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );
  } finally {
    await closeDirectories(handles);
  }
};

const runDarwinArchiveHelper = async (
  args: readonly string[],
  handles: readonly FileHandle[],
): Promise<string> => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error();
  }
  const result = await runProcess('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    DARWIN_ARCHIVE_HELPER_SCRIPT,
    '--',
    ...args,
  ], {
    extraStdioFds: handles.map((handle) => handle.fd),
  });
  if (result.exitCode !== 0 || result.signal !== null) throw new Error();
  return result.stdout.trim();
};

const removeStagingOwnershipMarker = async (
  stagingDirectory: string,
  stagingDirectoryIdentity: DirectoryIdentity,
  marker: StagingOwnershipMarker,
): Promise<void> => {
  const stagingDirectoryHandle = await openOwnedDirectory(
    stagingDirectory,
    stagingDirectoryIdentity,
  );
  try {
    const result = await runDarwinArchiveHelper([
      'remove-staging-marker',
      process.execPath,
      marker.filename,
      marker.contentsBase64,
      ...identityArguments(stagingDirectory, stagingDirectoryIdentity),
    ], [stagingDirectoryHandle]);
    if (result !== 'removed') throw new Error();
  } finally {
    await stagingDirectoryHandle.close().catch(() => {});
  }
};

const cleanupFailedStagingCreation = async (
  stagingRoot: string,
  stagingRootIdentity: DirectoryIdentity,
  marker: StagingOwnershipMarker,
): Promise<void> => {
  const stagingRootHandle = await openOwnedDirectory(
    stagingRoot,
    stagingRootIdentity,
  );
  try {
    const result = await runDarwinArchiveHelper([
      'cleanup-staging-marker',
      process.execPath,
      marker.filename,
      marker.contentsBase64,
      `.prepare-cleanup-${randomUUID()}`,
      ...identityArguments(stagingRoot, stagingRootIdentity),
    ], [stagingRootHandle]);
    if (result !== 'cleaned') throw new Error();
  } finally {
    await stagingRootHandle.close().catch(() => {});
  }
};

interface FinalizeArchiveAuthority {
  handles: FileHandle[];
  platformDirectory: FileHandle;
  stagingRoot: FileHandle;
  stagingDirectory: FileHandle;
}

const openFinalizeArchiveAuthority = async (
  prepared: StagedArchive,
  ownership: StagedArchiveOwnership,
): Promise<FinalizeArchiveAuthority> => {
  const platformDirectory = path.dirname(prepared.finalDirectory);
  const stagingRoot = path.dirname(prepared.stagingDirectory);
  const handles: FileHandle[] = [];
  try {
    const rootHandle = await openOwnedDirectory(
      prepared.root.absolutePath,
      ownership.root,
    );
    handles.push(rootHandle);
    const platformHandle = await openOwnedDirectory(
      platformDirectory,
      ownership.platformDirectory,
    );
    handles.push(platformHandle);
    const stagingRootHandle = await openOwnedDirectory(
      stagingRoot,
      ownership.stagingRoot,
    );
    handles.push(stagingRootHandle);
    const stagingDirectoryHandle = await openOwnedDirectory(
      prepared.stagingDirectory,
      ownership.stagingDirectory,
    );
    handles.push(stagingDirectoryHandle);
    return {
      handles,
      platformDirectory: platformHandle,
      stagingRoot: stagingRootHandle,
      stagingDirectory: stagingDirectoryHandle,
    };
  } catch (error) {
    await closeDirectories(handles);
    throw error;
  }
};

const inspectStagedArchive = async (
  prepared: StagedArchive,
  ownership: StagedArchiveOwnership,
  authority: FinalizeArchiveAuthority,
): Promise<StagingInspection> => {
  const stagingRoot = path.dirname(prepared.stagingDirectory);
  let inspectionResult: string;
  try {
    inspectionResult = await runDarwinArchiveHelper([
      'inspect-staging',
      process.execPath,
      STAGED_INSPECTION_WORKER_SCRIPT,
      ...identityArguments(prepared.root.absolutePath, ownership.root),
      ...identityArguments(stagingRoot, ownership.stagingRoot),
      ...identityArguments(prepared.stagingDirectory, ownership.stagingDirectory),
    ], [authority.stagingDirectory]);
  } catch {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }
  if (inspectionResult === 'ownership-conflict') {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }
  try {
    if (inspectionResult === 'error') throw new Error();
    return parseStagingInspection(inspectionResult);
  } catch {
    throw new DownloadError('DOWNLOAD_ARCHIVE_INVALID', ARCHIVE_INVALID_MESSAGE);
  }
};

const sealStagedArchive = async (
  prepared: StagedArchive,
  ownership: StagedArchiveOwnership,
  authority: FinalizeArchiveAuthority,
  receipt: DownloadReceipt,
): Promise<void> => {
  const stagingRoot = path.dirname(prepared.stagingDirectory);
  let sealResult: string;
  try {
    sealResult = await runDarwinArchiveHelper([
      'seal-staging',
      process.execPath,
      STAGED_SEAL_WORKER_SCRIPT,
      Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8').toString('base64'),
      ...identityArguments(prepared.root.absolutePath, ownership.root),
      ...identityArguments(stagingRoot, ownership.stagingRoot),
      ...identityArguments(prepared.stagingDirectory, ownership.stagingDirectory),
    ], [authority.stagingDirectory]);
  } catch {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }
  if (sealResult === 'content-conflict') {
    throw new DownloadError('DOWNLOAD_ARCHIVE_INVALID', ARCHIVE_INVALID_MESSAGE);
  }
  if (sealResult !== 'sealed') {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }
};

const publishArchiveAtomically = async (
  prepared: StagedArchive,
  ownership: StagedArchiveOwnership,
  authority: FinalizeArchiveAuthority,
): Promise<'published' | 'destination-conflict' | 'source-conflict'> => {
  const platformDirectory = path.dirname(prepared.finalDirectory);
  const stagingRoot = path.dirname(prepared.stagingDirectory);
  const publicationQuarantineName = `.publish-${randomUUID()}`;
  ownership.publicationQuarantineName = publicationQuarantineName;
  const publicationResult = await runDarwinArchiveHelper([
    'publish',
    path.basename(prepared.stagingDirectory),
    prepared.videoId,
    publicationQuarantineName,
    ...identityArguments(prepared.root.absolutePath, ownership.root),
    ...identityArguments(platformDirectory, ownership.platformDirectory),
    ...identityArguments(stagingRoot, ownership.stagingRoot),
    ...identityArguments(prepared.stagingDirectory, ownership.stagingDirectory),
    process.execPath,
  ], [
    authority.stagingRoot,
    authority.platformDirectory,
    authority.stagingDirectory,
  ]);
  if (
    publicationResult === 'published' ||
    publicationResult === 'destination-conflict' ||
    publicationResult === 'source-conflict'
  ) {
    return publicationResult;
  }
  throw new Error();
};

const cleanupArchiveAtomically = async (
  prepared: StagedArchive,
  ownership: StagedArchiveOwnership,
): Promise<void> => {
  const stagingRoot = path.dirname(prepared.stagingDirectory);
  const stagingBasename = path.basename(prepared.stagingDirectory);
  const cleanupCandidates = [stagingBasename];
  if (
    ownership.publicationQuarantineName !== undefined &&
    PUBLICATION_QUARANTINE_NAME.test(ownership.publicationQuarantineName)
  ) {
    cleanupCandidates.push(ownership.publicationQuarantineName);
  }
  const handles: FileHandle[] = [];
  try {
    handles.push(await openOwnedDirectory(
      prepared.root.absolutePath,
      ownership.root,
    ));
    const stagingRootHandle = await openOwnedDirectory(
      stagingRoot,
      ownership.stagingRoot,
    );
    handles.push(stagingRootHandle);
    let ownedEntryName: string | undefined;
    let ownedEntryPath: string | undefined;
    let stagingDirectoryHandle: FileHandle | undefined;
    for (const candidateName of cleanupCandidates) {
      const candidatePath = path.join(stagingRoot, candidateName);
      try {
        stagingDirectoryHandle = await openOwnedDirectory(
          candidatePath,
          ownership.stagingDirectory,
        );
        ownedEntryName = candidateName;
        ownedEntryPath = candidatePath;
        break;
      } catch {
        continue;
      }
    }
    if (
      stagingDirectoryHandle === undefined ||
      ownedEntryName === undefined ||
      ownedEntryPath === undefined
    ) {
      throw new Error();
    }
    handles.push(stagingDirectoryHandle);

    const cleanupResult = await runDarwinArchiveHelper([
      'cleanup',
      ownedEntryName,
      `.cleanup-${randomUUID()}`,
      ...identityArguments(prepared.root.absolutePath, ownership.root),
      ...identityArguments(stagingRoot, ownership.stagingRoot),
      ...identityArguments(ownedEntryPath, ownership.stagingDirectory),
      process.execPath,
    ], [stagingRootHandle, stagingDirectoryHandle]);
    if (cleanupResult !== 'cleaned') throw new Error();
  } finally {
    await closeDirectories(handles);
  }
};

export const validateArchiveRoot = async (
  workspaceRoot: string,
  outputRoot: string,
): Promise<ValidatedArchiveRoot> => {
  try {
    if (!path.isAbsolute(workspaceRoot)) throw new Error();
    const workspaceStats = await lstat(workspaceRoot);
    if (workspaceStats.isSymbolicLink() || !workspaceStats.isDirectory()) {
      throw new Error();
    }

    const segments = outputSegments(outputRoot);
    const realWorkspaceRoot = await realpath(workspaceRoot);
    let absolutePath = realWorkspaceRoot;
    for (const segment of segments) {
      absolutePath = path.join(absolutePath, segment);
      await ensureRealDirectory(absolutePath);
    }

    const realOutputRoot = await realpath(absolutePath);
    if (!isWithin(realWorkspaceRoot, realOutputRoot)) throw new Error();

    return {
      workspaceRoot: realWorkspaceRoot,
      absolutePath: realOutputRoot,
      relativePath: segments.join('/'),
    };
  } catch {
    throw new DownloadError('DOWNLOAD_OUTPUT_INVALID', OUTPUT_INVALID_MESSAGE);
  }
};

export const prepareArchive = async (
  root: ValidatedArchiveRoot,
  platform: DownloadPlatform,
  videoId: string,
): Promise<ArchivePreparation> => {
  if (!validVideoId(videoId) || !DownloadPlatformSchema.safeParse(platform).success) {
    throw new DownloadError('DOWNLOAD_ARCHIVE_INVALID', ARCHIVE_INVALID_MESSAGE);
  }

  let platformDirectory: string;
  let stagingRoot: string;
  try {
    const rootStats = await lstat(root.absolutePath);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error();
    platformDirectory = path.join(root.absolutePath, platform);
    stagingRoot = path.join(root.absolutePath, '.staging');
    await ensureRealDirectory(platformDirectory);
    await ensureRealDirectory(stagingRoot);
  } catch {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }

  const finalDirectory = path.join(platformDirectory, videoId);
  const relativeDirectory = path.posix.join(
    root.relativePath,
    platform,
    videoId,
  );

  const existingArchive = await readExistingArchive(
    root,
    platformDirectory,
    finalDirectory,
    relativeDirectory,
    platform,
    videoId,
  );
  if (existingArchive !== null) return existingArchive;

  let stagingRootIdentity: DirectoryIdentity | undefined;
  let ownershipMarker: StagingOwnershipMarker | undefined;
  try {
    const rootIdentity = await readDirectoryIdentity(root.absolutePath);
    const platformDirectoryIdentity = await readDirectoryIdentity(platformDirectory);
    stagingRootIdentity = await readDirectoryIdentity(stagingRoot);
    const stagingDirectory = await mkdtemp(path.join(stagingRoot, 'download-'));
    ownershipMarker = createStagingOwnershipMarker();
    await writeStagingOwnershipMarker(stagingDirectory, ownershipMarker);
    const prepared: StagedArchive = {
      status: 'staging',
      root,
      platform,
      videoId,
      stagingDirectory,
      finalDirectory,
      relativeDirectory,
    };
    const stagingDirectoryIdentity = await readDirectoryIdentity(stagingDirectory);
    stagedArchiveOwnership.set(prepared, {
      root: rootIdentity,
      platformDirectory: platformDirectoryIdentity,
      stagingRoot: stagingRootIdentity,
      stagingDirectory: stagingDirectoryIdentity,
    });
    await removeStagingOwnershipMarker(
      stagingDirectory,
      stagingDirectoryIdentity,
      ownershipMarker,
    );
    ownershipMarker = undefined;
    return prepared;
  } catch {
    if (stagingRootIdentity !== undefined && ownershipMarker !== undefined) {
      try {
        await cleanupFailedStagingCreation(
          stagingRoot,
          stagingRootIdentity,
          ownershipMarker,
        );
      } catch {
      }
    }
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }
};

export const openStagingDownloadAuthority = async (
  prepared: StagedArchive,
): Promise<StagingDownloadAuthority> => {
  const ownership = stagedArchiveOwnership.get(prepared);
  if (ownership === undefined || !isOwnedStagingDirectory(prepared)) {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }

  let handle: FileHandle;
  try {
    handle = await openOwnedDirectory(
      prepared.stagingDirectory,
      ownership.stagingDirectory,
    );
  } catch {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }

  let openAuthority = true;
  return {
    fd: handle.fd,
    async close(): Promise<void> {
      if (!openAuthority) return;
      openAuthority = false;
      try {
        await handle.close();
      } catch {
        throw new DownloadError(
          'DOWNLOAD_FINALIZE_FAILED',
          FINALIZE_FAILED_MESSAGE,
        );
      }
    },
  };
};

export const finalizeArchive = async (
  prepared: StagedArchive,
  input: FinalizeArchiveInput,
): Promise<DownloadedArchive> => {
  try {
    validatePreparedPaths(prepared, input);
  } catch {
    throw new DownloadError('DOWNLOAD_ARCHIVE_INVALID', ARCHIVE_INVALID_MESSAGE);
  }

  const ownership = stagedArchiveOwnership.get(prepared);
  if (ownership === undefined) {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }

  let authority: FinalizeArchiveAuthority;
  try {
    authority = await openFinalizeArchiveAuthority(prepared, ownership);
  } catch {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }

  try {
    const inspection = await inspectStagedArchive(prepared, ownership, authority);
    const {receipt, mediaFilename} = buildReceipt(prepared, input, inspection);
    await sealStagedArchive(prepared, ownership, authority, receipt);
    const downloadedArchive: DownloadedArchive = {
      status: 'downloaded',
      platform: input.platform,
      videoId: input.videoId,
      directory: prepared.relativeDirectory,
      mediaPath: path.posix.join(prepared.relativeDirectory, mediaFilename),
      receiptPath: path.posix.join(prepared.relativeDirectory, 'receipt.json'),
      receipt,
    };

    let publicationResult:
      | 'published'
      | 'destination-conflict'
      | 'source-conflict';
    try {
      publicationResult = await publishArchiveAtomically(
        prepared,
        ownership,
        authority,
      );
    } catch {
      throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
    }
    if (publicationResult === 'destination-conflict') {
      throw new DownloadError(
        'DOWNLOAD_DESTINATION_CONFLICT',
        DESTINATION_CONFLICT_MESSAGE,
      );
    }
    if (publicationResult === 'source-conflict') {
      throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
    }
    return downloadedArchive;
  } finally {
    await closeDirectories(authority.handles);
  }
};

export const cleanupArchive = async (
  prepared: StagedArchive,
): Promise<void> => {
  const ownership = stagedArchiveOwnership.get(prepared);
  if (
    ownership === undefined ||
    !isOwnedStagingDirectory(prepared)
  ) {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }
  try {
    await cleanupArchiveAtomically(prepared, ownership);
  } catch {
    throw new DownloadError('DOWNLOAD_FINALIZE_FAILED', FINALIZE_FAILED_MESSAGE);
  }
};
