export const getAssetFromGroup = (assets, assetType) => {
  if (!assetType || !assets) {
    return null;
  }

  if (Array.isArray(assets)) {
    return assets.find((entry) => entry?.asset_type === assetType) || null;
  }

  return assets?.[assetType] || null;
};

export const getAssetFromVersion = (currentVersion, assetType) => {
  if (!currentVersion) {
    return null;
  }
  return getAssetFromGroup(currentVersion.assets, assetType);
};

const normalizeAssetObjects = (objects) => {
  if (!Array.isArray(objects)) {
    return [];
  }
  return objects
    .filter((entry) => Number.isInteger(entry?.ordinal))
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);
};

const mergeAssetObjects = (existingObjects, incomingObjects) => {
  const merged = new Map();

  normalizeAssetObjects(existingObjects).forEach((entry) => {
    merged.set(entry.ordinal, { ...entry });
  });

  normalizeAssetObjects(incomingObjects).forEach((entry) => {
    const current = merged.get(entry.ordinal) || {};
    merged.set(entry.ordinal, { ...current, ...entry });
  });

  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value);
};

export class AssetView {
  constructor(asset) {
    this.asset = asset || null;
    this._objectsRef = null;
    this._sortedObjects = [];
  }

  getCardinality() {
    if (!this.asset) {
      return 0;
    }

    const reported = Number(this.asset.cardinality);
    if (Number.isFinite(reported) && reported > 0) {
      return reported;
    }

    const objectsCount = this.getObjects().length;
    if (objectsCount > 0) {
      return objectsCount;
    }

    return this.asset.metadata ? 1 : 0;
  }

  getObjects() {
    if (!this.asset || !Array.isArray(this.asset.objects) || this.asset.objects.length === 0) {
      return [];
    }

    if (this._objectsRef === this.asset.objects) {
      return this._sortedObjects;
    }

    this._objectsRef = this.asset.objects;
    this._sortedObjects = normalizeAssetObjects(this.asset.objects);
    return this._sortedObjects;
  }

  getObject(ordinal = 1) {
    const fromObjects = this.getObjects().find((entry) => entry.ordinal === ordinal);
    if (fromObjects) {
      return fromObjects;
    }

    if (ordinal === 1 && this.asset) {
      if (this.asset.url || this.asset.metadata) {
        return {
          ordinal: 1,
          url: this.asset.url || null,
          metadata: this.asset.metadata || null,
          expires_at: this.asset.expiresAt ?? null,
        };
      }
    }

    return null;
  }

  getPrimaryObject() {
    return this.getObject(1);
  }

  getPrimaryMetadata() {
    return this.getPrimaryObject()?.metadata || null;
  }

  getPrimaryUrl() {
    return this.getPrimaryObject()?.url || null;
  }

  hasObject(ordinal) {
    return Boolean(this.getObject(ordinal));
  }
}

export const createAssetView = (asset) => new AssetView(asset);

export const resolveDocumentAssetUrl = (
  doc,
  type,
  { ensureAssetUrl, getAsset, ensureOptions, objectOrdinal = 1 } = {},
) => {
  if (!doc || !type) {
    return null;
  }
  const asset = typeof getAsset === 'function' ? getAsset(doc, type) : null;
  if (!asset) {
    return null;
  }
  const view = createAssetView(asset);
  const object = view.getObject(objectOrdinal);
  const url = object?.url || (objectOrdinal === 1 ? view.getPrimaryUrl() : null);
  const expiresAt = typeof object?.expires_at === 'number'
    ? object.expires_at
    : objectOrdinal === 1 && typeof asset.expiresAt === 'number'
      ? asset.expiresAt
      : null;
  const now = Date.now();
  if (url && (!expiresAt || expiresAt > now)) {
    return url;
  }
  if (doc.id && asset.id && typeof ensureAssetUrl === 'function') {
    const force = Boolean(url && expiresAt && expiresAt <= now);
    const options = {
      force,
      start: objectOrdinal,
      limit: 1,
      ...(ensureOptions || {}),
    };
    if (!options.start) {
      options.start = objectOrdinal;
    }
    if (!options.limit) {
      options.limit = 1;
    }
    ensureAssetUrl(doc.id, asset, options).catch(() => {});
  }
  return null;
};

class AssetManager {
  constructor({ api, assetPresignTtlMs }) {
    this.api = api;
    this.assetPresignTtlMs = assetPresignTtlMs;
    this.assetCache = new Map();
    this.assetInflight = new Map();
  }

  setApi(api) {
    this.api = api;
  }

  rememberAsset(entry) {
    if (entry?.id) {
      this.assetCache.set(entry.id, entry);
    }
  }

  hydrateAsset(asset) {
    if (!asset || !asset.id) {
      return asset;
    }
    const cached = this.assetCache.get(asset.id);
    if (!cached) {
      const normalized = mergeAssetObjects(null, asset.objects);
      if (normalized.length) {
        return { ...asset, objects: normalized };
      }
      return asset;
    }
    const merged = { ...cached, ...asset };
    if (cached.url && !asset.url) {
      merged.url = cached.url;
    }
    if (cached.expiresAt) {
      const cachedExpires = Number(cached.expiresAt) || null;
      const assetExpires = Number(asset.expiresAt) || null;
      if (!assetExpires || (cachedExpires && cachedExpires > assetExpires)) {
        merged.expiresAt = cachedExpires;
      }
    }
    const mergedObjects = mergeAssetObjects(cached.objects, asset.objects);
    if (mergedObjects.length) {
      merged.objects = mergedObjects;
    }
    return merged;
  }

  hydrateDocument(document) {
    if (!document) {
      return document;
    }

    const currentVersion = document.current_version || null;
    if (!currentVersion) {
      return document;
    }

    let changed = false;
    let nextAssets = currentVersion.assets;

    if (nextAssets && !Array.isArray(nextAssets)) {
      const hydrated = {};
      Object.keys(nextAssets).forEach((key) => {
        hydrated[key] = this.hydrateAsset(nextAssets[key]);
        if (hydrated[key] !== nextAssets[key]) {
          changed = true;
        }
      });
      if (changed) {
        nextAssets = { ...nextAssets, ...hydrated };
      }
    } else if (Array.isArray(nextAssets)) {
      const hydratedList = nextAssets.map((item) => this.hydrateAsset(item));
      if (
        hydratedList.length !== nextAssets.length ||
        hydratedList.some((item, index) => item !== nextAssets[index])
      ) {
        changed = true;
        nextAssets = hydratedList;
      }
    }

    if (!changed) {
      return document;
    }

    const nextCurrentVersion = { ...currentVersion, assets: nextAssets };
    return { ...document, current_version: nextCurrentVersion };
  }

  hydrateDocuments(documents) {
    if (!Array.isArray(documents)) {
      return documents;
    }
    return documents.map((doc) => this.hydrateDocument(doc));
  }

  hydrateDetail(detail) {
    if (!detail) {
      return detail;
    }
    let changed = false;
    const next = { ...detail };

    if (detail.document) {
      const hydratedDocument = this.hydrateDocument(detail.document);
      if (hydratedDocument !== detail.document) {
        next.document = hydratedDocument;
        changed = true;
      }
    }

    if (Array.isArray(detail.assets)) {
      const hydratedAssets = detail.assets.map((item) => this.hydrateAsset(item));
      if (
        hydratedAssets.length !== detail.assets.length ||
        hydratedAssets.some((item, index) => item !== detail.assets[index])
      ) {
        next.assets = hydratedAssets;
        changed = true;
      }
    }

    return changed ? next : detail;
  }

  hydrateFolderContents(contents) {
    if (!contents) {
      return contents;
    }
    const next = { ...contents };
    if (Array.isArray(contents.documents)) {
      next.documents = this.hydrateDocuments(contents.documents);
    }
    if (contents.document) {
      next.document = this.hydrateDocument(contents.document);
    }
    return next;
  }

  ensureAsset(documentId, asset, { force = false, start = null, limit = null } = {}) {
    if (!documentId || !asset?.id) {
      return Promise.resolve(asset || null);
    }

    const requestedStart = Number.isInteger(start) && start > 0 ? start : 1;
    const requestedLimit = Number.isInteger(limit) && limit > 0 ? limit : 1;
    const requestedEnd = requestedStart + requestedLimit - 1;

    const baseAsset = this.assetCache.get(asset.id) || asset;
    const view = createAssetView(baseAsset);
    const assetExpiresAt = typeof baseAsset.expiresAt === 'number' ? baseAsset.expiresAt : null;
    const now = Date.now();

    const isOrdinalSatisfied = (ordinal) => {
      const object = view.getObject(ordinal);
      if (!object) {
        return false;
      }
      if (!object.url) {
        return false;
      }
      if (typeof object.expires_at === 'number') {
        return object.expires_at > now;
      }
      if (ordinal === 1 && baseAsset.url && (!assetExpiresAt || assetExpiresAt > now)) {
        return true;
      }
      return true;
    };

    let needsFetch = force;
    if (!needsFetch) {
      for (let ordinal = requestedStart; ordinal <= requestedEnd; ordinal += 1) {
        if (!isOrdinalSatisfied(ordinal)) {
          needsFetch = true;
          break;
        }
      }
    }

    if (!needsFetch) {
      this.rememberAsset(baseAsset);
      return Promise.resolve(baseAsset);
    }

    const inflightKey = `${documentId}:${asset.id}:${start ?? 'd'}:${limit ?? 'd'}`;
    if (!force && this.assetInflight.has(inflightKey)) {
      return this.assetInflight.get(inflightKey);
    }

    if (!this.api) {
      return Promise.reject(new Error('AssetManager API client is not configured.'));
    }

    const params = {};
    if (Number.isInteger(start) && start > 0) {
      params.start = start;
    }
    if (Number.isInteger(limit) && limit > 0) {
      params.limit = limit;
    }

    const requestConfig = Object.keys(params).length ? { params } : undefined;

    const request = this.api
      .get(`/assets/${asset.id}`, requestConfig)
      .then(({ data }) => {
        const incomingObjects = Array.isArray(data.objects) ? data.objects : [];
        const cachedEntry = this.assetCache.get(asset.id) || baseAsset;
        const mergedObjects = mergeAssetObjects(cachedEntry?.objects, incomingObjects);
        const combined = { ...cachedEntry, ...asset, ...data, objects: mergedObjects };
        const view = createAssetView(combined);
        const primaryObject = view.getPrimaryObject();
        const expiresAt = typeof primaryObject?.expires_at === 'number'
          ? primaryObject.expires_at
          : Date.now() + this.assetPresignTtlMs;
        const cardinality = (() => {
          const reported = Number(data.cardinality ?? asset.cardinality ?? cachedEntry?.cardinality);
          const objectsCount = mergedObjects.length;
          if (Number.isFinite(reported) && reported > 0) {
            return Math.max(reported, objectsCount) || null;
          }
          return objectsCount || null;
        })();

        const entry = {
          ...combined,
          cardinality,
          url: view.getPrimaryUrl(),
          expiresAt,
        };

        this.rememberAsset(entry);
        return entry;
      })
      .finally(() => {
        this.assetInflight.delete(inflightKey);
      });

    this.assetInflight.set(inflightKey, request);
    return request;
  }

  reset() {
    this.assetCache.clear();
    this.assetInflight.clear();
  }
}

export default AssetManager;
