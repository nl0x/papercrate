import React, { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useAppShell } from '../appShellContext';
import PreviewWorkspace from '../preview/PreviewWorkspace';

const DocumentViewerRoute = () => {
  const {
    previewWorkspaceDocument,
    previewWorkspaceEntry,
    closeDocumentPreview,
    handleThumbnailRegeneration,
    ensurePreviewData,
    notifyApiError,
    resolveApiPath,
  } = useAppShell();
  const { documentId } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    if (!documentId) {
      navigate('/documents', { replace: true });
      return;
    }

    let cancelled = false;

    const hydrate = async () => {
      try {
        await ensurePreviewData(documentId);
      } catch (error) {
        if (cancelled) {
          return;
        }
        notifyApiError(error, 'Failed to open document preview.');
        navigate('/documents', { replace: true });
      }
    };

    hydrate();

    return () => {
      cancelled = true;
    };
  }, [documentId, ensurePreviewData, notifyApiError, navigate]);

  const isReady =
    documentId && previewWorkspaceDocument && previewWorkspaceDocument.id === documentId;

  if (!isReady) {
    return (
      <main className="preview-main">
        <div className="preview-workspace__message">Loading preview…</div>
      </main>
    );
  }

  return (
    <main className="preview-main">
      <PreviewWorkspace
        document={previewWorkspaceDocument}
        previewEntry={previewWorkspaceEntry}
        resolveApiPath={resolveApiPath}
        onClose={closeDocumentPreview}
        onRegenerateThumbnails={handleThumbnailRegeneration}
      />
    </main>
  );
};

export default DocumentViewerRoute;

