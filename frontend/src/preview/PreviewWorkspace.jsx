import React from 'react';
import { DownloadIcon } from '../ui/icons';
import { formatFileSize } from '../utils/format';

const PreviewWorkspace = ({
  document,
  previewEntry,
  resolveApiPath,
  onClose,
  onRegenerateThumbnails,
}) => {
  if (!document) {
    return null;
  }

  const title = document.title || document.original_name || 'Document';
  const mime = previewEntry?.contentType || document.content_type || 'application/pdf';
  const downloadHref = document.current_version?.download_path
    ? resolveApiPath(document.current_version.download_path)
    : null;
  const sizeBytes = Number(document.current_version?.size_bytes) || 0;
  const sizeLabel = sizeBytes > 0 ? formatFileSize(sizeBytes) : null;
  const metadata =
    document.metadata && Object.keys(document.metadata).length > 0 ? document.metadata : null;

  return (
    <section className="preview-workspace">
      <header className="preview-workspace__header">
        <div className="preview-workspace__meta">
          <button
            type="button"
            className="secondary"
            onClick={() => onClose(document.folder_id ?? 'root')}
          >
            ← Back
          </button>
          <div>
            <h2>{title}</h2>
            <span className="meta">
              {document.content_type || mime}
              {sizeLabel ? ` · ${sizeLabel}` : ''}
            </span>
          </div>
        </div>
        <div className="preview-workspace__actions">
          <a
            className="button-link with-icon"
            href={downloadHref || '#'}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!downloadHref}
            onClick={(event) => {
              if (!downloadHref) {
                event.preventDefault();
              }
            }}
          >
            <DownloadIcon className="icon-inline" />
            <span>Download</span>
          </a>
          <button
            type="button"
            className="secondary"
            onClick={() => onRegenerateThumbnails(document.id)}
          >
            Re-run analysis
          </button>
        </div>
      </header>
      <div className="preview-workspace__body">
        {!previewEntry?.url ? (
          <div className="preview-workspace__message">Loading preview…</div>
        ) : (
          <iframe
            src={previewEntry.url}
            title={`Preview of ${title}`}
            className="preview-workspace__object"
          />
        )}
      </div>
      {metadata && (
        <section className="preview-workspace__metadata">
          <h3>Metadata</h3>
          <pre>{JSON.stringify(metadata, null, 2)}</pre>
        </section>
      )}
    </section>
  );
};

export default PreviewWorkspace;

