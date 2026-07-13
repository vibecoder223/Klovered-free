from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .auth import AuthError
from .routers import probe

app = FastAPI(title="Klovered Free — pipeline API")


@app.exception_handler(AuthError)
async def _auth_error_handler(_request: Request, exc: AuthError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"error": exc.message})


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


app.include_router(probe.router)
