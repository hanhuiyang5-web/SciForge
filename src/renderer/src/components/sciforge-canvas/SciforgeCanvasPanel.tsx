import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AllSelection } from '@tiptap/pm/state'
import type {
  SciforgeCanvasOpenResult,
  SciforgeCanvasReviewPacketModificationSuggestion,
  SciforgeCanvasSelectedShape,
  SciforgeCanvasSelectionState
} from '@shared/sciforge-canvas'
import {
  Download,
  Frame,
  Loader2,
  MessageSquarePlus,
  PencilLine,
  RefreshCw,
  Upload,
  X
} from 'lucide-react'
import {
  DefaultColorStyle,
  Tldraw,
  createShapeId,
  startEditingShapeWithRichText,
  toRichText,
  type Editor,
  type TLComponents,
  type TLShapeId
} from 'tldraw'
import 'tldraw/tldraw.css'
import './SciforgeCanvasPanel.css'

type Props = {
  workspaceRoot: string
  canvasId?: string
  className?: string
  onCollapse?: () => void
  variant?: 'standalone' | 'embedded'
}

type CanvasSnapshot = Extract<SciforgeCanvasOpenResult, { ok: true }>['snapshot']
type SelectedAnnotation = {
  id: string
  text: string
}
type TldrawShape = NonNullable<ReturnType<Editor['getShape']>>
type AnnotationDragState = {
  arrowId: TLShapeId
  markId: string
  origin: { x: number; y: number }
}

const DEFAULT_CANVAS_ID = 'default'
const AI_IMAGE_HOLDER_LABEL = '图片占位'
const AI_IMAGE_HOLDER_TITLE = '创建图片占位框，用于给后续生成图、科研图或 PPT 修订图定位'
const AI_IMAGE_HOLDER_DEFAULT_W = 320
const AI_IMAGE_HOLDER_DEFAULT_H = 220
const ANNOTATION_TOOL_LABEL = '标注'
const ANNOTATION_DEFAULT_TEXT = '批注'
const ANNOTATION_DEFAULT_COLOR = 'blue'
const ANNOTATION_COMPATIBLE_COLORS = new Set([ANNOTATION_DEFAULT_COLOR, 'red'])
const ANNOTATION_MIN_LENGTH = 8
const ANNOTATION_BEND_RATIO = 0.12
const ANNOTATION_MIN_BEND = 16
const ANNOTATION_MAX_BEND = 48
const ANNOTATION_LABEL_POSITION = 0
const ANNOTATION_SELECT_TEXT_MAX_ATTEMPTS = 8
const ANNOTATION_SELECT_TEXT_SETTLE_ATTEMPTS = 4
const MAX_SELECTION_ASSET_SRC_LENGTH = 512

const SCIFORGE_CANVAS_TLDRAW_COMPONENTS: TLComponents = {
  ActionsMenu: null,
  HelpMenu: null,
  MainMenu: null,
  NavigationPanel: null,
  PageMenu: null,
  QuickActions: null,
  StylePanel: null,
  Toolbar: null,
  ZoomMenu: null
}

type AiImageHolderShapeOverrides = {
  x?: number
  y?: number
  meta?: Record<string, unknown>
  props?: Record<string, unknown>
}

function getAiImageHolderMeta(): Record<string, unknown> {
  return {
    cowartAiImageHolder: true,
    cowartAiImageHolderVersion: 1,
    sciforgeCanvasAiImageHolder: true
  }
}

function createAiImageHolderShape(
  editor: Editor,
  id: TLShapeId,
  shapeOverrides: AiImageHolderShapeOverrides = {}
): void {
  const scale = editor.getResizeScaleFactor()
  const frameProps = { ...(shapeOverrides.props ?? {}) }
  delete frameProps.scale

  editor.createShape({
    id,
    type: 'frame',
    ...(typeof shapeOverrides.x === 'number' ? { x: shapeOverrides.x } : {}),
    ...(typeof shapeOverrides.y === 'number' ? { y: shapeOverrides.y } : {}),
    meta: {
      ...getAiImageHolderMeta(),
      ...(shapeOverrides.meta ?? {})
    },
    props: {
      w: AI_IMAGE_HOLDER_DEFAULT_W * scale,
      h: AI_IMAGE_HOLDER_DEFAULT_H * scale,
      name: AI_IMAGE_HOLDER_LABEL,
      color: 'blue',
      ...frameProps
    }
  } as never)
}

function createAiImageHolderAtViewportCenter(editor: Editor): TLShapeId {
  const scale = editor.getResizeScaleFactor()
  const w = AI_IMAGE_HOLDER_DEFAULT_W * scale
  const h = AI_IMAGE_HOLDER_DEFAULT_H * scale
  const center = editor.getViewportPageBounds().center
  const id = createShapeId()

  createAiImageHolderShape(editor, id, {
    x: center.x - w / 2,
    y: center.y - h / 2,
    props: { w, h }
  })
  editor.select(id)
  editor.setCurrentTool('select.idle')
  return id
}

function startEditingAnnotationArrowLabel(editor: Editor, arrowId: TLShapeId): void {
  const shape = editor.getShape(arrowId)
  if (!shape || !editor.canEditShape(shape)) return

  editor.select(arrowId)
  startEditingShapeWithRichText(editor, arrowId, { selectAll: true })
  pinAnnotationArrowLabelPosition(editor, arrowId)
  selectAnnotationTextWhenReady(editor, arrowId)
}

function pinAnnotationArrowLabelPosition(editor: Editor, arrowId: TLShapeId, attempt = 0): void {
  editor.timers.setTimeout(() => {
    const shape = editor.getShape(arrowId)
    if (!shape || !isAnnotationArrowShape(shape)) return
    const props = shape.props as Record<string, unknown>
    if (props.labelPosition !== ANNOTATION_LABEL_POSITION) {
      editor.updateShapes([
        {
          id: arrowId,
          type: 'arrow',
          props: {
            labelPosition: ANNOTATION_LABEL_POSITION
          }
        }
      ] as never)
    }

    if (attempt < 2 && editor.getEditingShapeId() === arrowId) {
      pinAnnotationArrowLabelPosition(editor, arrowId, attempt + 1)
    }
  }, 16)
}

function unlockGlobalToolLock(editor: Editor): void {
  if (!editor.getInstanceState().isToolLocked) return
  editor.updateInstanceState({ isToolLocked: false })
}

function selectAnnotationTextWhenReady(editor: Editor, arrowId: TLShapeId, attempt = 0): void {
  editor.timers.setTimeout(() => {
    if (editor.getEditingShapeId() !== arrowId) return

    const textEditor = editor.getRichTextEditor()
    if (textEditor) {
      textEditor.view.focus()
      textEditor.view.dispatch(
        textEditor.state.tr.setSelection(new AllSelection(textEditor.state.doc)).scrollIntoView()
      )
    }

    const didSelectText = selectAnnotationTextRange(editor, arrowId)
    if (didSelectText && attempt >= ANNOTATION_SELECT_TEXT_SETTLE_ATTEMPTS) return

    if (attempt < ANNOTATION_SELECT_TEXT_MAX_ATTEMPTS) {
      selectAnnotationTextWhenReady(editor, arrowId, attempt + 1)
    }
  }, 16)
}

function selectAnnotationTextRange(editor: Editor, arrowId: TLShapeId): boolean {
  const doc = editor.getContainer().ownerDocument
  const shapeElement = Array.from(doc.querySelectorAll('[data-shape-id]')).find(
    (element) => element.getAttribute('data-shape-id') === arrowId
  )
  const editable = shapeElement?.querySelector('[contenteditable="true"]')

  if (!(editable instanceof HTMLElement)) return false

  editable.focus()
  const textNodes = getTextNodes(editable)
  if (textNodes.length === 0) {
    return doc.activeElement === editable || editable.contains(doc.activeElement)
  }

  const range = doc.createRange()
  const firstTextNode = textNodes[0]
  const lastTextNode = textNodes[textNodes.length - 1]
  range.setStart(firstTextNode, 0)
  range.setEnd(lastTextNode, lastTextNode.textContent?.length ?? 0)

  const selection = doc.getSelection()
  if (!selection) return false

  selection.removeAllRanges()
  selection.addRange(range)
  doc.execCommand?.('selectAll')

  return selection.rangeCount > 0 && selection.toString() === editable.textContent
}

function getTextNodes(node: Node, textNodes: Text[] = []): Text[] {
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE && child.textContent) {
      textNodes.push(child as Text)
    } else {
      getTextNodes(child, textNodes)
    }
  })
  return textNodes
}

function getDefaultAnnotationArrowBend(dx: number, dy: number, scale: number): number {
  const length = Math.hypot(dx, dy)
  if (length === 0) return 0

  const bend = Math.min(
    Math.max(length * ANNOTATION_BEND_RATIO, ANNOTATION_MIN_BEND * scale),
    ANNOTATION_MAX_BEND * scale
  )

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? -bend : bend
  }

  return bend
}

function getAnnotationColor(editor: Editor): string {
  const color = editor.getStyleForNextShape(DefaultColorStyle)
  return color === DefaultColorStyle.defaultValue ? ANNOTATION_DEFAULT_COLOR : String(color)
}

function isAnnotationColorToken(value: unknown): boolean {
  return typeof value === 'string' && ANNOTATION_COMPATIBLE_COLORS.has(value)
}

export function SciforgeCanvasPanel({
  workspaceRoot,
  canvasId = DEFAULT_CANVAS_ID,
  className = '',
  onCollapse,
  variant = 'standalone'
}: Props): ReactElement {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [importingRecent, setImportingRecent] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [packetPath, setPacketPath] = useState<string | null>(null)
  const [packetSuggestions, setPacketSuggestions] = useState<SciforgeCanvasReviewPacketModificationSuggestion[]>([])
  const [selectedCount, setSelectedCount] = useState(0)
  const [selectedAnnotation, setSelectedAnnotation] = useState<SelectedAnnotation | null>(null)
  const [annotationDraft, setAnnotationDraft] = useState('')
  const [annotationCaptureActive, setAnnotationCaptureActive] = useState(false)
  const editorRef = useRef<Editor | null>(null)
  const annotationInputRef = useRef<HTMLInputElement | null>(null)
  const annotationDraftEditingRef = useRef(false)
  const annotationDragRef = useRef<AnnotationDragState | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSelectionRef = useRef('')

  const loadCanvas = useCallback(async () => {
    setLoading(true)
    setMessage(null)
    try {
      const result = await window.dsGui.openSciforgeCanvas({ workspaceRoot, canvasId })
      if (!result.ok) {
        setMessage(result.message)
        setSnapshot(null)
        return
      }
      setSnapshot(result.snapshot)
      setSelectedCount(result.selection.selectedShapes.length)
      setSelectedAnnotation(null)
      setAnnotationDraft('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setSnapshot(null)
    } finally {
      setLoading(false)
    }
  }, [canvasId, workspaceRoot])

  useEffect(() => {
    void loadCanvas()
  }, [loadCanvas])

  const saveCanvasNow = useCallback(async (editor: Editor): Promise<boolean> => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    setSaving(true)
    try {
      const result = await window.dsGui.saveSciforgeCanvas({
        workspaceRoot,
        canvasId,
        snapshot: editor.store.getStoreSnapshot()
      })
      if (!result.ok) {
        setMessage(result.message)
        return false
      }
      return true
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }, [canvasId, workspaceRoot])

  const saveCanvas = useCallback((editor: Editor) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void saveCanvasNow(editor)
    }, 450)
  }, [saveCanvasNow])

  const saveSelection = useCallback(async (editor: Editor, force = false): Promise<SciforgeCanvasSelectionState> => {
    const selection = getSelectionSnapshot(editor)
    const next = JSON.stringify(selection)
    if (next === lastSelectionRef.current && !force) return selection
    lastSelectionRef.current = next
    setSelectedCount(selection.selectedShapes.length)
    const nextAnnotation = getSelectedAnnotation(editor)
    setSelectedAnnotation((current) => keepStableSelectedAnnotation(current, nextAnnotation))
    if (!annotationDraftEditingRef.current) setAnnotationDraft(nextAnnotation?.text ?? '')
    await window.dsGui.saveSciforgeCanvasSelection({
      workspaceRoot,
      canvasId,
      selection
    })
    return selection
  }, [canvasId, workspaceRoot])

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    let isSyncingAnnotationRecords = false
    const saveInitial = window.setTimeout(() => saveCanvas(editor), 120)
    const selectionTimer = window.setInterval(() => {
      void saveSelection(editor)
    }, 300)
    const unsubscribeDocument = editor.store.listen(
      () => saveCanvas(editor),
      { source: 'user', scope: 'document' }
    )
    const unsubscribeSession = editor.store.listen(
      () => saveSelection(editor),
      { source: 'all', scope: 'session' }
    )
    const unsubscribeAnnotationShapeSync = editor.store.listen(
      ({ changes }) => {
        if (isSyncingAnnotationRecords) return
        const updates = annotationShapeUpdatesForStoreChanges(changes)
        if (!updates.length) return
        isSyncingAnnotationRecords = true
        try {
          editor.updateShapes(updates as never)
        } finally {
          isSyncingAnnotationRecords = false
        }
      },
      { source: 'all', scope: 'document' }
    )
    void saveSelection(editor)
    return () => {
      window.clearTimeout(saveInitial)
      window.clearInterval(selectionTimer)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      unsubscribeDocument()
      unsubscribeSession()
      unsubscribeAnnotationShapeSync()
      void saveCanvasNow(editor)
      void saveSelection(editor, true)
      if (editorRef.current === editor) editorRef.current = null
    }
  }, [saveCanvas, saveCanvasNow, saveSelection])

  const cancelAnnotationCapture = useCallback((messageText = '批注已取消。') => {
    const editor = editorRef.current
    const drag = annotationDragRef.current
    if (editor && drag) editor.bailToMark(drag.markId)
    annotationDragRef.current = null
    setAnnotationCaptureActive(false)
    setMessage(messageText)
  }, [])

  const activateFreeformAnnotation = useCallback(() => {
    const editor = editorRef.current
    if (!editor) {
      setMessage('Canvas is still loading.')
      return
    }
    unlockGlobalToolLock(editor)
    editor.setCurrentTool('select')
    annotationDragRef.current = null
    setAnnotationCaptureActive(true)
    setPacketPath(null)
    setPacketSuggestions([])
    setMessage('在画布上拖拽创建主题色批注箭头，松开后直接输入批注文字。')
  }, [])

  useEffect(() => {
    if (!annotationCaptureActive) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancelAnnotationCapture()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [annotationCaptureActive, cancelAnnotationCapture])

  const handleAnnotationCapturePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const editor = editorRef.current
    if (!editor) return

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)

    const origin = editor.screenToPage({ x: event.clientX, y: event.clientY })
    const scale = editor.getResizeScaleFactor()
    const color = getAnnotationColor(editor)
    const arrowId = createShapeId()
    const selectedShapeIds = editor.getSelectedShapeIds()
    const sourceShapeId = selectedShapeIds.length === 1 ? String(selectedShapeIds[0]) : undefined
    const markId = editor.markHistoryStoppingPoint(`sciforge_annotation_capture:${arrowId}`)

    annotationDragRef.current = {
      arrowId,
      markId,
      origin: { x: origin.x, y: origin.y }
    }
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: origin.x,
      y: origin.y,
      meta: {
        cowartAnnotationArrow: true,
        sciforgeCanvasAnnotation: true,
        ...(sourceShapeId ? { cowartAnnotationSourceShapeId: sourceShapeId } : {})
      },
      props: {
        kind: 'arc',
        dash: 'draw',
        size: 'm',
        fill: 'none',
        color,
        labelColor: color,
        bend: 0,
        start: { x: 0, y: 0 },
        end: { x: 1, y: 0 },
        arrowheadStart: 'none',
        arrowheadEnd: 'arrow',
        richText: toRichText(''),
        labelPosition: ANNOTATION_LABEL_POSITION,
        font: 'draw',
        scale,
        elbowMidPoint: 0.5
      }
    } as never)
  }, [])

  const handleAnnotationCapturePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const editor = editorRef.current
    const drag = annotationDragRef.current
    if (!editor || !drag) return
    event.preventDefault()
    event.stopPropagation()
    const point = editor.screenToPage({ x: event.clientX, y: event.clientY })
    editor.updateShapes([
      {
        id: drag.arrowId,
        type: 'arrow',
        props: {
          end: {
            x: point.x - drag.origin.x,
            y: point.y - drag.origin.y
          }
        }
      }
    ] as never)
  }, [])

  const handleAnnotationCapturePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const editor = editorRef.current
    const drag = annotationDragRef.current
    if (!editor || !drag) return
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const point = editor.screenToPage({ x: event.clientX, y: event.clientY })
    const dx = point.x - drag.origin.x
    const dy = point.y - drag.origin.y
    if (Math.hypot(dx, dy) < ANNOTATION_MIN_LENGTH / editor.getZoomLevel()) {
      editor.bailToMark(drag.markId)
      annotationDragRef.current = null
      setMessage('拖拽距离太短，继续拖拽创建批注。')
      return
    }

    editor.updateShapes([
      {
        id: drag.arrowId,
        type: 'arrow',
        props: {
          end: { x: dx, y: dy },
          bend: getDefaultAnnotationArrowBend(dx, dy, editor.getResizeScaleFactor())
        }
      }
    ] as never)
    annotationDragRef.current = null
    setAnnotationCaptureActive(false)
    setPacketPath(null)
    setPacketSuggestions([])
    setMessage('批注已创建，可直接在画布内输入文字。')
    editor.timers.setTimeout(() => startEditingAnnotationArrowLabel(editor, drag.arrowId), 16)
    void saveCanvasNow(editor)
    void saveSelection(editor, true)
  }, [saveCanvasNow, saveSelection])

  const handleAnnotationCapturePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    cancelAnnotationCapture()
  }, [cancelAnnotationCapture])

  const createAiHolder = useCallback(() => {
    const editor = editorRef.current
    if (!editor) {
      setMessage('Canvas is still loading.')
      return
    }
    const drag = annotationDragRef.current
    if (drag) editor.bailToMark(drag.markId)
    annotationDragRef.current = null
    setAnnotationCaptureActive(false)
    createAiImageHolderAtViewportCenter(editor)
    setPacketPath(null)
    setPacketSuggestions([])
    setMessage('图片占位已创建。它用于给后续生成图、科研图或 PPT 修订图定位，不会新建页面。')
    void saveCanvasNow(editor)
    void saveSelection(editor, true)
  }, [saveCanvasNow, saveSelection])

  const importRecentArtifacts = useCallback(async () => {
    const editor = editorRef.current
    setImportingRecent(true)
    setMessage(null)
    setPacketPath(null)
    setPacketSuggestions([])
    try {
      if (editor) {
        await saveCanvasNow(editor)
        await saveSelection(editor, true)
      }
      const result = await window.dsGui.importRecentSciforgeCanvasArtifacts({
        workspaceRoot,
        canvasId,
        limit: 8,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000
      })
      if (!result.ok) {
        setMessage(result.message)
        return
      }
      await loadCanvas()
      const imported = result.imported
      if (imported > 0) {
        setMessage(`已导入 ${imported} 个最近产物到画布。`)
      } else {
        setMessage('没有找到可导入的新图片、SVG 或 PPTX 产物。')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setImportingRecent(false)
    }
  }, [canvasId, loadCanvas, saveCanvasNow, saveSelection, workspaceRoot])

  const startAnnotation = useCallback(() => {
    const editor = editorRef.current
    if (!editor) {
      setMessage('Canvas is still loading.')
      return
    }
    const annotation = getSelectedAnnotation(editor)
    if (annotation) {
      setSelectedAnnotation(annotation)
      setAnnotationDraft(annotation.text)
      setMessage('Edit the selected annotation text below.')
      window.setTimeout(() => {
        annotationInputRef.current?.focus()
        annotationInputRef.current?.select()
      }, 0)
      return
    }
    if (hasAnnotatableSelection(editor)) {
      if (createAnnotationForSelectedShape(editor)) {
        const nextAnnotation = getSelectedAnnotation(editor)
        setSelectedAnnotation(nextAnnotation)
        setAnnotationDraft(nextAnnotation?.text ?? '')
        setPacketPath(null)
        setPacketSuggestions([])
        setMessage('批注已创建，可直接在画布内输入文字。')
        void saveCanvasNow(editor)
        void saveSelection(editor, true)
        return
      }
    }
    activateFreeformAnnotation()
  }, [activateFreeformAnnotation, saveCanvasNow, saveSelection])

  const focusSelectedAnnotationText = useCallback(() => {
    if (!selectedAnnotation) {
      setMessage('Select an annotation arrow first.')
      return
    }
    setMessage('Edit the selected annotation text below.')
    window.setTimeout(() => {
      annotationInputRef.current?.focus()
      annotationInputRef.current?.select()
    }, 0)
  }, [selectedAnnotation])

  const commitSelectedAnnotationText = useCallback((value = annotationDraft) => {
    const editor = editorRef.current
    if (!editor) {
      setMessage('Canvas is still loading.')
      return
    }
    const nextText = value.trim() || ANNOTATION_DEFAULT_TEXT
    if (!setSelectedAnnotationText(editor, nextText)) {
      setMessage('Select an annotation arrow first.')
      return
    }
    const nextAnnotation = getSelectedAnnotation(editor)
    setPacketPath(null)
    setPacketSuggestions([])
    setSelectedAnnotation((current) => keepStableSelectedAnnotation(current, nextAnnotation))
    setAnnotationDraft(nextAnnotation?.text ?? nextText)
    setMessage('Annotation text updated.')
    void saveCanvasNow(editor)
    void saveSelection(editor, true)
  }, [annotationDraft, saveCanvasNow, saveSelection])

  const exportReviewPacket = useCallback(async () => {
    setMessage(null)
    setPacketSuggestions([])
    const editor = editorRef.current
    if (editor) {
      await saveCanvasNow(editor)
      await saveSelection(editor, true)
    }
    const result = await window.dsGui.exportSciforgeCanvasReviewPacket({
      workspaceRoot,
      canvasId,
      title: 'SciForge Canvas Review'
    })
    if (result.ok) {
      setPacketPath(result.packetPath)
      setPacketSuggestions(result.packet.modificationSuggestions)
      setMessage(`Review packet exported with ${result.packet.modificationSuggestions.length} suggestion(s).`)
    } else {
      setMessage(result.message)
    }
  }, [canvasId, saveCanvasNow, saveSelection, workspaceRoot])

  const embedded = variant === 'embedded'

  return (
    <aside className={`flex h-full min-h-0 w-full flex-col bg-ds-sidebar ${embedded ? '' : 'border-l border-ds-border'} ${className}`}>
      {!embedded ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-ds-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ds-text">SciForge Canvas</div>
            <div className="truncate text-[11px] text-ds-muted">
              {saving ? 'Saving' : `${selectedCount} selected`}
            </div>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-ds-muted hover:bg-ds-hover hover:text-ds-text"
            title="Reload"
            onClick={() => void loadCanvas()}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-md p-1.5 text-ds-muted hover:bg-ds-hover hover:text-ds-text"
            title="Collapse"
            onClick={onCollapse}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
      ) : null}
      <div className="flex shrink-0 items-center gap-1 border-b border-ds-border px-2 py-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ds-text hover:bg-ds-hover"
          title={AI_IMAGE_HOLDER_TITLE}
          onClick={createAiHolder}
        >
          <Frame className="h-3.5 w-3.5" />
          {AI_IMAGE_HOLDER_LABEL}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ds-text hover:bg-ds-hover"
          onClick={startAnnotation}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          标注
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ds-text hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void importRecentArtifacts()}
          disabled={importingRecent}
          title="导入当前 workspace 最近生成的 PNG、SVG 或 PPTX 产物"
        >
          {importingRecent ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          导入产物
        </button>
        {selectedAnnotation ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ds-text hover:bg-ds-hover"
            title={`Edit annotation: ${selectedAnnotation.text}`}
            onClick={focusSelectedAnnotationText}
          >
            <PencilLine className="h-3.5 w-3.5" />
            编辑批注
          </button>
        ) : null}
        {embedded ? (
          <div className="ml-auto truncate px-2 text-[11px] text-ds-muted">
            {saving ? 'Saving' : `${selectedCount} selected`}
          </div>
        ) : null}
        {embedded ? (
          <button
            type="button"
            className="rounded-md p-1.5 text-ds-muted hover:bg-ds-hover hover:text-ds-text"
            title="Reload"
            onClick={() => void loadCanvas()}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          className={`${embedded ? '' : 'ml-auto'} inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ds-text hover:bg-ds-hover`}
          onClick={() => void exportReviewPacket()}
        >
          <Download className="h-3.5 w-3.5" />
          审改包
        </button>
      </div>
      {message || packetPath ? (
        <div className="shrink-0 border-b border-ds-border px-3 py-2 text-xs text-ds-muted">
          {message ? <div>{message}</div> : null}
          {packetPath ? <div className="mt-1 truncate font-mono">{packetPath}</div> : null}
          {packetSuggestions.length ? (
            <div className="mt-2 space-y-1">
              {packetSuggestions.slice(0, 3).map((suggestion, index) => (
                <div key={`${suggestion.annotationShapeId ?? 'suggestion'}-${index}`} className="rounded border border-ds-border bg-ds-bg px-2 py-1">
                  <div className="font-medium text-ds-text">
                    {suggestion.artifactKind ?? 'canvas'} {'->'} {suggestion.nextControlledTool}
                  </div>
                  <div className="mt-0.5">{suggestion.instruction}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {selectedAnnotation ? (
        <div className="shrink-0 border-b border-ds-border px-3 py-2">
          <label className="block text-[11px] font-medium text-ds-muted" htmlFor="sciforge-canvas-annotation-text">
            Annotation text
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              ref={annotationInputRef}
              id="sciforge-canvas-annotation-text"
              type="text"
              className="min-w-0 flex-1 rounded-md border border-ds-border bg-ds-bg px-2 py-1 text-xs text-ds-text outline-none focus:border-ds-accent"
              value={annotationDraft}
              onFocus={() => {
                annotationDraftEditingRef.current = true
              }}
              onBlur={() => {
                annotationDraftEditingRef.current = false
                commitSelectedAnnotationText()
              }}
              onChange={(event) => setAnnotationDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  annotationDraftEditingRef.current = false
                  commitSelectedAnnotationText(event.currentTarget.value)
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  annotationDraftEditingRef.current = false
                  setAnnotationDraft(selectedAnnotation.text)
                  event.currentTarget.blur()
                }
              }}
            />
            <button
              type="button"
              className="rounded-md border border-ds-border px-2 py-1 text-xs font-medium text-ds-text hover:bg-ds-hover"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commitSelectedAnnotationText()}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
      <div className="sciforge-canvas-tldraw-surface min-h-0 flex-1 bg-white">
        {loading ? (
          <div className="flex h-full items-center justify-center text-ds-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : snapshot ? (
          <>
            <Tldraw
              snapshot={snapshot as never}
              onMount={handleMount}
              components={SCIFORGE_CANVAS_TLDRAW_COMPONENTS}
            />
            {annotationCaptureActive ? (
              <div
                className="sciforge-canvas-annotation-capture"
                onPointerDown={handleAnnotationCapturePointerDown}
                onPointerMove={handleAnnotationCapturePointerMove}
                onPointerUp={handleAnnotationCapturePointerUp}
                onPointerCancel={handleAnnotationCapturePointerCancel}
              >
                <div className="sciforge-canvas-annotation-capture-hint">
                  拖拽创建批注，Esc 取消
                </div>
              </div>
            ) : null}
            <div className="sciforge-canvas-cowart-toolbar" aria-label="SciForge Canvas tools">
              <button
                type="button"
                className={`sciforge-canvas-cowart-tool ${annotationCaptureActive ? 'is-active' : ''}`}
                aria-pressed={annotationCaptureActive}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  activateFreeformAnnotation()
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title={ANNOTATION_TOOL_LABEL}
              >
                <MessageSquarePlus className="sciforge-canvas-cowart-tool-icon" aria-hidden="true" />
                <span>{ANNOTATION_TOOL_LABEL}</span>
              </button>
              <div aria-orientation="vertical" className="sciforge-canvas-cowart-toolbar-divider" role="separator" />
              <button
                type="button"
                className="sciforge-canvas-cowart-tool"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  void importRecentArtifacts()
                }}
                onPointerDown={(event) => event.stopPropagation()}
                disabled={importingRecent}
                title="导入最近生成的图片、科研图或 PPTX"
              >
                {importingRecent
                  ? <Loader2 className="sciforge-canvas-cowart-tool-icon animate-spin" aria-hidden="true" />
                  : <Upload className="sciforge-canvas-cowart-tool-icon" aria-hidden="true" />}
                <span>导入</span>
              </button>
              <div aria-orientation="vertical" className="sciforge-canvas-cowart-toolbar-divider" role="separator" />
              <button
                type="button"
                className="sciforge-canvas-cowart-tool"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  createAiHolder()
                }}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label={AI_IMAGE_HOLDER_TITLE}
                title={AI_IMAGE_HOLDER_TITLE}
              >
                <Frame className="sciforge-canvas-cowart-tool-icon" aria-hidden="true" />
                <span>{AI_IMAGE_HOLDER_LABEL}</span>
              </button>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-ds-muted">
            {message || 'Canvas unavailable.'}
          </div>
        )}
      </div>
    </aside>
  )
}

function getSelectionSnapshot(editor: Editor): SciforgeCanvasSelectionState {
  const selectedShapes = editor.getSelectedShapeIds().map((id) => {
    const shape = editor.getShape(id)
    const assetId = shape && 'assetId' in shape.props ? shape.props.assetId : null
    const asset = typeof assetId === 'string' ? editor.getAsset(assetId) : null
    const assetProps = asset?.props as Record<string, unknown> | undefined
    const bounds = shape ? editor.getShapePageBounds(shape) : null
    return {
      id: String(id),
      type: shape?.type,
      parentId: shape?.parentId ? String(shape.parentId) : undefined,
      x: shape?.x,
      y: shape?.y,
      rotation: shape?.rotation,
      meta: shape?.meta as Record<string, unknown> | undefined,
      props: shape?.props as Record<string, unknown> | undefined,
      asset: asset
        ? {
            id: String(asset.id),
            type: asset.type,
            name: typeof assetProps?.name === 'string' ? assetProps.name : undefined,
            src: summarizeSelectionAssetSrc(assetProps?.src),
            w: typeof assetProps?.w === 'number' ? assetProps.w : undefined,
            h: typeof assetProps?.h === 'number' ? assetProps.h : undefined,
            mimeType: typeof assetProps?.mimeType === 'string' ? assetProps.mimeType : undefined,
            fileSize: typeof assetProps?.fileSize === 'number' ? assetProps.fileSize : undefined
          }
        : null,
      bounds: bounds
        ? {
            x: bounds.x,
            y: bounds.y,
            w: bounds.w,
            h: bounds.h
          }
        : null,
      isAiImageHolder: shape?.meta?.cowartAiImageHolder === true
    } satisfies SciforgeCanvasSelectedShape
  })
  return {
    selectedShapes,
    updatedAt: new Date().toISOString()
  }
}

function summarizeSelectionAssetSrc(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  if (!value.startsWith('data:') && value.length <= MAX_SELECTION_ASSET_SRC_LENGTH) return value
  if (!value.startsWith('data:')) return `${value.slice(0, MAX_SELECTION_ASSET_SRC_LENGTH)}...`
  const commaIndex = value.indexOf(',')
  const prefix = commaIndex >= 0 ? value.slice(0, commaIndex + 1) : value.slice(0, 80)
  return `${prefix}<base64 omitted>`
}

function keepStableSelectedAnnotation(
  current: SelectedAnnotation | null,
  next: SelectedAnnotation | null
): SelectedAnnotation | null {
  if (!current && !next) return current
  if (current && next && current.id === next.id && current.text === next.text) return current
  return next
}

function getSelectedAnnotation(editor: Editor): SelectedAnnotation | null {
  const selectedShapeIds = editor.getSelectedShapeIds()
  if (selectedShapeIds.length !== 1) return null
  const shape = editor.getShape(selectedShapeIds[0])
  if (!shape || !isAnnotationArrowShape(shape)) return null
  return {
    id: String(shape.id),
    text: annotationTextFromShape(shape)
  }
}

function setSelectedAnnotationText(editor: Editor, text: string): boolean {
  const selectedShapeIds = editor.getSelectedShapeIds()
  if (selectedShapeIds.length !== 1) return false
  const shape = editor.getShape(selectedShapeIds[0])
  if (!shape || !isAnnotationArrowShape(shape)) return false

  const nextText = text.trim() || ANNOTATION_DEFAULT_TEXT
  editor.updateShapes([
    {
      id: shape.id,
      type: 'arrow',
      meta: {
        ...(shape.meta as Record<string, unknown>),
        cowartAnnotationArrow: true,
        sciforgeCanvasAnnotation: true
      },
      props: {
        richText: toRichText(nextText)
      }
    }
  ] as never)
  editor.select(shape.id)
  editor.setCurrentTool('select')
  return true
}

function isAnnotationArrowShape(shape: TldrawShape): boolean {
  if (shape.type !== 'arrow') return false
  const meta = shape.meta as Record<string, unknown>
  if (meta.cowartAnnotationArrow === true || meta.sciforgeCanvasAnnotation === true) return true

  const props = shape.props as unknown as Record<string, unknown>
  const text = annotationTextFromShape(shape)
  return Boolean(
    text &&
    (isAnnotationColorToken(props.color) || isAnnotationColorToken(props.labelColor))
  )
}

function annotationTextFromShape(shape: TldrawShape): string {
  const props = shape.props as unknown as Record<string, unknown>
  return (
    plainTextFromRichText(props.richText) ??
    plainTextFromRichText(props.text) ??
    ''
  )
}

function plainTextFromRichText(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  if (typeof value.text === 'string') return value.text
  const content = Array.isArray(value.content) ? value.content : []
  const text = content
    .map((item) => plainTextFromRichText(item))
    .filter(Boolean)
    .join(' ')
    .trim()
  return text || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function annotationShapeUpdatesForStoreChanges(changes: unknown): Array<{
  id: TLShapeId
  type: 'arrow'
  meta?: Record<string, unknown>
  props?: Record<string, unknown>
}> {
  const updates: Array<{
    id: TLShapeId
    type: 'arrow'
    meta?: Record<string, unknown>
    props?: Record<string, unknown>
  }> = []

  for (const [, next] of updatedRecordPairsFromStoreChanges(changes)) {
    if (next.typeName !== 'shape' || next.type !== 'arrow' || typeof next.id !== 'string') continue
    const meta = isRecord(next.meta) ? next.meta : {}
    const props = isRecord(next.props) ? next.props : {}
    const hasAnnotationMeta = meta.cowartAnnotationArrow === true || meta.sciforgeCanvasAnnotation === true
    const hasAnnotationLook = (isAnnotationColorToken(props.color) || isAnnotationColorToken(props.labelColor)) &&
      Boolean(plainTextFromRichText(props.richText) ?? plainTextFromRichText(props.text))
    if (!hasAnnotationMeta && !hasAnnotationLook) continue

    const nextMeta: Record<string, unknown> = {}
    if (meta.cowartAnnotationArrow !== true) nextMeta.cowartAnnotationArrow = true
    if (meta.sciforgeCanvasAnnotation !== true) nextMeta.sciforgeCanvasAnnotation = true

    const nextProps: Record<string, unknown> = {}
    const color = typeof props.color === 'string' ? props.color : ANNOTATION_DEFAULT_COLOR
    if (props.labelColor !== color) nextProps.labelColor = color
    if (props.labelPosition !== ANNOTATION_LABEL_POSITION) nextProps.labelPosition = ANNOTATION_LABEL_POSITION
    if (typeof props.elbowMidPoint !== 'number') nextProps.elbowMidPoint = 0.5

    if (Object.keys(nextMeta).length || Object.keys(nextProps).length) {
      updates.push({
        id: next.id as TLShapeId,
        type: 'arrow',
        ...(Object.keys(nextMeta).length ? { meta: { ...meta, ...nextMeta } } : {}),
        ...(Object.keys(nextProps).length ? { props: nextProps } : {})
      })
    }
  }

  return updates
}

function updatedRecordPairsFromStoreChanges(changes: unknown): Array<[
  Record<string, unknown>,
  Record<string, unknown>
]> {
  if (!isRecord(changes) || !isRecord(changes.updated)) return []
  const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = []
  for (const value of Object.values(changes.updated)) {
    if (!Array.isArray(value) || value.length < 2) continue
    const [previous, next] = value
    if (isRecord(previous) && isRecord(next)) pairs.push([previous, next])
  }
  return pairs
}

function hasAnnotatableSelection(editor: Editor): boolean {
  const selectedShapeIds = editor.getSelectedShapeIds()
  if (selectedShapeIds.length !== 1) return false
  const shape = editor.getShape(selectedShapeIds[0])
  return Boolean(shape && shape.type !== 'arrow')
}

function createAnnotationForSelectedShape(editor: Editor, text = ''): boolean {
  const selectedShapeIds = editor.getSelectedShapeIds()
  if (selectedShapeIds.length !== 1) return false

  const sourceShapeId = selectedShapeIds[0]
  const sourceShape = editor.getShape(sourceShapeId)
  if (!sourceShape || sourceShape.type === 'arrow') return false

  const bounds = editor.getShapePageBounds(sourceShapeId)
  if (!bounds) return false

  const scale = editor.getResizeScaleFactor()
  const arrowId = createShapeId()
  const start = {
    x: bounds.x + bounds.w + 72 * scale,
    y: bounds.y + Math.max(36 * scale, bounds.h * 0.22)
  }
  const end = {
    x: bounds.x + bounds.w * 0.78 - start.x,
    y: bounds.y + bounds.h * 0.44 - start.y
  }

  editor.createShape({
    id: arrowId,
    type: 'arrow',
    x: start.x,
    y: start.y,
    meta: {
      cowartAnnotationArrow: true,
      sciforgeCanvasAnnotation: true,
      cowartAnnotationSourceShapeId: String(sourceShapeId)
    },
    props: {
      kind: 'arc',
      dash: 'draw',
      size: 'm',
      fill: 'none',
      color: ANNOTATION_DEFAULT_COLOR,
      labelColor: ANNOTATION_DEFAULT_COLOR,
      bend: getDefaultAnnotationArrowBend(end.x, end.y, scale),
      start: { x: 0, y: 0 },
      end,
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      richText: toRichText(text),
      labelPosition: ANNOTATION_LABEL_POSITION,
      font: 'draw',
      scale,
      elbowMidPoint: 0.5
    }
  } as never)
  startEditingAnnotationArrowLabel(editor, arrowId)
  return true
}
