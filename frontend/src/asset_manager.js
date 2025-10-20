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

export const resolveDocumentAssetUrl = (doc, type, { ensureAssetUrl, getAsset, ensureOptions } = {}) => {
  if (!doc || !type) {
    return null;
  }
  const asset = typeof getAsset === 'function' ? getAsset(doc, type) : null;
  if (!asset) {
    return null;
  }
  const now = Date.now();
  const expiresAt = typeof asset.expiresAt === 'number' ? asset.expiresAt : null;
  const hasFreshUrl = asset.url && (!expiresAt || expiresAt > now);
  if (hasFreshUrl) {
    return asset.url;
  }
  if (doc.id && asset.id && typeof ensureAssetUrl === 'function') {
    const force = Boolean(asset.url && expiresAt && expiresAt <= now);
    const options = ensureOptions ? { ...ensureOptions, force } : { force };
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

    const assetExpiresAt = typeof asset.expiresAt === 'number' ? asset.expiresAt : null;
    if (!force && asset?.url && (!assetExpiresAt || assetExpiresAt > Date.now())) {
      this.rememberAsset(asset);
      return Promise.resolve(asset);
    }

    const cached = this.assetCache.get(asset.id);
    const now = Date.now();
    if (!force && cached && cached.expiresAt && cached.expiresAt > now && cached.url) {
      return Promise.resolve({ ...asset, ...cached });
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
        const objects = Array.isArray(data.objects) ? data.objects : [];
        const primaryObject = objects[0] || null;
        const expiresAt = typeof primaryObject?.expires_at === 'number'
          ? primaryObject.expires_at
          : Date.now() + this.assetPresignTtlMs;

        const entry = {
          ...asset,
          ...data,
          objects,
          url: primaryObject?.url || null,
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
