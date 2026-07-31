import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The panel that slides up over the instrument.
 *
 * Shared by the settings and the setlist, because getting *out* of one is a
 * problem neither of them should be solving on its own — and both were solving
 * it badly. The contents scroll, so a downward drag anywhere in the body is a
 * scroll rather than a dismissal, which leaves the swipe everybody's thumb
 * reaches for doing nothing at all. The only reliable way out was the Done
 * button at the very bottom, past everything, and reaching for the scrim beside
 * the panel lands inside its own padding — on a phone the sheet is full width,
 * so "just to the left of it" is the sheet, and whatever row happens to be
 * there gets the tap. Aiming to leave and landing in a text field is about the
 * worst answer an interface can give.
 *
 * So: a header that is always on screen, never scrolls away, carries a close
 * button, and can be dragged down to dismiss. `touch-action: none` on it means
 * a drag there is unambiguously a drag and never a scroll — which is why the
 * gesture lives on the header rather than on the body, where it would have to
 * compete with the scrolling and lose on some browser somewhere.
 */

/** Drag this far down and letting go dismisses. */
const DISMISS_PX = 92

export interface SheetProps {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}

export function Sheet({ open, title, onClose, children }: SheetProps) {
  const [dragY, setDragY] = useState(0)
  const dragRef = useRef({ id: -1, from: 0 })
  /** Whether the press that is ending began on the scrim rather than the sheet. */
  const fromScrimRef = useRef(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // A sheet that reopens mid-drag would come back up already half dismissed.
  useEffect(() => {
    if (!open) setDragY(0)
  }, [open])

  const onGripDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = { id: e.pointerId, from: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onGripMove = useCallback((e: React.PointerEvent) => {
    if (dragRef.current.id !== e.pointerId) return
    // Downward only. Dragging a sheet up past its own top edge is a gesture
    // with nowhere to go.
    setDragY(Math.max(0, e.clientY - dragRef.current.from))
  }, [])

  const onGripUp = useCallback(
    (e: React.PointerEvent) => {
      if (dragRef.current.id !== e.pointerId) return
      dragRef.current.id = -1
      const travelled = e.clientY - dragRef.current.from
      setDragY(0)
      if (travelled > DISMISS_PX) onClose()
    },
    [onClose],
  )

  if (!open) return null

  return (
    <div
      className="sheet-scrim"
      // Closed on release rather than on press, and only when the press began
      // out here too: starting a drag inside the sheet and finishing beyond it
      // is not a request to dismiss.
      onPointerDown={(e) => {
        fromScrimRef.current = e.target === e.currentTarget
      }}
      onPointerUp={(e) => {
        if (fromScrimRef.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={
          dragY
            ? { transform: `translateY(${dragY}px)`, animation: 'none' }
            : undefined
        }
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div
          className="sheet-head"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        >
          <div className="sheet-grip" />
          <div className="sheet-title">{title}</div>
          <button
            className="sheet-x"
            onClick={onClose}
            // Without this the header captures the pointer on the way down and
            // keeps the matching pointerup, so the button never sees a click.
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
            </svg>
          </button>
        </div>

        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}
