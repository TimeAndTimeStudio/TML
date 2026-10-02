// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

export class AppError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.status = options.status ?? 500;
    this.details = options.details;
    this.expose = options.expose ?? this.status < 500;
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export class HttpError extends AppError {}

export class ValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'VALIDATION_ERROR',
      status: options.status ?? 400,
      expose: true,
    });
  }
}

export class SourceNotAllowedError extends ValidationError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'URL_NOT_ALLOWED',
      status: 403,
    });
  }
}

export class UpstreamError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'UPSTREAM_ERROR',
      status: options.status ?? 502,
      expose: true,
    });
    this.upstreamStatus = options.upstreamStatus;
  }
}

export class NotFoundError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'NOT_FOUND',
      status: 404,
      expose: true,
    });
  }
}

export class MethodNotAllowedError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'METHOD_NOT_ALLOWED',
      status: 405,
      expose: true,
    });
    this.allow = options.allow ?? [];
  }
}

export class ConfigError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'CONFIG_ERROR',
      status: 500,
      expose: true,
    });
  }
}

export class DownloadError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'DOWNLOAD_FAILED',
      status: options.status ?? 502,
      expose: true,
    });
    this.upstreamStatus = options.upstreamStatus;
  }
}

export class ChecksumMismatchError extends DownloadError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'CHECKSUM_MISMATCH',
      status: options.status ?? 502,
    });
    this.mismatches = options.details?.mismatches ?? [];
  }
}

export class CancelledError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'CANCELLED',
      status: options.status ?? 499,
      expose: true,
    });
  }
}

export class InstallError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'INSTALL_FAILED',
      status: options.status ?? 500,
      expose: true,
    });
    this.failures = options.details?.failures ?? [];
  }
}

export class CorruptDataError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'INVALID_DATA',
      status: options.status ?? 500,
      expose: true,
    });
  }
}

export class JavaRuntimeError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'JAVA_RUNTIME_NOT_FOUND',
      status: options.status ?? 404,
      expose: true,
    });
    this.attempts = options.details?.attempts ?? [];
  }
}

export class LaunchError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'LAUNCH_FAILED',
      status: options.status ?? 500,
      expose: true,
    });
    this.stage = options.details?.stage ?? null;
    this.missing = options.details?.missing ?? [];
  }
}

export class AuthError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'AUTH_FAILED',
      status: options.status ?? 500,
      expose: true,
    });
    this.stage = options.details?.stage ?? null;
  }
}

export class InstanceError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'INSTANCE_FAILED',
      status: options.status ?? 500,
      expose: true,
    });
    this.stage = options.details?.stage ?? null;
  }
}

export function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    return new AppError('Internal server error', {
      code: 'INTERNAL_ERROR',
      status: 500,
      expose: false,
      cause: err,
    });
  }
  return new AppError('Internal server error', {
    code: 'INTERNAL_ERROR',
    status: 500,
    expose: false,
    details: { value: String(err) },
  });
}
