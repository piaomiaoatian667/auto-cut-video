export const EXIT_CODES = {
  success: 0,
  needsReview: 2,
  validationFailed: 3,
  environmentFailed: 4,
  cancelled: 130,
  terminated: 143,
} as const;
