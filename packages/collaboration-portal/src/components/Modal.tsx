import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

interface ModalProps {
  title: string
  description?: string
  closeLabel: string
  onClose(): void
  children: React.ReactNode
  wide?: boolean
}

export function Modal({ title, description, closeLabel, onClose, children, wide }: ModalProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const node = containerRef.current
    node?.querySelector<HTMLElement>('input, textarea, select, button')?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab' && node) {
        const focusable = [...node.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')]
        const first = focusable[0]
        const last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [onClose])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <div ref={containerRef} className={`modal-panel${wide ? ' modal-panel--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby={description ? 'modal-description' : undefined}>
        <header className="modal-header">
          <div>
            <p className="eyebrow">SciForge Cloud</p>
            <h2 id="modal-title">{title}</h2>
            {description && <p id="modal-description">{description}</p>}
          </div>
          <button type="button" className="icon-button" aria-label={closeLabel} onClick={onClose}><X size={18} /></button>
        </header>
        {children}
      </div>
    </div>
  )
}
