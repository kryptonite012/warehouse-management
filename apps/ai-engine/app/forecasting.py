"""SKU-level demand forecasting.

Model: a single gradient-boosted regressor trained across all SKUs of a site on
lag / rolling features (global model -> works for sparse long-tail SKUs).
Prediction intervals come from out-of-sample residuals on the last 14 days,
and `confidence` is the empirical coverage of that interval on the holdout.

Series that are too short or all-zero use an explicitly labelled rule
(moving average) and report confidence = None.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

MODEL_VERSION = "gbr-lag-v1"
MIN_HISTORY = 28
HOLDOUT = 14
LAGS = (1, 2, 3, 7, 14)


def _features(y: np.ndarray, t: int) -> list[float]:
    """Features for predicting y[t] from y[:t]."""
    past = y[:t]
    feats = [past[-lag] if len(past) >= lag else 0.0 for lag in LAGS]
    feats.append(past[-7:].mean() if len(past) else 0.0)
    feats.append(past[-28:].mean() if len(past) else 0.0)
    feats.append(past[-7:].std() if len(past) >= 2 else 0.0)
    feats.append(float(t % 7))  # weekday proxy (series are day-aligned)
    return feats


def _frame(series: dict[str, np.ndarray], start: int, end_offset: int) -> tuple[np.ndarray, np.ndarray]:
    xs, ys = [], []
    for y in series.values():
        for t in range(max(start, 14), len(y) - end_offset):
            xs.append(_features(y, t))
            ys.append(y[t])
    return np.asarray(xs, dtype=float), np.asarray(ys, dtype=float)


def moving_average(sku_id: str, y: np.ndarray, horizon: int) -> dict:
    window = y[-28:]
    mean, sd = float(window.mean()), float(window.std())
    total = mean * horizon
    spread = 1.28 * sd * np.sqrt(horizon)
    return {
        "sku_id": sku_id,
        "predicted_units": round(total, 2),
        "lower_bound": round(max(0.0, total - spread), 2),
        "upper_bound": round(total + spread, 2),
        "confidence": None,
        "method": "rule:moving_average_28d",
        "supporting_variables": {"mean_daily_units": mean, "std_daily_units": sd, "window_days": int(len(window)),
                                 "reason": "insufficient history for model"},
    }


def forecast(series_in: list[tuple[str, list[float]]], horizon: int) -> list[dict]:
    series = {sku: np.asarray(vals, dtype=float) for sku, vals in series_in}
    modelable = {k: v for k, v in series.items() if len(v) >= MIN_HISTORY and v.sum() > 0}
    results: list[dict] = []

    model = None
    q_lo = q_hi = 0.0
    coverage = None
    if modelable:
        x_train, y_train = _frame(modelable, 0, HOLDOUT)
        x_hold, y_hold = _frame({k: v for k, v in modelable.items()}, len(next(iter(modelable.values()))) - HOLDOUT, 0)
        if len(y_train) >= 50:
            model = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, random_state=7)
            model.fit(x_train, y_train)
            residuals = y_hold - model.predict(x_hold) if len(y_hold) else np.zeros(1)
            q_lo, q_hi = np.quantile(residuals, [0.1, 0.9])
            inside = ((residuals >= q_lo) & (residuals <= q_hi)).mean() if len(residuals) else 0.0
            coverage = float(round(inside, 4))
            # Refit on all data for the final forecast.
            x_all, y_all = _frame(modelable, 0, 0)
            model.fit(x_all, y_all)

    for sku, y in series.items():
        if model is None or sku not in modelable:
            results.append(moving_average(sku, y, horizon))
            continue
        # Recursive multi-step forecast.
        path = list(y)
        preds = []
        for _ in range(horizon):
            p = max(0.0, float(model.predict(np.asarray([_features(np.asarray(path), len(path))]))[0]))
            preds.append(p)
            path.append(p)
        total = float(sum(preds))
        results.append({
            "sku_id": sku,
            "predicted_units": round(total, 2),
            "lower_bound": round(max(0.0, total + q_lo * np.sqrt(horizon)), 2),
            "upper_bound": round(total + q_hi * np.sqrt(horizon), 2),
            "confidence": coverage,
            "method": "model:hist_gradient_boosting",
            "supporting_variables": {
                "lags": list(LAGS), "mean_7d": float(y[-7:].mean()), "mean_28d": float(y[-28:].mean()),
                "history_days": int(len(y)), "holdout_days": HOLDOUT,
            },
        })
    return results


def stockout_risk(available: float, daily_forecast: float) -> dict:
    """Days of cover; not an ML output, reported as a derived metric."""
    if daily_forecast <= 0:
        return {"days_of_cover": None, "risk": "LOW"}
    days = available / daily_forecast
    return {"days_of_cover": round(days, 2), "risk": "HIGH" if days < 1 else "MEDIUM" if days < 3 else "LOW"}


def to_dataframe(series_in: list[tuple[str, list[float]]]) -> pd.DataFrame:
    rows = [{"sku_id": s, "day": i, "units": v} for s, vals in series_in for i, v in enumerate(vals)]
    return pd.DataFrame(rows)
