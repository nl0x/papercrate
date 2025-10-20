import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { DownloadIcon, EditIcon } from '../ui/icons';
import { getTagColorStyle } from '../utils/colors';
import { formatFileSize } from '../utils/format';
import { resolveDocumentAssetUrl } from '../asset_manager';
import { CORRESPONDENT_ROLES } from '../constants/correspondents';

const MAX_PREVIEW_STACK_ITEMS = 15;

const normalizeRole = (role) => (role || '').toLowerCase();

const formatRoleLabel = (role) => {
  const normalized = normalizeRole(role);
  if (!normalized) return 'Other';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const compareCorrespondents = (a, b) => {
  const indexA = CORRESPONDENT_ROLES.indexOf(a.role);
  const indexB = CORRESPONDENT_ROLES.indexOf(b.role);
  const rankedA = indexA === -1 ? Number.MAX_SAFE_INTEGER : indexA;
  const rankedB = indexB === -1 ? Number.MAX_SAFE_INTEGER : indexB;
  if (rankedA !== rankedB) {
    return rankedA - rankedB;
  }
  return (a.name || '').localeCompare(b.name || '');
};

const sortCorrespondents = (entries = []) =>
  entries
    .map((entry) => ({
      id: entry.id,
      name: entry.name || '',
      role: normalizeRole(entry.role),
    }))
    .sort(compareCorrespondents);

const CorrespondentPills = ({ entries = [], onRemove, showCount = false }) => (
  <div className="correspondent-list">
    {entries.length ? (
      entries.map((entry) => (
        <span key={`${entry.id}:${entry.role}`} className="correspondent-pill">
          <span className="correspondent-pill__label">
            <strong>{formatRoleLabel(entry.role)}</strong>
            <span>
              {entry.name}
              {showCount && entry.count ? ` (${entry.count})` : ''}
            </span>
          </span>
          {onRemove ? (
            <button
              type="button"
              className="correspondent-pill__remove"
              onClick={() => onRemove(entry)}
              aria-label={`Remove ${entry.name} as ${formatRoleLabel(entry.role)}`}
            >
              ×
            </button>
          ) : null}
        </span>
      ))
    ) : (
      <span className="meta">No correspondents yet.</span>
    )}
  </div>
);

const TagSection = ({
  title,
  tags = [],
  onRemove,
  onAdd,
  emptyMessage = 'No tags yet.',
  addPlaceholder = 'Add or create tag',
  addButtonLabel = 'Add',
  datalistId,
  datalistOptions = [],
  className,
}) => (
  <div className={className}>
    <dt>{title}</dt>
    <div className="tag-list">
      {tags.length ? (
        tags.map((tag) => {
          const key = tag.id ?? tag.label;
          const style = getTagColorStyle(tag.color);
          return (
            <span key={key} className="tag-pill" style={style || undefined}>
              {tag.label}{' '}
              {onRemove ? (
                <button type="button" onClick={() => onRemove(tag)}>
                  ×
                </button>
              ) : null}
            </span>
          );
        })
      ) : (
        <span className="meta">{emptyMessage}</span>
      )}
    </div>
    {onAdd ? (
      <form
        className="inline"
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.tag;
          const value = input.value.trim();
          if (!value) return;
          onAdd({ value, input });
        }}
      >
        <input name="tag" placeholder={addPlaceholder} list={datalistId} />
        <button type="submit">{addButtonLabel}</button>
        {datalistId ? (
          <datalist id={datalistId}>
            {datalistOptions.map((option) => (
              <option key={option.id || option.label || option} value={option.label || option} />
            ))}
          </datalist>
        ) : null}
      </form>
    ) : null}
  </div>
);

const CorrespondentSection = ({
  title,
  entries = [],
  onRemove,
  onAdd,
  showCount = false,
  addPlaceholder = 'Add or create correspondent',
  addButtonLabel = 'Add',
  datalistId,
  datalistOptions = [],
  className,
}) => (
  <div className={className}>
    <dt>{title}</dt>
    <CorrespondentPills entries={entries} onRemove={onRemove} showCount={showCount} />
    {onAdd ? (
      <form
        className="correspondent-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const nameInput = form.elements.correspondent;
          const roleSelect = form.elements.role;
          const value = nameInput.value.trim();
          const role = roleSelect.value;
          if (!value) return;
          onAdd({ name: value, role, input: nameInput });
          form.reset();
        }}
      >
        <input
          name="correspondent"
          placeholder={addPlaceholder}
          list={datalistId}
        />
        <select name="role" defaultValue={CORRESPONDENT_ROLES[0]}>
          {CORRESPONDENT_ROLES.map((role) => (
            <option key={role} value={role}>
              {role.charAt(0).toUpperCase() + role.slice(1)}
            </option>
          ))}
        </select>
        <button type="submit">{addButtonLabel}</button>
        {datalistId ? (
          <datalist id={datalistId}>
            {datalistOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        ) : null}
      </form>
    ) : null}
  </div>
);

const computeStackAngle = (docId, index) => {
  if (index === 0) return 0;
  let hash = 0;
  const source = docId || `stack-${index}`;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) % 997;
  }
  const magnitude = Math.max(3, (hash % 13) + 3);
  const sign = index % 2 === 0 ? 1 : -1;
  return magnitude * sign;
};

const PreviewStack = ({
  items = [],
  maxItems = MAX_PREVIEW_STACK_ITEMS,
  emptyMessage = 'Preview unavailable',
  onItemActivate,
  onOpenPreview,
  activeItemId = null,
}) => {
  if (!items.length) {
    return <span className="meta">{emptyMessage}</span>;
  }

  const limited = items.slice(0, maxItems);
  const hasMultiple = limited.length > 1;
  const preparedItems = useMemo(
    () =>
      limited.map((entry, index) => ({
        entry,
        angle: index === 0 ? 0 : computeStackAngle(entry.id, index),
      })),
    [limited],
  );

  return (
    <div className="preview-stack preview-stack--stacked">
      {preparedItems.map(({ entry, angle }, index) => {
        const transform = hasMultiple
          ? `translate(-50%, -50%) rotate(${angle}deg)`
          : 'translate(-50%, -50%)';
        const isFront = index === 0;
        return (
          <div
            key={entry.id || index}
            className={`preview-stack__item orientation-${entry.orientation || 'landscape'}`}
            style={{
              zIndex: preparedItems.length - index,
              transform,
            }}
            aria-hidden={hasMultiple && !onItemActivate && !onOpenPreview ? 'true' : undefined}
          >
            <img
              src={entry.url}
              alt={entry.alt || ''}
              className="preview-stack__image"
              onClick={(event) => {
                event.stopPropagation();
                if (isFront && onOpenPreview) {
                  onOpenPreview(entry.id);
                } else if (onItemActivate) {
                  onItemActivate(entry.id);
                }
              }}
              onKeyDown={(event) => {
                if (!onItemActivate && !onOpenPreview) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (isFront && onOpenPreview) {
                    onOpenPreview(entry.id);
                  } else {
                    onItemActivate?.(entry.id);
                  }
                }
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

const DetailPanel = ({
  selectedDocuments = [],
  tags = [],
  tagLookupById = new Map(),
  onTagAdd,
  onTagRemove,
  onRegenerateThumbnails,
  previewEntry,
  onOpenPreview,
  onBulkTagAdd,
  onBulkTagRemove,
  onBulkReanalyze,
  onBulkCorrespondentAdd,
  onBulkCorrespondentRemove,
  onPromoteSelection,
  activePreviewId = null,
  onUpdateTitle = async () => false,
  ensureAssetUrl = null,
  getDocumentAsset = () => null,
  correspondents = [],
  onCorrespondentAdd,
  onCorrespondentRemove,
  resolveApiPath,
}) => {
  const selectedCount = selectedDocuments.length;
  const singleDoc = selectedCount === 1 ? selectedDocuments[0] : null;

  const [titleEditDocId, setTitleEditDocId] = useState(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState(null);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrUrl, setOcrUrl] = useState(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState(null);

  useEffect(() => {
    if (!singleDoc) {
      setTitleEditDocId(null);
      setTitleDraft('');
      setTitleError(null);
      setTitleSaving(false);
      setOcrOpen(false);
      setOcrLoading(false);
      setOcrError(null);
      setOcrUrl(null);
      return;
    }

    if (titleEditDocId && titleEditDocId !== singleDoc.id) {
      setTitleEditDocId(null);
      setTitleDraft('');
      setTitleError(null);
      setTitleSaving(false);
    }
  }, [singleDoc, titleEditDocId]);

  useEffect(() => {
    setOcrOpen(false);
    setOcrLoading(false);
    setOcrError(null);
    setOcrUrl(null);
  }, [singleDoc?.id]);

  const startTitleEdit = useCallback(() => {
    if (!singleDoc) return;
    setTitleEditDocId(singleDoc.id);
    setTitleDraft(singleDoc.title || singleDoc.original_name || '');
    setTitleError(null);
  }, [singleDoc]);

  const cancelTitleEdit = useCallback(() => {
    setTitleEditDocId(null);
    setTitleDraft('');
    setTitleError(null);
    setTitleSaving(false);
  }, []);

  const submitTitleEdit = useCallback(
    async (event) => {
      event.preventDefault();
      if (!singleDoc) return;
      const trimmed = titleDraft.trim();
      if (!trimmed) {
        setTitleError('Title cannot be empty.');
        return;
      }
      setTitleSaving(true);
      try {
        const ok = await onUpdateTitle(singleDoc.id, trimmed);
        if (ok) {
          setTitleEditDocId(null);
          setTitleDraft('');
          setTitleError(null);
        } else {
          setTitleError('Failed to update title.');
        }
      } finally {
        setTitleSaving(false);
      }
    },
    [singleDoc, titleDraft, onUpdateTitle],
  );

  const handlePreviewActivate = useCallback(
    (docId) => {
      if (!docId) return;
      onPromoteSelection?.(docId);
    },
    [onPromoteSelection],
  );

  const hasOcrAsset = useMemo(
    () => Boolean(singleDoc && getDocumentAsset(singleDoc, 'ocr-text')),
    [singleDoc, getDocumentAsset],
  );

  const loadOcrUrl = useCallback(async () => {
    if (!singleDoc) {
      return;
    }
    const asset = getDocumentAsset(singleDoc, 'ocr-text');
    if (!asset) {
      setOcrError('No OCR text available for this document.');
      setOcrUrl(null);
      return;
    }
    setOcrLoading(true);
    setOcrError(null);
    try {
      let entry = asset;
      let url = entry?.url ||
        resolveDocumentAssetUrl(singleDoc, 'ocr-text', {
          ensureAssetUrl,
          getAsset: getDocumentAsset,
        });
      if (!url && typeof ensureAssetUrl === 'function') {
        const ensured = await ensureAssetUrl(singleDoc.id, asset, { force: false });
        if (ensured) {
          entry = ensured;
        }
        url = entry?.url ||
          resolveDocumentAssetUrl(singleDoc, 'ocr-text', {
            ensureAssetUrl,
            getAsset: getDocumentAsset,
          });
      }
      if (!url) {
        throw new Error('OCR text URL is unavailable.');
      }
      setOcrUrl(url);
    } catch (error) {
      setOcrError(error.message || 'Failed to load OCR text.');
      setOcrUrl(null);
    } finally {
      setOcrLoading(false);
    }
  }, [singleDoc, ensureAssetUrl, getDocumentAsset]);

  const openOcrModal = useCallback(() => {
    if (!singleDoc) {
      return;
    }
    setOcrOpen(true);
    loadOcrUrl();
  }, [singleDoc, loadOcrUrl]);

  const closeOcrModal = useCallback(() => {
    setOcrOpen(false);
  }, []);

  const makePreviewItem = useCallback(
    (doc) => {
      if (!doc) return null;
      const url = resolveDocumentAssetUrl(doc, 'preview', {
        ensureAssetUrl,
        getAsset: getDocumentAsset,
      });
      if (!url) {
        return null;
      }
      const asset = getDocumentAsset(doc, 'preview');
      const primaryObject = asset?.objects?.[0] || null;
      const primaryMetadata = primaryObject?.metadata || asset?.metadata || {};
      const width = Number(primaryMetadata?.width) || 0;
      const height = Number(primaryMetadata?.height) || 0;
      const orientation = width > 0 && height > 0 ? (width >= height ? 'landscape' : 'portrait') : 'landscape';
      return {
        id: doc.id,
        url,
        orientation,
        alt: doc.title || doc.original_name || 'Document preview',
      };
    },
    [ensureAssetUrl, getDocumentAsset],
  );

  const stackDocuments = useMemo(() => {
    if (!selectedDocuments.length) return [];
    const seen = new Set();
    const ordered = [];
    for (let index = selectedDocuments.length - 1; index >= 0; index -= 1) {
      const doc = selectedDocuments[index];
      if (!doc?.id || seen.has(doc.id)) continue;
      seen.add(doc.id);
      ordered.push(doc);
      if (ordered.length >= MAX_PREVIEW_STACK_ITEMS) {
        break;
      }
    }
    return ordered;
  }, [selectedDocuments]);

  const singlePreviewItems = useMemo(() => {
    if (!singleDoc) return [];
    const item = makePreviewItem(singleDoc);
    return item ? [item] : [];
  }, [singleDoc, makePreviewItem]);

  const stackPreviews = useMemo(
    () =>
      stackDocuments
        .map((doc) => makePreviewItem(doc))
        .filter(Boolean),
    [stackDocuments, makePreviewItem],
  );

  useEffect(() => {
    if (!ensureAssetUrl) {
      return;
    }

    stackDocuments.forEach((doc) => {
      resolveDocumentAssetUrl(doc, 'preview', {
        ensureAssetUrl,
        getAsset: getDocumentAsset,
      });
    });
  }, [stackDocuments, ensureAssetUrl, getDocumentAsset]);

  const bulkTagUnion = useMemo(() => {
    if (!selectedDocuments.length) return [];
    const tagMap = new Map();
    selectedDocuments.forEach((doc) => {
      (doc.tags || []).forEach((tag) => {
        const label = (tag?.label || '').trim();
        if (!label) return;
        if (!tagMap.has(label)) {
          const fallback = tagLookupById.get(tag.id) || {};
          tagMap.set(label, {
            id: tag.id,
            label,
            color: tag.color || fallback.color,
          });
        }
      });
    });
    return [...tagMap.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [selectedDocuments, tagLookupById]);

  const stackTotalSizeBytes = useMemo(() => {
    if (!stackPreviews.length) return 0;
    const byId = new Map(selectedDocuments.map((doc) => [doc.id, doc]));
    return stackPreviews.reduce((sum, item) => {
      const source = byId.get(item.id);
      const bytes = source?.current_version?.size_bytes;
      return sum + (typeof bytes === 'number' ? bytes : 0);
    }, 0);
  }, [stackPreviews, selectedDocuments]);

  const availableCorrespondents = useMemo(
    () => (Array.isArray(correspondents) ? correspondents : []),
    [correspondents],
  );

  const correspondentOptions = useMemo(() => {
    const seen = new Set();
    return availableCorrespondents
      .map((entry) => (entry?.name || '').trim())
      .filter((name) => {
        if (!name) return false;
        const lower = name.toLowerCase();
        if (seen.has(lower)) {
          return false;
        }
        seen.add(lower);
        return true;
      });
  }, [availableCorrespondents]);

  const singleCorrespondents = useMemo(() => {
    if (!singleDoc) return [];
    return sortCorrespondents(singleDoc.correspondents || []);
  }, [singleDoc]);

  const bulkCorrespondents = useMemo(() => {
    if (selectedDocuments.length <= 1) {
      const doc = selectedDocuments[0];
      return doc ? sortCorrespondents(doc.correspondents || []) : [];
    }

    const map = new Map();
    selectedDocuments.forEach((doc) => {
      if (!doc?.id) return;
      (doc.correspondents || []).forEach((entry) => {
        if (!entry?.id) return;
        const normalizedRole = normalizeRole(entry.role);
        const key = `${entry.id}:${normalizedRole}`;
        if (!map.has(key)) {
          map.set(key, {
            id: entry.id,
            name: entry.name || '',
            role: normalizedRole,
            documentIds: new Set(),
          });
        }
        map.get(key).documentIds.add(doc.id);
      });
    });

    return [...map.values()]
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        role: entry.role,
        documentIds: [...entry.documentIds],
        count: entry.documentIds.size,
      }))
      .sort(compareCorrespondents);
  }, [selectedDocuments]);

  const handleBulkCorrespondentRemove = useCallback(
    (entry) => {
      if (!entry?.id) return;
      const normalizedRole = normalizeRole(entry.role);
      if (onBulkCorrespondentRemove) {
        return onBulkCorrespondentRemove({
          assignments: [
            {
              correspondent_id: entry.id,
              role: normalizedRole,
            },
          ],
          documentIds: entry.documentIds,
        });
      }

      if (!onCorrespondentRemove) return;
      const targets = entry.documentIds && entry.documentIds.length
        ? entry.documentIds
        : selectedDocuments
            .filter((doc) =>
              (doc.correspondents || []).some(
                (item) => item.id === entry.id && normalizeRole(item.role) === normalizedRole,
              ),
            )
            .map((doc) => doc.id);

      return Promise.all(
        targets.map((documentId) =>
          onCorrespondentRemove({
            documentId,
            correspondentId: entry.id,
            role: normalizedRole,
          }),
        ),
      ).catch(() => {});
    },
    [bulkCorrespondents, onBulkCorrespondentRemove, onCorrespondentRemove, selectedDocuments],
  );

  const renderSingle = () => {
    if (!singleDoc) {
      return <p className="meta">Select a document to view metadata, tags and actions.</p>;
    }

    const displayName = singleDoc.title || singleDoc.original_name;
    const downloadHref = singleDoc.current_version?.download_path
      ? resolveApiPath?.(singleDoc.current_version.download_path)
      : null;
    const isEditingTitle = titleEditDocId === singleDoc.id;
    const sizeBytes = Number(singleDoc.current_version?.size_bytes) || 0;
    const sizeLabel = sizeBytes > 0 ? formatFileSize(sizeBytes) : '—';
    const issuedAt = singleDoc.issued_at
      ? new Date(singleDoc.issued_at).toLocaleString()
      : '—';
    const tagsForDoc = Array.isArray(singleDoc.tags) ? singleDoc.tags : [];
    const pageCountRaw = singleDoc.current_version?.metadata?.page_count;
    const pageCountValue =
      typeof pageCountRaw === 'number'
        ? pageCountRaw
        : pageCountRaw != null && pageCountRaw !== ''
        ? Number.parseInt(pageCountRaw, 10)
        : null;
    const hasPageCount = Number.isFinite(pageCountValue) && pageCountValue >= 0;
    const metadata =
      singleDoc.metadata && Object.keys(singleDoc.metadata).length > 0 ? singleDoc.metadata : null;
    return (
      <>
        <div>
          <div className="preview-pane preview-pane--stack">
            <PreviewStack
              items={singlePreviewItems}
              maxItems={1}
              emptyMessage="Preview loading…"
              onItemActivate={handlePreviewActivate}
              onOpenPreview={onOpenPreview}
              activeItemId={activePreviewId}
            />
          </div>
        </div>
        <div className="doc-title-row">
          {isEditingTitle ? (
            <form className="doc-title-edit" onSubmit={submitTitleEdit}>
              <input
                value={titleDraft}
                onChange={(event) => {
                  setTitleDraft(event.target.value);
                  if (titleError) {
                    setTitleError(null);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelTitleEdit();
                  }
                }}
                aria-label="Document title"
                autoFocus
              />
              <button type="submit" disabled={titleSaving}>
                Save
              </button>
              <button
                type="button"
                className="secondary"
                onClick={cancelTitleEdit}
                disabled={titleSaving}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <h3 style={{ margin: 0 }}>{displayName}</h3>
              <button
                type="button"
                className="icon-button ghost"
                onClick={startTitleEdit}
                aria-label="Edit title"
                title="Edit title"
              >
                <EditIcon className="icon-inline" />
              </button>
            </>
          )}
        </div>
        {titleError ? <div className="status-inline error">{titleError}</div> : null}
        <div className="meta">
          <div>
            <strong>Uploaded:</strong>{' '}
            {singleDoc.uploaded_at ? new Date(singleDoc.uploaded_at).toLocaleString() : '—'}
          </div>
          <div>
            <strong>Size:</strong>{' '}
            {sizeLabel}
          </div>
          <div>
            <strong>Type:</strong> {singleDoc.content_type || 'Unknown'}
          </div>
          <div>
            <strong>Issued:</strong> {issuedAt}
          </div>
          {hasPageCount ? (
            <div>
              <strong>Pages:</strong> {pageCountValue}
            </div>
          ) : null}
          <div>
            <strong>Original filename:</strong>{' '}
            {singleDoc.original_name}
          </div>
        </div>
        <div className="detail-actions">
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
            onClick={() => onOpenPreview(singleDoc.id)}
          >
            Open preview
          </button>
        <button
          type="button"
          className="secondary"
          onClick={() => onRegenerateThumbnails(singleDoc.id)}
        >
          Re-run analysis
        </button>
        </div>
        {hasOcrAsset ? (
          <div className="detail-ocr-trigger">
            <button type="button" className="secondary" onClick={openOcrModal}>
              View OCR text
            </button>
          </div>
        ) : null}
        <TagSection
          title="Tags"
          tags={tagsForDoc.map((tag) => ({
            id: tag.id,
            label: tag.label,
            color: tag.color || tagLookupById.get(tag.id)?.color,
          }))}
          onRemove={(tag) => onTagRemove(singleDoc.id, tag.id)}
          onAdd={({ value, input }) => onTagAdd(singleDoc, value, input)}
          datalistId="tag-catalog-single"
          datalistOptions={tags}
        />
        <CorrespondentSection
          title="Correspondents"
          entries={singleCorrespondents}
          onRemove={(entry) =>
            onCorrespondentRemove?.({
              documentId: singleDoc.id,
              correspondentId: entry.id,
              role: entry.role,
            })
          }
          onAdd={({ name, role, input }) =>
            onCorrespondentAdd?.({
              document: singleDoc,
              name,
              role,
              input,
            })
          }
          datalistId="correspondent-catalog-single"
          datalistOptions={correspondentOptions}
        />
        {metadata && (
          <div>
            <dt>Metadata</dt>
            <pre>{JSON.stringify(metadata, null, 2)}</pre>
          </div>
        )}
        {hasOcrAsset && ocrOpen
          ? createPortal(
              <div className="modal-backdrop" role="presentation" onClick={closeOcrModal}>
                <div
                  className="modal modal--ocr"
                  role="dialog"
                  aria-modal="true"
                  aria-label="OCR text"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="modal__header">
                    <h3>OCR Text</h3>
                    <button
                      type="button"
                      className="icon-button ghost"
                      onClick={closeOcrModal}
                      aria-label="Close OCR text"
                    >
                      ×
                    </button>
                  </div>
                  <div className="modal__body detail-ocr__content">
                    {ocrLoading ? (
                      <div className="meta">Loading OCR text…</div>
                    ) : ocrError ? (
                      <div className="status-inline error">{ocrError}</div>
                    ) : ocrUrl ? (
                      <iframe
                        title="OCR text"
                        src={ocrUrl}
                        className="detail-ocr__frame"
                      />
                    ) : (
                      <div className="meta">OCR text empty.</div>
                    )}
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}
      </>
    );
  };

  const renderBulk = () => {
    const countLabel = `${selectedCount} document${selectedCount === 1 ? '' : 's'}`;
    const sizeLabel = stackTotalSizeBytes ? formatFileSize(stackTotalSizeBytes) : '—';

    return (
      <>
        <div>
          <div className="preview-pane preview-pane--stack">
            <PreviewStack
              items={stackPreviews}
              emptyMessage="No previews available."
              onItemActivate={handlePreviewActivate}
              onOpenPreview={onOpenPreview}
              activeItemId={activePreviewId}
            />
          </div>
        </div>
        <h3 style={{ margin: 0 }}>{countLabel}</h3>
        <div className="meta">
          <div>
            <strong>Total size (stack):</strong> {sizeLabel}
          </div>
        </div>
        <TagSection
          title="Tags"
          tags={bulkTagUnion}
          emptyMessage="No tags assigned."
          onRemove={(tag) => onBulkTagRemove?.({ label: tag.label })}
          onAdd={({ value, input }) => onBulkTagAdd?.({ label: value, input })}
          addPlaceholder="Add tag to selection"
          addButtonLabel="Add tag"
          datalistId="tag-catalog-bulk"
          datalistOptions={tags}
          className="bulk-tags"
        />
        <CorrespondentSection
          title="Correspondents"
          entries={bulkCorrespondents}
          onRemove={handleBulkCorrespondentRemove}
          onAdd={({ name, role, input }) =>
            onBulkCorrespondentAdd?.({ name, role, input })
          }
          addPlaceholder="Add correspondent to selection"
          datalistId="correspondent-catalog-bulk"
          datalistOptions={correspondentOptions}
          showCount
          className="bulk-correspondents"
        />
        <button
          type="button"
          className="secondary"
          onClick={() => onBulkReanalyze?.()}
        >
          Re-analyze selection
        </button>
      </>
    );
  };

  return (
    <aside className="detail-panel column">
      <div className="column-body scrollable">
        {selectedCount <= 1 ? renderSingle() : renderBulk()}
      </div>
    </aside>
  );
};

export default DetailPanel;
