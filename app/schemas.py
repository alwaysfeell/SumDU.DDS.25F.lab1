from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Money = Optional[Decimal]
MONEY_FIELD = dict(ge=0, max_digits=10, decimal_places=2)


def _check_not_blank(value: Optional[str], field: str) -> Optional[str]:
    if value is None:
        raise ValueError(f"{field} cannot be null")
    if not value.strip():
        raise ValueError(f"{field} cannot be empty")
    return value


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


class TravelPlanCreate(_Base):
    title: str = Field(max_length=200)
    description: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    budget: Money = Field(None, **MONEY_FIELD)
    currency: str = Field("USD", pattern=r"^[A-Z]{3}$")
    is_public: bool = False

    @field_validator("title")
    @classmethod
    def title_not_blank(cls, v):
        return _check_not_blank(v, "title")

    @model_validator(mode="after")
    def dates_in_order(self):
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("end_date must be greater than or equal to start_date")
        return self


class TravelPlanUpdate(_Base):

    title: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    budget: Money = Field(None, **MONEY_FIELD)
    currency: Optional[str] = Field(None, pattern=r"^[A-Z]{3}$")
    is_public: Optional[bool] = None
    version: int = Field(ge=1, description="Версія, яку клієнт прочитав (optimistic locking)")

    @field_validator("title")
    @classmethod
    def title_not_blank(cls, v):
        return _check_not_blank(v, "title")

    @field_validator("currency", "is_public")
    @classmethod
    def not_null(cls, v, info):
        if v is None:
            raise ValueError(f"{info.field_name} cannot be null")
        return v

    @model_validator(mode="after")
    def dates_in_order(self):
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("end_date must be greater than or equal to start_date")
        return self


class LocationCreate(_Base):
    name: str = Field(max_length=200)
    address: Optional[str] = None
    latitude: Optional[float] = Field(None, ge=-90, le=90, allow_inf_nan=False)
    longitude: Optional[float] = Field(None, ge=-180, le=180, allow_inf_nan=False)
    arrival_date: Optional[datetime] = None
    departure_date: Optional[datetime] = None
    budget: Money = Field(None, **MONEY_FIELD)
    notes: Optional[str] = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v):
        return _check_not_blank(v, "name")

    @model_validator(mode="after")
    def dates_in_order(self):
        if self.arrival_date and self.departure_date and self.departure_date < self.arrival_date:
            raise ValueError("departure_date must be greater than or equal to arrival_date")
        return self


class LocationUpdate(_Base):

    name: Optional[str] = Field(None, max_length=200)
    address: Optional[str] = None
    latitude: Optional[float] = Field(None, ge=-90, le=90, allow_inf_nan=False)
    longitude: Optional[float] = Field(None, ge=-180, le=180, allow_inf_nan=False)
    visit_order: Optional[int] = Field(None, ge=1)
    arrival_date: Optional[datetime] = None
    departure_date: Optional[datetime] = None
    budget: Money = Field(None, **MONEY_FIELD)
    notes: Optional[str] = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v):
        return _check_not_blank(v, "name")

    @field_validator("visit_order")
    @classmethod
    def order_not_null(cls, v):
        if v is None:
            raise ValueError("visit_order cannot be null")
        return v

    @model_validator(mode="after")
    def dates_in_order(self):
        if self.arrival_date and self.departure_date and self.departure_date < self.arrival_date:
            raise ValueError("departure_date must be greater than or equal to arrival_date")
        return self
