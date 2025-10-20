import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { resolveDocumentAssetUrl } from './asset_manager';
import { getReadableTextColor } from './utils/colors';
import './skeuomorphic_ws.css';

const ITEM_WIDTH = 220;
const ITEM_HEIGHT = 260;
const CANVAS_PADDING = 24;
const ROTATION_RANGE = 7;
const JITTER_X = 26;
const JITTER_Y = 32;
const DEFAULT_CANVAS_WIDTH = 1024;
const DEFAULT_CANVAS_HEIGHT = 680;
const TAG_MIME_TYPES = ['application/x-papercrate-tag', 'text/papercrate-tag'];

const resolveSizeKey = (doc) =>
  doc?.id || doc?.document_id || doc?.uuid || doc?.original_name || doc?.title || 'doc';

const CARD_MIN = 240;
const CARD_MAX = 340;
const EMPTY_CARD_ASPECT = 1.4;
const ZOOM_FILL_RATIO = 0.99;
const ZOOM_MIN_SCALE = 1.05;
const ZOOM_MAX_SCALE = 5;
const TAG_REMOVE_DISTANCE = 160;

const DEBUG_DRAG = false;
const DEBUG_FOCUS = true;
const DEBUG_DROP = true;

const resolveTagKey = (tag) => {
  if (!tag) {
    return null;
  }
  const key = tag.id ?? tag.uuid ?? tag.slug ?? tag.label;
  return key != null ? String(key) : null;
};

const generateInitialLayout = (
  entries,
  {
    canvasWidth,
    canvasHeight,
    padding,
    startZ = 0,
    rotationRange = ROTATION_RANGE,
    minSpacing = 48,
    shelfWidth = 0,
  },
) => {
  const layout = new Map();
  let currentZ = startZ;
  let maxZ = startZ;

  if (!entries.length) {
    return { layout, maxZ };
  }

  const shelfOffset = Math.max(shelfWidth, 0);
  const usableWidth = Math.max(canvasWidth - shelfOffset - padding * 2, 1);
  const usableHeight = Math.max(canvasHeight - padding * 2, 1);

  const spacingBuffer = Math.max(minSpacing, 0);
  const placed = [];

  const resolveBounds = (width, height) => {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    return {
      minCenterX: padding + halfWidth,
      maxCenterX: Math.max(
        padding + halfWidth,
        canvasWidth - shelfOffset - padding - halfWidth,
      ),
      minCenterY: padding + halfHeight,
      maxCenterY: Math.max(padding + halfHeight, canvasHeight - padding - halfHeight),
    };
  };

  const evaluateCandidateSpacing = (x, y, radius) => {
    if (!placed.length) {
      return Number.POSITIVE_INFINITY;
    }
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < placed.length; i += 1) {
      const item = placed[i];
      const dx = item.x - x;
      const dy = item.y - y;
      const distance = Math.sqrt(dx * dx + dy * dy) - item.radius - radius - spacingBuffer;
      if (distance < best) {
        best = distance;
      }
    }
    return best;
  };

  entries.forEach((entry, index) => {
    const width = Number(entry.width) || 0;
    const height = Number(entry.height) || 0;
    if (!entry.id || width <= 0 || height <= 0) {
      return;
    }

    const { minCenterX, maxCenterX, minCenterY, maxCenterY } = resolveBounds(width, height);

    const radius = Math.sqrt(width * width + height * height) / 2;

    let bestScore = -Infinity;
    let bestX = (minCenterX + maxCenterX) / 2;
    let bestY = (minCenterY + maxCenterY) / 2;
    const samplesPerAxis = 14;
    for (let gx = 0; gx < samplesPerAxis; gx += 1) {
      const fracX = (gx + 0.5) / samplesPerAxis;
      for (let gy = 0; gy < samplesPerAxis; gy += 1) {
        const fracY = (gy + 0.5) / samplesPerAxis;
        const candidateX = minCenterX + fracX * (maxCenterX - minCenterX);
        const candidateY = minCenterY + fracY * (maxCenterY - minCenterY);
        const edgeSpacing = Math.min(
          candidateX - minCenterX,
          maxCenterX - candidateX,
          candidateY - minCenterY,
          maxCenterY - candidateY,
        ) - spacingBuffer * 0.5;
        if (edgeSpacing <= 0) {
          continue;
        }
        const neighborSpacing = evaluateCandidateSpacing(candidateX, candidateY, radius);
        const score = Math.min(edgeSpacing, neighborSpacing);
        if (score > bestScore) {
          bestScore = score;
          bestX = candidateX;
          bestY = candidateY;
        }
      }
    }
    const centerX = clamp(bestX, minCenterX, maxCenterX);
    const centerY = clamp(bestY, minCenterY, maxCenterY);

    const rotation = randomRangeFromSeed(
      buildKey(entry.id, 'rotation'),
      -rotationRange,
      rotationRange,
    );

    currentZ += 1;
    layout.set(entry.id, {
      centerX,
      centerY,
      rotation,
      z: currentZ,
    });
    maxZ = Math.max(maxZ, currentZ);

    placed.push({ x: centerX, y: centerY, radius });
  });

  return { layout, maxZ };
};

const createDragPreview = (node, clientX, clientY) => {
  if (!(node instanceof HTMLElement)) {
    return null;
  }
  const rect = node.getBoundingClientRect();
  const safeClientX = Number.isFinite(clientX) ? clientX : rect.left + rect.width / 2;
  const safeClientY = Number.isFinite(clientY) ? clientY : rect.top + rect.height / 2;
  const offsetX = clamp(safeClientX - rect.left, 0, rect.width);
  const offsetY = clamp(safeClientY - rect.top, 0, rect.height);
  const clone = node.cloneNode(true);
  clone.style.position = 'absolute';
  clone.style.top = '-9999px';
  clone.style.left = '-9999px';
  clone.style.pointerEvents = 'none';
  clone.style.opacity = '1';
  clone.style.transform = 'none';
  document.body.appendChild(clone);
  return { clone, offsetX, offsetY };
};

const cleanupPreview = (previewNode) => {
  if (previewNode && previewNode.parentNode) {
    previewNode.parentNode.removeChild(previewNode);
  }
};

const useDocumentDrag = ({
  layoutRef,
  itemRefs,
  documentLookup,
  ensureDocumentSize,
  resolveBaseMetrics,
  bringToFront,
  setDraggingId,
  syncLayoutSnapshot,
  canvasSize,
  toggleZoom,
}) => {
  const dragStateRef = useRef(null);

  const finishDrag = useCallback(
    (pointerId) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== pointerId) {
        return;
      }
      const capturedTarget = state.capturedTarget;
      if (capturedTarget && typeof capturedTarget.releasePointerCapture === 'function') {
        try {
          capturedTarget.releasePointerCapture(pointerId);
        } catch (
          // eslint-disable-next-line no-empty
          error
        ) {}
      }
      dragStateRef.current = null;
      setDraggingId((current) => (current === state.docId ? null : current));
      syncLayoutSnapshot();
    },
    [setDraggingId, syncLayoutSnapshot],
  );

  const handlePointerDown = useCallback(
    (event, docId, { lockWhenZoomed = false } = {}) => {
      if (DEBUG_DRAG) {
        console.log(
          '[skeuo] handlePointerDown fired for doc',
          docId,
          'button',
          event.button,
          'pointerType',
          event.pointerType,
          'pointerId',
          event.pointerId,
        );
      }
      event.preventDefault();
      const entry = layoutRef.current.get(docId) || null;
      const doc = documentLookup.get(docId) || null;
      const { width: docWidth, height: docHeight } = ensureDocumentSize(doc);
      const { baseScale } = resolveBaseMetrics(doc, docWidth, docHeight);
      const defaultCenterX = CANVAS_PADDING + docWidth / 2;
      const defaultCenterY = CANVAS_PADDING + docHeight / 2;
      const centerX = typeof entry?.centerX === 'number' ? entry.centerX : defaultCenterX;
      const centerY = typeof entry?.centerY === 'number' ? entry.centerY : defaultCenterY;

      if (entry && (entry.centerX !== centerX || entry.centerY !== centerY)) {
        layoutRef.current.set(docId, { ...entry, centerX, centerY });
      }

      bringToFront(docId);
      const capturedTarget = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
      if (capturedTarget && typeof capturedTarget.setPointerCapture === 'function') {
        try {
          capturedTarget.setPointerCapture(event.pointerId);
        } catch (
          // eslint-disable-next-line no-empty
          error
        ) {}
      }
      dragStateRef.current = {
        docId,
        pointerId: event.pointerId,
        originCenterX: centerX,
        originCenterY: centerY,
        startX: event.clientX,
        startY: event.clientY,
        rotation: entry?.rotation ?? 0,
        moved: false,
        locked: Boolean(lockWhenZoomed),
        width: docWidth,
        height: docHeight,
        scale: baseScale,
        capturedTarget,
      };
      setDraggingId(docId);
    },
    [bringToFront, documentLookup, ensureDocumentSize, layoutRef, resolveBaseMetrics, setDraggingId],
  );

  const handlePointerMove = useCallback(
    (event) => {
      const state = dragStateRef.current;
      if (!state) {
        if (DEBUG_DRAG) {
          console.log('[skeuo] handlePointerMove: no drag state for pointer', event.pointerId);
        }
        return;
      }
      if (state.pointerId !== event.pointerId) {
        if (DEBUG_DRAG) {
          console.log(
            '[skeuo] handlePointerMove: pointer mismatch expected',
            state.pointerId,
            'got',
            event.pointerId,
          );
        }
        return;
      }
      event.preventDefault();
      if (state.locked) {
        if (DEBUG_DRAG) {
          console.log('[skeuo] handlePointerMove: locked drag for doc', state.docId);
        }
        return;
      }

      const entry = layoutRef.current.get(state.docId);
      if (!entry) {
        return;
      }

      const deltaX = event.clientX - state.startX;
      const deltaY = event.clientY - state.startY;
      const nextCenterX = state.originCenterX + deltaX;
      const nextCenterY = state.originCenterY + deltaY;

      const docWidth = state.width;
      const docHeight = state.height;
      const halfWidth = docWidth / 2;
      const halfHeight = docHeight / 2;
      const canvasWidth = canvasSize.width || DEFAULT_CANVAS_WIDTH;
      const canvasHeight = canvasSize.height || DEFAULT_CANVAS_HEIGHT;
      const minCenterX = CANVAS_PADDING + halfWidth;
      const maxCenterX = Math.max(minCenterX, canvasWidth - CANVAS_PADDING - halfWidth);
      const minCenterY = CANVAS_PADDING + halfHeight;
      const maxCenterY = Math.max(minCenterY, canvasHeight - CANVAS_PADDING - halfHeight);
      const clampedCenterX = clamp(nextCenterX, minCenterX, maxCenterX);
      const clampedCenterY = clamp(nextCenterY, minCenterY, maxCenterY);

      const prevCenterX = typeof entry.centerX === 'number' ? entry.centerX : state.originCenterX;
      const prevCenterY = typeof entry.centerY === 'number' ? entry.centerY : state.originCenterY;
      if (Math.abs(clampedCenterX - prevCenterX) < 0.5 && Math.abs(clampedCenterY - prevCenterY) < 0.5) {
        if (DEBUG_DRAG) {
          console.log('[skeuo] handlePointerMove: movement under threshold for doc', state.docId);
        }
        return;
      }

      const updated = { ...entry, centerX: clampedCenterX, centerY: clampedCenterY };
      layoutRef.current.set(state.docId, updated);

      const node = itemRefs.current.get(state.docId);
      if (node) {
        node.style.transform = formatTransform(
          clampedCenterX,
          clampedCenterY,
          state.rotation,
          state.scale || 1,
        );
      }
      state.moved = true;
      if (DEBUG_DRAG) {
        console.log('[skeuo] handlePointerMove: moved doc', state.docId, 'to', clampedCenterX, clampedCenterY);
      }
    },
    [canvasSize.height, canvasSize.width, itemRefs, layoutRef],
  );

  const handlePointerUp = useCallback(
    (event) => {
      const state = dragStateRef.current;
      if (state && state.pointerId === event.pointerId) {
        const moved = Boolean(state.moved);
        const docId = state.docId;
        finishDrag(event.pointerId);
        if (!moved) {
          toggleZoom(docId);
        }
        return;
      }
      finishDrag(event.pointerId);
    },
    [finishDrag, toggleZoom],
  );

  const handlePointerCancel = useCallback(
    (event) => {
      finishDrag(event.pointerId);
    },
    [finishDrag],
  );

  return {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  };
};

const seededRandom = (input) => {
  const text = String(input);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
};

const randomRangeFromSeed = (seedKey, min, max) => {
  const span = max - min;
  if (span <= 0) return min;
  const seed = seededRandom(seedKey);
  return min + seed * span;
};

const buildKey = (docId, suffix) => `${docId}::${suffix}`;

const clamp = (value, min, max) => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const formatTransform = (x, y, rotation = 0, scale = 1) =>
  `translate3d(${x}px, ${y}px, 0) rotate(${rotation}deg) scale(${scale})`;

const normalizeColor = (input) => {
  if (!input) return null;
  const value = String(input).trim();
  if (!value) return null;
  if (/^#(?:[0-9a-fA-F]{3}){1,2}$/.test(value)) {
    return value.length === 4
      ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
      : value;
  }
  if (/^[0-9a-fA-F]{6}$/.test(value)) {
    return `#${value}`;
  }
  return null;
};

const getContrastingTextColor = (hex) => getReadableTextColor(hex, { light: '#1f2125' });

const SkeuomorphicWorkspace = ({
  documents = [],
  searchResults = null,
  breadcrumbs = [],
  currentFolderName = 'Folder',
  onExit,
  onRefresh,
  onDocumentOpen,
  resolveThumbnailUrl,
  onAssignTagToDocument = null,
  onRemoveTagFromDocument = null,
  ensureAssetUrl = null,
  getDocumentAsset = () => null,
  activeTagIds = [],
}) => {
  const items = useMemo(() => (searchResults ? searchResults : documents), [documents, searchResults]);
  const showingSearchResults = searchResults !== null;


  const containerRef = useRef(null);
  const layoutRef = useRef(new Map());
  const itemRefs = useRef(new Map());
  const zCounterRef = useRef(10);

  const [layoutSnapshot, setLayoutSnapshot] = useState(() => new Map());

  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [draggingId, setDraggingId] = useState(null);
  const [zoomedId, setZoomedId] = useState(null);
  const [tagDropTargetId, setTagDropTargetId] = useState(null);
  const [pendingTagDocId, setPendingTagDocId] = useState(null);
  const [pendingRemovalTag, setPendingRemovalTag] = useState(null);
  const draggingTagRef = useRef(null);
  const pendingDocTagDragRef = useRef(null);
  const docSizeMapRef = useRef(new Map());
  const removalCursorActiveRef = useRef(false);
  const activeTagSet = useMemo(() => {
    if (!Array.isArray(activeTagIds) || activeTagIds.length === 0) {
      return new Set();
    }
    const set = new Set();
    activeTagIds.forEach((id) => {
      if (id != null) {
        set.add(String(id));
      }
    });
    return set;
  }, [activeTagIds]);

  const resolvePreviewAsset = useCallback(
    (doc) => {
      if (!doc) return null;
      return getDocumentAsset(doc, 'preview');
    },
    [getDocumentAsset],
  );

  const resolvePreviewDimensions = useCallback(
    (doc) => {
      if (!doc) return null;
      const asset = resolvePreviewAsset(doc);
      const primaryObject = asset?.objects?.[0] || null;
      const primaryMetadata = primaryObject?.metadata || asset?.metadata || {};
      const width = primaryMetadata?.width;
      const height = primaryMetadata?.height;
      if (typeof width === 'number' && typeof height === 'number') {
        return { width, height };
      }
      return null;
    },
    [resolvePreviewAsset],
  );

  const resolvePreviewUrl = useCallback(
    (doc) => {
      if (!doc) return null;
      return resolveDocumentAssetUrl(doc, 'preview', {
        ensureAssetUrl,
        getAsset: getDocumentAsset,
      });
    },
    [ensureAssetUrl, getDocumentAsset],
  );

  useEffect(() => {
    if (!ensureAssetUrl) {
      return;
    }

    items.forEach((doc) => {
      resolveDocumentAssetUrl(doc, 'preview', {
        ensureAssetUrl,
        getAsset: getDocumentAsset,
      });
    });
  }, [items, ensureAssetUrl, getDocumentAsset]);

  const focusCanvas = useCallback(() => {
    const canvas = containerRef.current;
    if (canvas && typeof canvas.focus === 'function') {
      const focusTarget = () => {
        try {
          if (DEBUG_FOCUS) {
            console.log('[skeuo] focusCanvas -> attempting focus', canvas);
          }
          canvas.focus({ preventScroll: true });
          if (DEBUG_FOCUS) {
            console.log('[skeuo] focusCanvas: applied focus. activeElement:', document?.activeElement);
          }
        } catch (
          // eslint-disable-next-line no-empty
          error
        ) {}
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(focusTarget);
      } else {
        setTimeout(focusTarget, 0);
      }
      if (DEBUG_FOCUS) {
        console.log('[skeuo] focusCanvas: scheduling focus. activeElement:', document?.activeElement);
      }
    }
  }, []);

  const queueFocusCanvas = useCallback(() => {
    if (typeof window === 'undefined') {
      focusCanvas();
      return;
    }
  if (DEBUG_FOCUS) {
    console.log('[skeuo] queueFocusCanvas -> scheduling deferred focus');
  }
  setTimeout(() => {
    if (DEBUG_FOCUS) {
      console.log('[skeuo] queueFocusCanvas -> executing deferred focus');
    }
      focusCanvas();
    }, 0);
  }, [focusCanvas]);

  const updateRemovalCursor = useCallback((active) => {
    if (typeof document === 'undefined') {
      return;
    }
    if (removalCursorActiveRef.current === active) {
      return;
    }
    const body = document.body;
    if (!body) {
      return;
    }
    removalCursorActiveRef.current = active;
    if (active) {
      body.classList.add('skeuo-cursor-remove');
    } else {
      body.classList.remove('skeuo-cursor-remove');
    }
  }, []);

  useEffect(
    () => () => {
      updateRemovalCursor(false);
    },
    [updateRemovalCursor],
  );

  const isTagTransfer = useCallback((event) => {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    return TAG_MIME_TYPES.some((type) =>
      typeof types.includes === 'function'
        ? types.includes(type)
        : Array.from(types).includes(type),
    );
  }, []);

  const handleTagDragEnd = useCallback(() => {
    updateRemovalCursor(false);
    setTagDropTargetId(null);
  }, [updateRemovalCursor]);

  const ensureDocumentSize = useCallback((doc) => {
    const key = resolveSizeKey(doc);
    const cache = docSizeMapRef.current.get(key);
    if (cache) {
      return cache;
    }
    let width;
    let height;

    const intrinsic = resolvePreviewDimensions(doc);
    if (intrinsic?.width && intrinsic?.height) {
      width = intrinsic.width;
      height = intrinsic.height;
    } else {
      const seed = seededRandom(`${key}:size`);
      width = CARD_MIN + seed * (Math.min(CARD_MAX, CARD_MAX / EMPTY_CARD_ASPECT) - CARD_MIN);
      width = clamp(width, CARD_MIN, Math.min(CARD_MAX, CARD_MAX / EMPTY_CARD_ASPECT));
      height = width * EMPTY_CARD_ASPECT;
    }

    if (!Number.isFinite(width) || width <= 0) {
      width = CARD_MIN;
    }
    if (!Number.isFinite(height) || height <= 0) {
      height = CARD_MIN;
    }

    const scaleDown = Math.min(1, CARD_MAX / width, CARD_MAX / height);
    width *= scaleDown;
    height *= scaleDown;

    const minDim = Math.min(width, height);
    if (minDim < CARD_MIN) {
      const scaleUp = CARD_MIN / minDim;
      width *= scaleUp;
      height *= scaleUp;

      const adjust = Math.min(1, CARD_MAX / width, CARD_MAX / height);
      width *= adjust;
      height *= adjust;
    }

    width = clamp(width, CARD_MIN, CARD_MAX);
    height = clamp(height, CARD_MIN, CARD_MAX);

    const size = { width, height };
    docSizeMapRef.current.set(key, size);
    return size;
  }, [resolvePreviewDimensions]);

  const documentLookup = useMemo(() => {
    const map = new Map();
    items.forEach((doc) => {
      if (doc?.id) {
        map.set(doc.id, doc);
      }
    });
    return map;
  }, [items]);

  useEffect(() => {
    docSizeMapRef.current = new Map();
  }, [items]);

  const resolveZoomMetrics = useCallback(
    (doc, cardWidth, cardHeight) => {
      const canvasWidth = canvasSize.width || DEFAULT_CANVAS_WIDTH;
      const canvasHeight = canvasSize.height || DEFAULT_CANVAS_HEIGHT;
      const safeCardWidth = cardWidth || CARD_MIN;
      const safeCardHeight = cardHeight || CARD_MIN;
      const usableWidth = Math.max(canvasWidth - CANVAS_PADDING * 2, safeCardWidth);
      const usableHeight = Math.max(canvasHeight - CANVAS_PADDING * 2, safeCardHeight);
      const viewportTargetWidth = usableWidth * ZOOM_FILL_RATIO;
      const viewportTargetHeight = usableHeight * ZOOM_FILL_RATIO;

      let zoomWidth = safeCardWidth;
      let zoomHeight = safeCardHeight;

      const previewDims = doc ? resolvePreviewDimensions(doc) : null;
      if (previewDims?.width && previewDims?.height) {
        const previewWidth = previewDims.width;
        const previewHeight = previewDims.height;
        const widthScaleLimit = previewWidth > 0 ? viewportTargetWidth / previewWidth : 1;
        const heightScaleLimit = previewHeight > 0 ? viewportTargetHeight / previewHeight : 1;
        const scaleToFit = Math.min(1, widthScaleLimit || 1, heightScaleLimit || 1);
        zoomWidth = previewWidth * scaleToFit;
        zoomHeight = previewHeight * scaleToFit;
      } else {
        const rawScale = Math.min(
          viewportTargetWidth / safeCardWidth,
          viewportTargetHeight / safeCardHeight,
        );
        const boundedScale =
          rawScale >= 1
            ? clamp(Math.max(rawScale, ZOOM_MIN_SCALE), ZOOM_MIN_SCALE, ZOOM_MAX_SCALE)
            : rawScale;
        zoomWidth = safeCardWidth * boundedScale;
        zoomHeight = safeCardHeight * boundedScale;
      }

      if (!Number.isFinite(zoomWidth) || zoomWidth <= 0) {
        zoomWidth = safeCardWidth;
      }
      if (!Number.isFinite(zoomHeight) || zoomHeight <= 0) {
        zoomHeight = safeCardHeight;
      }

      zoomWidth = Math.max(zoomWidth, safeCardWidth);
      zoomHeight = Math.max(zoomHeight, safeCardHeight);

      const zoomTargetX = (canvasWidth - zoomWidth) / 2;
      const zoomTargetY = (canvasHeight - zoomHeight) / 2;
      const maxX = Math.max(CANVAS_PADDING, canvasWidth - zoomWidth - CANVAS_PADDING);
      const maxY = Math.max(CANVAS_PADDING, canvasHeight - zoomHeight - CANVAS_PADDING);
      const clampedX = clamp(zoomTargetX, CANVAS_PADDING, maxX);
      const clampedY = clamp(zoomTargetY, CANVAS_PADDING, maxY);
      const zoomCenterX = clampedX + zoomWidth / 2;
      const zoomCenterY = clampedY + zoomHeight / 2;

      return {
        zoomWidth,
        zoomHeight,
        zoomCenterX,
        zoomCenterY,
      };
    },
    [canvasSize.width, canvasSize.height, resolvePreviewDimensions],
  );

  const resolveBaseMetrics = useCallback(
    (doc, cardWidth, cardHeight) => {
      const previewDims = doc ? resolvePreviewDimensions(doc) : null;
      if (previewDims?.width && previewDims?.height) {
        const baseWidth = Math.max(previewDims.width, cardWidth);
        const baseHeight = Math.max(previewDims.height, cardHeight);
        const scaleX = cardWidth / baseWidth;
        const scaleY = cardHeight / baseHeight;
        const baseScale = Math.min(scaleX, scaleY, 1);
        return {
          baseWidth,
          baseHeight,
          baseScale: Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1,
        };
      }
      return {
        baseWidth: cardWidth,
        baseHeight: cardHeight,
        baseScale: 1,
      };
    },
    [resolvePreviewDimensions],
  );

  const syncLayoutSnapshot = useCallback(() => {
    setLayoutSnapshot(new Map(layoutRef.current));
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return () => {};

    if (process.env.NODE_ENV !== 'production') {
      console.log('[skeuo] canvas element', container);
    }

    const commitSize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.floor(rect.width) || 0;
      const height = Math.floor(rect.height) || 0;
      setCanvasSize((prev) => {
        if (prev.width === width && prev.height === height) {
          return prev;
        }
        return { width, height };
      });
    };

    commitSize();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', commitSize);
      return () => {
        window.removeEventListener('resize', commitSize);
      };
    }

    const observer = new ResizeObserver(() => {
      commitSize();
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !canvasSize.width || !canvasSize.height) {
      return () => {};
    }

    const rafId = requestAnimationFrame(() => {
      if (!items.length) {
        layoutRef.current = new Map();
        syncLayoutSnapshot();
        return;
      }

      const previous = layoutRef.current;
      const next = new Map();
      let maxZ = zCounterRef.current;
      const canvasWidth = canvasSize.width || DEFAULT_CANVAS_WIDTH;
      const canvasHeight = canvasSize.height || DEFAULT_CANVAS_HEIGHT;
      const docsNeedingLayout = [];

      items.forEach((doc) => {
        const { width: docWidth, height: docHeight } = ensureDocumentSize(doc);
        const halfWidth = docWidth / 2;
        const halfHeight = docHeight / 2;

        const minCenterX = CANVAS_PADDING + halfWidth;
        const maxCenterX = Math.max(minCenterX, canvasWidth - CANVAS_PADDING - halfWidth);
        const minCenterY = CANVAS_PADDING + halfHeight;
        const maxCenterY = Math.max(minCenterY, canvasHeight - CANVAS_PADDING - halfHeight);

        const existing = previous.get(doc.id);
        if (existing) {
          const defaultCenterX = (minCenterX + maxCenterX) / 2;
          const defaultCenterY = (minCenterY + maxCenterY) / 2;
          const prevCenterX =
            typeof existing.centerX === 'number' ? existing.centerX : defaultCenterX;
          const prevCenterY =
            typeof existing.centerY === 'number' ? existing.centerY : defaultCenterY;
          const centerX = clamp(prevCenterX, minCenterX, maxCenterX);
          const centerY = clamp(prevCenterY, minCenterY, maxCenterY);
          const rotation = existing.rotation ?? 0;
          const z = existing.z ?? maxZ;
          maxZ = Math.max(maxZ, z);
          next.set(doc.id, { centerX, centerY, rotation, z });
          return;
        }

        docsNeedingLayout.push({
          id: doc.id,
          width: docWidth,
          height: docHeight,
          seedKey: resolveSizeKey(doc),
        });
      });

      if (docsNeedingLayout.length) {
        const { layout: generatedLayout, maxZ: updatedMaxZ } = generateInitialLayout(
          docsNeedingLayout,
          {
            canvasWidth,
            canvasHeight,
            padding: CANVAS_PADDING,
            startZ: maxZ,
            rotationRange: ROTATION_RANGE,
            minSpacing: 48,
            shelfWidth: 0,
          },
        );
        generatedLayout.forEach((entry, docId) => {
          next.set(docId, entry);
        });
        maxZ = Math.max(maxZ, updatedMaxZ);
      }

      layoutRef.current = next;
      zCounterRef.current = Math.max(zCounterRef.current, maxZ);
      syncLayoutSnapshot();
    });

    return () => cancelAnimationFrame(rafId);
  }, [
    items,
    canvasSize.width,
    canvasSize.height,
    ensureDocumentSize,
    syncLayoutSnapshot,
  ]);

  useEffect(() => {
    if (draggingId && !items.some((doc) => doc.id === draggingId)) {
      setDraggingId(null);
    }
  }, [draggingId, items]);

  const bringToFront = useCallback(
    (docId) => {
      zCounterRef.current += 1;
      const entry = layoutRef.current.get(docId);
      if (!entry) return;
      const updated = { ...entry, z: zCounterRef.current };
      layoutRef.current.set(docId, updated);
      syncLayoutSnapshot();
    },
    [syncLayoutSnapshot],
  );

  const toggleZoom = useCallback(
    (docId) => {
      setZoomedId((current) => {
        if (current === docId) {
          return null;
        }
        bringToFront(docId);
        return docId;
      });
    },
    [bringToFront],
  );
  const { handlePointerDown, handlePointerMove, handlePointerUp, handlePointerCancel } = useDocumentDrag({
    layoutRef,
    itemRefs,
    documentLookup,
    ensureDocumentSize,
    resolveBaseMetrics,
    bringToFront,
    setDraggingId,
    syncLayoutSnapshot,
    canvasSize,
    toggleZoom,
  });

  const handleTagDragEnterDoc = useCallback(
    (event, docId) => {
      if (!isTagTransfer(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      updateRemovalCursor(false);
      if (tagDropTargetId !== docId) {
        setTagDropTargetId(docId);
      }
    },
    [isTagTransfer, tagDropTargetId, updateRemovalCursor],
  );

  const handleTagDragOverDoc = useCallback(
    (event, docId) => {
      if (!isTagTransfer(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      updateRemovalCursor(false);
      const activeDrag = draggingTagRef.current;
      event.dataTransfer.dropEffect = activeDrag?.sourceDocId ? 'move' : 'copy';
      if (tagDropTargetId !== docId) {
        setTagDropTargetId(docId);
      }
    },
    [isTagTransfer, tagDropTargetId, updateRemovalCursor],
  );

  const handleTagDragLeaveDoc = useCallback((event, docId) => {
    if (!isTagTransfer(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (
      event.currentTarget instanceof HTMLElement &&
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    setTagDropTargetId((current) => (current === docId ? null : current));
    updateRemovalCursor(false);
  }, [isTagTransfer, updateRemovalCursor]);

  const markActiveTagDropHandled = useCallback((tagId, sourceDocId = null) => {
    const state = draggingTagRef.current;
    if (!state) {
      return;
    }
    if (state.tagId !== tagId) {
      return;
    }
    if (sourceDocId && state.sourceDocId !== sourceDocId) {
      return;
    }
    state.dropHandled = true;
  }, []);

  const handleTagDropOnDoc = useCallback(
    async (event, doc) => {
      if (!doc || !isTagTransfer(event) || typeof onAssignTagToDocument !== 'function') {
        if (DEBUG_DROP) {
          console.log('[skeuo] handleTagDropOnDoc: drop ignored', { doc, hasTransfer: isTagTransfer(event) });
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (DEBUG_DROP) {
        console.log('[skeuo] handleTagDropOnDoc: drop accepted for doc', doc.id, 'event', event);
      }
      setTagDropTargetId(null);

      let payload = null;
      try {
        const raw =
          event.dataTransfer.getData('application/x-papercrate-tag') ||
          event.dataTransfer.getData('text/papercrate-tag');
        payload = raw ? JSON.parse(raw) : null;
      } catch (error) {
        if (DEBUG_DROP) {
          console.warn('[skeuo] handleTagDropOnDoc: failed to parse payload', error);
        }
        payload = null;
      }

      if (!payload?.id) {
        if (DEBUG_DROP) {
          console.log('[skeuo] handleTagDropOnDoc: missing tag id payload', payload);
        }
        queueFocusCanvas();
        return;
      }

      const tagId = payload.id;
      const sourceDocId = payload.sourceDocId || null;
      if (DEBUG_DROP) {
        console.log('[skeuo] handleTagDropOnDoc: parsed payload', { tagId, sourceDocId });
      }

      if (sourceDocId && sourceDocId === doc.id) {
        markActiveTagDropHandled(tagId, sourceDocId);
        if (DEBUG_DROP) {
          console.log('[skeuo] handleTagDropOnDoc: drop from same doc ignored', tagId);
        }
        queueFocusCanvas();
        return;
      }

      const alreadyAssigned = Array.isArray(doc.tags)
        ? doc.tags.some((tag) => tag.id === tagId)
        : false;
      if (alreadyAssigned) {
        markActiveTagDropHandled(tagId, sourceDocId);
        if (DEBUG_DROP) {
          console.log('[skeuo] handleTagDropOnDoc: tag already assigned', tagId);
        }
        queueFocusCanvas();
        return;
      }

      const movingBetweenDocuments = Boolean(sourceDocId && sourceDocId !== doc.id);
      if (DEBUG_DROP) {
        console.log('[skeuo] handleTagDropOnDoc: movingBetweenDocuments', movingBetweenDocuments);
      }

      setPendingTagDocId(doc.id);
      try {
        await onAssignTagToDocument({ documentId: doc.id, tagId, tag: payload });
        markActiveTagDropHandled(tagId, sourceDocId);
        if (DEBUG_DROP) {
          console.log('[skeuo] handleTagDropOnDoc: assigned tag', tagId, 'to doc', doc.id);
        }
        if (movingBetweenDocuments && typeof onRemoveTagFromDocument === 'function') {
          setPendingRemovalTag({ docId: sourceDocId, tagId });
          try {
            await onRemoveTagFromDocument(sourceDocId, tagId);
            if (DEBUG_DROP) {
              console.log('[skeuo] handleTagDropOnDoc: removed tag from source doc', sourceDocId);
            }
          } finally {
            setPendingRemovalTag(null);
          }
        }
      } finally {
        setPendingTagDocId(null);
        if (DEBUG_DROP) {
          console.log('[skeuo] handleTagDropOnDoc: finalizing drop for tag', tagId);
        }
        queueFocusCanvas();
      }
    },
    [
      isTagTransfer,
      markActiveTagDropHandled,
      onAssignTagToDocument,
      onRemoveTagFromDocument,
      queueFocusCanvas,
    ],
  );

  const handleCanvasDragOver = useCallback(
    (event) => {
      if (!isTagTransfer(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      updateRemovalCursor(true);
      setTagDropTargetId(null);
    },
    [isTagTransfer, updateRemovalCursor],
  );

  const handleCanvasDragLeave = useCallback(
    (event) => {
      if (!isTagTransfer(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (
        event.currentTarget instanceof HTMLElement &&
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      updateRemovalCursor(false);
    },
    [isTagTransfer, updateRemovalCursor],
  );

  const handleCanvasDrop = useCallback(
    async (event) => {
      if (!isTagTransfer(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      updateRemovalCursor(false);
      queueFocusCanvas();
      setTagDropTargetId(null);

      let payload = null;
      try {
        const raw =
          event.dataTransfer.getData('application/x-papercrate-tag') ||
          event.dataTransfer.getData('text/papercrate-tag');
        payload = raw ? JSON.parse(raw) : null;
      } catch (error) {
        payload = null;
      }

      if (!payload?.id) {
        return;
      }

      const tagId = payload.id;
      const sourceDocId = payload.sourceDocId || null;
      markActiveTagDropHandled(tagId, sourceDocId);

      if (!sourceDocId || typeof onRemoveTagFromDocument !== 'function') {
        return;
      }

      setPendingRemovalTag({ docId: sourceDocId, tagId });
      try {
        await onRemoveTagFromDocument(sourceDocId, tagId);
      } catch (error) {
        console.error('Failed to remove tag via canvas drop', error);
      } finally {
        setPendingRemovalTag(null);
      }
    },
    [
      isTagTransfer,
      markActiveTagDropHandled,
      onRemoveTagFromDocument,
      queueFocusCanvas,
      updateRemovalCursor,
    ],
  );

  const handleDocTagPointerDown = useCallback((event, doc, tag) => {
    event.stopPropagation();
    if (!doc || !tag) {
      pendingDocTagDragRef.current = null;
      return;
    }
    const startX = Number.isFinite(event.clientX)
      ? event.clientX
      : Number.isFinite(event.pageX)
      ? event.pageX
      : 0;
    const startY = Number.isFinite(event.clientY)
      ? event.clientY
      : Number.isFinite(event.pageY)
      ? event.pageY
      : 0;
    pendingDocTagDragRef.current = {
      docId: doc.id,
      tagId: tag.id,
      startX,
      startY,
    };
    updateRemovalCursor(false);
  }, [updateRemovalCursor]);

  const handleDocTagDragStart = useCallback(
    (event, doc, tag) => {
      if (!doc || !tag) {
        return;
      }
      event.stopPropagation();
      try {
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'copyMove';
        }
      } catch (
        // eslint-disable-next-line no-empty
        error
      ) {}

      const payload = JSON.stringify({ id: tag.id, label: tag.label, sourceDocId: doc.id });
      try {
        event.dataTransfer?.setData('application/x-papercrate-tag', payload);
        event.dataTransfer?.setData('text/papercrate-tag', payload);
        event.dataTransfer?.setData('text/plain', tag.label || 'Tag');
      } catch (
        // eslint-disable-next-line no-empty
        error
      ) {}

      const pending = pendingDocTagDragRef.current;
      const node = event.currentTarget;
      const startX = Number.isFinite(event.clientX)
        ? event.clientX
        : Number.isFinite(event.pageX)
        ? event.pageX
        : 0;
      const startY = Number.isFinite(event.clientY)
        ? event.clientY
        : Number.isFinite(event.pageY)
        ? event.pageY
        : 0;
      const initialX =
        pending && pending.docId === doc.id && pending.tagId === tag.id && Number.isFinite(pending.startX)
          ? pending.startX
          : startX;
      const initialY =
        pending && pending.docId === doc.id && pending.tagId === tag.id && Number.isFinite(pending.startY)
          ? pending.startY
          : startY;
      pendingDocTagDragRef.current = null;
      let preview = null;
      if (node instanceof HTMLElement) {
        preview = createDragPreview(node, event.clientX, event.clientY);
        if (preview && event.dataTransfer) {
          try {
            event.dataTransfer.setDragImage(preview.clone, preview.offsetX, preview.offsetY);
          } catch (
            // eslint-disable-next-line no-empty
            error
          ) {}
        }
      }
      draggingTagRef.current = {
        sourceDocId: doc.id,
        tagId: tag.id,
        tagLabel: tag.label || 'Tag',
        startX: initialX,
        startY: initialY,
        distance: 0,
        element: node instanceof HTMLElement ? node : null,
        dropHandled: false,
        hasPosition: Number.isFinite(initialX) && Number.isFinite(initialY),
        previewClone: preview?.clone || null,
      };

      const hideNode = () => {
        if (draggingTagRef.current?.element === node) {
          node.classList.add('is-drag-hidden');
        }
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(hideNode);
      } else {
        setTimeout(hideNode, 0);
      }
    },
    [],
  );

  const handleDocTagDrag = useCallback(
    (event) => {
      const state = draggingTagRef.current;
      if (!state) {
        updateRemovalCursor(false);
        return;
      }
      if (!state.hasPosition && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
        state.startX = event.clientX;
        state.startY = event.clientY;
        state.hasPosition = true;
      }
      const clientX = Number.isFinite(event.clientX) ? event.clientX : state.startX;
      const clientY = Number.isFinite(event.clientY) ? event.clientY : state.startY;
      const deltaX = clientX - state.startX;
      const deltaY = clientY - state.startY;
      const distance = Math.hypot(deltaX, deltaY);
      if (Number.isFinite(distance)) {
        state.distance = distance;
      }
      const removalActive =
        Boolean(state.sourceDocId) &&
        !tagDropTargetId &&
        Number.isFinite(state.distance) &&
        state.distance >= TAG_REMOVE_DISTANCE;
      updateRemovalCursor(removalActive);
    },
    [tagDropTargetId, updateRemovalCursor],
  );

  const handleDocTagDragEnd = useCallback(
    (event) => {
      handleTagDragEnd();
      const state = draggingTagRef.current;
      if (!state) {
        return;
      }
      draggingTagRef.current = null;

      const node = state.element;
      const showNode = () => {
        if (node instanceof HTMLElement) {
          node.classList.remove('is-drag-hidden');
        }
      };
      cleanupPreview(state.previewClone);

      const scheduleShowNode = () => {
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(showNode);
        } else {
          setTimeout(showNode, 0);
        }
      };

      const dropEffect = event?.dataTransfer?.dropEffect || 'none';
      console.log('[skeuo] dragEnd dropEffect', dropEffect, 'dropHandled', state.dropHandled);
      const shouldRemove =
        !state.dropHandled &&
        dropEffect === 'none' &&
        state.sourceDocId &&
        typeof onRemoveTagFromDocument === 'function' &&
        (state.distance || 0) >= TAG_REMOVE_DISTANCE;

      if (!shouldRemove) {
        console.log('[skeuo] dragEnd -> no removal. distance:', state.distance);
        scheduleShowNode();
        queueFocusCanvas();
        updateRemovalCursor(false);
        return;
      }

      queueFocusCanvas();
      updateRemovalCursor(false);
      setPendingRemovalTag({ docId: state.sourceDocId, tagId: state.tagId });
      void (async () => {
        try {
          await onRemoveTagFromDocument(state.sourceDocId, state.tagId);
          console.log('[skeuo] dragEnd -> removed tag due to fling');
        } catch (error) {
          console.error('Failed to remove tag after drag', error);
          scheduleShowNode();
        } finally {
          setPendingRemovalTag(null);
        }
      })();
    },
    [queueFocusCanvas, handleTagDragEnd, onRemoveTagFromDocument, updateRemovalCursor],
  );

  const renderBreadcrumbs = () => {
    if (!breadcrumbs.length) return null;
    return (
      <nav className="skeuo-breadcrumbs" aria-label="Folder breadcrumbs">
        {breadcrumbs.map((crumb, index) => {
          const isLast = index === breadcrumbs.length - 1;
          return (
            <span key={crumb.id} className={`skeuo-crumb${isLast ? ' is-current' : ''}`}>
              {crumb.name}
              {!isLast && <span className="skeuo-crumb-separator">›</span>}
            </span>
          );
        })}
      </nav>
    );
  };

  return (
    <div className="skeuo-shell">
      <header className="skeuo-header">
        <div className="skeuo-header__meta">
          <h2>{currentFolderName}</h2>
          {renderBreadcrumbs()}
          {showingSearchResults && <span className="meta">Showing search results</span>}
        </div>
        <div className="skeuo-header__actions">
          <button type="button" className="secondary" onClick={onRefresh}>
            Refresh
          </button>
          <button type="button" onClick={onExit}>
            Back to List
          </button>
        </div>
      </header>
      <div
        className="skeuo-canvas"
        ref={containerRef}
        onDragOver={handleCanvasDragOver}
        onDragLeave={handleCanvasDragLeave}
        onDrop={handleCanvasDrop}
      >
        {items.length === 0 ? (
          <div className="skeuo-empty">
            <p>No documents to show here yet. Drop files to make this space come alive.</p>
          </div>
        ) : (
          items.map((doc) => {
            const { width: cardWidth, height: cardHeight } = ensureDocumentSize(doc);
            const { baseWidth, baseHeight, baseScale } = resolveBaseMetrics(doc, cardWidth, cardHeight);
            const fallbackLayout = {
              centerX: CANVAS_PADDING + cardWidth / 2,
              centerY: CANVAS_PADDING + cardHeight / 2,
              rotation: 0,
              z: 1,
            };
            const storedLayout = layoutSnapshot.get(doc.id) ?? layoutRef.current.get(doc.id);
            const layout = storedLayout || fallbackLayout;
            const layoutCenterX =
              typeof layout.centerX === 'number' ? layout.centerX : fallbackLayout.centerX;
            const layoutCenterY =
              typeof layout.centerY === 'number' ? layout.centerY : fallbackLayout.centerY;
            const isZoomed = zoomedId === doc.id;
            const { zoomWidth, zoomHeight, zoomCenterX, zoomCenterY } = resolveZoomMetrics(
              doc,
              cardWidth,
              cardHeight,
            );
            const targetCenterX = isZoomed ? zoomCenterX : layoutCenterX;
            const targetCenterY = isZoomed ? zoomCenterY : layoutCenterY;
            const rotation = isZoomed ? 0 : layout.rotation || 0;
            const zoomScale = isZoomed
              ? Math.min(
                  1,
                  Number.isFinite(zoomWidth / baseWidth) ? zoomWidth / baseWidth : 1,
                  Number.isFinite(zoomHeight / baseHeight) ? zoomHeight / baseHeight : 1,
                )
              : baseScale;
            const transform = formatTransform(
              Math.round(targetCenterX),
              Math.round(targetCenterY),
              rotation,
              zoomScale,
            );
            const style = {
              transform,
              zIndex: isZoomed ? 9999 : layout.z ?? 1,
            };
            const bodyStyle = {
              width: Math.round(baseWidth),
              height: Math.round(baseHeight),
            };
            const totalScale = zoomScale > 0 ? zoomScale : 1;
            const inverseTagScale = totalScale > 0 ? 1 / totalScale : 1;
            const tagsStyle = { '--tag-scale': inverseTagScale };
            const previewUrl = resolvePreviewUrl(doc);
            const imageUrl = previewUrl;
            const hasPreview = Boolean(imageUrl);
            const title = doc.title || doc.original_name || 'Document';
            const dragging = draggingId === doc.id;
            const tags = Array.isArray(doc.tags) ? doc.tags : [];
            const docTagKeys = tags
              .map((tag) => resolveTagKey(tag))
              .filter(Boolean);
            const matchesFilter =
              activeTagSet.size === 0 || docTagKeys.some((key) => activeTagSet.has(key));
            const dropActive = tagDropTargetId === doc.id;
            const dropPending = pendingTagDocId === doc.id;
            const itemClasses = ['skeuo-item'];
            if (dragging) itemClasses.push('is-dragging');
            if (isZoomed) itemClasses.push('is-zoomed');
            if (dropActive) itemClasses.push('is-tag-target');
            if (dropPending) itemClasses.push('is-tag-pending');
            if (!matchesFilter) itemClasses.push('is-filtered-out');
            const cardClasses = ['skeuo-item__card'];
            if (!hasPreview) cardClasses.push('skeuo-item__card--empty');
            const docTagTokens = docTagKeys.join(' ');
            return (
              <div
                key={doc.id}
                className={itemClasses.join(' ')}
                style={style}
                role="button"
                data-doc-id={doc.id}
                data-tag-ids={docTagTokens || undefined}
                aria-hidden={matchesFilter ? undefined : 'true'}
                ref={(node) => {
                  if (node) {
                    itemRefs.current.set(doc.id, node);
                  } else {
                    itemRefs.current.delete(doc.id);
                  }
                }}
                onPointerDown={(event) =>
                  handlePointerDown(event, doc.id, { lockWhenZoomed: isZoomed })
                }
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onDragEnter={(event) => handleTagDragEnterDoc(event, doc.id)}
                onDragOver={(event) => handleTagDragOverDoc(event, doc.id)}
                onDragLeave={(event) => handleTagDragLeaveDoc(event, doc.id)}
                onDrop={(event) => handleTagDropOnDoc(event, doc)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onDocumentOpen?.(doc.id);
                  }
                }}
              >
                <div className="skeuo-item__body" style={bodyStyle}>
                  <div className={cardClasses.join(' ')}>
                    {hasPreview ? (
                      <img src={imageUrl} alt={title} />
                    ) : (
                      <div className="skeuo-item__empty">
                        <div className="skeuo-item__placeholder">DOC</div>
                        <div className="skeuo-item__title" title={title}>
                          {title}
                        </div>
                      </div>
                    )}
                  </div>
                  {tags.length > 0 && (
                    <div className="skeuo-item__tags" aria-hidden="true" style={tagsStyle}>
                      {tags.map((tag) => {
                        const key = tag.id || tag.label || String(tag);
                        if (
                          pendingRemovalTag &&
                          pendingRemovalTag.docId === doc.id &&
                          pendingRemovalTag.tagId === tag.id
                        ) {
                          return null;
                        }
                        const colorValue = normalizeColor(tag.color);
                        const foreground = getContrastingTextColor(colorValue || '#1b1f24');
                        const pendingRemoval =
                          pendingRemovalTag &&
                          pendingRemovalTag.docId === doc.id &&
                          pendingRemovalTag.tagId === tag.id;
                        const tagClasses = ['skeuo-tag'];
                        if (pendingRemoval) tagClasses.push('is-tear-pending');
                        const tagStyle =
                          colorValue ? { backgroundColor: colorValue, color: foreground } : undefined;
                        return (
                          <div
                            key={key}
                            className={tagClasses.join(' ')}
                            style={tagStyle}
                            title={tag.label || 'Tag'}
                            draggable
                            onPointerDown={(event) => handleDocTagPointerDown(event, doc, tag)}
                            onDragStart={(event) => handleDocTagDragStart(event, doc, tag)}
                            onDrag={handleDocTagDrag}
                            onDragEnd={(event) => handleDocTagDragEnd(event)}
                          >
                            <span>{tag.label || 'Tag'}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default SkeuomorphicWorkspace;
