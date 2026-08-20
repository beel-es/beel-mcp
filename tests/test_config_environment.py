from __future__ import annotations

import pytest
from pydantic import ValidationError

from beel_mcp.config import Settings


def _settings(**kwargs) -> Settings:
    return Settings(**kwargs, _env_file=None)


@pytest.mark.parametrize("value", ["test", "live"])
def test_acepta_las_grafias_canonicas(value: str) -> None:
    assert _settings(BEEL_ENVIRONMENT=value).beel_environment == value


@pytest.mark.parametrize(
    ("legacy", "esperado"),
    [
        ("sandbox", "test"),
        ("production", "live"),
        ("prod", "live"),
        ("SANDBOX", "test"),
        ("Production", "live"),
    ],
)
def test_las_grafias_retiradas_siguen_arrancando(legacy: str, esperado: str) -> None:
    """Un `.env` escrito antes del renombrado no puede tumbar el servidor al iniciar.

    Es el motivo de que el Literal no se cambie a secas: quien ya tiene el MCP en
    marcha no se entera del cambio hasta que deja de levantar.
    """
    assert _settings(BEEL_ENVIRONMENT=legacy).beel_environment == esperado


def test_por_defecto_es_test() -> None:
    """El entorno seguro por defecto: nada de lo que se haga aqui es fiscal real."""
    assert _settings().beel_environment == "test"


def test_una_grafia_desconocida_no_cae_a_test_en_silencio() -> None:
    with pytest.raises(ValidationError):
        _settings(BEEL_ENVIRONMENT="banana")
