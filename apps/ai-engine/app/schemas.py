from pydantic import BaseModel, Field


class SkuSeries(BaseModel):
    sku_id: str
    daily_units: list[float] = Field(min_length=1, max_length=730, description="Oldest to newest, one value per day")


class ForecastRequest(BaseModel):
    horizon_days: int = Field(ge=1, le=28)
    series: list[SkuSeries] = Field(min_length=1, max_length=20000)


class SkuForecast(BaseModel):
    sku_id: str
    predicted_units: float
    lower_bound: float
    upper_bound: float
    confidence: float | None
    method: str
    supporting_variables: dict


class ForecastResponse(BaseModel):
    model_version: str
    generated_at: str
    forecasts: list[SkuForecast]


class MovementRecord(BaseModel):
    sku_id: str
    day: str
    movement_type: str
    units: float


class AnomalyRequest(BaseModel):
    records: list[MovementRecord] = Field(max_length=100000)
