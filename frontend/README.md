# Papercrate Frontend

A minimal Webpack-powered SPA to interact with the Papercrate Milestone 1 backend.

## Prerequisites

- Node.js 18+
- Backend API running locally on `http://127.0.0.1:3000`

## Setup

```bash
cd frontend
npm install
```

## Development

```bash
npm run dev
```

- Starts `webpack-dev-server` on <http://localhost:5173>
- Proxies `/api` requests to the backend (no CORS needed)
- Edit files in `src/` and the browser reloads automatically

## Production Build

```bash
npm run build
```

- Output written to `dist/`
- Set `API_BASE_URL` in `.env.local` if the API is not served from the same origin.

## Features

- Finder-style layout: folder tree, document table, and detail pane with metadata & tags
- Drag-and-drop moves (documents between folders) and file uploads (window-wide or onto a folder)
- Search box plus tag chips filter documents across the selected folder and all descendants
- Tag management (create/assign/remove) from the detail panel
- Login via the seeded admin account (`admin` / `adminadmin`) with stored JWT session
- Inline status banner for quick feedback on API interactions

## Assets

- The folder icon (`src/assets/folder.svg`) is derived from the Adwaita icon theme by the [GNOME Project](http://www.gnome.org/).
