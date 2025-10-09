import { useCallback } from 'react';

const noop = () => {};

const normalizeMessage = (error) => {
  if (!error) return 'Something went wrong.';
  if (typeof error === 'string') {
    return error;
  }
  const { response, message } = error;
  if (response?.data?.error) return response.data.error;
  if (response?.data?.message) return response.data.message;
  return message || 'Something went wrong.';
};

const useApiError = ({
  logger = console,
  onReport = noop,
} = {}) => {
  return useCallback(
    (error, { message, variant = 'error', retry = null } = {}) => {
      const normalizedMessage = message || normalizeMessage(error);
      if (logger && typeof logger.error === 'function') {
        logger.error('[API]', normalizedMessage, error);
      }
      onReport({ message: normalizedMessage, variant, retry, error });
      return normalizedMessage;
    },
    [logger, onReport],
  );
};

export default useApiError;
