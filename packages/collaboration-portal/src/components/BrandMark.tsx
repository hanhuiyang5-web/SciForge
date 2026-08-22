export function BrandMark({ compact = false }: { compact?: boolean }): React.JSX.Element {
  return (
    <div className="brand" aria-label="SciForge">
      <svg className="brand-mark" viewBox="0 0 36 36" aria-hidden="true">
        <path className="brand-mark__frame" d="M18 2.8 31.2 10.4v15.2L18 33.2 4.8 25.6V10.4Z" />
        <path className="brand-mark__orbit" d="M10.2 21.6c2.6 2.8 8.7 2.5 12.8-.7 4.2-3.2 5-7.9 1.9-9.5-3.1-1.7-9.1.3-12.8 3.9-3.8 3.7-4.1 7.3-1.9 8.9" />
        <circle className="brand-mark__core" cx="18" cy="18" r="3.4" />
      </svg>
      {!compact && <span className="brand-word">SciForge</span>}
    </div>
  )
}
