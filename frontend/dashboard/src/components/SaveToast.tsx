interface SaveToastProps {
  visible: boolean
}

/** Bottom-left confirmation after saving the layout. */
export function SaveToast({ visible }: SaveToastProps) {
  if (!visible) return null
  return (
    <div className="save-toast" role="status">
      Layout saved
    </div>
  )
}
