const isDev = process.env.NODE_ENV !== 'production';

function mask(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function sanitize(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === 'string') {
      // Mask anything that looks like a PAT or Bearer token (20+ char alphanumeric)
      return arg.replace(/([A-Za-z0-9_\-\.]{20,})/g, (m) => mask(m));
    }
    return arg;
  });
}

export const logger = {
  info: (msg: string, ...args: unknown[]) =>
    console.log(`[INFO]  ${new Date().toISOString()} ${msg}`, ...sanitize(args)),

  warn: (msg: string, ...args: unknown[]) =>
    console.warn(`[WARN]  ${new Date().toISOString()} ${msg}`, ...sanitize(args)),

  error: (msg: string, ...args: unknown[]) =>
    console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, ...sanitize(args)),

  debug: (msg: string, ...args: unknown[]) => {
    if (isDev || process.env.LOG_LEVEL === 'debug') {
      console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`, ...sanitize(args));
    }
  },
};
