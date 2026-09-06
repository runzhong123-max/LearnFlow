from app.core.config import Settings, normalize_openai_base_url


def test_openai_base_url_accepts_full_responses_and_chat_completion_endpoints():
    assert normalize_openai_base_url(
        "https://api.xiaomimimo.com/v1/responses"
    ) == "https://api.xiaomimimo.com/v1"
    assert normalize_openai_base_url(
        "https://gateway.example/v1/chat/completions/"
    ) == "https://gateway.example/v1"


def test_settings_normalizes_model_endpoint_during_startup():
    configured = Settings(
        llm_base_url="https://provider.example/openai/v1/responses",
    )

    assert configured.llm_base_url == "https://provider.example/openai/v1"
