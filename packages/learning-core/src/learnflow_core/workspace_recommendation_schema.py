"""Read-only device-local recommendation input; callers cannot supply ranking hints."""
from pydantic import BaseModel, ConfigDict, Field


class WorkspaceRecommendationsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    checkpoint_id: int | None = Field(default=None, gt=0, strict=True)
    limit: int = Field(default=6, ge=1, le=6, strict=True)
