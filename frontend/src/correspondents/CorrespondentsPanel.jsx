import React, { useCallback, useState } from 'react';

function CorrespondentsPanel({
  correspondents = [],
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
  onNotify,
}) {
  const [editingId, setEditingId] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [createName, setCreateName] = useState('');
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const startEdit = useCallback((correspondent) => {
    setEditingId(correspondent.id);
    setDraftName(correspondent.name || '');
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraftName('');
    setSaving(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editingId) return;
    const trimmed = draftName.trim();
    if (!trimmed) {
      onNotify?.('Correspondent name cannot be empty.', 'error');
      return;
    }

    setSaving(true);
    try {
      await onUpdate(editingId, { name: trimmed });
      cancelEdit();
    } catch (
      // eslint-disable-next-line no-empty
      error
    ) {}
  }, [editingId, draftName, onUpdate, cancelEdit, onNotify]);

  const handleDelete = useCallback(
    async (correspondent) => {
      if (!correspondent?.id) return;
      setDeletingId(correspondent.id);
      try {
        await onDelete(correspondent.id);
        if (editingId === correspondent.id) {
          cancelEdit();
        }
      } catch (
        // eslint-disable-next-line no-empty
        error
      ) {
        return;
      } finally {
        setDeletingId(null);
      }
    },
    [onDelete, editingId, cancelEdit],
  );

  const handleCreate = useCallback(
    async (event) => {
      event.preventDefault();
      const trimmed = createName.trim();
      if (!trimmed) {
        onNotify?.('Correspondent name cannot be empty.', 'error');
        return;
      }
      setCreating(true);
      try {
        await onCreate({ name: trimmed });
        setCreateName('');
      } catch (
        // eslint-disable-next-line no-empty
        error
      ) {
        return;
      } finally {
        setCreating(false);
      }
    },
    [createName, onCreate, onNotify],
  );

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

  const renderUsage = useCallback((usage) => {
    if (!usage) {
      return '0';
    }
    const total = typeof usage.total === 'number' ? usage.total : 0;
    const entries = usage.by_role ? Object.entries(usage.by_role) : [];
    if (!entries.length) {
      return total.toString();
    }
    const roleSummary = entries
      .map(([role, count]) => `${role}: ${count}`)
      .join(', ');
    return `${total} (${roleSummary})`;
  }, []);

  return (
    <section className="correspondents-panel column">
      <div className="column-header">
        <div className="column-header__titles">
          <h2>Correspondents</h2>
          <div className="column-subtitle">{correspondents.length} total</div>
        </div>
        <div className="header-actions correspondents-actions">
          <form className="correspondents-actions__form" onSubmit={handleCreate}>
            <input
              type="text"
              placeholder="New correspondent name"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              disabled={creating}
            />
            <button type="submit" disabled={creating || !createName.trim()}>
              {creating ? 'Creating…' : 'Create'}
            </button>
          </form>
          <button
            className="secondary"
            type="button"
            onClick={onRefresh}
            disabled={saving || creating || Boolean(deletingId)}
          >
            Refresh
          </button>
        </div>
      </div>
      <div className="column-body tags-panel__body">
        {correspondents.length === 0 ? (
          <div className="empty-state">No correspondents created yet.</div>
        ) : (
          <div className="tags-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="numeric">
                    Usage
                  </th>
                  <th scope="col" className="actions">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {correspondents.map((correspondent) => {
                  const isEditing = editingId === correspondent.id;
                  return (
                    <tr key={correspondent.id} className={isEditing ? 'editing' : ''}>
                      <td className="tags-table__label">
                        {isEditing ? (
                          <input
                            className="tags-table__label-input"
                            value={draftName}
                            onChange={(event) => setDraftName(event.target.value)}
                            onKeyDown={handleKeyDown}
                            disabled={saving}
                            autoFocus
                          />
                        ) : (
                          <span>{correspondent.name}</span>
                        )}
                      </td>
                      <td className="numeric">{renderUsage(correspondent.usage)}</td>
                      <td className="actions">
                        {isEditing ? (
                          <div className="tags-table__edit-controls">
                            <button
                              type="button"
                              className="secondary"
                              onClick={handleSave}
                              disabled={saving}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={cancelEdit}
                              disabled={saving}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="tags-table__row-actions">
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => startEdit(correspondent)}
                              disabled={deletingId === correspondent.id}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() => handleDelete(correspondent)}
                              disabled={deletingId === correspondent.id}
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

export default CorrespondentsPanel;
