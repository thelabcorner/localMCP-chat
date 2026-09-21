/** Shared, model-safe failure vocabulary for the first-party file-transfer bridge. */
export type FileTransferErrorCode =
  | 'FILE_TRANSFER_INVALID_INPUT'
  | 'FILE_TRANSFER_DISABLED'
  | 'FILE_TRANSFER_SOURCE_CHANGED'
  | 'FILE_TRANSFER_DESTINATION_EXISTS'
  | 'FILE_TRANSFER_TOO_LARGE'
  | 'FILE_TRANSFER_CHATGPT_REFERENCE_INVALID'
  | 'FILE_TRANSFER_OPENAI_AUTH_REQUIRED'
  | 'FILE_TRANSFER_OPENAI_AUTH_FAILED'
  | 'FILE_TRANSFER_OPENAI_NOT_FOUND'
  | 'FILE_TRANSFER_OPENAI_RATE_LIMITED'
  | 'FILE_TRANSFER_REMOTE_FAILED'
  | 'FILE_TRANSFER_LOCAL_READ_FAILED'
  | 'FILE_TRANSFER_LOCAL_WRITE_FAILED'
  | 'FILE_TRANSFER_UPLOAD_AMBIGUOUS';

export class FileTransferError extends Error {
  constructor(
    readonly code: FileTransferErrorCode,
    message: string,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'FileTransferError';
  }
}

export function asFileTransferError(error: unknown): FileTransferError {
  if (error instanceof FileTransferError) return error;
  return new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'The file transfer failed unexpectedly.');
}
