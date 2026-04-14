# FVMA Disaster Response Platform

A web platform for the **Florida Veterinary Medical Association (FVMA)** to coordinate veterinary disaster response—connecting volunteers, clinics, and resources when animals and communities need help.

## Project structure

| Folder | Description |
|--------|-------------|
| `backend/` | Node.js API server (Express) for data, integrations, and business logic |
| `frontend/` | React web app (Vite) for the user interface |

## Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- npm (comes with Node.js)

## Quick start

From the **project root**, install dependencies for both apps:

```bash
cd backend && npm install && cd ../frontend && npm install && cd ..
```

Or install each folder separately (see commands at the end of setup).

### Run the API server

```bash
cd backend
npm run dev
```

The API listens on port `3001` by default (configurable via `.env`).

### Run the web app

```bash
cd frontend
npm run dev
```

The Vite dev server prints a local URL (usually `http://localhost:5173`).

## Environment variables

- **Backend:** copy `backend/.env.example` to `backend/.env` and fill in values (Supabase, SendGrid, Twilio, etc.) when you connect those services.
- Never commit `.env` files; they are listed in `.gitignore`.

## Tech stack

- **Backend:** Express, CORS, Supabase client, SendGrid, Twilio, file uploads (Multer), spreadsheets (xlsx)
- **Frontend:** React, Vite, Tailwind CSS

---

*Built for FVMA disaster response coordination.*
