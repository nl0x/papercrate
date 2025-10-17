import React, { useCallback, useMemo } from 'react';
import { ChevronIcon, TrashIcon, EditIcon, FolderIcon } from '../ui/icons';

import { getTagColorStyle } from '../utils/colors';

const FolderNode = ({
  node,
  depth,
  isSelected,
  onToggle,
  onSelect,
  onDrop,
  onDragOver,
  onDragLeave,
  onDelete,
  onRename,
  renderChildren,
  onFolderDragStart,
  onFolderDragEnd,
  draggingFolderId,
}) => {
  const isRoot = node.id === 'root';
  const hasChildren = node.children.length > 0;
  const canToggle = !isRoot && (hasChildren || !node.loaded);
  const showChevron = !isRoot && hasChildren;
  const icon = showChevron ? <ChevronIcon className="toggle-icon" /> : null;
  const canDrag = !isRoot;
  const isDragging = draggingFolderId === node.id;
  const isExpanded = isRoot ? true : Boolean(node.expanded);
  const rowClasses = ['folder-row'];
  if (isSelected) {
    rowClasses.push('active');
  }

  const handleToggleClick = (event) => {
    event.stopPropagation();
    if (canToggle) {
      onToggle(node.id);
    }
  };

  return (
    <li className={`folder-node${isDragging ? ' is-dragging' : ''}`}>
      <div
        className={rowClasses.join(' ')}
        draggable={canDrag}
        onClick={() => onSelect(node.id)}
        onDragOver={(event) => onDragOver(event, node.id)}
        onDragLeave={onDragLeave}
        onDrop={(event) => onDrop(event, node.id)}
        onDragStart={(event) => {
          if (!canDrag || !onFolderDragStart) return;
          onFolderDragStart(event, node.id);
        }}
        onDragEnd={(event) => {
          if (onFolderDragEnd) {
            onFolderDragEnd(event);
          }
        }}
      >
        {!isRoot && (
          <span
            className={`toggle${showChevron ? '' : ' invisible'}${isExpanded ? ' expanded' : ''}`}
            onClick={handleToggleClick}
          >
            {icon}
          </span>
        )}
        <span className="name">
          <FolderIcon className="folder-icon-image" size={16} />
          {node.name}
        </span>
        {node.id !== 'root' && (
          <div className="folder-row__actions">
            <button
              type="button"
              className="icon-button ghost"
              onClick={(event) => {
                event.stopPropagation();
                if (!onRename) return;
                const nextName = window.prompt('Rename folder', node.name || '');
                if (!nextName) {
                  return;
                }
                const trimmed = nextName.trim();
                if (!trimmed || trimmed === node.name) {
                  return;
                }
                onRename(node.id, trimmed);
              }}
              title="Rename folder"
              aria-label={`Rename folder ${node.name}`}
            >
              <EditIcon className="icon-edit" size={18} />
            </button>
            <button
              type="button"
              className="icon-button ghost"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(node.id);
              }}
              title="Delete folder"
              aria-label={`Delete folder ${node.name}`}
            >
              <TrashIcon className="icon-trash" size={18} />
            </button>
          </div>
        )}
      </div>
      {isExpanded && node.children.length > 0 && (
        <ul className={`folder-children${depth === 0 ? ' folder-children--level1' : ''}`}>
          {renderChildren(node.children, depth + 1)}
        </ul>
      )}
    </li>
  );
};

const Sidebar = ({
  folderNodes,
  onToggle,
  onSelect,
  onDrop,
  onDragOver,
  onDragLeave,
  onDeleteFolder,
  onRenameFolder,
  selectedFolder,
  onFolderDragStart,
  onFolderDragEnd,
  draggedFolderId,
  tags = [],
  activeTagIds = [],
  onToggleTagFilter,
  correspondents = [],
  activeCorrespondentIds = [],
  onToggleCorrespondentFilter,
}) => {
  const sortedCorrespondents = useMemo(
    () =>
      [...correspondents].sort((a, b) =>
        (a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base' }),
      ),
    [correspondents],
  );
  const activeCorrespondentSet = useMemo(
    () => new Set(activeCorrespondentIds || []),
    [activeCorrespondentIds],
  );
  const handleToggleTag = onToggleTagFilter || (() => {});
  const activeTagSet = new Set(activeTagIds);

  const renderNodes = useCallback(
    (ids, depth) =>
      ids.map((id) => {
        const node = folderNodes.get(id);
        if (!node) return null;
        return (
          <FolderNode
            key={id}
            node={node}
            depth={depth}
            isSelected={selectedFolder === id}
            onToggle={() => onToggle(id)}
            onSelect={onSelect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDelete={onDeleteFolder}
            onRename={onRenameFolder}
            renderChildren={renderNodes}
            onFolderDragStart={onFolderDragStart}
            onFolderDragEnd={onFolderDragEnd}
            draggingFolderId={draggedFolderId}
          />
        );
      }),
    [
      folderNodes,
      selectedFolder,
      onToggle,
      onSelect,
      onDrop,
      onDragOver,
      onDragLeave,
      onDeleteFolder,
      onRenameFolder,
      onFolderDragStart,
      onFolderDragEnd,
      draggedFolderId,
    ],
  );

  const rootNode = folderNodes.get('root');

  return (
    <aside className="sidebar column">
      <div className="sidebar-section sidebar-section--folders">
        <div className="sidebar-section__header">
          <h3>Folders</h3>
        </div>
        <ul className="folder-tree">
          {rootNode && renderNodes([rootNode.id], 0)}
        </ul>
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section__header">
          <h3>Tags</h3>
          <span className="meta">{tags.length}</span>
        </div>
        <div
          className={`sidebar-tag-cloud${
            activeTagSet.size ? ' sidebar-tag-cloud--has-active' : ''
          }`}
          role="list"
        >
          {tags.length ? (
            tags.map((tag) => {
              const isActive = activeTagSet.has(tag.id);
              const style = getTagColorStyle(tag.color);
              const className = `sidebar-tag-pill${isActive ? ' active' : ''}`;
              return (
                <button
                  key={tag.id}
                  type="button"
                  role="listitem"
                  className={className}
                  style={style || undefined}
                  onClick={() => handleToggleTag(tag.id)}
                  aria-pressed={isActive}
                  draggable
                  onDragStart={(event) => {
                    try {
                      const payload = JSON.stringify({
                        id: tag.id,
                        label: tag.label,
                        color: tag.color || null,
                      });
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData('application/x-papercrate-tag', payload);
                      event.dataTransfer.setData('text/papercrate-tag', payload);
                    } catch (
                      // eslint-disable-next-line no-empty
                      error
                    ) {}
                  }}
                >
                  {tag.label}
                </button>
              );
            })
          ) : (
            <span className="meta">No tags yet</span>
          )}
        </div>
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section__header">
          <h3>Correspondents</h3>
          <span className="meta">{correspondents.length}</span>
        </div>
        <ul className="sidebar-correspondent-list">
          {sortedCorrespondents.length ? (
            sortedCorrespondents.map((correspondent) => {
              const isActive = activeCorrespondentSet.has(correspondent.id);
              const className = `sidebar-correspondent-item${isActive ? ' active' : ''}`;
              const label = correspondent.name || 'Unnamed';
              const handleSelect = () => {
                const nextId = isActive ? null : correspondent.id;
                onToggleCorrespondentFilter?.(nextId);
              };
              return (
                <li key={correspondent.id}>
                  <span
                    className={className}
                    role="button"
                    tabIndex={0}
                    onClick={handleSelect}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleSelect();
                      }
                    }}
                  >
                    {label}
                  </span>
                </li>
              );
            })
          ) : (
            <li className="meta">No correspondents yet</li>
          )}
        </ul>
      </div>
    </aside>
  );
};

export default Sidebar;
export { FolderNode };
