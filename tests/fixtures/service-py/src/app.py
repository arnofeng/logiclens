from fastapi import FastAPI
import requests

app = FastAPI()


@app.get("/api/python/users")
def list_users():
    requests.get("/api/python/orders")
    requests.get(build_runtime_url())
    cache.get("/api/python/local-cache")
    return []
