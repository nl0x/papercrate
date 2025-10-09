import React, { useCallback, useMemo, useState } from 'react';
import { getTagColorStyle, HEX_COLOR_PATTERN } from '../utils/colors';

function TagsPanel({ tags, onRefresh, onUpdateTag, onDeleteTag, onNotify }) {
  const [editingId, setEditingId] = useState(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftColor, setDraftColor] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const startEdit = useCallback((tag) => {
    setEditingId(tag.id);
    setDraftLabel(tag.label || '');
    setDraftColor(tag.color || '');
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraftLabel('');
    setDraftColor('');
    setSaving(false);
  }, []);

  const colorPickerValue = useMemo(() => {
    if (!draftColor) {
      return '#3366ff';
    }
    const match = HEX_COLOR_PATTERN.exec(draftColor.trim());
    if (!match) {
      return '#3366ff';
    }
    return `#${match[1].toLowerCase()}`;
  }, [draftColor]);

  const handleSave = useCallback(async () => {
    if (!editingId) return;

    const trimmedLabel = draftLabel.trim();
    if (!trimmedLabel) {
      onNotify?.('Tag label cannot be empty.', 'error');
      return;
    }

    const trimmedColor = draftColor.trim();
    const colorPattern = /^#([0-9a-fA-F]{6})$/;
    if (trimmedColor && !colorPattern.test(trimmedColor)) {
      onNotify?.('Colors must use the #RRGGBB format.', 'error');
      return;
    }

    setSaving(true);
    try {
      await onUpdateTag(editingId, {
        label: trimmedLabel,
        color: trimmedColor ? trimmedColor : null,
      });
      cancelEdit();
    } catch (updateError) {
      const message = updateError?.message || 'Failed to update tag.';
      onNotify?.(message, 'error');
    } finally {
      setSaving(false);
    }
  }, [editingId, draftLabel, draftColor, onUpdateTag, cancelEdit, onNotify]);

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleSave();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
      }
    },
    [handleSave, cancelEdit],
  );

  const handleDelete = useCallback(
    async (tag) => {
      if (!tag?.id || typeof onDeleteTag !== 'function') {
        return;
      }

      setDeletingId(tag.id);
      try {
        await onDeleteTag(tag.id);
        if (editingId === tag.id) {
          cancelEdit();
        }
      } catch (deleteError) {
        const message = deleteError?.message || 'Failed to delete tag.';
        onNotify?.(message, 'error');
      } finally {
        setDeletingId(null);
      }
    },
    [onDeleteTag, editingId, cancelEdit, onNotify],
  );

  return (
    <section className="tags-panel column">
      <div className="column-header">
        <div className="column-header__titles">
          <h2>Tags</h2>
          <div className="column-subtitle">{tags.length} total</div>
        </div>
        <div className="header-actions">
          <button
            className="secondary"
            type="button"
            onClick={onRefresh}
            disabled={saving || Boolean(deletingId)}
          >
            Refresh
          </button>
        </div>
      </div>
      <div className="column-body tags-panel__body">
        {tags.length === 0 ? (
          <div className="empty-state">No tags created yet.</div>
        ) : (
          <div className="tags-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">Tag</th>
                  <th scope="col">Color</th>
                  <th scope="col" className="numeric">
                    Documents
                  </th>
                  <th scope="col" className="actions">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {tags.map((tag) => {
                  const isEditing = editingId === tag.id;
                  return (
                    <tr key={tag.id} className={isEditing ? 'editing' : ''}>
                      <td className="tags-table__label">
                        {isEditing ? (
                          <input
                            className="tags-table__label-input"
                            value={draftLabel}
                            onChange={(event) => setDraftLabel(event.target.value)}
                            onKeyDown={handleKeyDown}
                            disabled={saving || deletingId === tag.id}
                            autoFocus
                          />
                        ) : (
                          <span
                            className="badge tag-chip"
                            style={getTagColorStyle(tag.color) || undefined}
                          >
                            {tag.label}
                          </span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <div className="tags-table__color-editor">
                            <input
                              type="color"
                              className="tags-table__color-picker"
                              value={colorPickerValue}
                              onChange={(event) => setDraftColor(event.target.value)}
                              disabled={saving || deletingId === tag.id}
                              aria-label="Pick tag color"
                            />
                            {draftColor && (
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => setDraftColor('')}
                                disabled={saving || deletingId === tag.id}
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        ) : tag.color ? (
                          <span
                            className="tags-table__swatch"
                            style={{ backgroundColor: tag.color }}
                            aria-label={`Tag color ${tag.color}`}
                          />
                        ) : (
                          <span className="meta">—</span>
                        )}
                      </td>
                      <td className="numeric">{tag.usage_count ?? 0}</td>
                      <td className="actions">
                        {isEditing ? (
                          <div className="tags-table__edit-controls">
                            <button
                              type="button"
                              className="secondary"
                              onClick={handleSave}
                              disabled={saving || deletingId === tag.id}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={cancelEdit}
                              disabled={saving || deletingId === tag.id}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() => handleDelete(tag)}
                              disabled={deletingId === tag.id}
                            >
                              Delete
                            </button>
                          </div>
                        ) : (
                          <div className="tags-table__row-actions">
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => startEdit(tag)}
                              disabled={deletingId === tag.id}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() => handleDelete(tag)}
                              disabled={deletingId === tag.id}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

export default TagsPanel;
