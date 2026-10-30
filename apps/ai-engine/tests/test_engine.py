import numpy as np
from fastapi.testclient import TestClient

from app.main import app
from app import forecasting

client = TestClient(app)


def seasonal(days=56, base=10.0, seed=1):
    rng = np.random.default_rng(seed)
    t = np.arange(days)
    return list(np.maximum(0, base + 4 * np.sin(2 * np.pi * t / 7) + rng.normal(0, 1, days)).round())


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["models"]["forecast"] == forecasting.MODEL_VERSION


def test_model_forecast_has_required_fields_and_sane_values():
    series = [{"sku_id": f"sku-{i}", "daily_units": seasonal(seed=i)} for i in range(6)]
    r = client.post("/forecast", json={"horizon_days": 7, "series": series})
    assert r.status_code == 200
    body = r.json()
    f = body["forecasts"][0]
    assert f["method"] == "model:hist_gradient_boosting"
    assert 0 <= f["confidence"] <= 1
    assert f["lower_bound"] <= f["predicted_units"] <= f["upper_bound"]
    # Mean demand is ~10/day -> 7-day total should be in a plausible band.
    assert 40 <= f["predicted_units"] <= 110


def test_short_history_falls_back_to_labelled_rule():
    r = client.post("/forecast", json={"horizon_days": 7, "series": [{"sku_id": "new", "daily_units": [1, 2, 3]}]})
    f = r.json()["forecasts"][0]
    assert f["method"].startswith("rule:")
    assert f["confidence"] is None


def test_anomaly_detection_flags_spike():
    records = [{"sku_id": "a", "day": f"2026-10-{d:02d}", "movement_type": "WRITE_OFF", "units": 2} for d in range(1, 29)]
    records += [{"sku_id": "b", "day": f"2026-10-{d:02d}", "movement_type": "DAMAGE", "units": 1} for d in range(1, 10)]
    records.append({"sku_id": "a", "day": "2026-10-29", "movement_type": "WRITE_OFF", "units": 250})
    r = client.post("/anomalies", json={"records": records})
    body = r.json()
    assert body["method"] == "model:isolation_forest"
    assert any(a["units"] == 250 for a in body["anomalies"])


def test_stockout_risk():
    assert forecasting.stockout_risk(2, 4)["risk"] == "HIGH"
    assert forecasting.stockout_risk(20, 4)["risk"] == "LOW"
