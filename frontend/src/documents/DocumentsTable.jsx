import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {getAssetFromVersion, resolveDocumentAssetUrl} from '../asset_manager';
import { getTagColorStyle } from '../utils/colors';
import { DownloadIcon, EditIcon, ViewListIcon, ViewGridIcon, FolderIcon } from '../ui/icons';

const TAG_MIME_TYPES = ['application/x-papercrate-tag', 'text/papercrate-tag'];

const getPageCount = (doc) =>
  Number.isFinite(doc?.current_version?.metadata?.page_count)
    ? doc.current_version.metadata.page_count
    : null;

const DocumentThumbnailImage = ({ document, ensureAssetUrl, getDocumentAsset, alt, maxSize = 48 }) => {
  const resolvedMaxSize = Math.max(1, Math.round(maxSize || 1));
  const thumbnailAsset = useMemo(() => getAssetFromVersion(document?.current_version, 'thumbnail'), [document?.current_version]);
  const assetWidth = Number(thumbnailAsset?.metadata?.width);
  const assetHeight = Number(thumbnailAsset?.metadata?.height);

  const dimensions = useMemo(() => {
    if (!Number.isFinite(assetWidth) || assetWidth <= 0 || !Number.isFinite(assetHeight) || assetHeight <= 0) {
      return { width: resolvedMaxSize, height: resolvedMaxSize };
    }
    const scale = Math.min(1, resolvedMaxSize / assetWidth, resolvedMaxSize / assetHeight);
    return {
      width: Math.max(1, Math.round(assetWidth * scale)),
      height: Math.max(1, Math.round(assetHeight * scale)),
    };
  }, [assetWidth, assetHeight, resolvedMaxSize]);

  const innerStyle = useMemo(
    () => ({ width: `${dimensions.width}px`, height: `${dimensions.height}px` }),
    [dimensions.height, dimensions.width],
  );
  const url = useMemo(
    () =>
      resolveDocumentAssetUrl(document, 'thumbnail', {
        ensureAssetUrl,
        getAsset: getDocumentAsset,
      }),
    [document, ensureAssetUrl, getDocumentAsset],
  );

  const pageCount = getPageCount(document);
  const showMultiPageBadge = Number.isFinite(pageCount) && pageCount > 1;
  const innerClasses = ['document-thumbnail-inner'];
  if (showMultiPageBadge) {
    innerClasses.push('document-thumbnail-inner--multipage');
  }

  return (
    <div className="document-thumbnail-wrapper">
      <div className={innerClasses.join(' ')} style={innerStyle}>
        {url ? (
          <img
            src={url}
            alt={alt || ''}
            className="document-thumbnail"
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
          />
        ) : (
          <div className="thumb-placeholder">DOC</div>
        )}
      </div>
    </div>
  );
};

const DocumentsTable = ({
  currentFolderName,
  breadcrumbs,
  onRefresh,
  onShowSkeuoWorkspace = () => {},
  onRequestCreateFolder,
  creatingFolder = false,
  subfolders,
  documents,
  searchResults,
  isFilterActive,
  onFolderSelect,
  onFolderDrop,
  onFolderDragOver,
  onFolderDragLeave,
  onFolderDragStart,
  onFolderDragEnd,
  draggedFolderId,
  onFolderDelete,
  selectedFolderIds = [],
  onFolderRowClick,
  onDocumentRowClick,
  onDocumentOpen,
  selectedDocumentIds,
  focusedDocumentId,
  focusedRowKey,
  draggingDocumentIds = [],
  onDocumentDragStart,
  onDocumentDragEnd,
  onDocumentDelete,
  onFolderRename,
  onDocumentRename,
  tagLookupById,
  onDocumentListFocus,
  onDocumentListKeyDown,
  onFocusedRowChange,
  ensureAssetUrl = null,
  getDocumentAsset = () => null,
  getDownloadHref,
  onTagClick,
  isSearchLoading = false,
  onDocumentTagDrop,
  viewMode = 'list',
  onViewModeChange,
  onClearSelection,
}) => {
  const showingSearchResults = searchResults !== null;
  const rows = showingSearchResults ? searchResults : documents;

  const selectedSet = useMemo(
    () => new Set(selectedDocumentIds),
    [selectedDocumentIds],
  );
  const selectedFolderSet = useMemo(
    () => new Set(selectedFolderIds || []),
    [selectedFolderIds],
  );
  const draggingSet = useMemo(
    () => new Set(draggingDocumentIds || []),
    [draggingDocumentIds],
  );
  const scrollRef = useRef(null);
  const isGridView = viewMode === 'grid';
  const handleSetViewMode = useCallback(
    (nextMode) => {
      if (!onViewModeChange) {
        return;
      }
      onViewModeChange(nextMode);
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
    },
    [onViewModeChange],
  );
  const isTagDragEvent = useCallback((event) => {
    const types = Array.from(event.dataTransfer?.types || []);
    return TAG_MIME_TYPES.some((type) => types.includes(type));
  }, []);
  const ensureFocusedRowVisible = useCallback(() => {
    if (!focusedRowKey) return;
    const container = scrollRef.current;
    if (!container) return;
    let selector = null;
    if (focusedRowKey.startsWith('document:')) {
      selector = `#document-row-${focusedRowKey.slice('document:'.length)}`;
    } else if (focusedRowKey.startsWith('folder:')) {
      selector = `#folder-row-${focusedRowKey.slice('folder:'.length)}`;
    }
    if (!selector) {
      return;
    }
    const row = container.querySelector(selector);
    if (!row || !container.contains(row)) {
      return;
    }

    const header = container.querySelector('thead');
    const headerHeight = header ? header.getBoundingClientRect().height : 0;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    const visibleTop = container.scrollTop + headerHeight;
    const visibleBottom = container.scrollTop + container.clientHeight;

    if (rowTop < visibleTop) {
      container.scrollTop = Math.max(rowTop - headerHeight, 0);
      return;
    }

    if (rowBottom > visibleBottom) {
      const nextScrollTop = rowBottom - container.clientHeight;
      container.scrollTop = Math.max(nextScrollTop, 0);
    }
  }, [focusedRowKey]);

  useEffect(() => {
    ensureFocusedRowVisible();
  }, [ensureFocusedRowVisible]);

  const activeDescendantId = useMemo(() => {
    if (!focusedRowKey) return undefined;
    if (focusedRowKey.startsWith('document:')) {
      return `document-row-${focusedRowKey.slice('document:'.length)}`;
    }
    if (focusedRowKey.startsWith('folder:')) {
      return `folder-row-${focusedRowKey.slice('folder:'.length)}`;
    }
    return undefined;
  }, [focusedRowKey]);

  const handleDocumentTagDragOver = useCallback(
    (event) => {
      if (!isTagDragEvent(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      event.currentTarget.classList.add('tag-drop-target');
    },
    [isTagDragEvent],
  );

  const handleDocumentTagDragLeave = useCallback(
    (event) => {
      if (!isTagDragEvent(event)) {
        return;
      }
      if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) {
        return;
      }
      event.currentTarget.classList.remove('tag-drop-target');
    },
    [isTagDragEvent],
  );

  const handleDocumentTagDrop = useCallback(
    (event, documentId) => {
      if (!isTagDragEvent(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.remove('tag-drop-target');
      const payload =
        event.dataTransfer.getData('application/x-papercrate-tag') ||
        event.dataTransfer.getData('text/papercrate-tag');
      if (!payload) {
        return;
      }
      try {
        const parsed = JSON.parse(payload);
        if (parsed?.id && onDocumentTagDrop) {
          onDocumentTagDrop(documentId, parsed);
        }
      } catch (
        // eslint-disable-next-line no-empty
        error
      ) {}
    },
    [isTagDragEvent, onDocumentTagDrop],
  );

  const handleGridBackgroundClick = useCallback(
    (event) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      onClearSelection?.();
    },
    [onClearSelection],
  );

  return (
    <section
      className={`documents-panel column documents-panel--view-${isGridView ? 'grid' : 'list'}`}
    >
      <div className="column-header">
        <div className="column-header__titles">
          <nav className="breadcrumb" aria-label="Folder breadcrumbs">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <span key={crumb.id} className="breadcrumb-item">
                  {isLast ? (
                    <span className="breadcrumb-current">{crumb.name}</span>
                  ) : (
                    <a
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        onFolderSelect(crumb.id);
                      }}
                    >
                      {crumb.name}
                    </a>
                  )}
                  {!isLast && <span className="breadcrumb-separator">›</span>}
                </span>
              );
            })}
          </nav>
          {showingSearchResults && (
            <div className="column-subtitle">Search results</div>
          )}
        </div>
        <div className="header-actions">
          <div className="view-toggle" role="group" aria-label="Change view">
            <button
              type="button"
              className={`view-toggle__button${isGridView ? '' : ' active'}`}
              onClick={() => handleSetViewMode('list')}
              aria-pressed={!isGridView}
              title="List view"
            >
              <ViewListIcon className="view-toggle__icon" size={18} />
            </button>
            <button
              type="button"
              className={`view-toggle__button${isGridView ? ' active' : ''}`}
              onClick={() => handleSetViewMode('grid')}
              aria-pressed={isGridView}
              title="Icons view"
            >
              <ViewGridIcon className="view-toggle__icon" size={18} />
            </button>
          </div>
          <button
            type="button"
            onClick={onRequestCreateFolder}
            disabled={creatingFolder}
          >
            {creatingFolder ? 'Creating…' : 'New folder'}
          </button>
          <button className="secondary" onClick={onRefresh}>
            Refresh
          </button>
          <button className="secondary" type="button" onClick={onShowSkeuoWorkspace}>
            Desk View
          </button>
        </div>
      </div>
      <div className="column-body">
        <div
          ref={scrollRef}
          className="documents-scroll"
          tabIndex={0}
          onFocus={(event) => {
            if (event.target === scrollRef.current) {
              onDocumentListFocus?.();
            }
          }}
          onKeyDown={(event) => {
            if (event.target !== scrollRef.current) {
              return;
            }
            if (onDocumentListKeyDown) {
              onDocumentListKeyDown(event);
            }
          }}
          aria-activedescendant={isGridView ? undefined : activeDescendantId}
        >
          {!showingSearchResults && !subfolders.length && rows.length === 0 ? (
            <div className="empty-state">
              Drop files anywhere or onto a folder to upload documents.
            </div>
          ) : isGridView ? (
            <div
              className="documents-grid"
              role="list"
              onClick={handleGridBackgroundClick}
            >
              {!showingSearchResults &&
                subfolders.map((folder) => {
                  const canDragFolder = folder.id !== 'root';
                  const isDraggingFolder = draggedFolderId === folder.id;
                  const isSelectedFolder = selectedFolderSet.has(folder.id);
                  const classes = ['document-card', 'folder-card'];
                  if (isDraggingFolder) classes.push('is-dragging');
                  if (isSelectedFolder) classes.push('selected');
                  return (
                    <div
                      key={folder.id}
                      className={classes.join(' ')}
                      role="listitem"
                      id={`folder-card-${folder.id}`}
                      draggable={canDragFolder}
                      onClick={(event) => {
                        onFolderRowClick?.(folder.id, event);
                        const shouldNavigate =
                          !event.defaultPrevented &&
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.shiftKey;
                        if (shouldNavigate) {
                          onFolderSelect(folder.id);
                        }
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        onFolderSelect(folder.id);
                      }}
                      onDragOver={(event) => onFolderDragOver(event, folder.id)}
                      onDragLeave={onFolderDragLeave}
                      onDrop={(event) => onFolderDrop(event, folder.id)}
                      onDragStart={(event) => {
                        if (canDragFolder) {
                          onFolderDragStart(event, folder.id);
                        }
                      }}
                      onDragEnd={(event) => {
                        if (canDragFolder) {
                          onFolderDragEnd(event);
                        }
                      }}
                    >
                      <div className="folder-card__icon">
                        <FolderIcon
                          className="folder-card__icon-svg"
                          size={128}
                        />
                      </div>
                      <div className="folder-card__meta">
                        <div className="folder-card__name" title={folder.name}>
                          {folder.name}
                        </div>
                      </div>
                    </div>
                  );
                })}
              {rows.map((doc) => {
                const isSelected = selectedSet.has(doc.id);
                const isDraggingDoc = draggingSet.has(doc.id);
                const tagList = Array.isArray(doc.tags) ? doc.tags : [];
                const visibleTags = tagList.slice(0, 3);
                const remainingTagCount = tagList.length > 3 ? tagList.length - 3 : 0;
                const cardClasses = ['document-card', 'document'];
                if (isSelected) cardClasses.push('selected');
                if (isDraggingDoc) cardClasses.push('is-dragging');
                return (
                  <div
                    key={doc.id}
                    className={cardClasses.join(' ')}
                    role="listitem"
                    id={`document-card-${doc.id}`}
                    onClick={(event) => onDocumentRowClick(doc.id, event)}
                    onDoubleClick={() => onDocumentOpen(doc.id)}
                    draggable
                    onDragStart={(event) => onDocumentDragStart(event, doc)}
                    onDragEnd={onDocumentDragEnd}
                    onDragOver={(event) => handleDocumentTagDragOver(event)}
                    onDragOverCapture={(event) => handleDocumentTagDragOver(event)}
                    onDragLeave={handleDocumentTagDragLeave}
                    onDragLeaveCapture={handleDocumentTagDragLeave}
                    onDrop={(event) => handleDocumentTagDrop(event, doc.id)}
                    onDropCapture={(event) => handleDocumentTagDrop(event, doc.id)}
                  >
                    <DocumentThumbnailImage
                      document={doc}
                      ensureAssetUrl={ensureAssetUrl}
                      getDocumentAsset={getDocumentAsset}
                      alt={`Thumbnail for ${doc.title || doc.original_name}`}
                      maxSize={128}
                    />
                    <div className="document-card__meta">
                      <div
                        className="document-card__title"
                        title={doc.title || doc.original_name}
                      >
                        {doc.title || doc.original_name}
                      </div>
                      {visibleTags.length > 0 && (
                        <div className="document-card__tags">
                          {visibleTags.map((tag) => {
                            const colorSource = tag?.color || tagLookupById?.get(tag.id)?.color;
                            const style = getTagColorStyle(colorSource);
                            return (
                              <span
                                key={tag.id}
                                className="badge tag-chip"
                                style={style || undefined}
                                title={tag.label}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (onTagClick) {
                                    onTagClick(tag.id);
                                  }
                                }}
                                role="button"
                                tabIndex={0}
                                draggable
                                onDragStart={(event) => {
                                  event.stopPropagation();
                                  try {
                                    if (event.dataTransfer) {
                                      event.dataTransfer.effectAllowed = 'copyMove';
                                    }
                                    const payload = JSON.stringify({
                                      id: tag.id,
                                      label: tag.label,
                                      sourceDocId: doc.id,
                                    });
                                    event.dataTransfer?.setData('application/x-papercrate-tag', payload);
                                    event.dataTransfer?.setData('text/papercrate-tag', payload);
                                    event.dataTransfer?.setData('text/plain', tag.label || 'Tag');
                                  } catch (
                                    // eslint-disable-next-line no-empty
                                    error
                                  ) {}
                                }}
                                onDragEnd={(event) => {
                                  event.stopPropagation();
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    if (onTagClick) {
                                      onTagClick(tag.id);
                                    }
                                  }
                                }}
                              >
                                {tag.label}
                              </span>
                            );
                          })}
                          {remainingTagCount > 0 && (
                            <span className="badge tag-chip tag-chip--more">+{remainingTagCount}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <table aria-multiselectable="true">
              <thead>
                <tr>
                  <th className="thumb-column">Preview</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Updated</th>
                  <th className="actions-column">Actions</th>
                </tr>
              </thead>
              <tbody>
                {!showingSearchResults &&
                  subfolders.map((folder) => {
                    const canDragFolder = folder.id !== 'root';
                    const isDraggingFolder = draggedFolderId === folder.id;
                    const isSelectedFolder = selectedFolderSet.has(folder.id);
                    return (
                      <tr
                        key={folder.id}
                        className={`folder${isDraggingFolder ? ' is-dragging' : ''}${
                          focusedRowKey === `folder:${folder.id}` ? ' focused' : ''
                        }${isSelectedFolder ? ' selected' : ''}`}
                        id={`folder-row-${folder.id}`}
                        onClick={(event) => {
                          onFolderRowClick?.(folder.id, event);
                          const shouldNavigate =
                            !event.defaultPrevented &&
                            !event.metaKey &&
                            !event.ctrlKey &&
                            !event.shiftKey;
                          if (shouldNavigate) {
                            onFolderSelect(folder.id);
                          }
                          if (scrollRef.current) {
                            scrollRef.current.focus({ preventScroll: true });
                          }
                          onFocusedRowChange?.(`folder:${folder.id}`);
                        }}
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          onFolderSelect(folder.id);
                        }}
                        onDragOver={(event) => onFolderDragOver(event, folder.id)}
                        onDragLeave={onFolderDragLeave}
                        onDrop={(event) => onFolderDrop(event, folder.id)}
                        draggable={canDragFolder}
                        onDragStart={(event) => {
                          if (canDragFolder) {
                            onFolderDragStart(event, folder.id);
                          }
                        }}
                        onDragEnd={(event) => {
                          if (canDragFolder) {
                            onFolderDragEnd(event);
                          }
                        }}
                      >
                        <td className="thumb-cell">
                          <div className="thumb-icon">
                            <FolderIcon
                              className="thumb-icon__image"
                              size={32}
                            />
                          </div>
                        </td>
                        <td className="doc-list__name">
                          <div className="doc-list__name-content">
                            <span>{folder.name}</span>
                            {folder.id !== 'root' && (
                              <button
                                type="button"
                                className="icon-button ghost doc-list__icon-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!onFolderRename) return;
                                  const nextName = window.prompt('Rename folder', folder.name || '');
                                  if (!nextName) {
                                    return;
                                  }
                                  const trimmed = nextName.trim();
                                  if (!trimmed || trimmed === folder.name) {
                                    return;
                                  }
                                  onFolderRename(folder.id, trimmed);
                                }}
                                title="Rename folder"
                                aria-label={`Rename folder ${folder.name}`}
                              >
                                <EditIcon className="doc-list__icon" size={16} />
                              </button>
                            )}
                          </div>
                        </td>
                        <td>Folder</td>
                        <td>—</td>
                        <td className="actions">
                          <button
                            type="button"
                            className="icon-button danger"
                            onClick={(event) => {
                              event.stopPropagation();
                              onFolderDelete(folder.id);
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                {rows.map((doc) => {
                  const isSelected = selectedSet.has(doc.id);
                  const isDraggingDoc = draggingSet.has(doc.id);
                  const rowClasses = ['document'];
                  if (isSelected) rowClasses.push('selected');
                  if (isDraggingDoc) rowClasses.push('is-dragging');
                  const downloadHref = getDownloadHref?.(doc) || null;

                  return (
                    <tr
                      key={doc.id}
                      className={rowClasses.join(' ')}
                      id={`document-row-${doc.id}`}
                      onClick={(event) => onDocumentRowClick(doc.id, event)}
                      onDoubleClick={() => onDocumentOpen(doc.id)}
                      draggable
                      onDragStart={(event) => onDocumentDragStart(event, doc)}
                      onDragEnd={onDocumentDragEnd}
                      onDragOver={handleDocumentTagDragOver}
                      onDragLeave={handleDocumentTagDragLeave}
                      onDrop={(event) => handleDocumentTagDrop(event, doc.id)}
                    >
                      <td className="thumb-cell">
                        <DocumentThumbnailImage
                          document={doc}
                          ensureAssetUrl={ensureAssetUrl}
                          getDocumentAsset={getDocumentAsset}
                          alt={`Thumbnail for ${doc.title || doc.original_name}`}
                        />
                      </td>
                      <td className="doc-list__name">
                        <div className="doc-name">
                          <div className="doc-list__name-content">
                            <span className="doc-name__title">{doc.title || doc.original_name}</span>
                            <button
                              type="button"
                              className="icon-button ghost doc-list__icon-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                if (!onDocumentRename) return;
                                const nextName = window.prompt(
                                  'Rename document',
                                  doc.title || doc.original_name || '',
                                );
                                if (!nextName) {
                                  return;
                                }
                                const trimmed = nextName.trim();
                                if (!trimmed || trimmed === (doc.title || doc.original_name)) {
                                  return;
                                }
                                onDocumentRename(doc.id, trimmed);
                              }}
                              title="Rename document"
                              aria-label={`Rename document ${doc.title || doc.original_name}`}
                            >
                              <EditIcon className="doc-list__icon" size={16} />
                            </button>
                          </div>
                          {(doc.tags || []).length > 0 && (
                            <div className="doc-name__tags">
                              {(doc.tags || []).map((tag) => {
                                const colorSource = tag?.color || tagLookupById?.get(tag.id)?.color;
                                const style = getTagColorStyle(colorSource);
                                return (
                                  <span
                                    key={tag.id}
                                    className="badge tag-chip"
                                    style={style || undefined}
                                    title={tag.label}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (onTagClick) {
                                        onTagClick(tag.id);
                                      }
                                    }}
                                    role="button"
                                    tabIndex={0}
                                    draggable
                                    onDragStart={(event) => {
                                      event.stopPropagation();
                                      try {
                                        if (event.dataTransfer) {
                                          event.dataTransfer.effectAllowed = 'copyMove';
                                        }
                                        const payload = JSON.stringify({
                                          id: tag.id,
                                          label: tag.label,
                                          sourceDocId: doc.id,
                                        });
                                        event.dataTransfer?.setData('application/x-papercrate-tag', payload);
                                        event.dataTransfer?.setData('text/papercrate-tag', payload);
                                        event.dataTransfer?.setData('text/plain', tag.label || 'Tag');
                                      } catch (
                                        // eslint-disable-next-line no-empty
                                        error
                                      ) {}
                                    }}
                                    onDragEnd={(event) => {
                                      event.stopPropagation();
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        if (onTagClick) {
                                          onTagClick(tag.id);
                                        }
                                      }
                                    }}
                                  >
                                    {tag.label}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </td>
                      <td>{doc.content_type || 'Document'}</td>
                      <td>
                        {doc.updated_at
                          ? new Date(doc.updated_at).toLocaleString()
                          : '—'}
                      </td>
                      <td className="actions">
                        <div className="action-buttons">
                          {downloadHref ? (
                            <a
                              className="button-link with-icon"
                              href={downloadHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              onAuxClick={(event) => event.stopPropagation()}
                              onContextMenu={(event) => event.stopPropagation()}
                            >
                              <DownloadIcon className="icon-inline" />
                              <span>Download</span>
                            </a>
                          ) : (
                            <span className="meta">No download</span>
                          )}
                          <button
                            type="button"
                            className="danger"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDocumentDelete?.(doc.id);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {rows.length === 0 && showingSearchResults && !isGridView && !isSearchLoading && (
          <div className="empty-state">No documents match the current filters.</div>
        )}
        {showingSearchResults && rows.length > 0 && (
          <div className="search-hint">
            Showing {rows.length} document{rows.length === 1 ? '' : 's'} in {currentFolderName} and subfolders.
          </div>
        )}
      </div>
      {isGridView && showingSearchResults && rows.length === 0 && !isSearchLoading && (
        <div className="empty-state empty-state--global">
          No documents match the current filters.
        </div>
      )}
    </section>
  );
}; 

export default DocumentsTable;
export { DocumentThumbnailImage };
