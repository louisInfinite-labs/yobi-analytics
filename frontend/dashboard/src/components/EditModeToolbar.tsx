interface EditModeToolbarProps {
  editMode: boolean
  isDirty: boolean
  onEnterEditMode: () => void
  onSave: () => void
  onCancel: () => void
  onResetToDefault: () => void
}

/** Enter/exit Edit Layout mode, plus Save/Cancel/Reset while editing.
 * Normal mode is locked (a single "Edit Layout" button); edit mode exposes
 * the rest, per Roadmap Phase 7. */
export function EditModeToolbar({ editMode, isDirty, onEnterEditMode, onSave, onCancel, onResetToDefault }: EditModeToolbarProps) {
  if (!editMode) {
    return (
      <button type="button" className="soft-button edit-mode-toolbar__enter" onClick={onEnterEditMode}>
        Edit Layout
      </button>
    )
  }

  return (
    <div className="edit-mode-toolbar" role="toolbar" aria-label="Layout editing">
      <span className="edit-mode-toolbar__label">Editing layout{isDirty ? " (unsaved changes)" : ""}</span>
      <button type="button" className="soft-button" onClick={onResetToDefault}>
        Reset to Default
      </button>
      <button type="button" className="soft-button" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="soft-button edit-mode-toolbar__save" onClick={onSave} disabled={!isDirty}>
        Save
      </button>
    </div>
  )
}
