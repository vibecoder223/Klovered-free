"""Vercel serverless entry point.

Vercel's Python runtime serves the ASGI/WSGI callable named ``app`` exported
from a file under ``api/``. We re-export the FastAPI app unchanged, so the same
application runs identically here, under uvicorn locally, and in the Docker
image. All routing is handled inside the app; vercel.json rewrites every path
to this function.
"""

import sys
from pathlib import Path

# The backend project root (parent of this api/ dir) holds the `app` package.
# Vercel executes functions with api/ as cwd-ish, so make the root importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402

__all__ = ["app"]
