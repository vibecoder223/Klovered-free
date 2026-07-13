from fastapi import FastAPI

app = FastAPI(title="Klovered Free — pipeline API")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
