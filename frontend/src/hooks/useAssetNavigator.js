import { useCallback, useEffect, useMemo, useState } from 'react';
import { createAssetView } from '../asset_manager';

const clampOrdinalValue = (value, cardinality, defaultOrdinal) => {
  const raw = Number.isFinite(value) ? value : defaultOrdinal;
  let next = Math.max(1, Math.floor(raw));
  if (cardinality && cardinality > 0) {
    next = Math.min(next, cardinality);
  }
  return next;
};

export const useAssetNavigator = ({
  document,
  assetType,
  ensureAssetUrl,
  getAsset,
  prefetch = 2,
  defaultOrdinal = 1,
}) => {
  const documentId = document?.id || null;

  const asset = useMemo(() => {
    if (!document || typeof getAsset !== 'function') {
      return null;
    }
    return getAsset(document, assetType);
  }, [document, assetType, getAsset]);

  const view = useMemo(() => createAssetView(asset), [asset]);
  const cardinality = view.getCardinality();

  const [ordinal, setOrdinalInternal] = useState(defaultOrdinal);

  useEffect(() => {
    setOrdinalInternal(defaultOrdinal);
  }, [documentId, assetType, defaultOrdinal]);

  const setOrdinal = useCallback(
    (next) => {
      setOrdinalInternal((prev) => {
        const target = typeof next === 'function' ? next(prev) : next;
        return clampOrdinalValue(target, cardinality, defaultOrdinal);
      });
    },
    [cardinality, defaultOrdinal],
  );

  const goPrev = useCallback(() => setOrdinal((value) => value - 1), [setOrdinal]);
  const goNext = useCallback(() => setOrdinal((value) => value + 1), [setOrdinal]);

  const objects = view.getObjects();
  const currentObject = view.getObject(ordinal);
  const currentUrl = currentObject?.url || view.getPrimaryUrl();
  const currentMetadata = currentObject?.metadata || view.getPrimaryMetadata() || null;

  const canGoPrev = ordinal > 1;
  const canGoNext = cardinality ? ordinal < cardinality : true;

  const ordinalsNeedingLoad = useMemo(() => {
    const missing = [];
    if (!asset) {
      return missing;
    }
    const maxOrdinal = cardinality && cardinality > 0
      ? Math.min(cardinality, ordinal + Math.max(1, prefetch) - 1)
      : ordinal + Math.max(1, prefetch) - 1;

    for (let ord = ordinal; ord <= maxOrdinal; ord += 1) {
      const object = view.getObject(ord);
      if (!object?.url) {
        missing.push(ord);
      }
    }

    return missing;
  }, [asset, view, ordinal, prefetch, cardinality]);

  const fetchStart = ordinalsNeedingLoad.length ? ordinalsNeedingLoad[0] : null;
  const fetchEnd = ordinalsNeedingLoad.length ? ordinalsNeedingLoad[ordinalsNeedingLoad.length - 1] : null;
  const fetchLimit = fetchStart && fetchEnd ? fetchEnd - fetchStart + 1 : null;

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!documentId || !asset || !ensureAssetUrl) {
      setLoading(false);
      return;
    }
    if (!fetchStart || !fetchLimit) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    ensureAssetUrl(documentId, asset, {
      start: fetchStart,
      limit: fetchLimit,
    })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [documentId, asset, ensureAssetUrl, fetchStart, fetchLimit]);

  return {
    document,
    documentId,
    asset,
    assetType,
    ordinal,
    setOrdinal,
    goPrev,
    goNext,
    canGoPrev,
    canGoNext,
    cardinality,
    currentObject,
    currentUrl,
    currentMetadata,
    objects,
    isLoading: loading,
  };
};

export default useAssetNavigator;
