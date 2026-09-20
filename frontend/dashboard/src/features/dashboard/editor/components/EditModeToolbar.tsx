interface EditModeToolbarProps {
  editMode: boolean
  isDirty: boolean
  onEnterEditMode: () => void
  onSave: () => void
  onCancel: () => void
  onResetToDefault: () => void
  /** Overrides the reset button's label -- defaults to this component's
   * original legacy-Dashboard wording so every existing caller renders
   * identically. MT-07's canonical editor passes "Restore Default" to
   * match `DASHBOARD_LAYOUT_GUIDELINES.md`'s exact action name. */
  resetToDefaultLabel?: string
  /** Disables Save independently of `isDirty` (e.g. while an Add
   * preview's geometry is displayed but not part of the draft), so the
   * "(unsaved changes)" indication still reflects the draft alone. */
  saveDisabled?: boolean
}

/** Enter/exit Edit Layout mode, plus Save/Cancel/Reset while editing.
 * Normal mode is locked (a single "Edit Layout" button); edit mode exposes
 * the rest, per Roadmap Phase 7. */
export function EditModeToolbar({
  editMode,
  isDirty,
  onEnterEditMode,
  onSave,
  onCancel,
  onResetToDefault,
  resetToDefaultLabel = "Reset to Default",
  saveDisabled = false,
}: EditModeToolbarProps) {
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
        {resetToDefaultLabel}
      </button>
      <button type="button" className="soft-button" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="soft-button edit-mode-toolbar__save" onClick={onSave} disabled={!isDirty || saveDisabled}>
        Save
      </button>
    </div>
  )
}
