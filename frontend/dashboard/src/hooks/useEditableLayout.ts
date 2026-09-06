import { useCallback, useEffect, useRef, useState } from "react"
import { buildDefaultLayout, readLayout, writeLayout } from "../lib/layoutStore"
import type { Breakpoint, LayoutProfile, WidgetInstance, WidgetTypeId } from "../types/widget"
import { getWidgetDefinition } from "../lib/widgetRegistry"

interface UseEditableLayoutResult {
  layout: LayoutProfile
  editMode: boolean
  isDirty: boolean
  saveConfirmation: boolean
  enterEditMode: () => void
  cancelEditMode: () => void
  save: () => void
  resetToDefault: () => void
  updateWidgetPositions: (updates: { instanceId: string; x: number; y: number; w: number; h: number }[]) => void
  addWidget: (type: WidgetTypeId) => void
  removeWidget: (instanceId: string) => void
}

/** Owns one profile+breakpoint's layout: loads it, tracks Edit Layout mode
 * and unsaved changes, and exposes Save/Cancel/Reset/add/remove/reposition
 * — Roadmap Phase 7's "Save, cancel, undo, reset-to-default, and
 * unsaved-change warnings are available." (undo is out of scope for v1:
 * Cancel already discards every change back to the last save, which covers
 * the same "I didn't mean that" need for a first pass). */
export function useEditableLayout(profileId: string, breakpoint: Breakpoint): UseEditableLayoutResult {
  const [savedLayout, setSavedLayout] = useState(() => readLayout(profileId, breakpoint))
  const [draftLayout, setDraftLayout] = useState(savedLayout)
  const [editMode, setEditMode] = useState(false)
  const [saveConfirmation, setSaveConfirmation] = useState(false)
  const confirmationTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  const isDirty = draftLayout !== savedLayout

  const enterEditMode = useCallback(() => setEditMode(true), [])

  const cancelEditMode = useCallback(() => {
    setDraftLayout(savedLayout)
    setEditMode(false)
  }, [savedLayout])

  const showSaveConfirmation = useCallback(() => {
    setSaveConfirmation(true)
    clearTimeout(confirmationTimeout.current)
    confirmationTimeout.current = setTimeout(() => setSaveConfirmation(false), 2500)
  }, [])

  const save = useCallback(() => {
    if (writeLayout(draftLayout)) {
      setSavedLayout(draftLayout)
      showSaveConfirmation()
    }
    setEditMode(false)
  }, [draftLayout, showSaveConfirmation])

  const resetToDefault = useCallback(() => {
    setDraftLayout(buildDefaultLayout(profileId, breakpoint))
  }, [profileId, breakpoint])

  const updateWidgetPositions = useCallback(
    (updates: { instanceId: string; x: number; y: number; w: number; h: number }[]) => {
      setDraftLayout((current) => ({
        ...current,
        widgets: current.widgets.map((widget) => {
          const update = updates.find((u) => u.instanceId === widget.instanceId)
          return update ? { ...widget, ...update, updatedAt: new Date().toISOString() } : widget
        }),
      }))
    },
    [],
  )

  const addWidget = useCallback((type: WidgetTypeId) => {
    const { schemaVersion, defaultSettings, sizeLimits } = getWidgetDefinition(type)
    const instance: WidgetInstance = {
      instanceId: `${type}-${crypto.randomUUID()}`,
      type,
      schemaVersion,
      x: 0,
      y: 0,
      w: sizeLimits.defaultW,
      h: sizeLimits.defaultH,
      settings: defaultSettings,
      updatedAt: new Date().toISOString(),
    }
    setDraftLayout((current) => ({ ...current, widgets: [...current.widgets, instance] }))
  }, [])

  const removeWidget = useCallback((instanceId: string) => {
    setDraftLayout((current) => ({ ...current, widgets: current.widgets.filter((w) => w.instanceId !== instanceId) }))
  }, [])

  // Ctrl+S / Cmd+S saves the draft while editing, instead of the browser's
  // own "Save Page As" — only active in edit mode so normal browsing keeps
  // the native shortcut.
  useEffect(() => {
    if (!editMode) return
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault()
        save()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [editMode, save])

  return {
    layout: draftLayout,
    editMode,
    isDirty,
    saveConfirmation,
    enterEditMode,
    cancelEditMode,
    save,
    resetToDefault,
    updateWidgetPositions,
    addWidget,
    removeWidget,
  }
}
