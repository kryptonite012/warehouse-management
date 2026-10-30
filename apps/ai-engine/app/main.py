"""QuickStore AI engine. Optional service: core operations never depend on it."""
from datetime import datetime, timezone

from fastapi import FastAPI

from . import anomalies, forecasting
from .schemas import AnomalyRequest, ForecastRequest, ForecastResponse

app = FastAPI(title="QuickStore AI Engine", version="1.0.0")


@app.get("/health")
def health():
    return {"status": "ok", "models": {"forecast": forecasting.MODEL_VERSION, "anomaly": anomalies.MODEL_VERSION}}


@app.post("/forecast", response_model=ForecastResponse)
def forecast(req: ForecastRequest):
    results = forecasting.forecast([(s.sku_id, s.daily_units) for s in req.series], req.horizon_days)
    return {
        "model_version": forecasting.MODEL_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "forecasts": results,
    }


@app.post("/anomalies")
def detect(req: AnomalyRequest):
    return anomalies.detect([r.model_dump() for r in req.records])
