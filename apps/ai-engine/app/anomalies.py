"""Unusual inventory movement detection with IsolationForest.

Features per (sku, day, movement_type): units, ratio to that SKU's median for the
type, and day-of-month. Requires >= 30 records; otherwise a labelled z-score rule.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

MODEL_VERSION = "iforest-v1"


def detect(records: list[dict]) -> dict:
    if not records:
        return {"method": "none", "model_version": MODEL_VERSION, "anomalies": []}
    df = pd.DataFrame(records)
    med = df.groupby(["sku_id", "movement_type"])["units"].transform("median").replace(0, 1)
    df["ratio"] = df["units"] / med
    if len(df) < 30:
        mean, sd = df["units"].mean(), df["units"].std(ddof=0) or 1.0
        df["score"] = (df["units"] - mean) / sd
        flagged = df[df["score"] > 3]
        return {"method": "rule:zscore>3", "model_version": "rule-v1",
                "anomalies": flagged[["sku_id", "day", "movement_type", "units", "score"]].to_dict("records")}
    x = np.column_stack([df["units"], df["ratio"], pd.to_datetime(df["day"]).dt.day])
    forest = IsolationForest(n_estimators=200, contamination="auto", random_state=7).fit(x)
    df["score"] = -forest.score_samples(x)
    df["is_anomaly"] = forest.predict(x) == -1
    flagged = df[df["is_anomaly"]].sort_values("score", ascending=False)
    return {
        "method": "model:isolation_forest",
        "model_version": MODEL_VERSION,
        "anomalies": flagged[["sku_id", "day", "movement_type", "units", "ratio", "score"]].to_dict("records"),
    }
