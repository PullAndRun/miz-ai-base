export const summarizeError = (error: unknown) => error instanceof Error
  ? { name: error.name, message: error.message }
  : error;

export const serializeError = (error: unknown) => error instanceof Error
  ? { name: error.name, message: error.message, stack: error.stack }
  : error;
