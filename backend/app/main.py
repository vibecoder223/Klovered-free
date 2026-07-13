from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .auth import AuthError
from .routers import answers, cron, documents, exports, jobs, knowledge, probe

app = FastAPI(title="Klovered Free — pipeline API")


@app.exception_handler(AuthError)
async def _auth_error_handler(_request: Request, exc: AuthError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"error": exc.message})


@app.exception_handler(HTTPException)
async def _http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    # Reshape FastAPI's default {"detail": ...} to {"error": ...} to match the
    # NextResponse.json({error}) shape the frontend already expects.
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


app.include_router(probe.router)
app.include_router(jobs.router)
app.include_router(documents.router)
app.include_router(knowledge.router)
app.include_router(cron.router)
app.include_router(answers.router)
app.include_router(exports.router)
