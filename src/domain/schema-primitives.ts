import {z} from 'zod';

const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

export const StableIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const ProjectRelativePathSchema = z.string().min(1).superRefine((value, context) => {
  if (value.startsWith('/')) {
    context.addIssue({code: 'custom', message: 'must not start with /'});
  }
  if (WINDOWS_DRIVE_PATTERN.test(value)) {
    context.addIssue({code: 'custom', message: 'must not use a Windows drive path'});
  } else if (URI_SCHEME_PATTERN.test(value)) {
    context.addIssue({code: 'custom', message: 'must not use a URI scheme'});
  }
  if (value.includes('\\')) {
    context.addIssue({code: 'custom', message: 'must use forward slashes'});
  }
  if (value.split('/').includes('..')) {
    context.addIssue({code: 'custom', message: 'must not contain a parent-directory segment'});
  }
});
