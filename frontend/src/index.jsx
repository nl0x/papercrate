import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useReducer,
} from 'react';
import { createRoot } from 'react-dom/client';
import axios from 'axios';
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  Outlet,
  useLocation,
  useNavigate,
  useMatch,
  matchPath,
} from 'react-router-dom';
import './styles.css';
import AssetManager, { getAssetFromVersion, resolveDocumentAssetUrl, createAssetView } from './asset_manager';
import useApiError from './hooks/useApiError';
import SkeuomorphicWorkspace from './skeuomorphic_ws';
import DetailPanel from './detail/DetailPanel';
import TagsPanel from './tags/TagsPanel';
import CorrespondentsPanel from './correspondents/CorrespondentsPanel';
import { CORRESPONDENT_ROLES } from './constants/correspondents';
import TagManager from './tag_manager';
import Sidebar from './sidebar/Sidebar';
import DocumentsTable from './documents/DocumentsTable';
import { AppShellContext, useAppShell } from './appShellContext';
import DocumentViewerRoute from './routes/DocumentViewerRoute';

const runtimeApiBase =
  typeof window !== 'undefined' && window.__PAPERCRATE_API_BASE_URL
    ? window.__PAPERCRATE_API_BASE_URL
    : '';

const DEFAULT_DEV_API = 'http://127.0.0.1:3000';
const ASSET_PRESIGN_TTL_MS = 240 * 1000; // backend issues 5 min tokens; refresh slightly early
const TAG_MIME_TYPES = ['application/x-papercrate-tag', 'text/papercrate-tag'];

const API_ROOT = (runtimeApiBase || process.env.API_BASE_URL || DEFAULT_DEV_API).replace(/\/$/, '');

const api = axios.create({
  baseURL: API_ROOT ? `${API_ROOT}/api` : '/api',
  withCredentials: true,
});

const STORED_TOKEN = window.localStorage.getItem('papercrate_token') || '';
if (STORED_TOKEN) {
  api.defaults.headers.common.Authorization = `Bearer ${STORED_TOKEN}`;
}

const initialAppState = {
  status: STORED_TOKEN ? 'authenticated' : 'logged-out',
  token: STORED_TOKEN,
  error: null,
  isRefreshing: false,
};

const AppStateContext = React.createContext(null);
const AppDispatchContext = React.createContext(null);

const appStateReducer = (state, action) => {
  switch (action.type) {
    case 'LOGIN_REQUEST':
      return { ...state, status: 'authenticating', error: null };
    case 'LOGIN_SUCCESS':
      return { ...state, status: 'authenticated', token: action.token, error: null };
    case 'LOGIN_FAILURE':
      return { status: 'logged-out', token: '', error: action.error || null, isRefreshing: false };
    case 'BOOTSTRAP_START':
      return { ...state, status: 'bootstrapping', error: null };
    case 'BOOTSTRAP_SUCCESS':
      return { ...state, status: 'ready', error: null };
    case 'BOOTSTRAP_FAILURE':
      return { ...state, status: 'authenticated', error: action.error || null };
    case 'TOKEN_REFRESH_START':
      return { ...state, isRefreshing: true, error: null };
    case 'TOKEN_REFRESH_SUCCESS':
      return {
        ...state,
        token: action.token,
        isRefreshing: false,
        status: state.status === 'logged-out' ? 'authenticated' : state.status,
      };
    case 'TOKEN_REFRESH_FAILURE':
      return { status: 'logged-out', token: '', error: action.error || null, isRefreshing: false };
    case 'LOGOUT':
      return { status: 'logged-out', token: '', error: null, isRefreshing: false };
    case 'RESET_ERROR':
      return { ...state, error: null };
    default:
      return state;
  }
};

const AppStateProvider = ({ children }) => {
  const [state, dispatch] = useReducer(appStateReducer, initialAppState);

  useEffect(() => {
    const token = state.token || '';
    if (token) {
      api.defaults.headers.common.Authorization = `Bearer ${token}`;
      window.localStorage.setItem('papercrate_token', token);
    } else {
      delete api.defaults.headers.common.Authorization;
      window.localStorage.removeItem('papercrate_token');
    }
  }, [state.token]);

  const stateValue = useMemo(() => state, [state]);

  return (
    <AppStateContext.Provider value={stateValue}>
      <AppDispatchContext.Provider value={dispatch}>
        {children}
      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
};

const useAppState = () => {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error('useAppState must be used within an AppStateProvider.');
  }
  return context;
};

const useAppDispatch = () => {
  const context = useContext(AppDispatchContext);
  if (!context) {
    throw new Error('useAppDispatch must be used within an AppStateProvider.');
  }
  return context;
};

const DEFAULT_FOLDER_NAME = 'All Documents';

const ROW_KEY_SEPARATOR = ':';
const DOCUMENT_ROW_PREFIX = 'document';
const FOLDER_ROW_PREFIX = 'folder';

const resolveApiPath = (path = '') => (API_ROOT ? `${API_ROOT}${path}` : path);

const makeRowKey = (type, id) =>
  id ? `${type}${ROW_KEY_SEPARATOR}${id}` : `${type}${ROW_KEY_SEPARATOR}`;

const getRowType = (key) => (typeof key === 'string' ? key.split(ROW_KEY_SEPARATOR, 1)[0] : '');

const getRowId = (key) => {
  if (typeof key !== 'string') return '';
  const separatorIndex = key.indexOf(ROW_KEY_SEPARATOR);
  if (separatorIndex === -1) return key;
  return key.slice(separatorIndex + 1);
};

const isDocumentRowKey = (key) => getRowType(key) === DOCUMENT_ROW_PREFIX;
const isFolderRowKey = (key) => getRowType(key) === FOLDER_ROW_PREFIX;

const resolveDocumentRowKey = (documentId) =>
  documentId ? makeRowKey(DOCUMENT_ROW_PREFIX, documentId) : null;

const resolveFolderRowKey = (folderId) =>
  folderId ? makeRowKey(FOLDER_ROW_PREFIX, folderId) : null;

const hasFiles = (event) =>
  Array.from(event.dataTransfer?.types || []).includes('Files');

const createRootNode = () => ({
  id: 'root',
  name: DEFAULT_FOLDER_NAME,
  parentId: null,
  children: [],
  expanded: true,
  loaded: false,
});

const StatusBanner = ({ status }) => {
  if (!status) return null;
  return <div className={`status-banner ${status.variant}`}>{status.message}</div>;
};

const DropOverlay = ({ active, folderName }) => (
  <div className={`drop-overlay${active ? ' active' : ''}`}>
    <div className="drop-overlay__content">
      Drop files to upload to <strong>{folderName}</strong>
    </div>
  </div>
);

const LoginView = ({ onSubmit, status }) => (
  <div className="login-screen">
    <div className="login-card">
      <h1>Papercrate</h1>
      <p>Authenticate to manage your documents.</p>
      <form onSubmit={onSubmit}>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          placeholder="admin"
          autoComplete="username"
          required
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          placeholder="••••••"
          autoComplete="current-password"
          required
        />
        <button type="submit">Sign in</button>
      </form>
      <StatusBanner status={status} />
    </div>
  </div>
);



const DocumentsLayout = ({ sidebarProps, children }) => (
  <main className="documents-main">
    <Sidebar {...sidebarProps} />
    {children}
  </main>
);

const AppLayout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const appState = useAppState();
  const appDispatch = useAppDispatch();
  const folderMatch = matchPath('/documents/folder/:folderId', location.pathname);
  const docMatch = matchPath('/documents/:documentId', location.pathname);
  const routeFolderId = folderMatch?.params?.folderId || null;
  const routeDocumentId = docMatch?.params?.documentId || null;
  const previewDocumentId = routeDocumentId;
  const { status: appStatus, token } = appState;
  const [status, setStatus] = useState(null);
  const setStatusMessage = useCallback((message, variant = 'info') => {
    setStatus(message ? { message, variant } : null);
  }, []);
  const handleApiReport = useCallback(
    ({ message, variant }) => setStatusMessage(message, variant),
    [setStatusMessage],
  );
  const reportApiError = useApiError({
    onReport: handleApiReport,
  });
  const notifyApiError = useCallback(
    (error, fallbackMessage, variant = 'error') =>
      reportApiError(error, { message: fallbackMessage, variant }),
    [reportApiError],
  );
  const [loading, setLoading] = useState(false);
  const [isCreateFolderModalOpen, setCreateFolderModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [createFolderError, setCreateFolderError] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const createFolderInputRef = useRef(null);
  const [folderNodes, setFolderNodes] = useState(() => {
    const rootNode = createRootNode();
    return new Map([[rootNode.id, rootNode]]);
  });
  const [folderContents, setFolderContents] = useState(() => new Map());
  const [selectedFolder, setSelectedFolder] = useState(routeFolderId || 'root');
  const [currentFolder, setCurrentFolder] = useState(null);
  const [currentSubfolders, setCurrentSubfolders] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [workspaceMode, setWorkspaceMode] = useState('table');
  const [documentsViewMode, setDocumentsViewMode] = useState(() => {
    if (typeof window === 'undefined') {
      return 'list';
    }
    const stored = window.localStorage.getItem('papercrate_view_mode');
    return stored === 'grid' ? 'grid' : 'list';
  });
  const initialRowSelection = routeDocumentId
    ? [resolveDocumentRowKey(routeDocumentId)]
    : [];
  const [selectedRowKeys, setSelectedRowKeys] = useState(initialRowSelection);
  const [selectionOrder, setSelectionOrder] = useState(initialRowSelection);
  const [focusedDocumentId, setFocusedDocumentId] = useState(routeDocumentId);
  const [focusedRowKey, setFocusedRowKey] = useState(() =>
    routeDocumentId ? resolveDocumentRowKey(routeDocumentId) : null,
  );
  const tokenRef = useRef(token);
  const refreshPromiseRef = useRef(null);
  const breadcrumbFetchRef = useRef(new Set());
  const tagRemovalCursorActiveRef = useRef(false);
  const setTagRemovalCursor = useCallback((active) => {
    if (typeof document === 'undefined') {
      return;
    }
    if (tagRemovalCursorActiveRef.current === active) {
      return;
    }
    const body = document.body;
    if (!body) {
      return;
    }
    tagRemovalCursorActiveRef.current = active;
    if (active) {
      body.classList.add('skeuo-cursor-remove');
    } else {
      body.classList.remove('skeuo-cursor-remove');
    }
  }, []);
  const refreshAccessToken = useCallback(async () => {
    console.log('[Auth] Attempting to refresh access token…');
    appDispatch({ type: 'TOKEN_REFRESH_START' });
    try {
      const { data } = await api.post('/auth/refresh');
      if (data?.access_token) {
        appDispatch({ type: 'TOKEN_REFRESH_SUCCESS', token: data.access_token });
        console.log('[Auth] Access token refreshed at', new Date().toISOString());
        return data.access_token;
      }
      throw new Error('Missing access token in refresh response');
    } catch (error) {
      console.warn('[Auth] Failed to refresh access token', error);
      appDispatch({ type: 'TOKEN_REFRESH_FAILURE', error: error?.message || null });
      throw error;
    }
  }, [appDispatch]);
  const [searchResults, setSearchResults] = useState(null);
  const [tags, setTags] = useState([]);
  const [correspondents, setCorrespondents] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTagFilters, setActiveTagFilters] = useState([]);
  const [activeCorrespondentFilters, setActiveCorrespondentFilters] = useState([]);
  const documentsRouteMatch = useMatch('/documents');
  const documentsFolderRouteMatch = useMatch('/documents/folder/:folderId');
  const documentsDetailRouteMatch = useMatch('/documents/:documentId');
  const tagsRouteMatch = useMatch('/tags');
  const correspondentsRouteMatch = useMatch('/correspondents');
  const isDocumentsRoute = Boolean(
    documentsRouteMatch || documentsFolderRouteMatch || documentsDetailRouteMatch,
  );
  const isTagsRoute = Boolean(tagsRouteMatch);
  const isCorrespondentsRoute = Boolean(correspondentsRouteMatch);
  const toggleTagFilter = useCallback((tagId) => {
    if (!tagId) return;
    setActiveTagFilters((previous) =>
      previous.includes(tagId)
        ? previous.filter((id) => id !== tagId)
        : previous.concat([tagId]),
    );
  }, []);

  const toggleCorrespondentFilter = useCallback((correspondentId) => {
    setActiveCorrespondentFilters((previous) => {
      if (!correspondentId) {
        return [];
      }
      return previous.includes(correspondentId) ? [] : [correspondentId];
    });
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setActiveTagFilters([]);
    setActiveCorrespondentFilters([]);
    setSearchLoading(false);
  }, []);

  const handleSearchSubmit = useCallback(() => {
    if (!navigate) return;
    const targetFolder = selectedFolder && selectedFolder !== 'root' ? selectedFolder : 'root';
    const targetPath = targetFolder === 'root' ? '/documents' : `/documents/folder/${targetFolder}`;
    if (!isDocumentsRoute || location.pathname !== targetPath) {
      navigate(targetPath, { replace: false });
    }
  }, [navigate, selectedFolder, isDocumentsRoute, location.pathname]);
  const [draggedDocumentIds, setDraggedDocumentIds] = useState([]);
  const [draggedFolderId, setDraggedFolderId] = useState(null);
  const [dropOverlayState, setDropOverlayState] = useState({
    active: false,
    folderName: DEFAULT_FOLDER_NAME,
  });
  const [activePreviewId, setActivePreviewId] = useState(routeDocumentId || null);
  const [searchLoading, setSearchLoading] = useState(false);
  const shellRef = useRef(null);
  const assetManagerRef = useRef(null);
  if (!assetManagerRef.current) {
    assetManagerRef.current = new AssetManager({ api, assetPresignTtlMs: ASSET_PRESIGN_TTL_MS });
  }
  const assetManager = assetManagerRef.current;

  const tagManagerRef = useRef(null);
  if (!tagManagerRef.current) {
    tagManagerRef.current = new TagManager();
  }
  const tagManager = tagManagerRef.current;

  const buildTagPayload = useCallback(
    ({ label, color } = {}) => tagManager.buildPayload({ label, color }),
    [tagManager],
  );

  const getDocumentAsset = useCallback((doc, type) => {
    if (!doc || !type) return null;
    return getAssetFromVersion(doc.current_version || null, type);
  }, []);

  const isAssetEquivalent = (lhs, rhs) => {
    if (!lhs || !rhs) return false;
    const lhsView = createAssetView(lhs);
    const rhsView = createAssetView(rhs);
    const lhsPrimaryMetadata = lhsView.getPrimaryMetadata() || lhs?.metadata;
    const rhsPrimaryMetadata = rhsView.getPrimaryMetadata() || rhs?.metadata;
    const lhsCardinality = lhsView.getCardinality() || lhs?.cardinality || null;
    const rhsCardinality = rhsView.getCardinality() || rhs?.cardinality || null;
    const lhsObjects = lhsView.getObjects();
    const rhsObjects = rhsView.getObjects();
    const objectsComparable = lhsObjects.length === rhsObjects.length
      && lhsObjects.every((entry, index) => {
        const other = rhsObjects[index];
        if (!other) return false;
        if (entry.ordinal !== other.ordinal) return false;
        if (entry.url && other.url && entry.url === other.url) {
          return true;
        }
        if (!entry.url && !other.url) {
          return JSON.stringify(entry.metadata || null) === JSON.stringify(other.metadata || null);
        }
        return entry.url === other.url;
      });
    return (
      lhs.id === rhs.id &&
      lhs.url === rhs.url &&
      lhsPrimaryMetadata?.width === rhsPrimaryMetadata?.width &&
      lhsPrimaryMetadata?.height === rhsPrimaryMetadata?.height &&
      lhs.mime_type === rhs.mime_type &&
      lhs.asset_type === rhs.asset_type &&
      lhs.created_at === rhs.created_at &&
      lhsCardinality === rhsCardinality &&
      objectsComparable
    );
  };

  const mergeAssetIntoGroup = (group, assetData) => {
    if (!assetData || !assetData.asset_type) {
      if (Array.isArray(group)) {
        return group;
      }
      return group || {};
    }

    if (Array.isArray(group) || !group) {
      const list = Array.isArray(group) ? group : [];
      const index = list.findIndex((item) => item?.id === assetData.id);
      if (index >= 0) {
        const existing = list[index];
        if (isAssetEquivalent(existing, assetData)) {
          return list;
        }
        const next = list.slice();
        next[index] = { ...existing, ...assetData };
        return next;
      }
      return list.concat({ ...assetData });
    }

    const key = assetData.asset_type;
    const previous = group?.[key];
    if (previous && isAssetEquivalent(previous, assetData)) {
      return group;
    }

    const next = { ...(group || {}) };
    next[key] = { ...(previous || {}), ...assetData };
    return next;
  };

  const mergeAssetIntoDocument = (doc, assetData) => {
    if (!doc) return doc;
    const existingGroup = doc.current_version?.assets || null;
    const nextGroup = mergeAssetIntoGroup(existingGroup, assetData);
    if (nextGroup === existingGroup) {
      return doc;
    }
    const updatedCurrentVersion = doc.current_version
      ? { ...doc.current_version, assets: nextGroup }
      : { assets: nextGroup };
    return { ...doc, current_version: updatedCurrentVersion };
  };

  const bootstrapInitializedRef = useRef(false);
  const selectionInitializedRef = useRef(false);
  const dragCounterRef = useRef(0);
  const prefetchedFoldersRef = useRef(new Set(['root']));
  const selectionAnchorRef = useRef(initialRowSelection[initialRowSelection.length - 1] || null);
  const selectionOrderRef = useRef(initialRowSelection);

  const selectedDocumentIds = useMemo(
    () =>
      selectedRowKeys
        .filter(isDocumentRowKey)
        .map((key) => getRowId(key))
        .filter(Boolean),
    [selectedRowKeys],
  );

  const selectedFolderIds = useMemo(
    () =>
      selectedRowKeys
        .filter(isFolderRowKey)
        .map((key) => getRowId(key))
        .filter(Boolean),
    [selectedRowKeys],
  );

  const resetWorkspaceState = useCallback(() => {
    const rootNode = createRootNode();
    setFolderNodes(new Map([[rootNode.id, rootNode]]));
    setFolderContents(new Map());
    setSelectedFolder('root');
    setCurrentFolder(null);
    setCurrentSubfolders([]);
    setDocuments([]);
    setSelectedRowKeys([]);
    setSelectionOrder([]);
    selectionOrderRef.current = [];
    setFocusedDocumentId(null);
    selectionAnchorRef.current = null;
    setDraggedDocumentIds([]);
    setDraggedFolderId(null);
    setSearchResults(null);
    setTags([]);
    setCorrespondents([]);
    setSearchQuery('');
    setActiveTagFilters([]);
    setDropOverlayState({ active: false, folderName: DEFAULT_FOLDER_NAME });
    setActivePreviewId(null);
    assetManager.reset();
    setPreviewEntries(() => new Map());
    previewInflightRef.current = new Map();
    dragCounterRef.current = 0;
    prefetchedFoldersRef.current = new Set(['root']);
    breadcrumbFetchRef.current = new Set();
    bootstrapInitializedRef.current = false;
    selectionInitializedRef.current = false;
  }, [assetManager]);

  const tagLookupById = useMemo(() => {
    const map = new Map();
    tags.forEach((tag) => {
      if (tag?.id) {
        map.set(tag.id, tag);
      }
    });
    return map;
  }, [tags]);

  const correspondentLookupByName = useMemo(() => {
    const map = new Map();
    correspondents.forEach((correspondent) => {
      if (correspondent?.name) {
        map.set(correspondent.name.toLowerCase(), correspondent);
      }
    });
    return map;
  }, [correspondents]);

  const updateSelectionOrder = useCallback((nextSelection, interactedKeys = []) => {
    const nextSet = new Set(nextSelection);
    const previousOrder = selectionOrderRef.current.filter((id) => nextSet.has(id));
    const interacted = (interactedKeys || []).filter((id, index, array) => array.indexOf(id) === index);

    const base = previousOrder.filter((id) => !interacted.includes(id));
    const result = [...base];

    interacted.forEach((id) => {
      if (nextSet.has(id) && !result.includes(id)) {
        result.push(id);
      }
    });

    nextSelection.forEach((id) => {
      if (!result.includes(id)) {
        result.push(id);
      }
    });

    if (
      result.length !== selectionOrderRef.current.length ||
      result.some((id, index) => selectionOrderRef.current[index] !== id)
    ) {
      selectionOrderRef.current = result;
      setSelectionOrder(result);
    } else {
      selectionOrderRef.current = result;
    }
  }, []);

  useEffect(() => {
    if (appStatus === 'logged-out') {
      resetWorkspaceState();
    }
  }, [appStatus, resetWorkspaceState]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    const requestInterceptor = api.interceptors.request.use((config) => {
      const currentToken = tokenRef.current;
      if (currentToken) {
        config.headers = config.headers || {};
        if (!config.headers.Authorization) {
          config.headers.Authorization = `Bearer ${currentToken}`;
        }
      }
      return config;
    });

    const responseInterceptor = api.interceptors.response.use(
      (response) => response,
      async (error) => {
        const { response, config } = error;
        if (!response || !config) {
          return Promise.reject(error);
        }

        const status = response.status;
        const url = typeof config.url === 'string' ? config.url : '';
        const isAuthRoute = url.includes('/auth/login') || url.includes('/auth/refresh');

        if (status === 401 && !config._retry && !isAuthRoute) {
          console.warn('[Auth] 401 received for', url, '- attempting token refresh');

          if (!refreshPromiseRef.current) {
            refreshPromiseRef.current = (async () => {
              try {
                return await refreshAccessToken();
              } finally {
                refreshPromiseRef.current = null;
              }
            })();
          }

          try {
            const newToken = await refreshPromiseRef.current;
            if (!newToken) {
              throw new Error('No token returned from refresh');
            }
            config._retry = true;
            config.headers = config.headers || {};
            config.headers.Authorization = `Bearer ${newToken}`;
            console.log('[Auth] Retrying original request', url);
            try {
              return await api(config);
            } catch (retryError) {
              if (retryError?.response?.status === 401) {
                notifyApiError(retryError, 'Session expired. Please log in again.');
              }
              throw retryError;
            }
          } catch (refreshError) {
            console.warn('[Auth] Refresh failed, clearing session');
            notifyApiError(refreshError, 'Session expired. Please log in again.');
            return Promise.reject(refreshError);
          }
        }

        return Promise.reject(error);
      },
    );

    return () => {
      api.interceptors.request.eject(requestInterceptor);
      api.interceptors.response.eject(responseInterceptor);
    };
  }, [notifyApiError, refreshAccessToken]);

  useEffect(() => {
    if (!selectedDocumentIds.length) {
      return;
    }
    if (!selectedDocumentIds.includes(activePreviewId)) {
      setActivePreviewId(selectedDocumentIds[selectedDocumentIds.length - 1]);
    }
    selectionInitializedRef.current = true;
  }, [selectedDocumentIds, activePreviewId]);

  const currentFolderName = useMemo(() => {
    if (selectedFolder === 'root' || !currentFolder) return DEFAULT_FOLDER_NAME;
    return currentFolder.name;
  }, [selectedFolder, currentFolder]);

  const isFilterActive = useMemo(
    () =>
      searchQuery.trim().length > 0 ||
      activeTagFilters.length > 0 ||
      activeCorrespondentFilters.length > 0,
    [searchQuery, activeTagFilters, activeCorrespondentFilters],
  );

  const applySelectedFolder = useCallback(
    (folderId, contents) => {
      const subfolders = contents?.subfolders ?? [];
      const docs = assetManager.hydrateDocuments(contents?.documents ?? []);
      const folderInfo = contents?.folder ?? null;

      setCurrentSubfolders(subfolders);
      setDocuments(docs);
      setCurrentFolder(folderInfo);

      const availableDocKeys = docs
        .map((doc) => resolveDocumentRowKey(doc.id))
        .filter(Boolean);
      const availableDocKeySet = new Set(availableDocKeys);

      let nextDocKeys = [];
      let mergedSelection = [];

      setSelectedRowKeys((previous) => {
        const previousFolderKeys = previous.filter(isFolderRowKey);
        const previousDocKeys = previous.filter(isDocumentRowKey);

        if (selectionInitializedRef.current) {
          nextDocKeys = previousDocKeys.filter((key) => availableDocKeySet.has(key));
        } else {
          const filtered = previousDocKeys.filter((key) => availableDocKeySet.has(key));
          if (filtered.length) {
            nextDocKeys = filtered;
          } else if (availableDocKeys.length) {
            nextDocKeys = [availableDocKeys[0]];
          } else {
            nextDocKeys = [];
          }
        }

        mergedSelection = [...previousFolderKeys, ...nextDocKeys];
        return mergedSelection;
      });

      const nextFocus = (() => {
        const currentFocusedKey = resolveDocumentRowKey(focusedDocumentId);
        if (currentFocusedKey && availableDocKeySet.has(currentFocusedKey)) {
          return focusedDocumentId;
        }
        if (nextDocKeys.length) {
          const lastDocKey = nextDocKeys[nextDocKeys.length - 1];
          return getRowId(lastDocKey) || null;
        }
        return null;
      })();

      setFocusedDocumentId(nextFocus);
      selectionAnchorRef.current = nextDocKeys.length
        ? nextDocKeys[nextDocKeys.length - 1]
        : null;
      selectionOrderRef.current = mergedSelection;
      setSelectionOrder(mergedSelection);

      return nextFocus;
    },
    [assetManager, focusedDocumentId, setSelectionOrder],
  );

  const showingSearchResults = searchResults !== null;

  const visibleDocuments = useMemo(
    () => (showingSearchResults ? searchResults : documents),
    [showingSearchResults, searchResults, documents],
  );

  const visibleDocumentIds = useMemo(
    () => visibleDocuments.map((doc) => doc.id),
    [visibleDocuments],
  );

  const visibleDocumentKeys = useMemo(
    () => visibleDocumentIds.map((id) => resolveDocumentRowKey(id)).filter(Boolean),
    [visibleDocumentIds],
  );

  const visibleFolderKeys = useMemo(
    () =>
      showingSearchResults
        ? []
        : currentSubfolders
            .map((folder) => resolveFolderRowKey(folder.id))
            .filter(Boolean),
    [showingSearchResults, currentSubfolders],
  );

  const visibleRowKeys = useMemo(
    () => [...visibleFolderKeys, ...visibleDocumentKeys],
    [visibleFolderKeys, visibleDocumentKeys],
  );

  const visibleRowKeySet = useMemo(
    () => new Set(visibleRowKeys),
    [visibleRowKeys],
  );

  const documentLookup = useMemo(() => {
    const map = new Map();
    const push = (items) => {
      (items || []).forEach((doc) => {
        if (doc?.id) {
          map.set(doc.id, doc);
        }
      });
    };

    push(documents);
    if (Array.isArray(searchResults)) {
      push(searchResults);
    }
    return map;
  }, [documents, searchResults]);

  const mapDocumentCaches = useCallback(
    (mapper) => {
      if (typeof mapper !== 'function') {
        return;
      }

      const applyToList = (list) => {
        let changed = false;
        const next = list.map((doc) => {
          const updated = mapper(doc);
          if (updated === undefined || updated === doc) {
            return doc;
          }
          changed = true;
          return updated;
        });
        return changed ? next : list;
      };

      setDocuments((prev) => applyToList(prev));
      setSearchResults((prev) => {
        if (!Array.isArray(prev)) {
          return prev;
        }
        return applyToList(prev);
      });
      setFolderContents((prev) => {
        if (!prev.size) {
          return prev;
        }
        let changed = false;
        const next = new Map();
        prev.forEach((contents, key) => {
          const docs = Array.isArray(contents?.documents) ? contents.documents : null;
          if (!docs || docs.length === 0) {
            next.set(key, contents);
            return;
          }
          let docsChanged = false;
          const updatedDocs = docs.map((doc) => {
            const updated = mapper(doc);
            if (updated === undefined || updated === doc) {
              return doc;
            }
            docsChanged = true;
            return updated;
          });
          if (docsChanged) {
            changed = true;
            next.set(key, { ...contents, documents: updatedDocs });
          } else {
            next.set(key, contents);
          }
        });
        return changed ? next : prev;
      });
    },
    [setDocuments, setSearchResults, setFolderContents],
  );

  const updateDocumentCaches = useCallback(
    (documentId, updater) => {
      if (!documentId || typeof updater !== 'function') {
        return;
      }

      mapDocumentCaches((doc) => {
        if (!doc || doc.id !== documentId) {
          return doc;
        }
        const updated = updater(doc);
        return updated === undefined ? doc : updated;
      });
    },
    [mapDocumentCaches],
  );

  const removeDocumentFromCaches = useCallback(
    (documentId) => {
      if (!documentId) {
        return;
      }

      const removeFromList = (list) => {
        const next = list.filter((doc) => doc.id !== documentId);
        return next.length === list.length ? list : next;
      };

      setDocuments((prev) => removeFromList(prev));
      setSearchResults((prev) => (Array.isArray(prev) ? removeFromList(prev) : prev));
      setFolderContents((prev) => {
        if (!prev.size) {
          return prev;
        }
        let changed = false;
        const next = new Map();
        prev.forEach((contents, key) => {
          const docs = Array.isArray(contents?.documents) ? contents.documents : null;
          if (!docs || docs.length === 0) {
            next.set(key, contents);
            return;
          }
          const filteredDocs = docs.filter((doc) => doc.id !== documentId);
          if (filteredDocs.length !== docs.length) {
            changed = true;
            next.set(key, { ...contents, documents: filteredDocs });
          } else {
            next.set(key, contents);
          }
        });
        return changed ? next : prev;
      });
    },
    [setDocuments, setSearchResults, setFolderContents],
  );

  const applySelection = useCallback(
    (rowKeys, { anchor, interactedKeys = [] } = {}) => {
      const unique = [];

      (rowKeys || []).forEach((key) => {
        if (!key) return;
        const canonicalKey = visibleRowKeySet.has(key)
          ? key
          : isDocumentRowKey(key)
          ? resolveDocumentRowKey(getRowId(key))
          : isFolderRowKey(key)
          ? resolveFolderRowKey(getRowId(key))
          : null;

        if (!canonicalKey || !visibleRowKeySet.has(canonicalKey)) {
          return;
        }

        if (!unique.includes(canonicalKey)) {
          unique.push(canonicalKey);
        }
      });

      let resolvedAnchor = anchor;
      if (resolvedAnchor && !unique.includes(resolvedAnchor)) {
        resolvedAnchor = null;
      }

      setSelectedRowKeys(unique);
      updateSelectionOrder(unique, interactedKeys);

      const nextFocusedDocumentId = (() => {
        if (focusedDocumentId) {
          const focusKey = resolveDocumentRowKey(focusedDocumentId);
          if (focusKey && unique.includes(focusKey)) {
            return focusedDocumentId;
          }
        }

        if (resolvedAnchor && isDocumentRowKey(resolvedAnchor)) {
          return getRowId(resolvedAnchor) || null;
        }

        const lastDocKey = [...unique].reverse().find(isDocumentRowKey);
        return lastDocKey ? getRowId(lastDocKey) || null : null;
      })();

      setFocusedDocumentId(nextFocusedDocumentId);

      if (resolvedAnchor) {
        selectionAnchorRef.current = resolvedAnchor;
      } else if (!unique.length) {
        selectionAnchorRef.current = null;
      } else if (!selectionAnchorRef.current || !unique.includes(selectionAnchorRef.current)) {
        selectionAnchorRef.current = unique[unique.length - 1];
      }

      return { selection: unique, focusKey: selectionAnchorRef.current };
    },
    [visibleRowKeySet, focusedDocumentId, updateSelectionOrder],
  );

  const promoteSelectionOrder = useCallback(
    (docId) => {
      if (!docId) return;
      const rowKey = resolveDocumentRowKey(docId);
      if (!rowKey) return;
      if (!selectedRowKeys.includes(rowKey)) return;
      updateSelectionOrder(selectedRowKeys, [rowKey]);
      selectionAnchorRef.current = rowKey;
      setFocusedDocumentId(docId);
      setActivePreviewId(docId);
    },
    [selectedRowKeys, updateSelectionOrder],
  );

  const visibleSelectedCount = useMemo(
    () => selectedDocumentIds.filter((id) => visibleDocumentIds.includes(id)).length,
    [selectedDocumentIds, visibleDocumentIds],
  );

  const allDocumentsSelected =
    visibleDocumentIds.length > 0 &&
    visibleSelectedCount === visibleDocumentIds.length;
  const someDocumentsSelected =
    visibleSelectedCount > 0 && !allDocumentsSelected;

  const folderOptions = useMemo(() => {
    const cache = new Map();
    const computePath = (id) => {
      if (cache.has(id)) {
        return cache.get(id);
      }
      if (!id || id === 'root') {
        cache.set('root', DEFAULT_FOLDER_NAME);
        return DEFAULT_FOLDER_NAME;
      }
      const node = folderNodes.get(id);
      if (!node) {
        return 'Folder';
      }
      const parentId = node.parentId || 'root';
      const parentPath = computePath(parentId);
      const name = node.name || 'Folder';
      const fullPath = parentId === 'root' ? name : `${parentPath}/${name}`;
      cache.set(id, fullPath);
      return fullPath;
    };

    const entries = [];
    folderNodes.forEach((node, id) => {
      if (!node) return;
      entries.push({ id, label: computePath(id) });
    });

    entries.sort((a, b) => {
      if (a.id === 'root') return -1;
      if (b.id === 'root') return 1;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });

    return entries;
  }, [folderNodes]);

  const folderLabelMap = useMemo(() => {
    const map = new Map();
    folderOptions.forEach((option) => {
      map.set(option.id, option.label);
    });
    return map;
  }, [folderOptions]);

  const navigableRows = useMemo(() => {
    const entries = [];
    if (!showingSearchResults) {
      currentSubfolders.forEach((folder) => {
        const key = resolveFolderRowKey(folder.id);
        if (key) {
          entries.push({ key, type: 'folder', id: folder.id });
        }
      });
    }
    visibleDocuments.forEach((doc) => {
      const key = resolveDocumentRowKey(doc.id);
      if (key) {
        entries.push({ key, type: 'document', id: doc.id });
      }
    });
    return entries;
  }, [showingSearchResults, currentSubfolders, visibleDocuments]);

  const navigableRowKeys = useMemo(
    () => navigableRows.map((entry) => entry.key),
    [navigableRows],
  );

  const handleRowSelection = useCallback(
    (rowKey, event) => {
      if (!rowKey || !visibleRowKeySet.has(rowKey)) {
        return;
      }

      setFocusedRowKey(rowKey);

      const shiftKey = Boolean(event?.shiftKey);
      const metaKey = Boolean(event?.metaKey);
      const ctrlKey = Boolean(event?.ctrlKey);
      const additive = metaKey || ctrlKey;

      if (shiftKey) {
        event?.preventDefault?.();
      }

      let anchorKey = selectionAnchorRef.current;
      if (!anchorKey && shiftKey && selectedRowKeys.length) {
        anchorKey = selectedRowKeys[selectedRowKeys.length - 1];
      }
      if (!anchorKey) {
        anchorKey = rowKey;
      }

      let nextKeys = [];
      let interactedKeys = [];

      if (shiftKey && anchorKey) {
        const anchorIndex = navigableRowKeys.indexOf(anchorKey);
        const targetIndex = navigableRowKeys.indexOf(rowKey);
        if (anchorIndex !== -1 && targetIndex !== -1) {
          const [start, end] =
            anchorIndex <= targetIndex
              ? [anchorIndex, targetIndex]
              : [targetIndex, anchorIndex];
          const range = navigableRowKeys.slice(start, end + 1);
          nextKeys = range;

          const previousSet = new Set(selectedRowKeys);
          interactedKeys = range.filter(
            (key) => key === rowKey || !previousSet.has(key),
          );
          if (!interactedKeys.includes(rowKey)) {
            interactedKeys.push(rowKey);
          }
        } else {
          nextKeys = [rowKey];
          interactedKeys = [rowKey];
        }
      } else if (additive) {
        if (selectedRowKeys.includes(rowKey)) {
          nextKeys = selectedRowKeys.filter((key) => key !== rowKey);
          interactedKeys = [];
        } else {
          nextKeys = [...selectedRowKeys, rowKey];
          interactedKeys = [rowKey];
        }
        anchorKey = rowKey;
      } else {
        nextKeys = [rowKey];
        interactedKeys = [rowKey];
        anchorKey = rowKey;
      }

      applySelection(nextKeys, { anchor: anchorKey, interactedKeys });
    },
    [applySelection, navigableRowKeys, selectedRowKeys, setFocusedRowKey, visibleRowKeySet],
  );

  const handleDocumentRowClick = useCallback(
    (documentId, event) => {
      const rowKey = resolveDocumentRowKey(documentId);
      if (!rowKey) return;
      handleRowSelection(rowKey, event);
    },
    [handleRowSelection],
  );

  const clearDocumentSelection = useCallback(() => {
    setFocusedRowKey(null);
    applySelection([], { anchor: null, interactedKeys: [] });
  }, [applySelection]);

  const handleFolderRowClick = useCallback(
    (folderId, event) => {
      const rowKey = resolveFolderRowKey(folderId);
      if (!rowKey) return;
      handleRowSelection(rowKey, event);
    },
    [handleRowSelection],
  );

  const prevFocusedDocIdRef = useRef(focusedDocumentId);
  useEffect(() => {
    const previous = prevFocusedDocIdRef.current;
    if (previous === focusedDocumentId) {
      return;
    }
    prevFocusedDocIdRef.current = focusedDocumentId;
    if (focusedDocumentId) {
      setFocusedRowKey(resolveDocumentRowKey(focusedDocumentId));
    } else {
      setFocusedRowKey((current) => (isFolderRowKey(current) ? current : null));
    }
  }, [focusedDocumentId]);

  useEffect(() => {
    if (!focusedRowKey) {
      return;
    }
    if (navigableRowKeys.includes(focusedRowKey)) {
      return;
    }
    const docKey = focusedDocumentId ? resolveDocumentRowKey(focusedDocumentId) : null;
    if (docKey && navigableRowKeys.includes(docKey)) {
      setFocusedRowKey(docKey);
      return;
    }
    if (navigableRowKeys.length) {
      setFocusedRowKey(navigableRowKeys[0]);
    } else {
      setFocusedRowKey(null);
    }
  }, [focusedRowKey, navigableRowKeys, focusedDocumentId]);


  const ensureFolderData = useCallback(
    async (folderId, { force = false, includeDocuments = true } = {}) => {
      if (!force && folderContents.has(folderId)) {
        return folderContents.get(folderId);
      }

      const path = folderId === 'root' ? 'root' : folderId;
      const params = includeDocuments
        ? undefined
        : { include_documents: false };
      const { data } = await api.get(`/folders/${path}/contents`, {
        params,
      });
      const hydrated = assetManager.hydrateFolderContents(data);

      setFolderNodes((prev) => {
        const next = new Map(prev);
        const existingNode = next.get(folderId) || {
          id: folderId,
          name: folderId === 'root' ? DEFAULT_FOLDER_NAME : data.folder?.name || 'Folder',
          parentId: data.folder?.parent_id || 'root',
          children: [],
          expanded: folderId === 'root',
          loaded: false,
        };

        const childIds = (data.subfolders || []).map((child) => child.id);
        next.set(folderId, {
          ...existingNode,
          name: folderId === 'root' ? DEFAULT_FOLDER_NAME : data.folder?.name || existingNode.name,
          parentId: data.folder?.parent_id ?? existingNode.parentId ?? 'root',
          children: childIds,
          expanded: folderId === 'root' ? true : existingNode.expanded,
          loaded: true,
        });

        (data.subfolders || []).forEach((child) => {
          const childNode = next.get(child.id);
          next.set(child.id, {
            id: child.id,
            name: child.name,
            parentId: child.parent_id ?? 'root',
            children: childNode?.children ?? [],
            expanded: childNode?.expanded ?? false,
            loaded: childNode?.loaded ?? false,
          });
        });

        return next;
      });

      setFolderContents((prev) => {
        const next = new Map(prev);
        next.set(folderId, hydrated);
        return next;
      });

      return hydrated;
    },
    [assetManager, folderContents],
  );
  const greedyPrefetchFolders = useCallback(
    async (startIds) => {
      const queue = Array.isArray(startIds) ? [...startIds] : [];
      const visited = prefetchedFoldersRef.current;

      while (queue.length) {
        const nextId = queue.shift();
        if (!nextId || visited.has(nextId)) {
          continue;
        }
        visited.add(nextId);

        try {
          const contents = await ensureFolderData(nextId, {
            force: false,
            includeDocuments: false,
          });
          const subfolders = Array.isArray(contents?.subfolders) ? contents.subfolders : [];
          subfolders.forEach((entry) => {
            if (entry?.id && !visited.has(entry.id)) {
              queue.push(entry.id);
            }
          });
        } catch (error) {
          console.warn('[Folders] Failed to prefetch folder tree for', nextId, error);
        }
      }
    },
    [ensureFolderData],
  );

  const isInvalidFolderDrop = useCallback(
    (sourceId, targetId) => {
      if (!sourceId) return false;
      if (!targetId || targetId === 'root') {
        return false;
      }
      if (sourceId === targetId) {
        return true;
      }

      let current = targetId;
      const visited = new Set();
      while (current && current !== 'root' && !visited.has(current)) {
        visited.add(current);
        if (current === sourceId) {
          return true;
        }
        const node = folderNodes.get(current);
        if (!node) break;
        current = node.parentId ?? 'root';
      }
      return false;
    },
    [folderNodes],
  );

  const moveFolder = useCallback(
    async (folderId, targetFolderId) => {
      const node = folderNodes.get(folderId);
      if (!node) {
        setStatusMessage('Folder metadata unavailable. Try refreshing.', 'error');
        return;
      }

      const previousParentKey = node.parentId ?? 'root';
      const targetKey = targetFolderId && targetFolderId !== 'root' ? targetFolderId : 'root';

      if (previousParentKey === targetKey) {
        return;
      }

      const parent_id = targetKey === 'root' ? null : targetKey;

      try {
        await api.patch(`/folders/${folderId}`, { parent_id });

        setFolderNodes((prev) => {
          const next = new Map(prev);
          const currentNode = next.get(folderId);
          if (!currentNode) {
            return prev;
          }

          const updatedNode = { ...currentNode, parentId: parent_id ?? null };
          next.set(folderId, updatedNode);

          const previousParent = next.get(previousParentKey);
          if (previousParent) {
            next.set(previousParentKey, {
              ...previousParent,
              children: (previousParent.children || []).filter((childId) => childId !== folderId),
            });
          }

          if (!next.has(targetKey)) {
            next.set(targetKey, {
              id: targetKey,
              name: targetKey === 'root' ? DEFAULT_FOLDER_NAME : 'Folder',
              parentId: targetKey === 'root' ? null : null,
              children: [],
              expanded: targetKey === 'root',
              loaded: false,
            });
          }

          const targetNode = next.get(targetKey);
          if (targetNode && !targetNode.children.includes(folderId)) {
            next.set(targetKey, {
              ...targetNode,
              children: [...targetNode.children, folderId],
            });
          }

          return next;
        });

        const refreshTargets = new Set([previousParentKey, targetKey]);
        for (const key of refreshTargets) {
          if (key === 'root') {
            await ensureFolderData('root', { force: true });
          } else {
            await ensureFolderData(key, { force: true });
          }
        }

        if (selectedFolder === folderId) {
          await ensureFolderData(folderId, { force: true });
          setSelectedFolder(folderId);
        }

        setStatusMessage('Folder moved.', 'success');
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to move folder.';
        notifyApiError(error, message);

        const refreshTargets = new Set([previousParentKey, targetKey]);
        for (const key of refreshTargets) {
          if (key === 'root') {
            await ensureFolderData('root', { force: true });
          } else {
            await ensureFolderData(key, { force: true });
          }
        }
      }
    },
    [api, folderNodes, ensureFolderData, selectedFolder, setSelectedFolder, setFolderNodes, notifyApiError],
  );

  const refreshTags = useCallback(async () => {
    try {
      const { data } = await api.get('/tags');
      setTags(data || []);
    } catch (error) {
      notifyApiError(error, 'Unable to load tags.');
    }
  }, [api, notifyApiError]);

  const refreshCorrespondents = useCallback(async () => {
    try {
      const { data } = await api.get('/correspondents');
      setCorrespondents(data || []);
    } catch (error) {
      notifyApiError(error, 'Unable to load correspondents.');
    }
  }, [api, notifyApiError]);

  const handleTagUpdate = useCallback(
    async (tagId, changes) => {
      if (!tagId) {
        throw new Error('Missing tag identifier.');
      }

      const payload = {};
      if (typeof changes.label === 'string') {
        payload.label = changes.label;
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'color')) {
        payload.color = changes.color;
      }

      if (Object.keys(payload).length === 0) {
        return false;
      }

      try {
        await api.patch(`/tags/${tagId}`, payload);
        await refreshTags();
        setStatusMessage('Tag updated.', 'success');
        return true;
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to update tag.';
        notifyApiError(error, message);
        throw new Error(message);
      }
    },
    [api, refreshTags, notifyApiError, setStatusMessage],
  );

  const handleTagCreate = useCallback(
    async ({ label, color } = {}) => {
      const payload = tagManager.buildPayload({ label, color });
      try {
        await api.post('/tags', payload);
        await refreshTags();
        setStatusMessage('Tag created.', 'success');
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to create tag.';
        notifyApiError(error, message);
        throw new Error(message);
      }
    },
    [api, refreshTags, notifyApiError, setStatusMessage, tagManager],
  );

  const handleCorrespondentUpdate = useCallback(
    async (correspondentId, changes) => {
      if (!correspondentId) {
        throw new Error('Missing correspondent identifier.');
      }

      const payload = {};
      if (typeof changes.name === 'string') {
        const trimmed = changes.name.trim();
        if (!trimmed) {
          throw new Error('Correspondent name cannot be empty.');
        }
        payload.name = trimmed;
      }

      if (Object.keys(payload).length === 0) {
        return false;
      }

      try {
        await api.patch(`/correspondents/${correspondentId}`, payload);
        await refreshCorrespondents();
        setStatusMessage('Correspondent updated.', 'success');
        return true;
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to update correspondent.';
        notifyApiError(error, message);
        throw new Error(message);
      }
    },
    [api, refreshCorrespondents, notifyApiError, setStatusMessage],
  );

  const handleCorrespondentCreate = useCallback(
    async ({ name }) => {
      const trimmed = (name || '').trim();
      if (!trimmed) {
        throw new Error('Correspondent name is required.');
      }
      try {
        const { data } = await api.post('/correspondents', { name: trimmed });
        await refreshCorrespondents();
        setStatusMessage('Correspondent created.', 'success');
        return data;
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to create correspondent.';
        notifyApiError(error, message);
        throw new Error(message);
      }
    },
    [api, refreshCorrespondents, notifyApiError, setStatusMessage],
  );

  const handleCorrespondentDelete = useCallback(
    async (correspondentId) => {
      if (!correspondentId) {
        throw new Error('Missing correspondent identifier.');
      }

      const stripFromDoc = (doc) => {
        if (!doc || !Array.isArray(doc.correspondents)) {
          return doc;
        }
        const next = doc.correspondents.filter((entry) => entry.id !== correspondentId);
        if (next.length === doc.correspondents.length) {
          return doc;
        }
        return { ...doc, correspondents: next };
      };

      try {
        await api.delete(`/correspondents/${correspondentId}`);
        await refreshCorrespondents();

        mapDocumentCaches(stripFromDoc);

        setStatusMessage('Correspondent deleted.', 'success');
        return true;
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to delete correspondent.';
        notifyApiError(error, message);
        throw new Error(message);
      }
    },
    [api, refreshCorrespondents, notifyApiError, setStatusMessage, mapDocumentCaches],
  );

  async function handleDocumentCorrespondentAttach(
    { documentId, correspondentId, role },
    { notify = true, refresh = true } = {},
  ) {
    if (!documentId || !correspondentId || !role) {
      throw new Error('Missing document, correspondent or role.');
    }
    try {
      await api.post(`/documents/${documentId}/correspondents`, {
        assignments: [{ correspondent_id: correspondentId, role }],
        replace: false,
      });
      if (refresh) {
        await refreshCurrentFolder();
      }
      if (notify) {
        setStatusMessage('Correspondent assigned.', 'success');
      }
      return true;
    } catch (error) {
      const message = error.response?.data?.error || 'Failed to assign correspondent.';
      notifyApiError(error, message);
      throw new Error(message);
    }
  }

  async function handleCorrespondentRemove(
    { documentId, correspondentId, role },
    { notify = true, refresh = true } = {},
  ) {
    if (!documentId || !correspondentId || !role) {
      throw new Error('Missing document, correspondent or role.');
    }
    try {
      await api.delete(`/documents/${documentId}/correspondents/${correspondentId}`, {
        params: { role },
      });
      if (refresh) {
        await refreshCurrentFolder();
      }
      if (notify) {
        setStatusMessage('Correspondent removed.', 'success');
      }
      return true;
    } catch (error) {
      const message = error.response?.data?.error || 'Failed to remove correspondent.';
      notifyApiError(error, message);
      throw new Error(message);
    }
  }

  const handleCorrespondentAdd = useCallback(
    async ({ document, name, role, input }) => {
      if (!document?.id) {
        throw new Error('Missing document for correspondent assignment.');
      }
      const trimmed = (name || '').trim();
      if (!trimmed) {
        setStatusMessage('Correspondent name is required.', 'error');
        return;
      }
      const normalizedRole = (role || '').trim().toLowerCase();
      if (!CORRESPONDENT_ROLES.includes(normalizedRole)) {
        setStatusMessage('Select a valid correspondent role.', 'error');
        return;
      }

      let target = correspondentLookupByName.get(trimmed.toLowerCase()) || null;
      if (!target) {
        try {
          target = await handleCorrespondentCreate({ name: trimmed });
        } catch (error) {
          return;
        }
      }

      if (!target?.id) {
        setStatusMessage('Unable to resolve correspondent.', 'error');
        return;
      }

      try {
        await handleDocumentCorrespondentAttach({
          documentId: document.id,
          correspondentId: target.id,
          role: normalizedRole,
        });
        if (input) {
          input.value = '';
        }
      } catch (
        // eslint-disable-next-line no-empty
        error
      ) {}
    },
    [
      handleCorrespondentCreate,
      handleDocumentCorrespondentAttach,
      correspondentLookupByName,
      setStatusMessage,
    ],
  );

  const handleTagDelete = useCallback(
    async (tagId) => {
      if (!tagId) {
        throw new Error('Missing tag identifier.');
      }

      try {
        await api.delete(`/tags/${tagId}`);
        setActiveTagFilters((prev) => prev.filter((id) => id !== tagId));

        const stripTagFromDoc = (doc) => {
          if (!doc || !Array.isArray(doc.tags)) {
            return doc;
          }
          const nextTags = doc.tags.filter((tag) => tag.id !== tagId);
          if (nextTags.length === doc.tags.length) {
            return doc;
          }
          return { ...doc, tags: nextTags };
        };

        mapDocumentCaches(stripTagFromDoc);

        await refreshTags();
        setStatusMessage('Tag deleted.', 'success');
        return true;
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to delete tag.';
        notifyApiError(error, message);
        throw new Error(message);
      }
    },
    [
      api,
      refreshTags,
      notifyApiError,
      setStatusMessage,
      mapDocumentCaches,
      setActiveTagFilters,
    ],
  );

  const loadFolder = useCallback(
    async (folderId, { showLoading = true, preserveSearch = false } = {}) => {
      const targetId = folderId || 'root';
      setSelectedFolder(targetId);
      if (showLoading) setLoading(true);
      try {
        const contents = await ensureFolderData(targetId, { force: true });
        if (targetId !== 'root') {
          try {
            await ensureFolderData('root', { force: false });
          } catch (error) {
            console.warn('Failed to refresh root folder tree', error);
          }
        }
        applySelectedFolder(targetId, contents);
        if (!preserveSearch) {
          setSearchResults(null);
        }
      } catch (error) {
        notifyApiError(error, 'Failed to load folder contents.');
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [ensureFolderData, applySelectedFolder, notifyApiError],
  );

  useEffect(() => {
    if (!folderContents || typeof folderContents.forEach !== 'function') {
      return;
    }

    const pendingIds = [];
    folderContents.forEach((contents) => {
      const subfolders = Array.isArray(contents?.subfolders) ? contents.subfolders : [];
      subfolders.forEach((entry) => {
        if (entry?.id && !prefetchedFoldersRef.current.has(entry.id)) {
          pendingIds.push(entry.id);
        }
      });
    });

    if (!pendingIds.length) {
      return;
    }

    greedyPrefetchFolders(pendingIds).catch(() => {});
  }, [folderContents, greedyPrefetchFolders]);

  const selectFolder = useCallback(
    async (folderId, { replace = false, immediate = false } = {}) => {
      const targetId = folderId && folderId !== 'root' ? folderId : 'root';

      if (!navigate || immediate) {
        await loadFolder(targetId, { preserveSearch: isFilterActive });
        return;
      }

      const path = targetId === 'root' ? '/documents' : `/documents/folder/${targetId}`;
      navigate(path, { replace });
    },
    [loadFolder, navigate, isFilterActive],
  );

  const initializeAfterLogin = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([refreshTags(), refreshCorrespondents()]);
      const initialFolder = routeFolderId && routeFolderId !== 'root' ? routeFolderId : 'root';
      await loadFolder(initialFolder, { showLoading: false });
    } catch (error) {
      notifyApiError(error, 'Failed to initialize data.');
      throw error;
    } finally {
      setLoading(false);
    }
  }, [refreshTags, refreshCorrespondents, routeFolderId, loadFolder, notifyApiError]);

  useEffect(() => {
    if (!token) {
      return;
    }
    if (appStatus !== 'ready' && appStatus !== 'bootstrapping') {
      return;
    }

    const targetParam = routeFolderId ?? 'root';

    if (targetParam === 'root' && routeDocumentId) {
      return;
    }

    const hasData = folderContents.has(targetParam);
    if (targetParam !== selectedFolder || !hasData) {
      loadFolder(targetParam, {
        showLoading: !routeDocumentId,
        preserveSearch: isFilterActive,
      });
    }
  }, [
    token,
    appStatus,
    routeFolderId,
    routeDocumentId,
    selectedFolder,
    loadFolder,
    folderContents,
    isFilterActive,
  ]);

  const refreshCurrentFolder = useCallback(async () => {
    setLoading(true);
    try {
      const contents = await ensureFolderData(selectedFolder, { force: true });
      applySelectedFolder(selectedFolder, contents);
    } catch (error) {
      notifyApiError(error, 'Failed to refresh folder.');
    } finally {
      setLoading(false);
    }
  }, [selectedFolder, ensureFolderData, applySelectedFolder, notifyApiError]);

  const handleBulkCorrespondentAdd = useCallback(
    async ({ name, role, input }) => {
      const trimmed = (name || '').trim();
      if (!trimmed) {
        setStatusMessage('Correspondent name is required.', 'error');
        return;
      }
      if (!selectedDocumentIds.length) {
        setStatusMessage('Select documents before assigning correspondents.', 'error');
        return;
      }
      const normalizedRole = (role || '').trim().toLowerCase();
      if (!CORRESPONDENT_ROLES.includes(normalizedRole)) {
        setStatusMessage('Select a valid correspondent role.', 'error');
        return;
      }

      let target = correspondentLookupByName.get(trimmed.toLowerCase()) || null;
      if (!target) {
        try {
          target = await handleCorrespondentCreate({ name: trimmed });
        } catch (error) {
          return;
        }
      }

      if (!target?.id) {
        setStatusMessage('Unable to resolve correspondent.', 'error');
        return;
      }

      const response = await api.post('/documents/bulk/correspondents', {
        document_ids: selectedDocumentIds,
        assignments: [
          {
            correspondent_id: target.id,
            role: normalizedRole,
          },
        ],
        action: 'add',
      });

      const { assigned = 0, removed = 0 } = response.data || {};

      await refreshCurrentFolder();
      const assignedSuffix = assigned === 1 ? '' : 's';
      if (removed > 0) {
        const removedSuffix = removed === 1 ? '' : 's';
        setStatusMessage(
          `Correspondent assigned (${assigned}) and replaced ${removed} link${removedSuffix}.`,
          'success',
        );
      } else {
        setStatusMessage(
          `Correspondent assigned to ${assigned} document${assignedSuffix}.`,
          'success',
        );
      }

      if (input) {
        input.value = '';
      }
    },
    [
      correspondentLookupByName,
      handleCorrespondentCreate,
      api,
      refreshCurrentFolder,
      selectedDocumentIds,
      setStatusMessage,
    ],
  );

  const handleBulkCorrespondentRemove = useCallback(
    async ({ assignments = [], documentIds }) => {
      if (!assignments.length) {
        setStatusMessage('Select a correspondent to remove.', 'error');
        return;
      }

      const targets = Array.isArray(documentIds) && documentIds.length
        ? documentIds
        : selectedDocumentIds;

      if (!targets.length) {
        setStatusMessage('Select documents before removing correspondents.', 'error');
        return;
      }

      const normalizedAssignments = assignments.map((entry) => ({
        correspondent_id: entry.correspondent_id,
        role: (entry.role || '').toLowerCase(),
      }));

      const response = await api.post('/documents/bulk/correspondents', {
        document_ids: targets,
        assignments: normalizedAssignments,
        action: 'remove',
      });

      const { assigned = 0, removed = 0 } = response.data || {};
      await refreshCurrentFolder();

      if (removed > 0) {
        const removedSuffix = removed === 1 ? '' : 's';
        setStatusMessage(
          `Correspondent removed from ${removed} link${removedSuffix}.`,
          'success',
        );
      } else if (assigned > 0) {
        const assignedSuffix = assigned === 1 ? '' : 's';
        setStatusMessage(`Correspondent updated ${assigned} link${assignedSuffix}.`, 'info');
      } else {
        setStatusMessage('No correspondents changed.', 'info');
      }
    },
    [api, refreshCurrentFolder, selectedDocumentIds, setStatusMessage],
  );

  useEffect(() => {
    if (appStatus !== 'authenticated') {
      return;
    }
    if (bootstrapInitializedRef.current) {
      return;
    }

    let cancelled = false;
    const bootstrap = async () => {
      bootstrapInitializedRef.current = true;
      appDispatch({ type: 'BOOTSTRAP_START' });
      try {
        await initializeAfterLogin();
        if (!cancelled) {
          appDispatch({ type: 'BOOTSTRAP_SUCCESS' });
        }
      } catch (error) {
        if (!cancelled) {
          appDispatch({
            type: 'BOOTSTRAP_FAILURE',
            error: error?.message || 'Failed to initialize data.',
          });
          bootstrapInitializedRef.current = false;
        }
      }
    };

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, [appStatus, appDispatch, initializeAfterLogin]);

  const handleBulkMoveSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (!selectedDocumentIds.length) {
        setStatusMessage('Select documents before moving.', 'error');
        return;
      }

      const form = new FormData(event.currentTarget);
      const target = form.get('target')?.toString() || 'root';
      const folderId = target === 'root' ? null : target;

      setLoading(true);
      try {
        await api.post('/documents/bulk/move', {
          document_ids: selectedDocumentIds,
          folder_id: folderId,
        });

        const count = selectedDocumentIds.length;
        const suffix = count === 1 ? '' : 's';
        const folderLabel =
          folderId === null
            ? DEFAULT_FOLDER_NAME
            : folderLabelMap.get(target) || 'target folder';
        setStatusMessage(
          `Moved ${count} document${suffix} to ${folderLabel}.`,
          'success',
        );

        applySelection([], { anchor: null });

        await refreshCurrentFolder();
      if (folderId && folderId !== selectedFolder) {
        await ensureFolderData(folderId, { force: true });
      }

      event.currentTarget.reset();
    } catch (error) {
      const message = error.response?.data?.error || 'Failed to move documents.';
      notifyApiError(error, message);
    } finally {
      setLoading(false);
    }
  },
  [
    api,
    selectedDocumentIds,
    folderLabelMap,
    applySelection,
    refreshCurrentFolder,
    ensureFolderData,
    notifyApiError,
    selectedFolder,
    setStatusMessage,
  ],
  );

  const parseTagInput = useCallback((value) => {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }, []);

  const bulkTagOperation = useCallback(
    async ({ labels, action }) => {
      const normalized = labels.map((label) => label.trim()).filter((label) => label.length > 0);
      if (!normalized.length) {
        return { ok: false, reason: 'no-labels' };
      }
      if (!selectedDocumentIds.length) {
        return { ok: false, reason: 'no-selection' };
      }

      let tagIds = [];

      if (action === 'remove') {
        const missing = normalized.find(
          (label) => !tags.some((tag) => tag.label.toLowerCase() === label.toLowerCase()),
        );
        if (missing) {
          return { ok: false, reason: 'tag-missing', label: missing };
        }

        tagIds = normalized.map((label) => {
          const tag = tags.find((item) => item.label.toLowerCase() === label.toLowerCase());
          return tag?.id;
        }).filter(Boolean);
      }

      setLoading(true);
      try {
        if (action === 'add') {
          const createdIds = [];
          for (const label of normalized) {
            let tag = tags.find((item) => item.label.toLowerCase() === label.toLowerCase()) || null;
            if (!tag) {
              const payload = tagManager.buildPayload({ label });
              const { data } = await api.post('/tags', payload);
              tag = data;
              await refreshTags();
            }
            createdIds.push(tag.id);
          }
          tagIds = Array.from(new Set(createdIds));
        }

        tagIds = Array.from(new Set(tagIds));

        if (!tagIds.length) {
          return { ok: false, reason: 'no-tags' };
        }

        await api.post('/documents/bulk/tags', {
          document_ids: selectedDocumentIds,
          tag_ids: tagIds,
          action,
        });

        await refreshCurrentFolder();

        return {
          ok: true,
          tagCount: tagIds.length,
          docsCount: selectedDocumentIds.length,
        };
      } catch (error) {
        const message =
          error.response?.data?.error ||
          (action === 'add' ? 'Failed to assign tags.' : 'Failed to remove tags.');
        notifyApiError(error, message);
        return { ok: false, reason: 'request-failed' };
      } finally {
        setLoading(false);
      }
    },
    [
      selectedDocumentIds,
      tags,
      api,
      refreshTags,
      refreshCurrentFolder,
      notifyApiError,
      setLoading,
      tagManager,
    ],
  );

  const handleBulkTagAdd = useCallback(
    async (event) => {
      event.preventDefault();
      if (!selectedDocumentIds.length) {
        setStatusMessage('Select documents before assigning tags.', 'error');
        return;
      }

      const form = new FormData(event.currentTarget);
      const raw = form.get('tags')?.toString().trim() || '';
      const labels = parseTagInput(raw);
      if (!labels.length) {
        setStatusMessage('Enter at least one tag label.', 'error');
        return;
      }
      const result = await bulkTagOperation({ labels, action: 'add' });
      if (result?.ok) {
        const { tagCount, docsCount } = result;
        setStatusMessage(
          `Assigned ${tagCount} tag${tagCount === 1 ? '' : 's'} to ${docsCount} document${
            docsCount === 1 ? '' : 's'
          }.`,
          'success',
        );
        event.currentTarget.reset();
      } else if (result?.reason === 'no-labels') {
        setStatusMessage('Enter at least one tag label.', 'error');
      }
    },
    [
      selectedDocumentIds,
      setStatusMessage,
      parseTagInput,
      bulkTagOperation,
    ],
  );

  const handleBulkTagRemove = useCallback(
    async (event) => {
      event.preventDefault();
      if (!selectedDocumentIds.length) {
        setStatusMessage('Select documents before removing tags.', 'error');
        return;
      }

      const form = new FormData(event.currentTarget);
      const raw = form.get('tags')?.toString().trim() || '';
      const labels = parseTagInput(raw);
      if (!labels.length) {
        setStatusMessage('Enter at least one tag label to remove.', 'error');
        return;
      }

      const result = await bulkTagOperation({ labels, action: 'remove' });
      if (result?.ok) {
        const { docsCount } = result;
        setStatusMessage(
          `Removed tags from ${docsCount} document${docsCount === 1 ? '' : 's'}.`,
          'success',
        );
        event.currentTarget.reset();
      } else if (result?.reason === 'no-labels') {
        setStatusMessage('Enter at least one tag label to remove.', 'error');
      } else if (result?.reason === 'tag-missing') {
        setStatusMessage(`Tag “${result.label}” not found.`, 'error');
      }
    },
    [
      selectedDocumentIds,
      setStatusMessage,
      parseTagInput,
      bulkTagOperation,
    ],
  );

  const handleBulkTagAddFromDetail = useCallback(
    async ({ label, input }) => {
      const trimmed = (label || '').trim();
      if (!trimmed) {
        setStatusMessage('Enter a tag label.', 'error');
        return;
      }
      if (!selectedDocumentIds.length) {
        setStatusMessage('Select documents before assigning tags.', 'error');
        return;
      }
      const result = await bulkTagOperation({ labels: [trimmed], action: 'add' });
      if (result?.ok) {
        const { tagCount, docsCount } = result;
        setStatusMessage(
          `Assigned ${tagCount} tag${tagCount === 1 ? '' : 's'} to ${docsCount} document${
            docsCount === 1 ? '' : 's'
          }.`,
          'success',
        );
        if (input) {
          input.value = '';
        }
      }
    },
    [bulkTagOperation, selectedDocumentIds, setStatusMessage],
  );

  const handleBulkTagRemoveFromDetail = useCallback(
    async ({ label, input }) => {
      const trimmed = (label || '').trim();
      if (!trimmed) {
        setStatusMessage('Enter a tag label to remove.', 'error');
        return;
      }
      if (!selectedDocumentIds.length) {
        setStatusMessage('Select documents before removing tags.', 'error');
        return;
      }
      const result = await bulkTagOperation({ labels: [trimmed], action: 'remove' });
      if (result?.ok) {
        const { docsCount } = result;
        setStatusMessage(
          `Removed tags from ${docsCount} document${docsCount === 1 ? '' : 's'}.`,
          'success',
        );
        if (input) {
          input.value = '';
        }
      } else if (result?.reason === 'tag-missing') {
        setStatusMessage(`Tag “${result.label}” not found.`, 'error');
      }
    },
    [bulkTagOperation, selectedDocumentIds, setStatusMessage],
  );

  const handleBulkSelectionReanalyze = useCallback(async () => {
    if (!selectedDocumentIds.length) {
      setStatusMessage('Select documents before requesting re-analysis.', 'error');
      return;
    }

    setLoading(true);
    try {
      const { data } = await api.post('/documents/bulk/reanalyze', {
        document_ids: selectedDocumentIds,
        force: true,
      });
      const queued = data?.queued ?? selectedDocumentIds.length;
      setStatusMessage(
        `Queued re-analysis for ${queued} document${queued === 1 ? '' : 's'}.`,
        'success',
      );
    } catch (error) {
      const message =
        error.response?.data?.error || 'Failed to queue document re-analysis.';
      notifyApiError(error, message);
    } finally {
      setLoading(false);
    }
  }, [selectedDocumentIds, api, notifyApiError, setStatusMessage]);

  const uploadFile = useCallback(
    async (file, targetFolderId) => {
      if (!file || file.size === 0) {
        setStatusMessage('Skipped empty file.', 'error');
        return null;
      }

      const formData = new FormData();
      formData.append('file', file, file.name);
      if (targetFolderId && targetFolderId !== 'root') {
        formData.append('folder_id', targetFolderId);
      }

      try {
        const { data, status } = await api.post('/documents', formData);
        const duplicate = data?.reused || status === 200;
        setStatusMessage(
          duplicate
            ? `${file.name} already exists; reused existing document.`
            : `Uploaded ${file.name}`,
          duplicate ? 'info' : 'success',
        );
        return data;
      } catch (error) {
        const message = error.response?.data?.error || `Failed to upload ${file.name}.`;
        notifyApiError(error, message);
        throw error;
      }
    },
    [notifyApiError, setStatusMessage],
  );

  const folderPathCacheRef = useRef(new Map());
  const [previewEntries, setPreviewEntries] = useState(() => new Map());
  const previewInflightRef = useRef(new Map());

  const ensureFolderPathOnServer = useCallback(
    async (baseFolderId, segments) => {
      const trimmedSegments = segments.map((segment) => segment.trim()).filter(Boolean);
      if (trimmedSegments.length === 0) {
        return baseFolderId ?? null;
      }

      const cacheKey = `${baseFolderId ?? 'ROOT'}:${trimmedSegments.join('/')}`;
      const cache = folderPathCacheRef.current;
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
      }

      const payload = {
        parent_id: baseFolderId && baseFolderId !== 'root' ? baseFolderId : null,
        segments: trimmedSegments,
      };

      const { data } = await api.post('/folders/path', payload);
      const folderId = data.folder.id;
      cache.set(cacheKey, folderId);
      return folderId;
    },
    [],
  );

  const ensureAssetUrl = useCallback(
    async (documentId, asset, { force = false, start = null, limit = null } = {}) => {
      if (!documentId || !asset?.id) {
        return null;
      }

      try {
        const entry = await assetManager.ensureAsset(documentId, asset, {
          force,
          start,
          limit,
        });

        if (!entry) {
          return null;
        }

        setDocuments((prev) =>
          prev.map((doc) => (doc.id === documentId ? mergeAssetIntoDocument(doc, entry) : doc)),
        );

        setSearchResults((prev) =>
          Array.isArray(prev)
            ? prev.map((doc) => (doc.id === documentId ? mergeAssetIntoDocument(doc, entry) : doc))
            : prev,
        );

        return entry;
      } catch (error) {
        notifyApiError(error, 'Unable to refresh document asset.');
        throw error;
      }
    },
    [
      assetManager,
      setDocuments,
      setSearchResults,
      notifyApiError,
    ],
  );

  const dragPreviewRef = useRef(null);

  const destroyDragPreview = useCallback(() => {
    const node = dragPreviewRef.current;
    if (node && node.parentNode) {
      node.parentNode.removeChild(node);
    }
    dragPreviewRef.current = null;
  }, []);

  useEffect(() => destroyDragPreview, [destroyDragPreview]);

  const createDragPreview = useCallback(
    ({ documents = [], folders = [] } = {}) => {
      destroyDragPreview();

      const docEntries = (documents || []).filter(Boolean);
      const folderEntries = (folders || []).filter(Boolean);
      const totalCount = docEntries.length + folderEntries.length;
      if (!totalCount) {
        return null;
      }

      const maxVisible = 4;
      const size = 64;
      const canvasSize = Math.round(size * 1.6);

      const visibleItems = [];
      docEntries.slice(0, maxVisible).forEach((doc) => {
        visibleItems.push({ type: 'document', payload: doc });
      });

      if (visibleItems.length < maxVisible) {
        folderEntries
          .slice(0, maxVisible - visibleItems.length)
          .forEach((folderId) => visibleItems.push({ type: 'folder', payload: folderId }));
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'document-drag-preview';
      wrapper.style.setProperty('--drag-preview-size', `${canvasSize}px`);

      visibleItems.forEach((item, index) => {
        const layer = document.createElement('div');
        layer.className = 'document-drag-preview__thumb';
        const rotationMagnitude = Math.random() * 8 + 2; // 2..10 degrees
        const rotation = (index % 2 === 0 ? 1 : -1) * rotationMagnitude;
        layer.style.setProperty('--rotation-deg', `${rotation}deg`);

        if (item.type === 'document') {
          const doc = item.payload;
          const rowEl = doc?.id
            ? document.getElementById(`document-row-${doc.id}`) ||
              document.getElementById(`document-card-${doc.id}`)
            : null;
          const thumbnailEl = rowEl?.querySelector('.document-thumbnail');
          const placeholderEl = rowEl?.querySelector('.thumb-placeholder');

          let content = null;
          if (thumbnailEl instanceof HTMLImageElement) {
            content = thumbnailEl.cloneNode(true);
            content.draggable = false;
            content.style.pointerEvents = 'none';
          } else if (placeholderEl instanceof HTMLElement) {
            content = placeholderEl.cloneNode(true);
            content.style.pointerEvents = 'none';
          }

          if (content) {
            layer.appendChild(content);
          } else {
            layer.textContent = 'DOC';
          }
        } else {
          const folderId = item.payload;
          const rowEl = folderId ? document.getElementById(`folder-row-${folderId}`) : null;
          const iconEl = rowEl?.querySelector('.thumb-icon');

          let content = null;
          if (iconEl instanceof HTMLElement) {
            content = iconEl.cloneNode(true);
            content.classList.add('document-drag-preview__folder-thumb');
            const svg = content.querySelector('svg');
            if (svg) {
              svg.setAttribute('width', '48');
              svg.setAttribute('height', '48');
            }
          }

          if (!content) {
            content = document.createElement('div');
            content.className = 'document-drag-preview__folder-placeholder';
            content.textContent = 'Folder';
          }

          layer.appendChild(content);
        }

        wrapper.appendChild(layer);
      });

      if (totalCount > 1) {
        const badge = document.createElement('div');
        badge.className = 'document-drag-preview__count';
        badge.textContent =
          totalCount > maxVisible ? `+${totalCount - maxVisible}` : `${totalCount}`;
        wrapper.appendChild(badge);
      }

      document.body.appendChild(wrapper);
      dragPreviewRef.current = wrapper;
      return wrapper;
    },
    [destroyDragPreview],
  );

  const handleDocumentDragStart = useCallback(
    (event, documentOrId) => {
      const documentId = typeof documentOrId === 'string' ? documentOrId : documentOrId?.id;
      if (!documentId) {
        return;
      }

      const documentKey = resolveDocumentRowKey(documentId);
      if (!documentKey) {
        return;
      }

      const isAlreadySelected = selectedDocumentIds.includes(documentId);
      const selection = isAlreadySelected ? [...selectedDocumentIds] : [documentId];
      const folderSelection = selectedFolderIds.length ? [...selectedFolderIds] : [];

      if (!isAlreadySelected) {
        applySelection([documentKey], {
          anchor: documentKey,
          interactedKeys: [documentKey],
        });
      }

      const previewDocs = selection.map((id) => documentLookup.get(id) || null).filter(Boolean);
      const previewNode = createDragPreview({
        documents: previewDocs,
        folders: folderSelection,
      });

      setDraggedDocumentIds(selection);
      if (folderSelection.length) {
        setDraggedFolderId(folderSelection[0] || null);
      }
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData(
          'application/x-papercrate-doc-list',
          JSON.stringify(selection),
        );
        if (folderSelection.length) {
          event.dataTransfer.setData(
            'application/x-papercrate-folder-list',
            JSON.stringify(folderSelection),
          );
          if (folderSelection.length === 1) {
            event.dataTransfer.setData('application/x-papercrate-folder', folderSelection[0]);
          }
        }
      } catch (
        // eslint-disable-next-line no-empty
        error
      ) {}
      if (previewNode) {
        const width = previewNode.offsetWidth || 96;
        const height = previewNode.offsetHeight || 96;
        event.dataTransfer.setDragImage(previewNode, width / 2, height / 2);
      }
      event.currentTarget.classList.add('dragging');
    },
    [
      selectedDocumentIds,
      selectedFolderIds,
      applySelection,
      documentLookup,
      createDragPreview,
      setDraggedFolderId,
    ],
  );

  const handleDocumentDragEnd = useCallback(
    (event) => {
      setDraggedDocumentIds([]);
      event.currentTarget.classList.remove('dragging');
      destroyDragPreview();
      setDraggedFolderId(null);
    },
    [destroyDragPreview, setDraggedFolderId],
  );

  const handleFolderDragStart = useCallback(
    (event, folderId) => {
      if (folderId === 'root') {
        return;
      }
      event.stopPropagation();
      const folderKey = resolveFolderRowKey(folderId);
      const isAlreadySelected = folderKey ? selectedRowKeys.includes(folderKey) : false;

      let effectiveFolderSelection = selectedFolderIds;
      let effectiveDocumentSelection = selectedDocumentIds;

      if (!isAlreadySelected && folderKey) {
        effectiveFolderSelection = [folderId];
        effectiveDocumentSelection = [];
        handleRowSelection(folderKey, { preventDefault: () => {} });
      }

      const uniqueFolders = effectiveFolderSelection.length
        ? Array.from(new Set(effectiveFolderSelection.filter(Boolean)))
        : [folderId];

      setDraggedFolderId(folderId);
      if (effectiveDocumentSelection.length) {
        setDraggedDocumentIds(effectiveDocumentSelection);
      }

      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData(
          'application/x-papercrate-folder-list',
          JSON.stringify(uniqueFolders),
        );
        if (uniqueFolders.length === 1) {
          event.dataTransfer.setData('application/x-papercrate-folder', uniqueFolders[0]);
        }
        if (effectiveDocumentSelection.length) {
          event.dataTransfer.setData(
            'application/x-papercrate-doc-list',
            JSON.stringify(effectiveDocumentSelection),
          );
        }
      } catch (
        // eslint-disable-next-line no-empty
        error
      ) {}

      const previewDocs = effectiveDocumentSelection
        .map((id) => documentLookup.get(id) || null)
        .filter(Boolean);
      const previewNode = createDragPreview({
        documents: previewDocs,
        folders: uniqueFolders,
      });
      if (previewNode) {
        const width = previewNode.offsetWidth || 96;
        const height = previewNode.offsetHeight || 96;
        event.dataTransfer.setDragImage(previewNode, width / 2, height / 2);
      }
      event.currentTarget?.classList.add('dragging');
    },
    [
      selectedRowKeys,
      selectedFolderIds,
      selectedDocumentIds,
      setDraggedFolderId,
      setDraggedDocumentIds,
      handleRowSelection,
      documentLookup,
      createDragPreview,
    ],
  );

  const handleFolderDragEnd = useCallback(
    (event) => {
      if (event?.currentTarget) {
        event.currentTarget.classList.remove('dragging');
      }
      setDraggedFolderId(null);
      setDraggedDocumentIds([]);
      destroyDragPreview();
    },
    [setDraggedFolderId, setDraggedDocumentIds, destroyDragPreview],
  );

  const ensurePreviewUrl = useCallback(
    async (documentId, { force = false } = {}) => {
      if (!documentId) return null;

      const existing = previewEntries.get(documentId) || null;
      const now = Date.now();
      const expiresAt = typeof existing?.expiresAt === 'number' ? existing.expiresAt : null;
      if (!force && existing && (!expiresAt || expiresAt > now)) {
        return existing;
      }

      if (!force && previewInflightRef.current.has(documentId)) {
        return previewInflightRef.current.get(documentId);
      }

      const request = (async () => {
        try {
          const { data } = await api.get(`/documents/${documentId}/download`);
          const ttl = data.expires_in ? Math.max(data.expires_in - 60, 30) * 1000 : 5 * 60 * 1000;
          const entry = {
            url: data.url,
            contentType: data.content_type || null,
            filename: data.filename,
            expiresAt: Date.now() + ttl,
          };
          setPreviewEntries((prev) => {
            const next = new Map(prev);
            next.set(documentId, entry);
            return next;
          });
          return entry;
        } catch (error) {
          notifyApiError(error, 'Unable to fetch document preview.');
          throw error;
        } finally {
          previewInflightRef.current.delete(documentId);
        }
      })();

      previewInflightRef.current.set(documentId, request);
      return request;
    },
    [previewEntries, notifyApiError],
  );

  const extractFilesFromDataTransfer = useCallback(async (dataTransfer) => {
    if (!dataTransfer) {
      throw new Error('No drop payload found.');
    }

    const items = Array.from(dataTransfer.items || []);
    console.info('[Uploads] drop start', { items: items.length, files: (dataTransfer.files || []).length });

    const results = [];
    const seenKeys = new Set();

    const pushFile = (file, ancestors = []) => {
      if (!file) return;
      const segments = (ancestors || []).filter(Boolean);
      const key = `${segments.join('/')}/${file.name}:${file.size}`;
      if (seenKeys.has(key)) {
        // skipped duplicate
        return;
      }
      seenKeys.add(key);
      results.push({ file, segments });
      // queued file
    };

    const readAllEntries = async (reader) => {
      const entries = [];
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) {
          break;
        }
        entries.push(...batch);
      }
      return entries;
    };

    const walkEntry = async (entry, ancestors = []) => {
      if (!entry) return;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => {
          try {
            entry.file(resolve, reject);
          } catch (error) {
            console.warn('[Uploads] entry.file failed', error);
            reject(error);
          }
        });
        pushFile(file, ancestors);
        return;
      }
      if (entry.isDirectory) {
        const nextAncestors = entry.name ? [...ancestors, entry.name] : [...ancestors];
        const reader = entry.createReader();
        const entries = await readAllEntries(reader);
        for (const child of entries) {
          // eslint-disable-next-line no-await-in-loop
          await walkEntry(child, nextAncestors);
        }
      }
    };

    await Promise.all(
      items.map(async (item, index) => {
        if (item.kind !== 'file') return;

        const fileFromItem = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
        if (fileFromItem) {
          const relativePath =
            typeof fileFromItem.webkitRelativePath === 'string' ? fileFromItem.webkitRelativePath : '';
          const segments = relativePath
            ? relativePath
                .split('/')
                .slice(0, -1)
                .filter(Boolean)
            : [];
          pushFile(fileFromItem, segments);
        }

        if (typeof item.webkitGetAsEntry === 'function') {
          try {
            const entry = item.webkitGetAsEntry();
            if (entry) {
              // processing entry
              await walkEntry(entry, []);
              return;
            }
          } catch (error) {
            console.warn('[Uploads] webkitGetAsEntry failed', error);
          }
        }

        if (!fileFromItem) {
          console.info('[Uploads] item missing file handle', index);
        }
      }),
    );

    Array.from(dataTransfer.files || []).forEach((file, index) => {
      if (!file) return;
      // FileList entry suppressed
      const relativePath =
        typeof file.webkitRelativePath === 'string' ? file.webkitRelativePath : '';
      const segments = relativePath
        ? relativePath
            .split('/')
            .slice(0, -1)
            .filter(Boolean)
        : [];
      pushFile(file, segments);
    });

    if (!results.length) {
      throw new Error('No files detected in drop payload.');
    }

    console.info('[Uploads] prepared files', results.length);

    return results;
  }, []);


  const handleFileDrop = useCallback(
    async (dataTransfer, targetFolderId) => {
      if (!token) {
        setStatusMessage('Please log in before uploading.', 'error');
        return;
      }

      setLoading(true);

      try {
        folderPathCacheRef.current.clear();

        let extracted;
        try {
          extracted = await extractFilesFromDataTransfer(dataTransfer);
        } catch (error) {
          const message = error.message || 'Failed to process dropped files.';
          notifyApiError(error, message);
          return;
        }

        if (!extracted.length) {
          setStatusMessage('No files to upload.', 'info');
          return;
        }
        const baseFolderId =
          targetFolderId && targetFolderId !== 'root' ? targetFolderId : null;

        for (const { file, segments } of extracted) {
          // eslint-disable-next-line no-await-in-loop
          const destinationId = segments.length
            ? await ensureFolderPathOnServer(baseFolderId, segments)
            : baseFolderId;

          const uploadTarget =
            destinationId ??
            (targetFolderId && targetFolderId !== 'root' ? targetFolderId : 'root');

          // eslint-disable-next-line no-await-in-loop
          await uploadFile(file, uploadTarget);
        }

        await refreshCurrentFolder();

        if (
          targetFolderId &&
          targetFolderId !== 'root' &&
          targetFolderId !== selectedFolder
        ) {
          await ensureFolderData(targetFolderId, { force: true });
        }
      } catch (error) {
        notifyApiError(error, 'Failed to upload files.');
      } finally {
        setLoading(false);
      }
    },
    [
      token,
      extractFilesFromDataTransfer,
      ensureFolderPathOnServer,
      uploadFile,
      refreshCurrentFolder,
      selectedFolder,
      ensureFolderData,
      notifyApiError,
      setStatusMessage,
    ],
  );

  const normalizeDocumentId = (value) => {
    if (!value) return null;
    if (typeof value === 'object' && value.id) {
      return value.id;
    }
    return value;
  };

  const moveDocumentsToFolder = useCallback(
    async (documentIds, targetFolderId) => {
      const uniqueIds = Array.from(
        new Set((documentIds || []).map((value) => normalizeDocumentId(value)).filter(Boolean)),
      );
      if (!uniqueIds.length) return;

      const target = targetFolderId === 'root' ? null : targetFolderId;
      setLoading(true);
      try {
        if (uniqueIds.length === 1) {
          await api.patch(`/documents/${uniqueIds[0]}/folder`, { folder_id: target });
        } else {
          await api.post('/documents/bulk/move', {
            document_ids: uniqueIds,
            folder_id: target,
          });
        }

        const count = uniqueIds.length;
        const suffix = count === 1 ? '' : 's';
        const targetLabel =
          target === null
            ? DEFAULT_FOLDER_NAME
            : folderLabelMap.get(targetFolderId) || 'target folder';
        setStatusMessage(
          `Moved ${count} document${suffix} to ${targetLabel}.`,
          'success',
        );

        await refreshCurrentFolder();
      if (targetFolderId && targetFolderId !== selectedFolder) {
        await ensureFolderData(targetFolderId, { force: true });
      }
    } catch (error) {
      const message = error.response?.data?.error || 'Failed to move documents.';
      notifyApiError(error, message);
    } finally {
      setLoading(false);
    }
  },
  [
    api,
    ensureFolderData,
    refreshCurrentFolder,
    selectedFolder,
    folderLabelMap,
    notifyApiError,
    setStatusMessage,
  ],
  );

  const handleThumbnailRegeneration = useCallback(
    async (documentId) => {
      if (!token) {
        setStatusMessage('Log in to manage assets.', 'error');
        return;
      }
      setLoading(true);
      try {
        await api.post(`/documents/${documentId}/assets`, null, {
          params: { force: true },
        });
        setStatusMessage('Document re-analysis queued.', 'info');
        await refreshCurrentFolder();
      } catch (error) {
        const message =
          error.response?.data?.error || 'Failed to request thumbnail generation.';
        notifyApiError(error, message);
      } finally {
        setLoading(false);
      }
    },
    [token, refreshCurrentFolder, notifyApiError, setStatusMessage],
  );

  const ensurePreviewData = useCallback(
    async (documentId) => {
      if (!documentId) return null;

      const findInCache = () => {
        const pool = searchResults ?? documents;
        return pool.find((item) => item.id === documentId) || null;
      };

      let doc = findInCache();

      if (!doc) {
        const { data } = await api.get(`/documents/${documentId}`);
        const hydratedDetail = assetManager.hydrateDetail(data);
        const fetched = hydratedDetail?.document || data.document || data;
        doc = fetched ? assetManager.hydrateDocument(fetched) : null;
        if (!doc) {
          throw new Error('Document metadata unavailable.');
        }

        setDocuments((prev) => {
          if (prev.some((item) => item.id === doc.id)) {
            return prev;
          }
          return [doc, ...prev];
        });
      }

      const targetFolder = doc?.folder_id || selectedFolder || 'root';
      if (targetFolder && targetFolder !== selectedFolder) {
        await loadFolder(targetFolder, { showLoading: false, preserveSearch: isFilterActive });
        doc = findInCache() || doc;
      }

      await ensurePreviewUrl(documentId, { force: false });
      setActivePreviewId(documentId);
      return doc;
    },
    [
      searchResults,
      documents,
      api,
      assetManager,
      setDocuments,
      selectedFolder,
      loadFolder,
      isFilterActive,
      ensurePreviewUrl,
      setActivePreviewId,
    ],
  );

  const openDocumentPreview = useCallback(
    (documentId, { replace = false } = {}) => {
      if (!documentId) return;
      navigate(`/documents/${documentId}`, { replace });
    },
    [navigate],
  );

  const closeDocumentPreview = useCallback(
    (folderId = null) => {
      const targetId = folderId || selectedFolder || 'root';
      const path = targetId === 'root' ? '/documents' : `/documents/folder/${targetId}`;
      navigate(path, { replace: false });
    },
    [navigate, selectedFolder],
  );

  const handleDocumentListFocus = useCallback(() => {
    if (focusedRowKey && navigableRowKeys.includes(focusedRowKey)) {
      return;
    }

    let resolvedKey = null;
    for (let index = selectedRowKeys.length - 1; index >= 0; index -= 1) {
      const candidate = selectedRowKeys[index];
      if (navigableRowKeys.includes(candidate)) {
        resolvedKey = candidate;
        break;
      }
    }

    if (!resolvedKey && navigableRows.length) {
      resolvedKey = navigableRows[0].key;
    }

    if (!resolvedKey) {
      return;
    }

    setFocusedRowKey(resolvedKey);

    if (!selectedRowKeys.includes(resolvedKey)) {
      applySelection([resolvedKey], { anchor: resolvedKey, interactedKeys: [resolvedKey] });
    }
  }, [
    focusedRowKey,
    navigableRowKeys,
    selectedRowKeys,
    navigableRows,
    applySelection,
  ]);

  const handleDocumentListKeyDown = useCallback(
    (event) => {
      const { key, shiftKey } = event;
      const triggers = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ', 'Space', 'Spacebar'];
      if (!triggers.includes(key)) {
        return;
      }

      if (!navigableRows.length) {
        return;
      }

      event.preventDefault();

      let activeKey =
        focusedRowKey && navigableRowKeys.includes(focusedRowKey)
          ? focusedRowKey
          : null;

      if (!activeKey) {
        for (let index = selectedRowKeys.length - 1; index >= 0; index -= 1) {
          const candidate = selectedRowKeys[index];
          if (navigableRowKeys.includes(candidate)) {
            activeKey = candidate;
            break;
          }
        }
      }

      if (!activeKey) {
        activeKey = navigableRowKeys[0];
        setFocusedRowKey(activeKey);
      }

      let currentIndex = navigableRowKeys.indexOf(activeKey);

      if (key === 'Enter' || key === ' ' || key === 'Space' || key === 'Spacebar') {
        const row = currentIndex === -1 ? navigableRows[0] : navigableRows[currentIndex];
        if (!row) {
          return;
        }
        handleRowSelection(row.key, event);
        if (row.type === 'folder') {
          selectFolder(row.id);
        } else if (row.type === 'document') {
          openDocumentPreview(row.id);
        }
        return;
      }

      let nextIndex = currentIndex;

      if (key === 'ArrowDown') {
        nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, navigableRows.length - 1);
      } else if (key === 'ArrowUp') {
        nextIndex = currentIndex === -1 ? navigableRows.length - 1 : Math.max(currentIndex - 1, 0);
      } else if (key === 'Home') {
        nextIndex = 0;
      } else if (key === 'End') {
        nextIndex = navigableRows.length - 1;
      }

      if (nextIndex === -1 || nextIndex >= navigableRows.length) {
        return;
      }

      if (nextIndex === currentIndex && key !== 'Home' && key !== 'End') {
        return;
      }

      const targetRow = navigableRows[nextIndex];
      if (!targetRow) {
        return;
      }

      setFocusedRowKey(targetRow.key);

      handleRowSelection(targetRow.key, {
        shiftKey,
        preventDefault: () => {},
      });
    },
    [
      navigableRows,
      navigableRowKeys,
      focusedRowKey,
      selectedRowKeys,
      handleRowSelection,
      selectFolder,
      openDocumentPreview,
    ],
  );

  useEffect(() => {
    if (!previewDocumentId) return;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeDocumentPreview();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewDocumentId, closeDocumentPreview]);

  const handleDocumentTitleUpdate = useCallback(
    async (documentId, nextTitle) => {
      const trimmed = nextTitle.trim();
      if (!trimmed) {
        setStatusMessage('Document title cannot be empty.', 'error');
        return false;
      }

      setLoading(true);
      try {
        const { data } = await api.patch(`/documents/${documentId}`, { title: trimmed });
        const hydratedDetail = assetManager.hydrateDetail(data);
        const hydratedDocument = hydratedDetail?.document || data.document || data;

        updateDocumentCaches(documentId, (doc) => {
          if (hydratedDocument) {
            return { ...doc, ...hydratedDocument };
          }
          return { ...doc, title: trimmed };
        });

        setStatusMessage('Document title updated.', 'success');
        return true;
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to update document title.';
        notifyApiError(error, message);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [assetManager, notifyApiError, setStatusMessage, updateDocumentCaches],
  );

  const applyTagRemovalToCaches = useCallback(
    (documentId, tagId) => {
      if (!documentId || !tagId) {
        return;
      }

      updateDocumentCaches(documentId, (doc) => {
        if (!Array.isArray(doc.tags)) {
          return doc;
        }
        const nextTags = doc.tags.filter((tag) => tag.id !== tagId);
        if (nextTags.length === doc.tags.length) {
          return doc;
        }
        return { ...doc, tags: nextTags };
      });
    },
    [updateDocumentCaches],
  );

  const handleTagRemove = useCallback(
    async (documentId, tagId, { refreshTagList = true, showMessage = true } = {}) => {
      if (!documentId || !tagId) {
        return false;
      }

      try {
        await api.delete(`/documents/${documentId}/tags/${tagId}`);
        applyTagRemovalToCaches(documentId, tagId);
        if (refreshTagList) {
          await refreshTags();
        }
        if (showMessage) {
          setStatusMessage('Tag removed.', 'success');
        }
        return true;
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to remove tag.';
        notifyApiError(error, message);
        return false;
      }
    },
    [api, refreshTags, notifyApiError, setStatusMessage, applyTagRemovalToCaches],
  );

  const handleTagAdd = useCallback(
    async (document, label, input) => {
      const normalizedLabel = tagManager.normalizeLabel(label);
      let tag =
        tags.find((item) => item.label.toLowerCase() === normalizedLabel.toLowerCase()) || null;
      try {
        if (!tag) {
          const payload = tagManager.buildPayload({ label: normalizedLabel });
          const { data } = await api.post('/tags', payload);
          tag = data;
          await refreshTags();
        }
        await api.post(`/documents/${document.id}/tags`, { tag_ids: [tag.id] });
        setStatusMessage('Tag assigned.', 'success');
        input.value = '';
        await refreshCurrentFolder();
      } catch (error) {
        notifyApiError(error, 'Failed to assign tag.');
      }
    },
    [tags, refreshTags, refreshCurrentFolder, notifyApiError, setStatusMessage, tagManager],
  );

  const handleDocumentTagAttach = useCallback(
    async ({ documentId, tagId, tag: tagData = null }) => {
      if (!documentId || !tagId) {
        return false;
      }

      const resolveTagForCache = () => {
        const lookupTag = tagLookupById.get(tagId);
        const source = lookupTag || tagData;
        if (!source) {
          return { id: tagId, label: 'Tag', color: null };
        }
        return {
          id: source.id ?? tagId,
          label: source.label || source.name || 'Tag',
          color: Object.prototype.hasOwnProperty.call(source, 'color')
            ? source.color
            : null,
        };
      };

      try {
        await api.post(`/documents/${documentId}/tags`, { tag_ids: [tagId] });
        updateDocumentCaches(documentId, (doc) => {
          if (!doc) {
            return doc;
          }
          const currentTags = Array.isArray(doc.tags) ? doc.tags : [];
          if (currentTags.some((existing) => existing?.id === tagId)) {
            return doc;
          }
          return { ...doc, tags: [...currentTags, resolveTagForCache()] };
        });
        setStatusMessage('Tag assigned.', 'success');
        await refreshCurrentFolder();
        return true;
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to assign tag.';
        notifyApiError(error, message);
        return false;
      }
    },
    [
      api,
      refreshCurrentFolder,
      notifyApiError,
      setStatusMessage,
      updateDocumentCaches,
      tagLookupById,
    ],
  );

  const handleDocumentTagDrop = useCallback(
    async (documentId, tag) => {
      if (!documentId || !tag?.id) {
        return;
      }

      if (tag.sourceDocId && tag.sourceDocId === documentId) {
        return;
      }

      const attached = await handleDocumentTagAttach({ documentId, tagId: tag.id, tag });
      if (!attached) {
        return;
      }

      if (tag.sourceDocId && tag.sourceDocId !== documentId) {
        await handleTagRemove(tag.sourceDocId, tag.id, {
          refreshTagList: false,
          showMessage: false,
        });
      }
    },
    [handleDocumentTagAttach, handleTagRemove],
  );

  const handleFolderDelete = useCallback(
    async (folderId) => {
      if (!token) {
        setStatusMessage('Log in to manage folders.', 'error');
        return;
      }
      if (folderId === 'root') {
        setStatusMessage('The root folder cannot be removed.', 'error');
        return;
      }
      setLoading(true);
      try {
        const contents = await ensureFolderData(folderId, { force: true });
        const hasChildren = (contents.subfolders || []).length > 0;
        const hasDocs = (contents.documents || []).length > 0;
        if (hasChildren || hasDocs) {
          setStatusMessage('Folder must be empty before it can be deleted.', 'error');
          return;
        }
        await api.delete(`/folders/${folderId}`);
        setFolderNodes((prev) => {
          const next = new Map(prev);
          const node = next.get(folderId);
          next.delete(folderId);
          if (node) {
            const parentId = node.parentId || 'root';
            const parentNode = next.get(parentId);
            if (parentNode) {
              next.set(parentId, {
                ...parentNode,
                children: parentNode.children.filter((id) => id !== folderId),
              });
            }
          }
          return next;
        });
        setFolderContents((prev) => {
          const next = new Map(prev);
          next.delete(folderId);
          return next;
        });
        if (selectedFolder === folderId) {
          const node = folderNodes.get(folderId);
          const parentId = node?.parentId || 'root';
          setSelectedFolder(parentId);
          const parentContents = await ensureFolderData(parentId, { force: true });
          applySelectedFolder(parentId, parentContents);
        } else if (selectedFolder !== 'root') {
          await ensureFolderData(selectedFolder, { force: true });
      }
      setStatusMessage('Folder deleted.', 'success');
    } catch (error) {
      const message = error.response?.data?.error || 'Failed to delete folder.';
      notifyApiError(error, message);
    } finally {
      setLoading(false);
    }
  },
    [
      token,
      ensureFolderData,
      selectedFolder,
      folderNodes,
      applySelectedFolder,
      notifyApiError,
      setStatusMessage,
    ],
  );

  const handleFolderRename = useCallback(
    async (folderId, nextName) => {
      if (!token) {
        setStatusMessage('Log in to rename folders.', 'error');
        return false;
      }
      if (!folderId || folderId === 'root') {
        setStatusMessage('The root folder cannot be renamed.', 'error');
        return false;
      }
      const trimmed = (nextName || '').trim();
      if (!trimmed) {
        setStatusMessage('Folder name cannot be empty.', 'error');
        return false;
      }

      setLoading(true);
      try {
        await api.patch(`/folders/${folderId}`, { name: trimmed });

        setFolderNodes((prev) => {
          const next = new Map(prev);
          const node = next.get(folderId);
          if (node) {
            next.set(folderId, { ...node, name: trimmed });
          }
          return next;
        });

        setFolderContents((prev) => {
          if (!prev.has(folderId)) {
            return prev;
          }
          const next = new Map(prev);
          const existing = next.get(folderId) || {};
          const folderInfo = existing.folder
            ? { ...existing.folder, name: trimmed }
            : { id: folderId, name: trimmed };
          next.set(folderId, { ...existing, folder: folderInfo });
          return next;
        });

        setCurrentFolder((prev) => (prev?.id === folderId ? { ...prev, name: trimmed } : prev));

        setStatusMessage('Folder renamed.', 'success');
        return true;
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to rename folder.';
        notifyApiError(error, message);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [api, token, notifyApiError, setStatusMessage],
  );

  const handleFolderCreate = useCallback(
    async (name, onSuccess) => {
      if (!token) {
        setStatusMessage('Log in to create folders.', 'error');
        return false;
      }
      if (!name.trim()) {
        setStatusMessage('Folder name cannot be empty.', 'error');
        return false;
      }
      const payload = {
        name: name.trim(),
        parent_id: selectedFolder === 'root' ? null : selectedFolder,
      };
      setLoading(true);
      let succeeded = false;
      try {
        const { data } = await api.post('/folders', payload);
        onSuccess();
        setStatusMessage('Folder created.', 'success');
        setFolderNodes((prev) => {
          const next = new Map(prev);
          const parentId = payload.parent_id || 'root';
          const parentNode = next.get(parentId);
          if (parentNode) {
            next.set(parentId, {
              ...parentNode,
              children: parentNode.children.concat([data.folder.id]),
              loaded: true,
            });
          }
          next.set(data.folder.id, {
            id: data.folder.id,
            name: data.folder.name,
            parentId: parentId,
            children: [],
            expanded: false,
            loaded: false,
          });
          return next;
        });
        await ensureFolderData(selectedFolder, { force: true });
        succeeded = true;
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to create folder.';
        notifyApiError(error, message);
        succeeded = false;
      } finally {
        setLoading(false);
      }
      return succeeded;
    },
    [token, selectedFolder, ensureFolderData, notifyApiError, setStatusMessage],
  );

  const openCreateFolderModal = useCallback(() => {
    setNewFolderName('');
    setCreateFolderError('');
    setCreateFolderModalOpen(true);
  }, []);

  const closeCreateFolderModal = useCallback(() => {
    if (creatingFolder) {
      return;
    }
    setCreateFolderModalOpen(false);
    setNewFolderName('');
    setCreateFolderError('');
  }, [creatingFolder]);

  const handleCreateFolderSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      const trimmed = newFolderName.trim();
      if (!trimmed) {
        setCreateFolderError('Folder name cannot be empty.');
        return;
      }

      if (!token) {
        setCreateFolderError('Log in to create folders.');
        return;
      }

      setCreatingFolder(true);
      setCreateFolderError('');

      try {
        const success = await handleFolderCreate(trimmed, () => {
          setCreateFolderModalOpen(false);
          setNewFolderName('');
          setCreateFolderError('');
        });
        if (!success) {
          setCreateFolderError('Unable to create folder. Check the status message for details.');
        }
      } finally {
        setCreatingFolder(false);
      }
    },
    [newFolderName, handleFolderCreate, token],
  );

  useEffect(() => {
    if (!isCreateFolderModalOpen) {
      return;
    }
    const node = createFolderInputRef.current;
    if (node) {
      node.focus();
      node.select();
    }
  }, [isCreateFolderModalOpen]);

  useEffect(() => {
    if (!isCreateFolderModalOpen) {
      return;
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCreateFolderModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isCreateFolderModalOpen, closeCreateFolderModal]);

  useEffect(() => {
    if (!token) return undefined;

    if (!isFilterActive) {
      setSearchResults(null);
      setSearchLoading(false);
      return undefined;
    }

    let cancelled = false;
    let started = false;
    setSearchLoading(true);

    const debounce = setTimeout(async () => {
      started = true;
      setLoading(true);
      try {
        const params = {};
        const trimmedQuery = searchQuery.trim();
        if (trimmedQuery.length) {
          params.query = trimmedQuery;
        }
        if (activeTagFilters.length) {
          params.tags = activeTagFilters.join(',');
        }
        if (activeCorrespondentFilters.length) {
          params.correspondents = activeCorrespondentFilters.join(',');
        }
        const folderIdentifier = selectedFolder === 'root' ? null : selectedFolder;
        if (folderIdentifier) {
          params.folder_id = folderIdentifier;
        }
        const { data } = await api.get('/documents', { params });
        if (cancelled) return;

        const results = assetManager.hydrateDocuments(data || []);
        setSearchResults(results);

        if (!results.length) {
          setSearchLoading(false);
          setSelectedRowKeys([]);
          setFocusedDocumentId(null);
          selectionOrderRef.current = [];
          setSelectionOrder([]);
          selectionAnchorRef.current = null;
          return;
        }

        const resultKeys = results
          .map((doc) => resolveDocumentRowKey(doc.id))
          .filter(Boolean);

        let targetKey = null;
        let nextSelectionKeys = [];

        setSelectedRowKeys((previous) => {
          const previousDocKeys = previous.filter(isDocumentRowKey);
          const filtered = previousDocKeys.filter((key) => resultKeys.includes(key));
          if (filtered.length) {
            targetKey = filtered[filtered.length - 1];
            nextSelectionKeys = filtered;
            return filtered;
          }
          targetKey = resultKeys[0] || null;
          nextSelectionKeys = targetKey ? [targetKey] : [];
          return nextSelectionKeys;
        });

        selectionOrderRef.current = nextSelectionKeys;
        setSelectionOrder(nextSelectionKeys);

        const targetDocId = targetKey ? getRowId(targetKey) : null;

        setFocusedDocumentId((previous) => {
          if (previous && resultKeys.includes(resolveDocumentRowKey(previous))) {
            return previous;
          }
          return targetDocId;
        });

        selectionAnchorRef.current = targetKey;

        // rely on hydrated search results; assets refresh on demand
      } catch (error) {
        if (cancelled) return;
        notifyApiError(error, 'Search failed. Please try again.');
        setSearchResults(null);
      } finally {
        if (!cancelled && started) {
          setLoading(false);
          setSearchLoading(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(debounce);
      if (started) {
        setLoading(false);
        setSearchLoading(false);
      }
    };
  }, [
    token,
    isFilterActive,
    searchQuery,
    activeTagFilters,
    activeCorrespondentFilters,
    selectedFolder,
    notifyApiError,
    assetManager,
  ]);

  useEffect(() => {
    if (!token) {
      setDropOverlayState((prev) => ({ ...prev, active: false }));
      dragCounterRef.current = 0;
      return undefined;
    }

    const handleDragEnter = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounterRef.current += 1;
      setDropOverlayState({ active: true, folderName: currentFolderName });
    };

    const handleDragOver = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };

    const handleDragLeave = (event) => {
      if (!hasFiles(event)) return;
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) {
        setDropOverlayState((prev) => ({ ...prev, active: false }));
      }
    };

    const handleDrop = async (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounterRef.current = 0;
      setDropOverlayState((prev) => ({ ...prev, active: false }));
      await handleFileDrop(event.dataTransfer, selectedFolder);
    };

    const dropTarget = shellRef.current;
    if (!dropTarget) {
      return undefined;
    }

    dropTarget.addEventListener('dragenter', handleDragEnter);
    dropTarget.addEventListener('dragover', handleDragOver);
    dropTarget.addEventListener('dragleave', handleDragLeave);
    dropTarget.addEventListener('drop', handleDrop);

    return () => {
      dropTarget.removeEventListener('dragenter', handleDragEnter);
      dropTarget.removeEventListener('dragover', handleDragOver);
      dropTarget.removeEventListener('dragleave', handleDragLeave);
      dropTarget.removeEventListener('drop', handleDrop);
      dragCounterRef.current = 0;
      setDropOverlayState((prev) => ({ ...prev, active: false }));
    };
  }, [token, handleFileDrop, currentFolderName, selectedFolder]);

  useEffect(
    () => () => {
      setTagRemovalCursor(false);
    },
    [setTagRemovalCursor],
  );

  useEffect(() => {
    const host = shellRef.current;
    if (!host) {
      return undefined;
    }

    const isTagTransfer = (event) => {
      const types = event?.dataTransfer?.types;
      if (!types) {
        return false;
      }
      if (typeof types.includes === 'function') {
        return TAG_MIME_TYPES.some((type) => types.includes(type));
      }
      return TAG_MIME_TYPES.some((type) => Array.from(types).includes(type));
    };

    const isDocumentDropTarget = (target) =>
      target instanceof Element ? Boolean(target.closest('[data-doc-id]')) : false;

    const handleTagDragOver = (event) => {
      if (!isTagTransfer(event)) {
        return;
      }
      if (isDocumentDropTarget(event.target)) {
        setTagRemovalCursor(false);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setTagRemovalCursor(true);
    };

    const handleTagDragLeave = (event) => {
      if (!isTagTransfer(event)) {
        return;
      }
      const related = event.relatedTarget;
      if (related instanceof Element && host.contains(related)) {
        if (isDocumentDropTarget(related)) {
          setTagRemovalCursor(false);
        }
        return;
      }
      setTagRemovalCursor(false);
    };

    const handleTagDrop = async (event) => {
      if (!isTagTransfer(event)) {
        return;
      }
      setTagRemovalCursor(false);
      if (isDocumentDropTarget(event.target) || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const raw =
        event.dataTransfer.getData('application/x-papercrate-tag') ||
        event.dataTransfer.getData('text/papercrate-tag');
      if (!raw) {
        return;
      }
      try {
        const payload = JSON.parse(raw);
        if (payload?.sourceDocId && payload?.id) {
          await handleTagRemove(payload.sourceDocId, payload.id, {
            refreshTagList: false,
            showMessage: true,
          });
        }
      } catch (error) {
        console.warn('Failed to remove tag from drop target', error);
      }
    };

    const handleTagDragEnd = () => {
      setTagRemovalCursor(false);
    };

    host.addEventListener('dragover', handleTagDragOver, true);
    host.addEventListener('dragleave', handleTagDragLeave, true);
    host.addEventListener('drop', handleTagDrop, true);
    window.addEventListener('dragend', handleTagDragEnd, true);

    return () => {
      host.removeEventListener('dragover', handleTagDragOver, true);
      host.removeEventListener('dragleave', handleTagDragLeave, true);
      host.removeEventListener('drop', handleTagDrop, true);
      window.removeEventListener('dragend', handleTagDragEnd, true);
      setTagRemovalCursor(false);
    };
  }, [handleTagRemove, setTagRemovalCursor]);

  const handleLogin = useCallback(
    async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const payload = {
        username: form.get('username')?.toString().trim(),
        password: form.get('password')?.toString() || '',
      };
      if (!payload.username || !payload.password) {
        setStatusMessage('Username and password are required.', 'error');
        return;
      }
      try {
        setLoading(true);
        appDispatch({ type: 'LOGIN_REQUEST' });
        const { data } = await api.post('/auth/login', payload);
      appDispatch({ type: 'LOGIN_SUCCESS', token: data.access_token });
      setStatusMessage('Login successful.', 'success');
    } catch (error) {
      appDispatch({
        type: 'LOGIN_FAILURE',
        error: error?.response?.data?.error || 'Login failed. Check credentials.',
      });
      notifyApiError(error, 'Login failed. Check credentials.');
    } finally {
      setLoading(false);
    }
  },
  [appDispatch, notifyApiError, setStatusMessage],
  );

  const handleLogout = useCallback(async () => {
    try {
      setLoading(true);
      await api.post('/auth/logout');
    } catch (error) {
      console.warn('[Auth] Failed to revoke refresh token during logout', error);
    } finally {
      setLoading(false);
      appDispatch({ type: 'LOGOUT' });
      setStatusMessage('Logged out.', 'info');
    }
  }, [appDispatch, setStatusMessage]);

  const handleBulkReanalyze = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.post('/documents/reanalyze');
      const total = data?.queued ?? 0;
      const suffix = total === 1 ? '' : 's';
      setStatusMessage(
        `Queued re-analysis for ${total} document${suffix}.`,
        'success',
      );
    } catch (error) {
      const message =
        error.response?.data?.error || 'Failed to queue document re-analysis.';
      notifyApiError(error, message);
    } finally {
      setLoading(false);
    }
  }, [notifyApiError, setStatusMessage]);


  const folderClickHandlers = {
    onToggle: async (folderId) => {
      const node = folderNodes.get(folderId);
      if (node && !node.loaded) {
        try {
          await ensureFolderData(folderId, { includeDocuments: false });
        } catch (error) {
          notifyApiError(error, 'Failed to load folder.');
        }
      }
      setFolderNodes((prev) => {
        const next = new Map(prev);
        const current = next.get(folderId);
        if (!current) return prev;
        next.set(folderId, { ...current, expanded: !current.expanded });
        return next;
      });
    },
    onSelect: selectFolder,
    onDrop: async (event, folderId) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.remove('is-drop-target');

      let folderIds = [];
      try {
        const rawFolderList = event.dataTransfer.getData('application/x-papercrate-folder-list');
        if (rawFolderList) {
          const parsed = JSON.parse(rawFolderList);
          if (Array.isArray(parsed)) {
            folderIds = parsed.filter(Boolean);
          }
        }
      } catch (
        // eslint-disable-next-line no-empty
        error
      ) {}

      if (!folderIds.length) {
        let folderSourceId = draggedFolderId;
        if (!folderSourceId) {
          try {
            if (event.dataTransfer.types?.includes('application/x-papercrate-folder')) {
              folderSourceId = event.dataTransfer.getData('application/x-papercrate-folder');
            }
          } catch (
            // eslint-disable-next-line no-empty
            error
          ) {}
        }

        if (folderSourceId) {
          folderIds = [folderSourceId];
        }
      }

      folderIds = Array.from(new Set(folderIds.filter(Boolean)));

      if (folderIds.length) {
        setDraggedFolderId(null);
        const invalidMove = folderIds.some((sourceId) => isInvalidFolderDrop(sourceId, folderId));
        if (invalidMove) {
          setStatusMessage(
            'Cannot move a folder into itself or one of its descendants.',
            'error',
          );
          return;
        }

        for (const sourceId of folderIds) {
          // eslint-disable-next-line no-await-in-loop
          await moveFolder(sourceId, folderId);
        }
      }

      if (hasFiles(event)) {
        await handleFileDrop(event.dataTransfer, folderId);
        return;
      }

      let docIds = [];
      try {
        const raw = event.dataTransfer.getData('application/x-papercrate-doc-list');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            docIds = parsed.filter(Boolean);
          }
        }
      } catch (
        // eslint-disable-next-line no-empty
        error
      ) {}

      if (!docIds.length) {
        try {
          const single = event.dataTransfer.getData('application/x-papercrate-doc');
          if (single) {
            docIds = [single];
          }
        } catch (
          // eslint-disable-next-line no-empty
          error
        ) {}
      }

      if (!docIds.length && draggedDocumentIds.length) {
        docIds = draggedDocumentIds;
      }

      docIds = Array.from(new Set(docIds));

      if (!docIds.length || folderId === selectedFolder) {
        return;
      }

      setDraggedDocumentIds([]);
      await moveDocumentsToFolder(docIds, folderId);
    },
    onDragOver: (event, folderId) => {
      const folderDragActive = Boolean(draggedFolderId);
      if (folderDragActive && isInvalidFolderDrop(draggedFolderId, folderId)) {
        return;
      }

      if (hasFiles(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        event.currentTarget.classList.add('is-drop-target');
        return;
      }

      if (draggedDocumentIds.length || folderDragActive) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        event.currentTarget.classList.add('is-drop-target');
      }
    },
    onDragLeave: (event) => {
      event.currentTarget.classList.remove('is-drop-target');
    },
  };

  const selectedDocument = useMemo(() => {
    if (!focusedDocumentId) {
      return null;
    }
    const list = searchResults ?? documents;
    return list.find((doc) => doc.id === focusedDocumentId) || null;
  }, [searchResults, documents, focusedDocumentId]);

  const handleDocumentDelete = useCallback(
    async (documentId) => {
      if (!documentId) return;
      if (!token) {
        setStatusMessage('Log in to manage documents.', 'error');
        return;
      }

      const doc = documentLookup.get(documentId) || null;
      const label = doc?.title || doc?.original_name || 'this document';

      const confirmed = window.confirm(`Delete "${label}"? This action cannot be undone.`);
      if (!confirmed) {
        return;
      }

      setLoading(true);
      try {
        await api.delete(`/documents/${documentId}`);

        removeDocumentFromCaches(documentId);

        setPreviewEntries((prev) => {
          if (!prev.has(documentId)) {
            return prev;
          }
          const next = new Map(prev);
          next.delete(documentId);
          return next;
        });
        previewInflightRef.current.delete(documentId);

        if (selectedDocumentIds.includes(documentId)) {
          const remainingRowKeys = selectedDocumentIds
            .filter((id) => id !== documentId)
            .map((id) => resolveDocumentRowKey(id))
            .filter(Boolean);
          const removedKey = resolveDocumentRowKey(documentId);
          applySelection(remainingRowKeys, {
            anchor: null,
            interactedKeys: removedKey ? [removedKey] : [],
          });
        }

        if (previewDocumentId === documentId) {
          closeDocumentPreview();
        }

        setStatusMessage('Document deleted.', 'success');
      } catch (error) {
        const message = error.response?.data?.error || 'Failed to delete document.';
        notifyApiError(error, message);
      } finally {
        setLoading(false);
      }
    },
    [
      api,
      token,
      documentLookup,
      setStatusMessage,
      removeDocumentFromCaches,
      setPreviewEntries,
      previewInflightRef,
      previewDocumentId,
      closeDocumentPreview,
      selectedDocumentIds,
      applySelection,
      notifyApiError,
    ],
  );

  const orderedSelectedDocuments = useMemo(() => {
    const ordered = [];
    const seen = new Set();
    const pushDoc = (doc) => {
      if (doc?.id && !seen.has(doc.id)) {
        ordered.push(doc);
        seen.add(doc.id);
      }
    };

    selectionOrder.forEach((key) => {
      if (!isDocumentRowKey(key)) {
        return;
      }
      const docId = getRowId(key);
      const doc = documentLookup.get(docId) || null;
      pushDoc(doc);
    });

    selectedDocumentIds.forEach((id) => {
      if (seen.has(id)) return;
      const doc = documentLookup.get(id) || null;
      pushDoc(doc);
    });

    return ordered;
  }, [selectionOrder, documentLookup, selectedDocumentIds]);

  const { breadcrumbs, missingBreadcrumbAncestors } = useMemo(() => {
    const chain = [];
    const seen = new Set();
    const pending = new Set();
    let currentId = selectedFolder || 'root';
    let guard = 0;

    while (currentId && !seen.has(currentId) && guard < 32) {
      guard += 1;
      seen.add(currentId);

      if (currentId === 'root') {
        chain.push({ id: 'root', name: DEFAULT_FOLDER_NAME });
        currentId = null;
        break;
      }

      const node = folderNodes.get(currentId);
      if (node) {
        chain.push({ id: currentId, name: node.name || 'Folder' });
        currentId = node.parentId ?? 'root';
        continue;
      }

      let fallbackName = '…';
      let parentId = null;

      if (currentFolder && currentFolder.id === currentId) {
        fallbackName = currentFolder.name;
        parentId = currentFolder.parent_id ?? 'root';
      }

      chain.push({ id: currentId, name: fallbackName });
      pending.add(currentId);
      currentId = parentId;
    }

    if (!chain.some((crumb) => crumb.id === 'root')) {
      chain.push({ id: 'root', name: DEFAULT_FOLDER_NAME });
    }

    const ordered = [];
    const seenOrdered = new Set();
    chain
      .slice()
      .reverse()
      .forEach((crumb) => {
        if (!seenOrdered.has(crumb.id)) {
          seenOrdered.add(crumb.id);
          ordered.push(crumb);
        }
      });

    return { breadcrumbs: ordered, missingBreadcrumbAncestors: Array.from(pending) };
  }, [selectedFolder, folderNodes, currentFolder]);

  useEffect(() => {
    if (!missingBreadcrumbAncestors.length) {
      return;
    }

    missingBreadcrumbAncestors.forEach((folderId) => {
      if (!folderId || folderId === 'root') {
        return;
      }
      if (breadcrumbFetchRef.current.has(folderId)) {
        return;
      }

      breadcrumbFetchRef.current.add(folderId);
      ensureFolderData(folderId, { force: false })
        .catch((error) => {
          console.warn('Failed to preload breadcrumb ancestor', folderId, error);
        })
        .finally(() => {
          breadcrumbFetchRef.current.delete(folderId);
        });
    });
  }, [missingBreadcrumbAncestors, ensureFolderData]);

  const selectedPreviewEntry = useMemo(() => {
    if (!selectedDocument) {
      return null;
    }
    return previewEntries.get(selectedDocument.id) || null;
  }, [selectedDocument, previewEntries]);

  const previewWorkspaceEntry = useMemo(() => {
    if (!previewDocumentId) {
      return null;
    }
    return previewEntries.get(previewDocumentId) || null;
  }, [previewDocumentId, previewEntries]);

  const previewWorkspaceDocument = useMemo(() => {
    if (!previewDocumentId) return null;
    const pool = searchResults ?? documents;
    return pool.find((doc) => doc.id === previewDocumentId) || null;
  }, [previewDocumentId, searchResults, documents]);

  const previewActive = Boolean(previewDocumentId && previewWorkspaceDocument);

  const sidebarProps = {
    folderNodes,
    onToggle: folderClickHandlers.onToggle,
    onSelect: folderClickHandlers.onSelect,
    onDrop: folderClickHandlers.onDrop,
    onDragOver: folderClickHandlers.onDragOver,
    onDragLeave: folderClickHandlers.onDragLeave,
    onDeleteFolder: handleFolderDelete,
    onRenameFolder: handleFolderRename,
    selectedFolder,
    onFolderDragStart: handleFolderDragStart,
    onFolderDragEnd: handleFolderDragEnd,
    draggedFolderId,
    tags,
    activeTagIds: activeTagFilters,
    onToggleTagFilter: toggleTagFilter,
    correspondents,
    activeCorrespondentIds: activeCorrespondentFilters,
    onToggleCorrespondentFilter: toggleCorrespondentFilter,
  };

  const resolveThumbnailUrlForDoc = useCallback(
    (doc) =>
      resolveDocumentAssetUrl(doc, 'thumbnail', {
        ensureAssetUrl,
        getAsset: getDocumentAsset,
      }),
    [ensureAssetUrl, getDocumentAsset],
  );

  const showSkeuoWorkspace = useCallback(() => setWorkspaceMode('skeuo'), [setWorkspaceMode]);
  const exitSkeuoWorkspace = useCallback(() => setWorkspaceMode('table'), [setWorkspaceMode]);
  const handleDocumentsViewModeChange = useCallback((mode) => {
    setDocumentsViewMode((previous) => {
      const next = mode === 'grid' ? 'grid' : 'list';
      if (next !== previous && typeof window !== 'undefined') {
        window.localStorage.setItem('papercrate_view_mode', next);
      }
      return next;
    });
  }, []);

  const documentsTableProps = {
    currentFolderName,
    breadcrumbs,
    onRefresh: refreshCurrentFolder,
    onShowSkeuoWorkspace: showSkeuoWorkspace,
    onRequestCreateFolder: openCreateFolderModal,
    creatingFolder,
    subfolders: currentSubfolders,
    documents,
    searchResults,
    isFilterActive,
    onFolderSelect: selectFolder,
    onFolderDrop: folderClickHandlers.onDrop,
    onFolderDragOver: folderClickHandlers.onDragOver,
    onFolderDragLeave: folderClickHandlers.onDragLeave,
    onFolderDragStart: handleFolderDragStart,
    onFolderDragEnd: handleFolderDragEnd,
    draggedFolderId,
    onFolderDelete: handleFolderDelete,
    onFolderRowClick: handleFolderRowClick,
    onFolderRename: handleFolderRename,
    onDocumentRowClick: handleDocumentRowClick,
    onDocumentOpen: openDocumentPreview,
    onDocumentDelete: handleDocumentDelete,
    onDocumentRename: handleDocumentTitleUpdate,
    selectedDocumentIds,
    selectedFolderIds,
    focusedDocumentId,
    focusedRowKey,
    draggingDocumentIds: draggedDocumentIds,
    onDocumentDragStart: handleDocumentDragStart,
    onDocumentDragEnd: handleDocumentDragEnd,
    isSearchLoading: searchLoading,
    tagLookupById,
    onDocumentListFocus: handleDocumentListFocus,
    onDocumentListKeyDown: handleDocumentListKeyDown,
    onFocusedRowChange: setFocusedRowKey,
    ensureAssetUrl,
    getDocumentAsset,
    getDownloadHref: (doc) =>
      doc?.current_version?.download_path
        ? resolveApiPath(doc.current_version.download_path)
        : null,
    onTagClick: toggleTagFilter,
    onDocumentTagDrop: handleDocumentTagDrop,
    viewMode: documentsViewMode,
    onViewModeChange: handleDocumentsViewModeChange,
    onClearSelection: clearDocumentSelection,
  };

  const detailPanelProps = {
    selectedDocuments: orderedSelectedDocuments,
    tags,
    tagLookupById,
    onTagAdd: handleTagAdd,
    onTagRemove: handleTagRemove,
    onRegenerateThumbnails: handleThumbnailRegeneration,
    previewEntry: selectedPreviewEntry,
    onOpenPreview: openDocumentPreview,
    onBulkTagAdd: handleBulkTagAddFromDetail,
    onBulkTagRemove: handleBulkTagRemoveFromDetail,
    onBulkReanalyze: handleBulkSelectionReanalyze,
    onBulkCorrespondentAdd: handleBulkCorrespondentAdd,
    onBulkCorrespondentRemove: handleBulkCorrespondentRemove,
    onPromoteSelection: promoteSelectionOrder,
    activePreviewId,
    onUpdateTitle: handleDocumentTitleUpdate,
    ensureAssetUrl,
    getDocumentAsset,
    correspondents,
    onCorrespondentAdd: handleCorrespondentAdd,
    onCorrespondentRemove: handleCorrespondentRemove,
    resolveApiPath,
  };

  const skeuoWorkspaceProps = useMemo(
    () => ({
      documents,
      searchResults,
      breadcrumbs,
      currentFolderName,
      onExit: exitSkeuoWorkspace,
      onRefresh: refreshCurrentFolder,
      onDocumentOpen: openDocumentPreview,
      resolveThumbnailUrl: resolveThumbnailUrlForDoc,
      onAssignTagToDocument: handleDocumentTagAttach,
      onRemoveTagFromDocument: handleTagRemove,
      ensureAssetUrl,
      getDocumentAsset,
      activeTagIds: activeTagFilters,
    }),
    [
      documents,
      searchResults,
      breadcrumbs,
      currentFolderName,
      exitSkeuoWorkspace,
      refreshCurrentFolder,
      openDocumentPreview,
      resolveThumbnailUrlForDoc,
      handleDocumentTagAttach,
      handleTagRemove,
      ensureAssetUrl,
      getDocumentAsset,
      activeTagFilters,
    ],
  );

  const contextValue = useMemo(
    () => ({
      token,
      appStatus,
      status,
      setStatusMessage,
      dropOverlayState,
      handleBulkReanalyze,
      handleLogout,
      sidebarProps,
      tags,
      refreshTags,
      handleTagUpdate,
      handleTagCreate,
      handleTagDelete,
      handleDocumentTagAttach,
      correspondents,
      refreshCorrespondents,
      handleCorrespondentUpdate,
      handleCorrespondentCreate,
      handleCorrespondentDelete,
      handleDocumentCorrespondentAttach,
      handleCorrespondentRemove,
      handleCorrespondentAdd,
      previewActive,
      previewWorkspaceDocument,
      previewWorkspaceEntry,
      closeDocumentPreview,
      handleThumbnailRegeneration,
      documentsTableProps,
      detailPanelProps,
      workspaceMode,
      showSkeuoWorkspace,
      exitSkeuoWorkspace,
      skeuoWorkspaceProps,
      ensurePreviewData,
      notifyApiError,
      resolveApiPath,
    }),
    [
      token,
      appStatus,
      status,
      setStatusMessage,
      dropOverlayState,
      handleBulkReanalyze,
      handleLogout,
      sidebarProps,
      tags,
      refreshTags,
      handleTagUpdate,
      handleTagCreate,
      handleTagDelete,
      handleDocumentTagAttach,
      correspondents,
      refreshCorrespondents,
      handleCorrespondentUpdate,
      handleCorrespondentCreate,
      handleCorrespondentDelete,
      handleDocumentCorrespondentAttach,
      handleCorrespondentRemove,
      handleCorrespondentAdd,
      previewActive,
      previewWorkspaceDocument,
      previewWorkspaceEntry,
      closeDocumentPreview,
      handleThumbnailRegeneration,
      documentsTableProps,
      detailPanelProps,
      workspaceMode,
      showSkeuoWorkspace,
      exitSkeuoWorkspace,
      skeuoWorkspaceProps,
      ensurePreviewData,
      notifyApiError,
      resolveApiPath,
    ],
  );

  if (appStatus === 'logged-out' || appStatus === 'authenticating') {
    return (
      <Navigate
        to="/account/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }

  return (
    <AppShellContext.Provider value={contextValue}>
      <div className="app-shell" ref={shellRef}>
        <DropOverlay
          active={dropOverlayState.active}
          folderName={dropOverlayState.folderName}
        />
        <header className="app-bar">
          <div className="app-bar__main">
            <div className="app-bar__meta">
              <h1>Papercrate</h1>
              <span className="app-bar__hint">
                {appStatus === 'bootstrapping' && loading
                  ? 'Loading your library…'
                  : previewActive
                  ? 'Viewing document preview. Press ← Back to return to the library.'
                  : 'Drag files here to upload.'}
              </span>
            </div>
            <div className="app-bar__search">
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search documents"
                aria-label="Search documents"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleSearchSubmit();
                  }
                }}
              />
              {isFilterActive && (
                <button
                  type="button"
                  className="app-bar__search-clear"
                  onClick={clearFilters}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="app-bar__right">
              <div className="app-bar__links">
                <button
                  type="button"
                  className={`app-bar__link${isDocumentsRoute ? ' active' : ''}`}
                  onClick={() => navigate('/documents')}
                >
                  Documents
                </button>
                <button
                  type="button"
                  className={`app-bar__link${isTagsRoute ? ' active' : ''}`}
                  onClick={() => navigate('/tags')}
                >
                  Tags
                  <span className="app-bar__link-count">{tags.length}</span>
                </button>
                <button
                  type="button"
                  className={`app-bar__link${isCorrespondentsRoute ? ' active' : ''}`}
                  onClick={() => navigate('/correspondents')}
                >
                  Correspondents
                  <span className="app-bar__link-count">{correspondents.length}</span>
                </button>
              </div>
              {status && (
                <div className="app-bar__status">
                  <StatusBanner status={status} />
                </div>
              )}
              <div className="app-bar__actions">
                <button
                  className="secondary"
                  type="button"
                  onClick={handleBulkReanalyze}
                >
                  Re-analyze All
                </button>
                <button className="secondary" onClick={handleLogout}>
                  Log out
                </button>
              </div>
            </div>
          </div>
        </header>
        <Outlet />
        {isCreateFolderModalOpen && (
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={closeCreateFolderModal}
          >
            <div
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-folder-title"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="create-folder-title">Create folder</h3>
              <form className="modal__form" onSubmit={handleCreateFolderSubmit}>
                <label htmlFor="new-folder-name">Folder name</label>
                <input
                  id="new-folder-name"
                  ref={createFolderInputRef}
                  value={newFolderName}
                  onChange={(event) => {
                    setNewFolderName(event.target.value);
                    if (createFolderError) {
                      setCreateFolderError('');
                    }
                  }}
                  placeholder="Enter folder name"
                  disabled={creatingFolder}
                  autoComplete="off"
                />
                {createFolderError && <p className="modal__error">{createFolderError}</p>}
                <div className="modal__actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={closeCreateFolderModal}
                    disabled={creatingFolder}
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={creatingFolder}>
                    {creatingFolder ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AppShellContext.Provider>
  );
};

const DocumentsRoute = () => {
  const {
    sidebarProps,
    documentsTableProps,
    detailPanelProps,
    workspaceMode,
    skeuoWorkspaceProps,
  } = useAppShell();

  if (workspaceMode === 'skeuo') {
    return (
      <DocumentsLayout sidebarProps={sidebarProps}>
        <SkeuomorphicWorkspace {...skeuoWorkspaceProps} />
      </DocumentsLayout>
    );
  }

  return (
    <DocumentsLayout sidebarProps={sidebarProps}>
      <DocumentsTable {...documentsTableProps} />
      <DetailPanel {...detailPanelProps} />
    </DocumentsLayout>
  );
};

const LoginRoute = () => {
  const { status: appStatus } = useAppState();
  const appDispatch = useAppDispatch();
  const location = useLocation();
  const [status, setStatus] = useState(null);

  const setStatusMessage = useCallback((message, variant = 'info') => {
    setStatus(message ? { message, variant } : null);
  }, []);
  const handleLoginApiReport = useCallback(
    ({ message, variant }) => setStatusMessage(message, variant),
    [setStatusMessage],
  );
  const reportLoginError = useApiError({
    onReport: handleLoginApiReport,
  });
  const notifyLoginError = useCallback(
    (error, fallbackMessage, variant = 'error') =>
      reportLoginError(error, { message: fallbackMessage, variant }),
    [reportLoginError],
  );

  const handleLogin = useCallback(
    async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const payload = {
        username: form.get('username')?.toString().trim(),
        password: form.get('password')?.toString() || '',
      };

      if (!payload.username || !payload.password) {
        setStatusMessage('Username and password are required.', 'error');
        return;
      }

      try {
        appDispatch({ type: 'LOGIN_REQUEST' });
        const { data } = await api.post('/auth/login', payload);
        appDispatch({ type: 'LOGIN_SUCCESS', token: data.access_token });
        setStatusMessage('Login successful.', 'success');
      } catch (error) {
        const message = error?.response?.data?.error || 'Login failed. Check credentials.';
        appDispatch({ type: 'LOGIN_FAILURE', error: message });
        notifyLoginError(error, message);
      }
    },
    [appDispatch, notifyLoginError, setStatusMessage],
  );

  const redirectTarget = useMemo(() => {
    const target = location.state?.from;
    if (typeof target === 'string' && target.startsWith('/')) {
      return target;
    }
    return '/documents';
  }, [location.state]);

  if (appStatus !== 'logged-out' && appStatus !== 'authenticating') {
    return <Navigate to={redirectTarget} replace />;
  }

  return (
    <div className="app-shell">
      <LoginView onSubmit={handleLogin} status={status} />
    </div>
  );
};

function TagsRoute() {
  const {
    tags,
    refreshTags,
    handleTagUpdate,
    handleTagDelete,
    setStatusMessage,
  } = useAppShell();
  return (
    <main className="panels-main">
      <TagsPanel
        tags={tags}
        onRefresh={refreshTags}
        onUpdateTag={handleTagUpdate}
        onDeleteTag={handleTagDelete}
        onNotify={setStatusMessage}
      />
    </main>
  );
}

function CorrespondentsRoute() {
  const {
    correspondents,
    refreshCorrespondents,
    handleCorrespondentCreate,
    handleCorrespondentUpdate,
    handleCorrespondentDelete,
    setStatusMessage,
  } = useAppShell();

  return (
    <main className="panels-main">
      <CorrespondentsPanel
        correspondents={correspondents}
        onRefresh={refreshCorrespondents}
        onCreate={handleCorrespondentCreate}
        onUpdate={handleCorrespondentUpdate}
        onDelete={handleCorrespondentDelete}
        onNotify={setStatusMessage}
      />
    </main>
  );
}

const AppRouter = () => (
  <Routes>
    <Route path="/account/login" element={<LoginRoute />} />
    <Route element={<AppLayout />}>
      <Route path="/" element={<Navigate to="/documents" replace />} />
      <Route path="/documents" element={<DocumentsRoute />} />
      <Route path="/documents/folder/:folderId" element={<DocumentsRoute />} />
      <Route path="/documents/:documentId" element={<DocumentViewerRoute />} />
      <Route path="/tags" element={<TagsRoute />} />
      <Route path="/correspondents" element={<CorrespondentsRoute />} />
      <Route path="*" element={<Navigate to="/documents" replace />} />
    </Route>
  </Routes>
);

const container = document.getElementById('app');
const root = createRoot(container);
root.render(
  <AppStateProvider>
    <HashRouter hashType="hashbang">
      <AppRouter />
    </HashRouter>
  </AppStateProvider>,
);
